// api/db/customs-collab-detail.js — customs detail + invoice-template builder
// split out of customs-collab.js (2026-07-14, ≤500-line rule).
import { getPool } from "../db.js";
import { cleanString } from "./factory-portal-utils.js";
import { money, ensureCustomsStatus, uploadedForCustoms } from "./customs-collab-status.js";
import { factorySpread, loadCustomsItems, factoryGoodsLinesFromItems } from "./customs-collab-docs.js";
import { resolveFactory, requireFinance, failClosed, assertFactoryCustoms, fileUrl, json } from "./customs-collab-shared.js";
import { scrubFactoryCustomsPayload } from "./lib/collab-field-profiles.js";

async function handleDetail(req, res) {
  const pool = getPool();
  const factoryMode = !!cleanString(req.query?.c || req.query?.mt);
  let scope = null;
  if (factoryMode) {
    scope = await resolveFactory(req, pool);
    if (!scope) return failClosed(res);
  } else if (!requireFinance(req, res)) {
    return;
  }

  const customsNo = cleanString(req.query.customs_no);
  const requestedFactoryCode = factoryMode ? null : cleanString(req.query.factory_code) || null;
  if (!customsNo) return json(res, 400, { error: "customs_no required" });

  const client = await pool.connect();
  try {
    const st = factoryMode ? await assertFactoryCustoms(client, scope.factory.code, customsNo) : await ensureCustomsStatus(client, customsNo, requestedFactoryCode);
    const up = await uploadedForCustoms(client, customsNo, st.factory_code);
    const effective = factoryMode ? null : (money(st.manual_expected_amount) ?? null);  // 工厂侧不回读内部/报关派生应开金额

    const fer = await client.query(
      `SELECT fer.customs_no, fer.contract_no, MIN(fer.export_date) AS export_date,
              MAX(fer.fob_cny) AS fob_cny,
              jsonb_agg(item ORDER BY ord) FILTER (WHERE item IS NOT NULL) AS items
         FROM finance_export_rebates fer
         LEFT JOIN LATERAL jsonb_array_elements(
           CASE WHEN jsonb_typeof(fer.raw->'items')='array' THEN fer.raw->'items' ELSE '[]'::jsonb END
         ) WITH ORDINALITY AS x(item, ord) ON true
        WHERE fer.customs_no=$1
        GROUP BY fer.customs_no, fer.contract_no`,
      [customsNo]
    );

    // 一票多厂防跳单: 详情里的发票/事件只给本厂行的(NULL厂码历史链保持可见,存量已回填)
    const inv = await client.query(
      `SELECT fii.id, fii.invoice_no, fii.issue_date, fii.amount_incl_tax,
              fii.review_status, l.link_status, fii.attachments
         FROM invoice_customs_links l
         JOIN finance_invoices_in fii ON fii.id=l.invoice_id
        WHERE l.customs_no=$1
          AND ($2::text IS NULL OR l.factory_code=$2 OR l.factory_code IS NULL)
        ORDER BY fii.issue_date DESC NULLS LAST, fii.id DESC`,
      [customsNo, st.factory_code]
    );

    const ev = await client.query(
      `SELECT id, invoice_id, invoice_no, customs_no, factory_code, event_type,
              old_status, new_status, amount_incl_tax, reason, payload,
              created_by, actor_role, created_at
         FROM invoice_events
        WHERE customs_no=$1
          AND ($2::text IS NULL OR factory_code=$2 OR factory_code IS NULL)
        ORDER BY created_at ASC, id ASC`,
      [customsNo, st.factory_code]
    );

    const row = fer.rows[0] || {};
    const rawItems = Array.isArray(row.items) ? row.items : [];
    const items = factoryMode
      ? factoryGoodsLinesFromItems(rawItems, null, false).lines
      : rawItems;

    let invoiceTemplate;
    if (factoryMode) {
      const contractNo = st.contract_no || row.contract_no || null;
      let orderResult = contractNo
        ? await client.query(
            /* 🩸 0814：台账 contract_no 常是多合同拼串
               （660860 = 'CP26031606-2/FS20260603076'），全等匹配认不到订单 →
               order 为 null → 买方那段被 if(order) 整个跳过 → 开票模板「购买方信息」空白。
               跟 customs-collab-status.js 的 404 是同一个病根，这里也补 LIKE 兜底。
               排序让全等优先，避免多合同时挑错单。 */
            `SELECT id, order_no, contract_no, issuing_company, company_code, customer_po
               FROM orders
              WHERE COALESCE(contract_no,'') <> ''
                AND ($1 = contract_no OR $1 LIKE '%'||contract_no||'%')
                AND COALESCE(status,'') <> 'cancelled'
              ORDER BY ($1 = contract_no) DESC, id DESC
              LIMIT 1`,
            [contractNo]
          )
        : { rows: [] };
      if (!orderResult.rows[0]) {
        /* 🩸 0814 补上最权威的一条路：台账 raw.order_nos。
           802335/802346 的台账合同号是 CP26052851，而订单 40-CP-6/40-CP-7 的合同号是
           FS20260625907 —— 合同号根本对不上，真正的关联在 raw.order_nos 里。
           系统别处（退税主表证据链、协同 fer_base）早就用这条，只有这里漏了，
           导致 order=null → 买方信息空白。
           工厂模式下再按工厂收窄，避免一票多厂时认到别家的订单。 */
        orderResult = await client.query(
          `SELECT o.id, o.order_no, o.contract_no, o.issuing_company, o.company_code, o.customer_po
             FROM orders o
             JOIN finance_export_rebates f ON f.customs_no = $1
            WHERE COALESCE(o.status,'') <> 'cancelled'
              AND o.order_no = ANY(ARRAY(SELECT jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(f.raw->'order_nos')='array'
                         THEN f.raw->'order_nos' ELSE '[]'::jsonb END)))
              AND ($2::text IS NULL OR COALESCE(o.factory_code,
                    (SELECT code FROM companies WHERE id=o.factory_company_id)) = $2)
            ORDER BY o.id DESC
            LIMIT 1`,
          [customsNo, factoryMode ? scope.factory.code : null]
        );
      }
      if (!orderResult.rows[0]) {
        orderResult = await client.query(
          `SELECT id, order_no, contract_no, issuing_company, company_code, customer_po
             FROM orders
            WHERE order_no=$1
              AND COALESCE(status,'') <> 'cancelled'
            ORDER BY id DESC
            LIMIT 1`,
          [customsNo]
        );
      }
      if (!orderResult.rows[0]) {
        orderResult = await client.query(
          `SELECT id, order_no, contract_no, issuing_company, company_code, customer_po
             FROM orders
            WHERE bl_no=$1
              AND COALESCE(status,'') <> 'cancelled'
            ORDER BY id DESC
            LIMIT 1`,
          [customsNo]
        );
      }
      const order = orderResult.rows[0] || null;

      // 合并报关单: 该报关单/BL下同工厂的全部订单(合并开票,产品全列)
      let orderIds = order?.id ? [order.id] : [];
      let mergedOrderNos = order?.order_no || null;
      if (order) {
        const grpR = await client.query(
          `SELECT array_agg(o.id) AS ids, string_agg(o.order_no, ',' ORDER BY o.order_no) AS order_nos
             FROM orders o
            WHERE COALESCE(o.status,'') <> 'cancelled'
              AND (o.bl_no=$1 OR o.order_no=$1 OR o.contract_no=$2)
              AND ($3::text IS NULL OR COALESCE(o.factory_code,
                    (SELECT code FROM companies WHERE id=o.factory_company_id)) = $3)`,
          [customsNo, order.contract_no, factoryMode ? scope.factory.code : null]
        );
        if (grpR.rows[0]?.ids?.length) {
          orderIds = grpR.rows[0].ids;
          mergedOrderNos = grpR.rows[0].order_nos;
        }
      }

      let buyer = { name: null, tax_id: null };
      if (order) {
        const buyerKey = cleanString(order.issuing_company);
        const companyCode = cleanString(order.company_code);
        const buyerResult = await client.query(
          `SELECT name_cn, tax_id
             FROM companies
            WHERE ($1 <> '' AND (code=$1 OR name_cn=$1))
               OR ($2 <> '' AND code=$2)
            ORDER BY CASE
              WHEN $1 <> '' AND name_cn=$1 THEN 0
              WHEN $1 <> '' AND code=$1 THEN 1
              WHEN $2 <> '' AND code=$2 THEN 2
              ELSE 9
            END, id ASC
            LIMIT 1`,
          [buyerKey, companyCode]
        );
        const b = buyerResult.rows[0];
        buyer = { name: b?.name_cn || buyerKey || null, tax_id: b?.tax_id || null };
      }

      const sellerResult = await client.query(
        `SELECT name_cn, factory_name, tax_id, address, bank_name, bank_account, province
           FROM companies
          WHERE code=$1
          LIMIT 1`,
        [st.factory_code]
      );
      const sellerRow = sellerResult.rows[0] || {};
      const seller = { name: sellerRow.name_cn || scope.factory.name || null, tax_id: sellerRow.tax_id || null, bank_name: sellerRow.bank_name || null, bank_account: sellerRow.bank_account || null };

      const rawUnit = rawItems.find((x) => x?.unit2 || x?.transaction_unit || x?.unit)?.unit2
        || rawItems.find((x) => x?.unit2 || x?.transaction_unit || x?.unit)?.transaction_unit
        || rawItems.find((x) => x?.unit2 || x?.transaction_unit || x?.unit)?.unit
        || null;

      const isDg = /-DG-/i.test(mergedOrderNos || order?.order_no || "");
      const spread = await factorySpread(client, customsNo, st.contract_no || row.contract_no || order?.contract_no);
      const ciTpl = await loadCustomsItems(client, customsNo);
      const anchoredTpl = factoryGoodsLinesFromItems(ciTpl.items, sellerRow, spread.length > 1);
      const anchorResult = orderIds.length
        ? await client.query(
            `SELECT ROUND(COALESCE(NULLIF(SUM(oli.factory_subtotal),0),
                           NULLIF(SUM(oli.qty_ctn*oli.bg_bx*p.factory_price),0),
                           NULLIF(SUM(oli.qty_ctn*p.factory_price),0))::numeric,2) AS factory_expected_amount
               FROM order_line_items oli
               LEFT JOIN products p ON p.id=oli.product_id
              WHERE oli.order_id = ANY($1::int[])`,
            [orderIds]
          )
        : { rows: [] };
      const factoryExpectedAmount = money(anchorResult.rows[0]?.factory_expected_amount);

      invoiceTemplate = { buyer, seller, lines: anchoredTpl.lines, order_no: mergedOrderNos || order?.order_no || null,
        po_no: order?.customer_po || null, factory_ref: order?.contract_no || null,
        factory_expected_amount: factoryExpectedAmount, needs_internal_fill: factoryExpectedAmount === null,
        lines_anchored: anchoredTpl.anchored, needs_customs_import: !anchoredTpl.anchored };
    }

    const payload = {
      success: true,
      factory: factoryMode ? scope.factory : undefined,
      customs: {
        customs_no: factoryMode ? undefined : customsNo,
        contract_no: st.contract_no || row.contract_no || null,
        export_date: row.export_date || null,
        factory_code: st.factory_code,
        status: st.status,
        system_expected_amount: factoryMode ? undefined : money(st.system_expected_amount),
        manual_expected_amount: factoryMode ? undefined : money(st.manual_expected_amount),
        effective_expected_amount: factoryMode ? undefined : effective,
        factory_expected_amount: factoryMode ? invoiceTemplate?.factory_expected_amount : undefined,
        needs_internal_fill: factoryMode ? invoiceTemplate?.needs_internal_fill : undefined,
        uploaded_amount: up.uploaded_amount,
        valid_invoice_count: up.valid_invoice_count,
        diff_amount: factoryMode || effective === null ? undefined : money(effective - up.uploaded_amount),
      },
      items,
      invoice_template: invoiceTemplate,
      invoices: inv.rows.map((r) => ({
        id: r.id,
        invoice_no: r.invoice_no,
        issue_date: r.issue_date,
        amount_incl_tax: money(r.amount_incl_tax),
        review_status: r.review_status,
        link_status: r.link_status,
        file_url: fileUrl(r),
      })),
      events: ev.rows,
    };
    return res.json(factoryMode ? scrubFactoryCustomsPayload(payload) : payload);
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  } finally {
    client.release();
  }
}

export { handleDetail };
