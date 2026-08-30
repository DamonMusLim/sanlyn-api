import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 改价流水(71417条) —— 喂「调价记录」「调价监控」「智能调价」。\n// 🔴 源表有 cost_price,【不查】。mkt_* 是竞品价(别人的售价,不是我们的成本),允许。
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
  const params = [cleanText(req.query?.store_code, 120), cleanText(req.query?.channel, 120), cleanText(req.query?.product_code, 120), cleanText(req.query?.exec_status, 120), pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT id, ts, log_date, store_code, store_name, channel, product_code, product_name,\n             old_price, new_price, rate, reason, result, days_left, tier,\n             mkt_price, mkt_store, mkt_sold, mkt_conf, mkt_captured_at,\n             stock_qty, qty_90, expiry_flag, problem_type,\n             exec_status, executed_at, readback_ok, barcode, mt_price, ele_price
        FROM public.petstore_pricing_log
       WHERE ($1::text IS NULL OR store_code::text = $1)
         AND ($2::text IS NULL OR channel::text = $2)
         AND ($3::text IS NULL OR product_code::text = $3)
         AND ($4::text IS NULL OR exec_status::text = $4)
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY ts DESC NULLS LAST, id DESC) AS __rn
        FROM filtered ORDER BY ts DESC NULLS LAST, id DESC LIMIT $5 OFFSET $6
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn)
             FILTER (WHERE page_rows.id IS NOT NULL), '[]'::jsonb) AS rows,
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
