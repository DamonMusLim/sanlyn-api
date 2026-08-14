import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function clean(v) { return String(v ?? "").trim(); }

export async function loadReconSupplier(pool, q = {}) {
  const supplier = clean(q.supplier);
  const year = clean(q.year);
  if (!supplier) throw new Error("supplier required");

  const args = [supplier];
  let billYearSql = "";
  let flowYearSql = "";
  if (year) {
    args.push(year);
    billYearSql = `AND LEFT(b.bill_month, 4) = $2`;
    flowYearSql = `AND EXTRACT(YEAR FROM bf.tx_date)::text = $2`;
  }

  const sql = `
WITH supplier_master AS (
  SELECT DISTINCT BTRIM(supplier) AS supplier
    FROM freight_supplier_bills
   WHERE NULLIF(BTRIM(supplier), '') IS NOT NULL
     AND COALESCE(rebill_status, '') NOT IN ('voided', 'absorbed')
),
target_suppliers AS (
  SELECT supplier FROM supplier_master WHERE supplier ILIKE '%' || $1 || '%'
),
bills AS (
  SELECT b.supplier,
         b.bill_month AS ym,
         CASE WHEN UPPER(BTRIM(COALESCE(b.currency_norm, b.currency, 'CNY'))) = 'RMB' THEN 'CNY'
              ELSE UPPER(BTRIM(COALESCE(b.currency_norm, b.currency, 'CNY'))) END AS currency,
         SUM(COALESCE(b.amount, 0)) AS amount
    FROM freight_supplier_bills b
    JOIN target_suppliers ts ON ts.supplier = BTRIM(b.supplier)
   WHERE COALESCE(b.rebill_status, '') NOT IN ('voided', 'absorbed')
     AND NULLIF(BTRIM(b.bill_month), '') IS NOT NULL
     ${billYearSql}
   GROUP BY b.supplier, b.bill_month,
            CASE WHEN UPPER(BTRIM(COALESCE(b.currency_norm, b.currency, 'CNY'))) = 'RMB' THEN 'CNY'
                 ELSE UPPER(BTRIM(COALESCE(b.currency_norm, b.currency, 'CNY'))) END
),
flow_base AS (
  SELECT bf.entity_code,
         BTRIM(bf.counterparty_name) AS counterparty_name,
         TO_CHAR(bf.tx_date, 'YYYY-MM') AS ym,
         CASE WHEN UPPER(BTRIM(COALESCE(bf.currency, 'CNY'))) = 'RMB' THEN 'CNY'
              ELSE UPPER(BTRIM(COALESCE(bf.currency, 'CNY'))) END AS currency,
         SUM(COALESCE(bf.amount, 0)) AS amount
    FROM bank_flows bf
   WHERE bf.entity_code IN ('babi', 'oceanbaby')
     AND bf.direction = 'out'
     AND NULLIF(BTRIM(bf.counterparty_name), '') IS NOT NULL
     ${flowYearSql}
   GROUP BY bf.entity_code, BTRIM(bf.counterparty_name), TO_CHAR(bf.tx_date, 'YYYY-MM'),
            CASE WHEN UPPER(BTRIM(COALESCE(bf.currency, 'CNY'))) = 'RMB' THEN 'CNY'
                 ELSE UPPER(BTRIM(COALESCE(bf.currency, 'CNY'))) END
),
exact_candidates AS (
  SELECT f.counterparty_name, sm.supplier AS matched_supplier
    FROM (SELECT DISTINCT counterparty_name FROM flow_base) f
    JOIN supplier_master sm ON sm.supplier = f.counterparty_name
),
exact_counts AS (
  SELECT counterparty_name, COUNT(*) AS n, MAX(matched_supplier) AS matched_supplier
    FROM exact_candidates
   GROUP BY counterparty_name
),
fuzzy_candidates AS (
  SELECT f.counterparty_name, sm.supplier AS matched_supplier
    FROM (SELECT DISTINCT counterparty_name FROM flow_base) f
    JOIN supplier_master sm ON f.counterparty_name LIKE '%' || LEFT(sm.supplier, 8) || '%'
                            OR sm.supplier LIKE '%' || LEFT(f.counterparty_name, 8) || '%'
   WHERE NOT EXISTS (SELECT 1 FROM exact_candidates e WHERE e.counterparty_name = f.counterparty_name)
),
fuzzy_counts AS (
  SELECT counterparty_name, COUNT(*) AS n, MAX(matched_supplier) AS matched_supplier
    FROM fuzzy_candidates
   GROUP BY counterparty_name
),
resolved_flows AS (
  SELECT f.entity_code, f.counterparty_name, f.ym, f.currency, f.amount,
         CASE WHEN e.n = 1 THEN e.matched_supplier ELSE '待映射' END AS supplier,
         CASE WHEN e.n = 1 THEN false ELSE true END AS unmatched
    FROM flow_base f
    JOIN exact_counts e ON e.counterparty_name = f.counterparty_name
  UNION ALL
  SELECT f.entity_code, f.counterparty_name, f.ym, f.currency, f.amount,
         CASE WHEN m.n = 1 THEN m.matched_supplier ELSE '待映射' END AS supplier,
         CASE WHEN m.n = 1 THEN false ELSE true END AS unmatched
    FROM flow_base f
    JOIN fuzzy_counts m ON m.counterparty_name = f.counterparty_name
  UNION ALL
  SELECT f.entity_code, f.counterparty_name, f.ym, f.currency, f.amount, '待映射' AS supplier, true AS unmatched
    FROM flow_base f
   WHERE NOT EXISTS (SELECT 1 FROM exact_counts e WHERE e.counterparty_name = f.counterparty_name)
     AND NOT EXISTS (SELECT 1 FROM fuzzy_counts m WHERE m.counterparty_name = f.counterparty_name)
),
paid AS (
  SELECT rf.supplier, rf.ym, rf.currency, rf.entity_code, rf.unmatched,
         STRING_AGG(DISTINCT rf.counterparty_name, ' / ' ORDER BY rf.counterparty_name) AS counterparty_names,
         SUM(rf.amount) AS amount
    FROM resolved_flows rf
   WHERE rf.supplier IN (SELECT supplier FROM target_suppliers) OR rf.unmatched
   GROUP BY rf.supplier, rf.ym, rf.currency, rf.entity_code, rf.unmatched
),
keys AS (
  SELECT supplier, ym FROM bills
  UNION
  SELECT supplier, ym FROM paid
),
bill_pivot AS (
  SELECT supplier, ym,
         SUM(amount) FILTER (WHERE currency = 'CNY') AS bill_cny,
         SUM(amount) FILTER (WHERE currency = 'USD') AS bill_usd
    FROM bills
   GROUP BY supplier, ym
),
paid_pivot AS (
  SELECT supplier, ym,
         SUM(amount) FILTER (WHERE currency = 'CNY' AND entity_code = 'babi') AS paid_babi_cny,
         SUM(amount) FILTER (WHERE currency = 'USD' AND entity_code = 'babi') AS paid_babi_usd,
         SUM(amount) FILTER (WHERE currency = 'CNY' AND entity_code = 'oceanbaby') AS paid_ocean_cny,
         SUM(amount) FILTER (WHERE currency = 'USD' AND entity_code = 'oceanbaby') AS paid_ocean_usd,
         BOOL_OR(COALESCE(unmatched, false)) AS unmatched,
         STRING_AGG(DISTINCT counterparty_names, ' / ' ORDER BY counterparty_names) FILTER (WHERE counterparty_names IS NOT NULL) AS counterparty_names
    FROM paid
   GROUP BY supplier, ym
),
joined AS (
  SELECT k.supplier, k.ym,
         b.bill_cny, b.bill_usd,
         p.paid_babi_cny, p.paid_babi_usd, p.paid_ocean_cny, p.paid_ocean_usd,
         COALESCE(p.unmatched, false) AS unmatched,
         p.counterparty_names
    FROM keys k
    LEFT JOIN bill_pivot b ON b.supplier = k.supplier AND b.ym = k.ym
    LEFT JOIN paid_pivot p ON p.supplier = k.supplier AND p.ym = k.ym
),
out_rows AS (
  SELECT supplier, ym,
         ROUND(COALESCE(bill_cny, 0)::numeric, 2) AS bill_cny,
         ROUND(COALESCE(bill_usd, 0)::numeric, 2) AS bill_usd,
         ROUND(COALESCE(paid_babi_cny, 0)::numeric, 2) AS paid_babi_cny,
         ROUND(COALESCE(paid_babi_usd, 0)::numeric, 2) AS paid_babi_usd,
         ROUND(COALESCE(paid_ocean_cny, 0)::numeric, 2) AS paid_ocean_cny,
         ROUND(COALESCE(paid_ocean_usd, 0)::numeric, 2) AS paid_ocean_usd,
         ROUND((COALESCE(bill_cny, 0) - COALESCE(paid_babi_cny, 0) - COALESCE(paid_ocean_cny, 0))::numeric, 2) AS gap_cny,
         ROUND((COALESCE(bill_usd, 0) - COALESCE(paid_babi_usd, 0) - COALESCE(paid_ocean_usd, 0))::numeric, 2) AS gap_usd,
         unmatched,
         counterparty_names
    FROM joined
),
final_rows AS (
  SELECT 0 AS sort_key, * FROM out_rows WHERE supplier <> '待映射'
  UNION ALL
  SELECT 1 AS sort_key, * FROM out_rows WHERE supplier = '待映射'
  UNION ALL
  SELECT 2 AS sort_key, '累计' AS supplier, '累计' AS ym,
         ROUND(SUM(bill_cny)::numeric, 2), ROUND(SUM(bill_usd)::numeric, 2),
         ROUND(SUM(paid_babi_cny)::numeric, 2), ROUND(SUM(paid_babi_usd)::numeric, 2),
         ROUND(SUM(paid_ocean_cny)::numeric, 2), ROUND(SUM(paid_ocean_usd)::numeric, 2),
         ROUND(SUM(gap_cny)::numeric, 2), ROUND(SUM(gap_usd)::numeric, 2),
         false AS unmatched, NULL AS counterparty_names
    FROM out_rows
)
SELECT supplier, ym, bill_cny, bill_usd, paid_babi_cny, paid_babi_usd,
       paid_ocean_cny, paid_ocean_usd, gap_cny, gap_usd, unmatched, counterparty_names
  FROM final_rows
 ORDER BY sort_key, supplier, ym`;
  const r = await pool.query(sql, args);
  const unmatched = r.rows
    .filter((x) => x.unmatched)
    .map((x) => ({ ym: x.ym, counterparty_name: x.counterparty_names || "", supplier: x.supplier }))
    .filter((x) => x.counterparty_name);
  return { rows: r.rows, unmatched_counterparties: unmatched };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const data = await loadReconSupplier(getPool(), req.query);
    res.status(200).json({ success: true, data: data.rows, count: data.rows.length, unmatched_counterparties: data.unmatched_counterparties });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
