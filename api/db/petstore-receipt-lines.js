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
  const receiptNo = cleanText(req.query?.receipt_no, 120);
  if (!receiptNo) return { error: "receipt_no_required" };

  const productCode = cleanText(req.query?.product_code, 120);
  const params = [receiptNo, productCode, pageSize, offset];
  const sql = `
    WITH filtered AS (
      SELECT receipt_no, product_code, product_name, spec_text, qty_purchase,
             qty_actual, qty_ok, qty_bad, qty_reject, reject_reason, batch_no,
             produce_date, expire_date
        FROM public.petstore_receipt_lines
       WHERE receipt_no = $1
         AND ($2::text IS NULL OR product_code = $2)
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT receipt_no, product_code, product_name, spec_text, qty_purchase,
             qty_actual, qty_ok, qty_bad, qty_reject, reject_reason, batch_no,
             produce_date, expire_date
        FROM filtered
       ORDER BY product_code ASC
       LIMIT $3 OFFSET $4
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows)) FILTER (WHERE page_rows.receipt_no IS NOT NULL),
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
    const data = await listRows(req);
    if (data.error === "receipt_no_required") return json(res, 400, { ok: false, error: "receipt_no_required" });
    return json(res, 200, data);
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || "server_error" });
  }
}
