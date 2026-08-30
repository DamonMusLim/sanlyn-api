import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 供应商/客户资料 —— 喂「供应商资料」「客户资料」两页,靠 supplier_kind 区分。
// ⚠️ 供应商名本身在【单据类页面】允许显示(Damon 0830 拍板),商品目录类仍锁。
const DEFAULT_PAGE = 1, DEFAULT_PAGE_SIZE = 50, MAX_PAGE_SIZE = 200;
function cleanText(v, max = 120) { const s = String(v ?? "").trim(); return s ? s.slice(0, max) : null; }
function positiveInt(v, f) { const n = Number.parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : f; }
function paging(q) {
  const page = positiveInt(q?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(q?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}
function json(res, s, d) { return res.status(s).json(d); }

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const enableRaw = cleanText(req.query?.enable, 10);
  const enable = enableRaw === null ? null : (enableRaw === "true" || enableRaw === "1");
  const params = [
    cleanText(req.query?.supplier_kind, 20),
    cleanText(req.query?.supplier_name, 120),
    cleanText(req.query?.channel, 40),
    enable,
    pageSize, offset,
  ];
  const sql = `
    WITH filtered AS (
      SELECT supplier_code, supplier_name, channel, settlement_type, arrive_days,
             contact_name, contact_phone, address_remark, supplier_kind,
             enable, order_count, source, created_at
        FROM public.petstore_suppliers
       WHERE ($1::text IS NULL OR supplier_kind = $1)
         AND ($2::text IS NULL OR supplier_name ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR channel = $3)
         AND ($4::boolean IS NULL OR enable = $4)
    ), total_count AS (SELECT COUNT(*)::int AS total FROM filtered),
    page_rows AS (
      SELECT *, ROW_NUMBER() OVER (ORDER BY order_count DESC, supplier_name ASC) AS __rn FROM filtered ORDER BY order_count DESC, supplier_name ASC LIMIT $5 OFFSET $6
    )
    SELECT COALESCE(jsonb_agg(to_jsonb(page_rows) - '__rn' ORDER BY page_rows.__rn) FILTER (WHERE page_rows.supplier_code IS NOT NULL), '[]'::jsonb) AS rows,
           total_count.total
      FROM total_count LEFT JOIN page_rows ON true GROUP BY total_count.total`;
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
