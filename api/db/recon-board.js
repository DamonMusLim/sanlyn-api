import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  TOLERANCE, STALE_CUTOFF, money, parseLimit, ageDays, due, isDone, isPartial, statusOf,
  hasText, relationTypeLabel, relationTitle, settlementLine, aggregateStatus, baseTone,
  worstTone, ageChip, nextAction, amountMapAdd, amountList,
} from "./recon-board-helpers.js";
import { INVOICE_CONFIRM_SQL, reviewPriceOverride } from "./recon-board-invoice-confirm.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);

function json(res, status, payload) {
  return res.status(status).json(payload);
}

async function fetchFacts(pool, { q = "", limit = 500 } = {}) {
  const like = `%${q}%`;
  const args = q ? [like, limit] : [limit];
  const orderFilter = q ? `
    AND (o.order_no ILIKE $1 OR o.contract_no ILIKE $1 OR o.customer ILIKE $1)` : "";
  const shipmentFilter = q ? `
    AND (sp.shipment_no ILIKE $1 OR sp.bl_no ILIKE $1 OR sp.forwarder_cn ILIKE $1
      OR EXISTS (SELECT 1 FROM selected_orders so WHERE so.order_no = ANY(COALESCE(sp.order_nos, '{}'::text[]))))` : "";
  const sql = `
WITH selected_orders AS (
  SELECT o.* FROM orders o
   WHERE o.deleted_at IS NULL AND COALESCE(o.status, '') <> 'cancelled' ${orderFilter}
   ORDER BY COALESCE(o.status_updated_at, o.updated_at, o.created_at) DESC NULLS LAST, o.id DESC
   LIMIT $${args.length}
),
payments AS (
  SELECT so.order_no, so.contract_no,
         COALESCE(SUM(COALESCE(fp.this_amount, fp.amount)) FILTER (WHERE fp.direction='out'),0) AS paid,
         COALESCE(SUM(COALESCE(fp.this_amount, fp.amount)) FILTER (WHERE fp.direction='in'),0) AS received
    FROM selected_orders so
    LEFT JOIN finance_payments fp ON ((so.contract_no IS NOT NULL AND fp.contract_no=so.contract_no) OR (so.order_no IS NOT NULL AND fp.order_no=so.order_no))
   GROUP BY so.order_no, so.contract_no
),
drafts AS (
  SELECT so.order_no, so.contract_no, d.status AS invoice_status, d.currency AS invoice_currency,
         COALESCE(d.amount_invoice, d.amount_declared, d.amount_order) AS invoice_amount
    FROM selected_orders so LEFT JOIN finance_invoice_drafts d ON d.contract_no=so.contract_no
),
slips AS (
  SELECT so.order_no, so.contract_no,
         COUNT(DISTINCT bsl.id) FILTER (WHERE bsl.contract_no=so.contract_no OR bsl.order_no=so.order_no) AS customer_slip_count,
         COUNT(DISTINCT bsl.id) FILTER (WHERE fp.id IS NOT NULL) AS factory_slip_count
    FROM selected_orders so
    LEFT JOIN bank_slip_links bsl ON bsl.contract_no=so.contract_no OR bsl.order_no=so.order_no OR bsl.payment_id IS NOT NULL
    LEFT JOIN finance_payments fp ON fp.id=bsl.payment_id AND fp.direction='out'
      AND ((fp.contract_no=so.contract_no AND so.contract_no IS NOT NULL) OR (fp.order_no=so.order_no AND so.order_no IS NOT NULL))
   GROUP BY so.order_no, so.contract_no
),
-- 客户应收锚定源 = finance_export_rebates.fob_cny(报关销售额,唯一真源;绝不用 orders.total/OLI)。
-- 借鉴 customer-ar-reconcile.js 的锚定逻辑,此处按 contract_no 聚合(一票多单时各 fer 行 SUM,避免 JOIN 扇出)。
-- 无 fer 行 → receivable_anchor=NULL → orderFact 里 anchored=false → 前端显"待报关"。
receivable_anchor AS (
  SELECT so.contract_no,
         SUM(r.fob_cny) AS receivable_anchor,
         MIN(r.currency) AS anchor_currency,
         COUNT(*) AS anchor_decl_count
    FROM selected_orders so
    JOIN finance_export_rebates r ON r.contract_no = so.contract_no AND so.contract_no IS NOT NULL
   GROUP BY so.contract_no
),
-- 客户发票号:finance_invoices_out.contract_nos 数组重叠匹配(排除作废/红冲/草稿)。
customer_invoices AS (
  SELECT so.contract_no,
         (array_agg(DISTINCT fio.invoice_no) FILTER (WHERE fio.invoice_no IS NOT NULL))[1] AS invoice_no
    FROM selected_orders so
    JOIN finance_invoices_out fio
      ON so.contract_no = ANY(COALESCE(fio.contract_nos::text[], '{}'::text[]))
     AND so.contract_no IS NOT NULL
     AND COALESCE(fio.void_status,'') <> 'void'
     AND COALESCE(fio.review_status,'') NOT IN ('void','red_ink')
     AND COALESCE(fio.invoice_no,'') NOT LIKE 'CI-DRAFT%'
   GROUP BY so.contract_no
),
-- 客户水单文件 url:bank_slips.file_url,经 bank_slip_links 按 contract_no/order_no 挂到订单。
customer_slip_file AS (
  SELECT so.contract_no, so.order_no,
         (array_agg(bs.file_url ORDER BY bs.created_at DESC)
            FILTER (WHERE bs.file_url IS NOT NULL))[1] AS slip_file_url
    FROM selected_orders so
    JOIN bank_slip_links bsl ON (bsl.contract_no=so.contract_no AND so.contract_no IS NOT NULL)
                             OR (bsl.order_no=so.order_no AND so.order_no IS NOT NULL)
    JOIN bank_slips bs ON bs.id = bsl.slip_id
   GROUP BY so.contract_no, so.order_no
),
-- 订单运输信息:按 order_no 在 shipping_plans.order_nos 数组里找;一订单多柜取最新 etd。
order_shipment AS (
  SELECT DISTINCT ON (so.order_no)
         so.order_no,
         sp.container_no, sp.shipper, sp.carrier_code, sp.vessel, sp.etd, sp.eta,
         sp.customer AS consignee
    FROM selected_orders so
    JOIN shipping_plans sp ON sp.deleted_at IS NULL
     AND so.order_no = ANY(COALESCE(sp.order_nos, '{}'::text[]))
   ORDER BY so.order_no, sp.etd DESC NULLS LAST
),
selected_shipments AS (
  SELECT sp.* FROM shipping_plans sp
   WHERE sp.deleted_at IS NULL AND NULLIF(BTRIM(COALESCE(sp.shipment_no, '')), '') IS NOT NULL ${shipmentFilter}
),
bill_rows AS (
  SELECT sp.id AS plan_id, fsb.* FROM selected_shipments sp
    LEFT JOIN active_freight_supplier_bills fsb ON fsb.link_plan_id=sp._id OR (sp.bl_no IS NOT NULL AND (fsb.bl_no=sp.bl_no OR fsb.link_plan_id=sp.bl_no))
),
bill_groups AS (
  SELECT br.plan_id,
         COALESCE(br.supplier_company_code, br.supplier) AS party_key,
         MAX(br.supplier_company_code) AS supplier_company_code,
         MAX(br.supplier) AS supplier_name,
         MAX(br.payer_company_code) AS payer_company_code,
         COALESCE(br.currency_norm, br.currency, 'CNY') AS currency,
         COALESCE(SUM(br.amount),0) AS ap_total,
         COALESCE(SUM(br.ap_paid_amount),0) AS ap_paid,
         COALESCE(SUM(br.sale_amount),0) AS ar_total,
         COALESCE(SUM(br.ar_paid_amount),0) AS ar_paid,
         COALESCE(jsonb_agg(jsonb_build_object('ap_status', br.ap_status, 'ar_status', br.ar_status)) FILTER (WHERE br.id IS NOT NULL), '[]'::jsonb) AS bills
    FROM bill_rows br
   WHERE br.id IS NOT NULL
   GROUP BY br.plan_id, COALESCE(br.supplier_company_code, br.supplier), COALESCE(br.currency_norm, br.currency, 'CNY')
),
${INVOICE_CONFIRM_SQL},
shipment_sum AS (
  SELECT sp.id, sp._id, sp.shipment_no, sp.bl_no, sp.order_nos, sp.issuing_company,
         sp.forwarder_cn AS forwarder, sp.forwarder_company_id, sp.customer, sp.company_code, sp.customer_company_id,
         sp.container_no, sp.shipper, sp.carrier_code, sp.vessel, sp.etd, sp.eta,
         sp.customer AS consignee,
         sp.created_at, sp.updated_at, sp.forwarder_price_confirmed_at,
         COALESCE(SUM(bg.ap_total),0) AS ap_total, COALESCE(SUM(bg.ap_paid),0) AS ap_paid,
         COALESCE(SUM(bg.ar_total),0) AS ar_total, COALESCE(SUM(bg.ar_paid),0) AS ar_paid,
         COUNT(DISTINCT bg.currency) FILTER (WHERE bg.party_key IS NOT NULL) AS bill_currency_count,
         MIN(bg.currency) FILTER (WHERE bg.party_key IS NOT NULL) AS bill_currency,
         COALESCE(jsonb_agg(to_jsonb(bg) ORDER BY bg.party_key, bg.currency) FILTER (WHERE bg.party_key IS NOT NULL), '[]'::jsonb) AS bill_groups,
         COALESCE(icg.invoice_confirm_status, 'none') AS invoice_confirm_status,
         COALESCE(icg.pending_price_review, false) AS pending_price_review,
         icg.confirm_actor,
         icg.confirm_at,
         COALESCE(icg.invoice_confirm_refs, '[]'::jsonb) AS invoice_confirm_refs,
         (NULLIF(BTRIM(COALESCE(sp.forwarder_cn, '')), '') IS NULL) AS missing_forwarder,
         CASE WHEN EXISTS (SELECT 1 FROM recon_lines rl WHERE rl.template_key='ap_forwarder' AND sp.bl_no IS NOT NULL AND rl.line_key LIKE '%' || sp.bl_no || '%' AND COALESCE(rl.actual_amount,0)>0) THEN 'invoiced' ELSE 'pending' END AS ap_invoice
    FROM selected_shipments sp
    LEFT JOIN bill_groups bg ON bg.plan_id=sp.id
    LEFT JOIN invoice_confirm_groups icg ON icg.shipment_id=sp.id
   GROUP BY sp.id, sp._id, sp.shipment_no, sp.bl_no, sp.order_nos, sp.issuing_company,
            sp.forwarder_cn, sp.forwarder_company_id, sp.customer, sp.company_code, sp.customer_company_id,
            sp.container_no, sp.shipper, sp.carrier_code, sp.vessel, sp.etd, sp.eta,
            sp.created_at, sp.updated_at, sp.forwarder_price_confirmed_at,
            icg.invoice_confirm_status, icg.pending_price_review, icg.confirm_actor, icg.confirm_at, icg.invoice_confirm_refs
)
SELECT
  (SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.last_action_at DESC NULLS LAST), '[]'::jsonb) FROM (
    SELECT so.created_at, so.updated_at, so.etd, so.order_date, so.order_no, so.contract_no, so.customer, so.factory, so.issuing_company, so.currency,
           so.factory_code, so.factory_company_id, so.company_code, so.customer_company_id,
           so.created_by, so.status_updated_by, COALESCE(so.status_updated_at, so.updated_at) AS last_action_at,
           so.factory_confirmed_at, so.customer_confirmed_at,
           COALESCE(so.factory_total_amount, so.total_amount_factory, so.factory_amount) AS payable,
           -- 应收锚定:仅报关销售额 fob_cny;无 fer 锚 → NULL(anchored=false → 前端"待报关"),绝不兜底订单额。
           ra.receivable_anchor AS receivable,
           (ra.receivable_anchor IS NOT NULL) AS anchored,
           ra.anchor_currency, ra.anchor_decl_count,
           ci.invoice_no,
           csf.slip_file_url,
           osh.container_no, osh.shipper, osh.carrier_code, osh.vessel, osh.etd AS ship_etd, osh.eta AS ship_eta, osh.consignee,
           p.paid, p.received, d.invoice_status, d.invoice_currency, d.invoice_amount, s.factory_slip_count, s.customer_slip_count
      FROM selected_orders so LEFT JOIN payments p USING(order_no, contract_no) LEFT JOIN drafts d USING(order_no, contract_no) LEFT JOIN slips s USING(order_no, contract_no)
           LEFT JOIN receivable_anchor ra USING(contract_no)
           LEFT JOIN customer_invoices ci USING(contract_no)
           LEFT JOIN customer_slip_file csf USING(contract_no, order_no)
           LEFT JOIN order_shipment osh USING(order_no)
  ) x) AS orders,
  (SELECT COALESCE(jsonb_agg(to_jsonb(ss) ORDER BY ss.created_at DESC NULLS LAST), '[]'::jsonb) FROM shipment_sum ss) AS shipments,
  (SELECT COALESCE(jsonb_agg(to_jsonb(d)), '[]'::jsonb) FROM finance_invoice_drafts d WHERE d.status IN ('pending','blocked','confirmed')) AS invoice_drafts,
  (SELECT COALESCE(jsonb_agg(to_jsonb(e)), '[]'::jsonb) FROM finance_recon_exceptions e WHERE e.status='open') AS exceptions,
  (SELECT COUNT(*)::int FROM finance_payments WHERE COALESCE(direction,'')='') AS unclassified_payments_count`;
  const r = await pool.query(sql, args);
  return r.rows[0] || {};
}

function orderFact(row) {
  const payable = money(row.payable);
  const paid = money(row.paid) || 0;
  const anchored = Boolean(row.anchored);
  const receivable = anchored ? money(row.receivable) : null; // 无报关锚 → null(待报关),绝不兜底订单额
  const received = money(row.received) || 0;
  // 应收币种以报关锚币种为准(报关销售额口径),缺则回退订单币种
  const arCurrency = anchored ? "CNY" : (row.currency || "CNY"); // fob_cny 恒为人民币口径,锚定应收固定 CNY(currency 列是原始申报币种,USD 单会错标)
  const age = ageDays(row.etd || row.order_date || row.created_at);
  const invoiceStatus = row.invoice_status || "none";
  const fTone = baseTone({ total: payable, paid, age, createdAt: row.created_at });
  const cTone = baseTone({ total: receivable, paid: received, age, invoiceStatus, createdAt: row.created_at });
  const refs = { order_no: row.order_no, contract_no: row.contract_no };
  const settlementLines = [
    settlementLine({
      sourceType: "order",
      counterpartyType: "factory",
      direction: "ap",
      ownEntity: row.issuing_company,
      counterpartyName: row.factory,
      counterpartyCode: row.factory_code,
      total: payable,
      paid,
      currency: row.currency || "CNY",
      refs,
      tone: fTone,
      slipUploaded: Number(row.factory_slip_count || 0) > 0,
      dataMissing: !hasText(row.factory) && !hasText(row.factory_code),
      missingReason: !hasText(row.factory) && !hasText(row.factory_code) ? "缺工厂" : null,
    }),
    settlementLine({
      sourceType: "order",
      counterpartyType: "customer",
      direction: "ar",
      ownEntity: row.issuing_company,
      counterpartyName: row.customer,
      counterpartyCode: row.company_code,
      total: receivable,
      paid: received,
      currency: arCurrency,
      refs,
      tone: cTone,
      invoiceStatus,
      slipUploaded: Number(row.customer_slip_count || 0) > 0,
      dataMissing: !hasText(row.customer) && !hasText(row.company_code),
      missingReason: !hasText(row.customer) && !hasText(row.company_code) ? "缺客户" : null,
    }),
  ];
  const r = {
    id: `order:${row.order_no || row.contract_no}`,
    type: "order",
    order_no: row.order_no,
    contract_no: row.contract_no,
    title: row.order_no || row.contract_no || "未编号订单",
    subtitle: [row.contract_no || "无合同号", row.customer || "无客户", row.factory || "无工厂"].join(" · "),
    currency: row.currency || "CNY",
    owner: row.status_updated_by || row.created_by || "未指派",
    last_action_at: row.last_action_at || row.updated_at || row.created_at || null,
    age_days: age,
    age_chip: ageChip(age, due(receivable, received) > TOLERANCE || due(payable, paid) > TOLERANCE),
    amounts: { receivable, received, receivable_due: due(receivable, received), payable, paid, payable_due: due(payable, paid) },
    settlement_lines: settlementLines,
    anchored,
    receivable_status: anchored ? undefined : "pending_customs", // 前端据此显"待报关"
    invoice_no: row.invoice_no || null,
    slip_file_url: row.slip_file_url || null,
    consignee: row.consignee || null,
    shipping: {
      container_no: row.container_no || null,
      shipper: row.shipper || null,
      carrier_code: row.carrier_code || null,
      vessel: row.vessel || null,
      etd: row.ship_etd || null,
      eta: row.ship_eta || null,
      consignee: row.consignee || null,
    },
    factory_side: { payable, paid, due: due(payable, paid), paid_status: statusOf(payable, paid), slip_count: Number(row.factory_slip_count || 0), tone: fTone },
    customer_side: { invoice_status: invoiceStatus, anchored, receivable, received, currency: arCurrency, due: due(receivable, received), received_status: statusOf(receivable, received), invoice_no: row.invoice_no || null, slip_file_url: row.slip_file_url || null, slip_uploaded: Number(row.customer_slip_count || 0) > 0, tone: cTone },
    signals: {
      invoice_status: invoiceStatus,
      receivable_due: due(receivable, received),
      payable_due: due(payable, paid),
      customer_slip_uploaded: Number(row.customer_slip_count || 0) > 0,
      amount_partial: isPartial(receivable, received) || isPartial(payable, paid),
    },
  };
  r.tone = worstTone([fTone, cTone]);
  r.next_action = nextAction(r);
  return r;
}

function shipmentFact(row, selectedOrderNos) {
  const billGroups = Array.isArray(row.bill_groups) ? row.bill_groups : [];
  const ap = money(row.ap_total);
  const apPaid = money(row.ap_paid) || 0;
  const ar = money(row.ar_total);
  const arPaid = money(row.ar_paid) || 0;
  const age = ageDays(row.forwarder_price_confirmed_at || row.created_at);
  const apTone = baseTone({ total: ap, paid: apPaid, age, invoiceStatus: row.ap_invoice, createdAt: row.created_at });
  const arTone = baseTone({ total: ar, paid: arPaid, age, createdAt: row.created_at });
  const orderNos = row.order_nos || [];
  const parent = orderNos.find(no => selectedOrderNos.has(no)) || null;
  const refs = { shipment_id: row._id || row.id, shipment_no: row.shipment_no, bl_no: row.bl_no, order_nos: orderNos, parent_order_no: parent };
  const settlementLines = [];
  const firstText = (...xs) => xs.find(hasText) || null;
  const displayForwarderName = firstText(...billGroups.map(g => g.supplier_name), row.forwarder);
  const missingForwarder = !hasText(displayForwarderName);
  for (const g of billGroups) {
    const groupBills = Array.isArray(g.bills) ? g.bills : [];
    const lineForwarderName = firstText(g.supplier_name, row.forwarder);
    const lineForwarderMissing = !hasText(lineForwarderName);
    settlementLines.push(settlementLine({
      sourceType: "shipment",
      counterpartyType: "forwarder",
      direction: "ap",
      ownEntity: row.issuing_company,
      ownEntityCode: g.payer_company_code || null,
      counterpartyName: lineForwarderName,
      counterpartyCode: g.supplier_company_code || null,
      total: g.ap_total,
      paid: g.ap_paid,
      currency: g.currency || row.bill_currency || "CNY",
      refs,
      status: aggregateStatus(groupBills, "ap_status"),
      tone: apTone,
      invoiceStatus: row.ap_invoice || "pending",
      dataMissing: lineForwarderMissing,
      missingReason: lineForwarderMissing ? "缺货代" : null,
    }));
    if ((money(g.ar_total) || 0) > TOLERANCE || (money(g.ar_paid) || 0) > TOLERANCE) {
      settlementLines.push(settlementLine({
        sourceType: "shipment",
        counterpartyType: "customer",
        direction: "ar",
        ownEntity: row.issuing_company,
        ownEntityCode: g.payer_company_code || null,
        counterpartyName: row.customer || "运费承付方",
        counterpartyCode: row.company_code || null,
        total: g.ar_total,
        paid: g.ar_paid,
        currency: g.currency || row.bill_currency || "CNY",
        refs,
        status: aggregateStatus(groupBills, "ar_status"),
        tone: arTone,
      }));
    }
  }
  if (!settlementLines.length) {
    settlementLines.push(settlementLine({
      sourceType: "shipment",
      counterpartyType: "forwarder",
      direction: "ap",
      ownEntity: row.issuing_company,
      counterpartyName: row.forwarder,
      counterpartyCode: row.forwarder_company_id ? String(row.forwarder_company_id) : null,
      total: ap,
      paid: apPaid,
      currency: row.bill_currency || "CNY",
      refs,
      status: "unpaid",
      tone: apTone,
      invoiceStatus: row.ap_invoice || "pending",
      dataMissing: missingForwarder,
      missingReason: missingForwarder ? "缺货代" : null,
    }));
  }
  const r = {
    id: `shipment:${row.shipment_no || row.bl_no || row.id}`,
    type: "shipment",
    parent_order_no: parent,
    is_top_level: !parent,
    shipment_no: row.shipment_no,
    bl_no: row.bl_no,
    order_nos: orderNos,
    title: row.shipment_no || row.bl_no || "未编号CY",
    subtitle: [row.bl_no || "无BL", displayForwarderName || "缺货代", parent ? `挂 ${parent}` : (orderNos.length ? "关联订单未在当前列表" : "纯海运票")].join(" · "),
    currency: row.bill_currency || "CNY",
    owner: "未指派",
    last_action_at: row.updated_at || row.forwarder_price_confirmed_at || row.created_at || null,
    age_days: age,
    age_chip: ageChip(age, due(ap, apPaid) > TOLERANCE || due(ar, arPaid) > TOLERANCE),
    bill_currency_count: Number(row.bill_currency_count || 0),
    freight_confirmed: Boolean(row.forwarder_price_confirmed_at),
    invoice_confirm_status: row.invoice_confirm_status || "none",
    pending_price_review: Boolean(row.pending_price_review),
    confirm_actor: row.confirm_actor || null,
    confirm_at: row.confirm_at || null,
    invoice_confirm_refs: Array.isArray(row.invoice_confirm_refs) ? row.invoice_confirm_refs : [],
    consignee: row.consignee || row.customer || null, // consignee=收货人=shipping_plans.customer(出口货买方)
    shipping: {
      container_no: row.container_no || null,
      shipper: row.shipper || null,
      carrier_code: row.carrier_code || null,
      vessel: row.vessel || null,
      etd: row.etd || null,
      eta: row.eta || null,
      consignee: row.consignee || row.customer || null,
    },
    amounts: { payable: ap, paid: apPaid, payable_due: due(ap, apPaid), receivable: ar, received: arPaid, receivable_due: due(ar, arPaid) },
    settlement_lines: settlementLines,
    data_missing: missingForwarder,
    missing_reason: missingForwarder ? "缺货代" : null,
    factory_side: { payable: ap, paid: apPaid, due: due(ap, apPaid), paid_status: aggregateStatus(billGroups.flatMap(g => Array.isArray(g.bills) ? g.bills : []), "ap_status"), invoice_status: row.ap_invoice || "pending", tone: missingForwarder ? "risk" : apTone },
    customer_side: { receivable: ar, received: arPaid, due: due(ar, arPaid), received_status: aggregateStatus(billGroups.flatMap(g => Array.isArray(g.bills) ? g.bills : []), "ar_status"), tone: arTone },
    signals: { invoice_status: row.ap_invoice || "pending", payable_due: due(ap, apPaid), receivable_due: due(ar, arPaid), customer_slip_uploaded: true, amount_partial: isPartial(ap, apPaid) || isPartial(ar, arPaid) },
  };
  r.tone = worstTone([...settlementLines.map(l => l.tone), apTone, arTone]);
  r.next_action = nextAction(r);
  return r;
}

function sortRows(rows) {
  const toneRank = { risk: 0, todo: 1, stale: 2, done: 3 };
  return rows.sort((a, b) => {
    const aOver = a.age_chip?.tone === "risk" ? 0 : a.age_chip?.tone === "todo" ? 1 : 2;
    const bOver = b.age_chip?.tone === "risk" ? 0 : b.age_chip?.tone === "todo" ? 1 : 2;
    return aOver - bOver || toneRank[a.tone] - toneRank[b.tone] ||
      Math.max(b.amounts?.receivable_due || 0, b.amounts?.payable_due || 0) - Math.max(a.amounts?.receivable_due || 0, a.amounts?.payable_due || 0) ||
      new Date(b.last_action_at || 0) - new Date(a.last_action_at || 0);
  });
}

function buildRows(facts) {
  const orders = (facts.orders || []).map(orderFact);
  const selected = new Set(orders.map(o => o.order_no).filter(Boolean));
  const shipments = (facts.shipments || []).map(s => shipmentFact(s, selected));
  return sortRows([...orders, ...shipments]);
}

function buildSummary(facts) {
  const rows = buildRows(facts);
  const queues = {
    ar_due: { key: "ar_due", label: "今日应收未收", amounts: new Map(), count: 0 },
    ap_due: { key: "ap_due", label: "今日应付未付", amounts: new Map(), count: 0 },
    invoice_pending: { key: "invoice_pending", label: "资料齐待开票", amounts: new Map(), count: 0 },
    slip_pending: { key: "slip_pending", label: "客户水单待认领", amounts: new Map(), count: 0 },
    price_review: { key: "price_review", label: "改价待审", amounts: new Map(), count: 0 },
    risk: { key: "risk", label: "异常待核", amounts: new Map(), count: 0 },
  };
  for (const r of rows) {
    for (const line of r.settlement_lines || []) {
      if (line.direction === "ar" && line.due > TOLERANCE) { queues.ar_due.count++; amountMapAdd(queues.ar_due.amounts, line.currency, line.due); }
      if (line.direction === "ap" && line.due > TOLERANCE) { queues.ap_due.count++; amountMapAdd(queues.ap_due.amounts, line.currency, line.due); }
      if (line.data_missing || line.tone === "risk") { queues.risk.count++; amountMapAdd(queues.risk.amounts, line.currency, line.due || line.total || 0); }
    }
    if (r.type === "order" && r.amounts.receivable_due > TOLERANCE && !r.signals.customer_slip_uploaded) { queues.slip_pending.count++; amountMapAdd(queues.slip_pending.amounts, r.currency, r.amounts.receivable_due); }
    if (r.type === "shipment" && r.pending_price_review) queues.price_review.count++;
  }
  for (const d of facts.invoice_drafts || []) {
    if (d.status === "pending") { queues.invoice_pending.count++; amountMapAdd(queues.invoice_pending.amounts, d.currency || "CNY", d.amount_invoice ?? d.amount_declared ?? d.amount_order); }
  }
  for (const e of facts.exceptions || []) {
    queues.risk.count++;
    amountMapAdd(queues.risk.amounts, e.currency || "CNY", Math.abs(money(e.diff_amount) || money(e.expected_amount) || 0));
  }
  return Object.values(queues).map(q => ({ ...q, amounts: amountList(q.amounts) }));
}

async function handleBoard(req, res) {
  const facts = await fetchFacts(getPool(), { q: String(req.query?.q || "").trim(), limit: parseLimit(req.query?.limit) });
  const rows = buildRows(facts);
  return res.json({ success: true, rows, orders: rows.filter(r => r.type === "order"), shipments: rows.filter(r => r.type === "shipment"), unclassified_payments_count: Number(facts.unclassified_payments_count || 0) });
}

async function handleSummary(req, res) {
  const facts = await fetchFacts(getPool(), { q: "", limit: 10000 });
  return res.json({ success: true, summary: { queues: buildSummary(facts), generated_at: new Date().toISOString() } });
}

async function handleReviewPrice(req, res) {
  const result = await reviewPriceOverride(getPool(), req);
  return json(res, result.status, result.payload);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    if (!requireAuth(req, res)) return;
    if (!FINANCE_ROLES.has(req.user?.role)) return json(res, 403, { error: "Forbidden", message: "仅财务/管理员可访问" });
    const action = String(req.query?.action || "board").trim();
    if (req.method === "GET" && action === "board") return handleBoard(req, res);
    if (req.method === "GET" && action === "summary") return handleSummary(req, res);
    if (req.method === "POST" && action === "review-price") return handleReviewPrice(req, res);
    if (!["GET", "POST"].includes(req.method)) return json(res, 405, { error: "Method not allowed" });
    return json(res, 404, { error: "unknown action" });
  } catch (err) {
    console.error("[recon-board]", err);
    return json(res, 500, { error: "Internal server error", detail: err.message });
  }
}
