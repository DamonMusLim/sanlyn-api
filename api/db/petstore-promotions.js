import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 营销活动 —— scope=mt 出美团活动档位(211条),scope=rule 出自建促销规则(2条+35个商品)。
const DEFAULT_PAGE = 1, DEFAULT_PAGE_SIZE = 50, MAX_PAGE_SIZE = 200;
function cleanText(v, m = 120) { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; }
function positiveInt(v, f) { const n = Number.parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : f; }
function paging(q) {
  const page = positiveInt(q?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(q?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function json(res, s, d) { return res.status(s).json(d); }

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const scope = cleanText(req.query?.scope, 20) === "rule" ? "rule" : "mt";
  const params = [cleanText(req.query?.keyword, 120), pageSize, offset];
  const sql = scope === "rule" ? `
    WITH filtered AS (
      SELECT r.id, r.program_id, r.minimum_qty, r.minimum_amount, r.applies_scope,
             COUNT(p.product_code)::int AS product_count
        FROM public.petstore_promo_rule r
        LEFT JOIN public.petstore_promo_product p ON p.program_id = r.program_id
       WHERE ($1::text IS NULL OR r.applies_scope ILIKE '%' || $1 || '%')
       GROUP BY r.id, r.program_id, r.minimum_qty, r.minimum_amount, r.applies_scope
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY id DESC) AS __rn
        FROM filtered ORDER BY id DESC LIMIT $2 OFFSET $3
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.id IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`
  : `
    WITH filtered AS (
      SELECT sub_act_id, sub_act_name, wm_poi_id, sub_item_amount, max_apply_price,
             max_act_price, plat_charge_amount, can_apply, can_not_apply_reason,
             min_order_count, day_stock_limit_min, max_sku_per_poi, capture_date
        FROM public.petstore_mt_activity_subact
       WHERE ($1::text IS NULL OR sub_act_name ILIKE '%' || $1 || '%')
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY capture_date DESC NULLS LAST, sub_act_id DESC) AS __rn
        FROM filtered ORDER BY capture_date DESC NULLS LAST, sub_act_id DESC LIMIT $2 OFFSET $3
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.sub_act_id IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;
  const r = await getPool().query(sql, params);
  const f = r.rows[0] || { rows: [], total: 0 };
  return { rows: f.rows, total: f.total, page, pageSize };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await listRows(req));
  } catch (e) { return json(res, 500, { ok: false, error: e.message || "server_error" }); }
}
