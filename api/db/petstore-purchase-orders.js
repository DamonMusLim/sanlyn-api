import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const DEFAULT_PAGE = 1;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

function cleanText(value, max = 120) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function positiveInt(value, fallback) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function paging(query) {
  const page = positiveInt(query?.page, DEFAULT_PAGE);
  const pageSize = Math.min(positiveInt(query?.pageSize, DEFAULT_PAGE_SIZE), MAX_PAGE_SIZE);
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function json(res, status, data) {
  return res.status(status).json(data);
}

async function listRows(req) {
  const { page, pageSize, offset } = paging(req.query || {});
  const storeCode = cleanText(req.query?.store_code, 80);
  const poStatus = cleanText(req.query?.po_status, 80);
  const supplier = cleanText(req.query?.supplier, 120);
  const poNo = cleanText(req.query?.po_no, 120);
  const params = [storeCode, poStatus, supplier, poNo, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT po_no, store_code, supplier, po_status, kind_count, qty_total,
             total_amount, doc_ref, doc_ref AS require_no, plan_no,
             ali_order_no, ali_freight, purchase_account,
             logistics_no, logistics_status, purchased_at, expect_arrive_at
        FROM public.petstore_purchase_orders
       WHERE ($1::text IS NULL OR store_code = $1)
         AND ($2::text IS NULL OR po_status = $2)
         AND ($3::text IS NULL OR supplier ILIKE '%' || $3 || '%')
         AND ($4::text IS NULL OR po_no ILIKE '%' || $4 || '%')
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT po_no, store_code, supplier, po_status, kind_count, qty_total,
             total_amount, doc_ref, require_no, plan_no,
             ali_order_no, ali_freight, purchase_account,
             logistics_no, logistics_status, purchased_at, expect_arrive_at
        FROM filtered
       ORDER BY purchased_at DESC NULLS LAST, po_no DESC
       LIMIT $5 OFFSET $6
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows)) FILTER (WHERE page_rows.po_no IS NOT NULL),
             '[]'::jsonb
           ) AS rows,
           total_count.total
      FROM total_count
      LEFT JOIN page_rows ON true
     GROUP BY total_count.total`;
  const result = await getPool().query(sql, params);
  const first = result.rows[0] || { rows: [], total: 0 };
  return { rows: first.rows, total: first.total, page, pageSize };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await listRows(req));
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || "server_error" });
  }
}
