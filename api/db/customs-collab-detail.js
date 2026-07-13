// api/db/customs-collab-detail.js — customs detail + invoice-template builder
// split out of customs-collab.js (2026-07-14, ≤500-line rule).
import { getPool } from "../db.js";
import { cleanString } from "./factory-portal-utils.js";
import { money, ensureCustomsStatus, uploadedForCustoms } from "./customs-collab-status.js";
import { factorySpread, loadCustomsItems, invoiceLinesFromItems } from "./customs-collab-docs.js";
import { resolveFactory, requireFinance, failClosed, assertFactoryCustoms, fileUrl, json } from "./customs-collab-shared.js";

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
    const effective = money(st.manual_expected_amount) ?? money(st.system_expected_amount);

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
      ? rawItems.map((x) => ({ name_cn: x.name_cn || x.name || null, qty1: x.qty1 || null, qty2: x.qty2 || null }))
      : rawItems;

    let invoiceTemplate;
    if (factoryMode) {
      const contractNo = st.contract_no || row.contract_no || null;
      let orderResult = contractNo
        ? await client.query(
            `SELECT id, order_no, contract_no, issuing_company, company_code, customer_po
               FROM orders
              WHERE contract_no=$1
                AND COALESCE(status,'') <> 'cancelled'
              ORDER BY id DESC
              LIMIT 1`,
            [contractNo]
          )
        : { rows: [] };
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
      const anchoredTpl = invoiceLinesFromItems(ciTpl.items, sellerRow, spread.length > 1);
      const lineResult = !anchoredTpl.anchored && orderIds.length
        ? await client.query(
            `SELECT
                COALESCE(NULLIF(BTRIM(oli.declaration_name), ''),
                         NULLIF(BTRIM(oli.product_name), ''),
                         NULLIF(BTRIM(p.declaration_name), ''),
                         NULLIF(BTRIM(p.product_name), '')) AS name,
                COALESCE(NULLIF(BTRIM(p.spec), ''), NULLIF(BTRIM(oli.size), '')) AS spec,
                COALESCE(NULLIF(BTRIM(p.transaction_unit), ''), NULLIF($2, ''), NULLIF(BTRIM(oli.unit), ''), '箱') AS unit,
                ROUND(SUM(COALESCE(oli.qty_ctn, 0))::numeric, 2) AS qty,
                ROUND(COALESCE(NULLIF(SUM(oli.factory_subtotal),0), NULLIF(SUM(oli.qty_ctn*oli.bg_bx*p.factory_price),0), NULLIF(SUM(oli.qty_ctn*p.factory_price),0), 0)::numeric, 2) AS amount,
                CASE
                  WHEN COALESCE(NULLIF(BTRIM(oli.hs_code), ''), NULLIF(BTRIM(p.hs_code), '')) LIKE '2309%' THEN 0.09
                  ELSE 0.13
                END AS vat_rate
               FROM order_line_items oli
               LEFT JOIN products p ON p.id=oli.product_id
              WHERE oli.order_id = ANY($1::int[])
              GROUP BY
                COALESCE(NULLIF(BTRIM(oli.declaration_name), ''),
                         NULLIF(BTRIM(oli.product_name), ''),
                         NULLIF(BTRIM(p.declaration_name), ''),
                         NULLIF(BTRIM(p.product_name), '')),
                COALESCE(NULLIF(BTRIM(p.spec), ''), NULLIF(BTRIM(oli.size), '')),
                COALESCE(NULLIF(BTRIM(p.transaction_unit), ''), NULLIF($2, ''), NULLIF(BTRIM(oli.unit), ''), '箱'),
                CASE
                  WHEN COALESCE(NULLIF(BTRIM(oli.hs_code), ''), NULLIF(BTRIM(p.hs_code), '')) LIKE '2309%' THEN 0.09
                  ELSE 0.13
                END
              ORDER BY MIN(oli.sort_order) NULLS LAST, MIN(oli.id)`,
            [orderIds, rawUnit]
          )
        : { rows: [] };

      const unitMap = { CTN: "箱", PCS: "件", KG: "千克", BAG: "包", SET: "套" };
      const lines = anchoredTpl.anchored ? anchoredTpl.lines : lineResult.rows.map((l) => ({ name: l.name || null, spec: l.spec || null,
        unit: unitMap[String(l.unit || "").toUpperCase()] || l.unit || "箱", qty: money(l.qty) || 0,
        amount: money(l.amount) || 0, unit_price_ex: money(l.qty) ? money((Number(l.amount) || 0) / Number(l.qty)) : null,
        vat_rate: Number(l.vat_rate) || 0.13 }));
      // 价税合计口径与报关申报总额比;+1元容差吸收税前换算的分位进位差
      const linesTotal = lines.reduce((sum, l) => sum + (Number(l.amount) || 0) * (1 + (Number(l.vat_rate) || 0)), 0);
      const baoguanAmount = money(row.fob_cny);

      invoiceTemplate = { buyer, seller, lines, order_no: mergedOrderNos || order?.order_no || null,
        po_no: order?.customer_po || null, factory_ref: order?.contract_no || null, baoguan_amount: baoguanAmount,
        lines_anchored: anchoredTpl.anchored, over_baoguan: baoguanAmount !== null && linesTotal > baoguanAmount + 1,
        total_incl: money(linesTotal) || effective || null };
      delete invoiceTemplate.baoguan_amount;
    }

    return res.json({
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
        effective_expected_amount: effective,
        uploaded_amount: up.uploaded_amount,
        valid_invoice_count: up.valid_invoice_count,
        diff_amount: effective === null ? null : money(effective - up.uploaded_amount),
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
    });
  } catch (e) {
    return json(res, e.status || 500, { error: e.message });
  } finally {
    client.release();
  }
}

export { handleDetail };
