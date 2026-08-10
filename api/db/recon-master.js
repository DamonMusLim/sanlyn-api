import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function clean(v) { return String(v ?? "").trim(); }

export async function loadReconMaster(pool, q = {}) {
  const company = clean(q.company);
  const year = clean(q.year);
  if (!company) throw new Error("company required");
  const args = [company];
  let yearSql = "";
  if (year) {
    args.push(year);
    yearSql = `AND (
      EXTRACT(YEAR FROM COALESCE(bp.etd, o.delivery_date, o.created_at))::text = $2
      OR EXTRACT(YEAR FROM pg.etd)::text = $2
    )`;
  }
  const sql = `
WITH order_pick AS (
  SELECT o.*,
         bp.bl_no AS best_bl_no, bp.etd AS best_etd, bp._id AS best_plan_id,
         CASE WHEN NULLIF(BTRIM(bp.bl_no),'') IS NULL OR bp.bl_no ~ '^[0-9]+-[0-9]+$' THEN NULL ELSE BTRIM(bp.bl_no) END AS clean_bl
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT sp._id, sp.bl_no, sp.etd
        FROM shipping_plans sp
       WHERE sp.deleted_at IS NULL
         AND (
           o.shipping_plan_id::text = sp._id OR o.shipping_plan_id::text = sp.id::text
           OR o.order_no = ANY(COALESCE(sp.order_nos,'{}'::text[]))
           OR o.contract_no = ANY(COALESCE(sp.contract_nos,'{}'::text[]))
         )
       ORDER BY (sp.bl_no IS NOT NULL AND sp.bl_no !~ '^[0-9]+-[0-9]+$') DESC,
                sp.etd DESC NULLS LAST, sp.updated_at DESC NULLS LAST
       LIMIT 1
    ) bp ON TRUE
    LEFT JOIN shipping_plans pg ON pg.bl_no = bp.bl_no AND bp.bl_no IS NOT NULL
   WHERE o.deleted_at IS NULL
     AND COALESCE(o.status,'') <> 'cancelled'
     AND o.company_code = $1
     ${yearSql}
),
order_groups AS (
  SELECT COALESCE(clean_bl, 'ORDER:' || COALESCE(order_no, contract_no, _id::text)) AS group_key,
         clean_bl AS bl_no,
         array_agg(DISTINCT contract_no) FILTER (WHERE NULLIF(contract_no,'') IS NOT NULL) AS contracts,
         array_agg(DISTINCT customer_po) FILTER (WHERE NULLIF(customer_po,'') IS NOT NULL) AS customer_pos,
         string_agg(DISTINCT COALESCE(order_no, contract_no), '+' ORDER BY COALESCE(order_no, contract_no)) AS po_nos,
         MIN(best_etd) AS etd,
         string_agg(DISTINCT NULLIF(trade_terms,''), '+' ORDER BY NULLIF(trade_terms,'')) AS trade_terms,
         SUM(COALESCE(factory_total_amount, total_amount_factory, factory_amount, 0)) AS goods_cost,
         SUM(COALESCE(customer_amount, total_amount, 0)) AS goods_sale
    FROM order_pick
   GROUP BY COALESCE(clean_bl, 'ORDER:' || COALESCE(order_no, contract_no, _id::text)), clean_bl
),
plan_groups AS (
  SELECT BTRIM(sp.bl_no) AS bl_no,
         MIN(sp.etd) AS etd,
         MAX(sp.freight_sale_usd) AS ocean_sale_usd,
         MAX(sp.freight_sale_cny) AS port_sale_cny
    FROM shipping_plans sp
   WHERE sp.deleted_at IS NULL
     AND sp.company_code = $1
     AND NULLIF(BTRIM(sp.bl_no),'') IS NOT NULL
     AND sp.bl_no !~ '^[0-9]+-[0-9]+$'
     ${year ? "AND EXTRACT(YEAR FROM sp.etd)::text = $2" : ""}
   GROUP BY BTRIM(sp.bl_no)
),
bill_groups AS (
  SELECT BTRIM(bl_no) AS bl_no,
         SUM(CASE WHEN UPPER(COALESCE(currency_norm,currency,'USD'))='USD'
                   AND (cost_category ILIKE '%海运%' OR cost_category ILIKE '%ocean%' OR cost_category ILIKE '%freight%')
                  THEN COALESCE(amount,0) ELSE 0 END) AS ocean_cost_usd,
         SUM(CASE WHEN UPPER(COALESCE(currency_norm,currency,'USD'))='CNY'
                   AND (cost_category ILIKE '%驳船%' OR cost_category ILIKE '%barge%')
                  THEN COALESCE(amount,0) ELSE 0 END) AS barge_cost_cny
    FROM active_freight_supplier_bills
   WHERE UPPER(COALESCE(currency_norm,currency,'USD')) IN ('USD','CNY')
     AND NULLIF(BTRIM(bl_no),'') IS NOT NULL
   GROUP BY BTRIM(bl_no)
),
joined AS (
  SELECT COALESCE(og.group_key, pg.bl_no) AS group_key,
         COALESCE(og.bl_no, pg.bl_no) AS bl_no, og.contracts, og.customer_pos,
         og.po_nos, COALESCE(og.etd, pg.etd) AS etd, og.trade_terms,
         COALESCE(og.goods_cost,0) AS goods_cost, COALESCE(og.goods_sale,0) AS goods_sale,
         COALESCE(bg.ocean_cost_usd,0) AS ocean_cost_usd,
         COALESCE(bg.barge_cost_cny,0) AS barge_cost_cny,
         COALESCE(pg.ocean_sale_usd,0) AS ocean_sale_usd,
         COALESCE(pg.port_sale_cny,0) AS port_sale_cny
    FROM order_groups og
    FULL JOIN plan_groups pg ON pg.bl_no = og.bl_no
    LEFT JOIN bill_groups bg ON bg.bl_no = COALESCE(og.bl_no, pg.bl_no)
),
decl AS (
  SELECT j.group_key, SUM(x.fob_cny) AS declared_amount
    FROM joined j
    LEFT JOIN LATERAL (
      SELECT DISTINCT r.customs_no, r.fob_cny
        FROM finance_export_rebates r
        LEFT JOIN LATERAL regexp_split_to_table(COALESCE(r.contract_no,''), '\\s*/\\s*') part(v) ON TRUE
       WHERE part.v = ANY(COALESCE(j.contracts,'{}'::text[]))
          OR part.v = ANY(COALESCE(j.customer_pos,'{}'::text[]))
    ) x ON TRUE
   GROUP BY j.group_key
)
SELECT j.po_nos, j.bl_no, j.etd, j.trade_terms,
       ROUND(j.goods_cost::numeric,2) AS goods_cost,
       ROUND(j.goods_sale::numeric,2) AS goods_sale,
       ROUND(j.ocean_cost_usd::numeric,2) AS ocean_cost_usd,
       ROUND(j.barge_cost_cny::numeric,2) AS barge_cost_cny,
       ROUND(j.ocean_sale_usd::numeric,2) AS ocean_sale_usd,
       ROUND(j.port_sale_cny::numeric,2) AS port_sale_cny,
       ROUND(COALESCE(d.declared_amount,0)::numeric,2) AS declared_amount,
       ARRAY_REMOVE(ARRAY[
         CASE WHEN NULLIF(j.bl_no,'') IS NULL THEN '缺BL' END,
         CASE WHEN COALESCE(j.goods_cost,0)=0 THEN '缺成本' END,
         CASE WHEN COALESCE(j.goods_sale,0)=0 THEN '缺销售' END,
         CASE WHEN COALESCE(d.declared_amount,0)=0 THEN '缺报关' END
       ], NULL) AS gap_flags
  FROM joined j LEFT JOIN decl d USING(group_key)
 ORDER BY j.etd NULLS LAST, j.bl_no NULLS LAST, j.po_nos NULLS LAST`;
  const r = await pool.query(sql, args);
  return r.rows;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const rows = await loadReconMaster(getPool(), req.query);
    res.status(200).json({ success: true, data: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
