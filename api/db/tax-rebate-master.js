// 退税主表 · 以报关单为准（只读）
// 铁律：逐项 HS/品名/数量/净重/金额/税率 一律取自 customs_declaration_items（海关报关单），
//       禁用 order_line_items(OLI)。工厂/PO 仅作归属标注，来自 orders，不参与任何计算。
//       退税率只有 9%(HS 2309*) 与 13%；任一行算不出，整票 est_rebate 返回 null，不给半截数。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export async function loadTaxRebateMaster(pool, q = {}) {
  const from = String(q.from || "2026-01-01").trim();
  const sql = `
WITH decl AS (
  SELECT f.customs_no, f.export_date, f.contract_no, f.fob_cny,
    COALESCE(f.rebate_lifecycle_status, f.status) AS status,
    f.raw->'tax_declare'->>'batch' AS batch, cd.id AS decl_id,
    COALESCE(NULLIF(array_to_string(cd.container_nos, '/'), ''),
             NULLIF(replace(sp.container_no, ',', '/'), '')) AS containers,
    sp.container_qty, sp.container_type,
    sp.bl_no, sp.mbl_no, sp.hbl_no, sp.so_no, sp.vessel, sp.voyage,
    to_char(sp.etd, 'YYYY-MM-DD') AS etd
  FROM finance_export_rebates f
  LEFT JOIN customs_declarations cd ON cd.declaration_no = f.customs_no
  LEFT JOIN shipping_plans sp ON sp._id = cd.shipping_plan_id
  WHERE f.export_date >= $1
),
line AS (
  SELECT d.customs_no, ci.sort_order AS item_no, ci.hs_code,
    ci.declaration_name_cn AS name, ci.qty, ci.unit,
    ci.net_weight_kg AS nw, ci.declaration_amount AS amt,
    CASE WHEN ci.hs_code LIKE '2309%' THEN 0.09
         WHEN ci.hs_code IS NULL OR ci.hs_code = '' THEN NULL
         ELSE 0.13 END AS rate,
    (SELECT rim.invoice_no FROM finance_rebate_inv_map rim
      WHERE rim.customs_no = d.customs_no
        AND rim.declaration_name = ci.declaration_name_cn LIMIT 1) AS invoice_no
  FROM decl d
  JOIN customs_declaration_items ci
    ON ci.declaration_id = d.decl_id AND ci.deleted_at IS NULL
),
agg AS (
  SELECT customs_no, count(*) AS n,
    count(*) FILTER (WHERE rate IS NULL OR amt IS NULL) AS bad,
    count(*) FILTER (WHERE nw IS NULL) AS no_nw,
    round(sum(amt), 2) AS line_amt_sum,
    CASE WHEN count(*) FILTER (WHERE rate IS NULL OR amt IS NULL) > 0 THEN NULL
         ELSE round(sum(amt * rate), 2) END AS est_rebate,
    json_agg(json_build_object(
      'item_no', item_no, 'hs', hs_code, 'name', name, 'qty', qty, 'unit', unit,
      'nw', nw, 'amt', amt, 'rate', rate, 'invoice_no', invoice_no,
      'line_rebate', CASE WHEN rate IS NOT NULL AND amt IS NOT NULL
                          THEN round(amt * rate, 2) END
    ) ORDER BY item_no) AS items
  FROM line GROUP BY customs_no
)
SELECT d.customs_no, to_char(d.export_date,'YYYY-MM-DD') AS export_date,
  d.status, d.batch, d.contract_no, d.containers, d.container_qty, d.container_type,
  d.bl_no, d.mbl_no, d.hbl_no, d.so_no, d.vessel, d.voyage, d.etd,
  d.fob_cny, COALESCE(a.n, 0) AS item_count, COALESCE(a.bad, 0) AS bad_lines,
  a.est_rebate, a.no_nw, a.line_amt_sum,
  -- 数据等级：报关单级 = 逐项都有净重 且 逐项金额合计与报关额吻合；否则是模版/预估，不能当退税依据
  CASE WHEN a.n IS NULL THEN 'none'
       WHEN COALESCE(a.no_nw,0) = 0 AND a.line_amt_sum IS NOT NULL
            AND abs(a.line_amt_sum - d.fob_cny) < 0.01 THEN 'customs'
       ELSE 'template' END AS data_grade,
  COALESCE(a.items, '[]'::json) AS items,
  (SELECT string_agg(DISTINCT o.order_no, '/') FROM orders o
     WHERE d.contract_no LIKE '%'||o.contract_no||'%' AND o.contract_no <> '') AS order_nos,
  (SELECT string_agg(DISTINCT o.factory, '/') FROM orders o
     WHERE d.contract_no LIKE '%'||o.contract_no||'%' AND o.contract_no <> '') AS factories,
  (SELECT string_agg(i.invoice_no, ',' ORDER BY i.issue_date) FROM finance_invoices_in i
     WHERE i.customs_nos @> ARRAY[d.customs_no]::varchar[]) AS invoices
FROM decl d LEFT JOIN agg a ON a.customs_no = d.customs_no
ORDER BY d.export_date DESC, d.customs_no`;
  const r = await pool.query(sql, [from]);
  return r.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const rows = await loadTaxRebateMaster(getPool(), req.query);
    res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
