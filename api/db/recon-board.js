import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import {
  TOLERANCE, STALE_CUTOFF, money, parseLimit, ageDays, due, isDone, isPartial, statusOf,
  hasText, relationTypeLabel, relationTitle, settlementLine, aggregateStatus, baseTone,
  worstTone, ageChip, nextAction, amountMapAdd, amountList,
} from "./recon-board-helpers.js";
import { reviewPriceOverride } from "./recon-board-invoice-confirm.js";
import { buildBoardSql } from "./recon-board-sql.js";
import { linePayments } from "./recon-board-line-payments.js";

const FINANCE_ROLES = new Set(["admin", "finance"]);

function json(res, status, payload) {
  return res.status(status).json(payload);
}

async function fetchFacts(pool, { q = "", limit = 500 } = {}) {
  const like = `%${q}%`;
  const args = q ? [like, limit] : [limit];
  const orderFilter = q ? `
    AND (o.order_no ILIKE $1 OR o.contract_no ILIKE $1 OR o.customer ILIKE $1
      -- 客户汇款单上写的常是 PO 号或提单号,不是我方合同号;也允许按水单挂链上的号反查到订单
      OR o.customer_po ILIKE $1 OR o.bl_no ILIKE $1 OR o.pi_no ILIKE $1 OR o.sc_no ILIKE $1
      OR EXISTS (SELECT 1 FROM bank_slip_links bl2
                  WHERE (bl2.order_no = o.order_no OR (o.contract_no IS NOT NULL AND bl2.contract_no = o.contract_no))
                    AND (bl2.contract_no ILIKE $1 OR bl2.order_no ILIKE $1)))` : "";
  const shipmentFilter = q ? `
    AND (sp.shipment_no ILIKE $1 OR sp.bl_no ILIKE $1 OR sp.forwarder_cn ILIKE $1
      OR EXISTS (SELECT 1 FROM selected_orders so WHERE so.order_no = ANY(COALESCE(sp.order_nos, '{}'::text[]))))` : "";
  const sql = buildBoardSql({ orderFilter, shipmentFilter, argsLen: args.length });
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
    order_date: row.order_date || null,
    delivery_date: row.confirmed_delivery || row.delivery_date || null,
    // 三价并列:采购(付工厂) / 报关(申报额,拼接号已按销售额占比拆到单) / 销售(收客户)
    price_buy: money(row.price_buy),
    price_declared: anchored ? money(row.price_declared) : null,   // 无报关锚 → null(前端显"缺"而非0)
    price_sale: money(row.price_sale),
    anchor_from_declaration: Boolean(row.anchor_from_declaration), // true=来自报关单主表而非退税表
    // 退税:平价转卖(采购=销售)时利润全在退税(Damon 2026-08-05)。真实毛利 = 货款毛利 + 退税额。
    rebate: {
      rate: row.rebate_rate == null ? null : Number(row.rebate_rate),
      expected: money(row.rebate_amt),
      received: money(row.rebate_received) || 0,
      status: row.rebate_status || null,
    },
    slip: {
      alloc: money(row.slip_alloc),                 // 客户汇入水单已认领金额
      ap_alloc: money(row.slip_ap_alloc),           // ⚠ 我方付出去的水单被挂到本单(方向错挂),不算已收
      receipt_count: Number(row.receipt_count || 0),// 有回单文件的份数
      currency: row.slip_currency || arCurrency,
      file_url: row.slip_file_url || null,
      direction_warn: money(row.slip_ap_alloc) > 1,
    },
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
  const feeGroups = Array.isArray(row.fee_groups) ? row.fee_groups : [];
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
    fees: feeGroups.map(f => { const a = money(f.amount), p = money(f.paid) || 0; return { fee_class: f.fee_class, currency: f.currency, amount: a, paid: p, due: due(a, p), status: statusOf(a, p), bill_count: f.bill_count }; }),
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
    if (req.method === "GET" && action === "line-payments") return res.json(await linePayments(getPool(), req.query || {}));
    if (req.method === "POST" && action === "review-price") return handleReviewPrice(req, res);
    if (!["GET", "POST"].includes(req.method)) return json(res, 405, { error: "Method not allowed" });
    return json(res, 404, { error: "unknown action" });
  } catch (err) {
    console.error("[recon-board]", err);
    return json(res, 500, { error: "Internal server error", detail: err.message });
  }
}
