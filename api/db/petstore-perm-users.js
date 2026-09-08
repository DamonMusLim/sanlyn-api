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

async function tenantCompanyCode(pool, user) {
  const fromToken = cleanText(user?.companyCode || user?.company_code, 80);
  if (fromToken) return fromToken;
  const uid = user?.uid || user?.id || user?.sub;
  const username = cleanText(user?.username || user?.account, 160);
  if (!uid && !username) return null;
  const r = await pool.query(
    `SELECT company_code
       FROM accounts
      WHERE ($1::text IS NOT NULL AND id::text = $1::text)
         OR ($2::text IS NOT NULL AND username = $2)
      LIMIT 1`,
    [uid ? String(uid) : null, username],
  );
  return cleanText(r.rows[0]?.company_code, 80);
}

async function listRows(req) {
  const pool = getPool();
  const companyCode = await tenantCompanyCode(pool, req.user);
  if (!companyCode) {
    const err = new Error("account_company_required");
    err.statusCode = 403;
    throw err;
  }

  const { page, pageSize, offset } = paging(req.query || {});
  const keyword = cleanText(req.query?.keyword, 120);
  const status = cleanText(req.query?.status, 40);
  const roleKey = cleanText(req.query?.role_key, 80);
  const storeCode = cleanText(req.query?.store_code, 80);
  const params = [companyCode, keyword, status, roleKey, storeCode, pageSize, offset];
  const sql = `
    WITH user_stores AS (
      SELECT account_id,
             string_agg(store_code, ',' ORDER BY is_default DESC, store_code) AS stores
        FROM petstore_account_stores
       WHERE company_code = $1
       GROUP BY account_id
    ), filtered AS (
      SELECT a.id AS account_id, a.username, a.contact_name, a.contact_phone,
             p.status, r.role_name, r.role_key, COALESCE(us.stores, '') AS stores
        FROM accounts a
        JOIN petstore_account_profile p ON p.account_id = a.id AND p.company_code = $1
        JOIN petstore_roles r ON r.id = p.role_id AND r.company_code = $1
        LEFT JOIN user_stores us ON us.account_id = a.id
       WHERE a.company_code = $1
         AND ($2::text IS NULL OR a.username ILIKE '%' || $2 || '%'
              OR a.contact_name ILIKE '%' || $2 || '%')
         AND ($3::text IS NULL OR p.status = $3)
         AND ($4::text IS NULL OR r.role_key = $4)
         AND ($5::text IS NULL OR EXISTS (
               SELECT 1
                 FROM petstore_account_stores s
                WHERE s.company_code = $1 AND s.account_id = a.id AND s.store_code = $5
             ))
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM filtered
    ), page_rows AS (
      SELECT account_id, username, contact_name, contact_phone, status,
             role_name, role_key, stores
        FROM filtered
       ORDER BY account_id
       LIMIT $6 OFFSET $7
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows)) FILTER (WHERE page_rows.account_id IS NOT NULL),
             '[]'::jsonb
           ) AS rows,
           total_count.total
      FROM total_count
      LEFT JOIN page_rows ON true
     GROUP BY total_count.total`;
  const result = await pool.query(sql, params);
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
    return json(res, err.statusCode || 500, { ok: false, error: err.message || "server_error" });
  }
}
