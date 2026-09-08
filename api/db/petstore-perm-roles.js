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

async function roleMenus(pool, roleId, companyCode) {
  const role = await pool.query(
    `SELECT id FROM petstore_roles WHERE id = $1 AND company_code = $2`,
    [roleId, companyCode],
  );
  if (!role.rows[0]) {
    const err = new Error("role_forbidden");
    err.statusCode = 403;
    throw err;
  }
  const result = await pool.query(
    `SELECT menu_path
       FROM petstore_role_menus
      WHERE role_id = $1 AND company_code = $2
      ORDER BY menu_path`,
    [roleId, companyCode],
  );
  return result.rows.map((row) => row.menu_path);
}

async function listRows(req) {
  const pool = getPool();
  const companyCode = await tenantCompanyCode(pool, req.user);
  if (!companyCode) {
    const err = new Error("account_company_required");
    err.statusCode = 403;
    throw err;
  }

  const roleId = positiveInt(req.query?.role_id, 0);
  if (roleId > 0) {
    const rows = await roleMenus(pool, roleId, companyCode);
    return { rows, total: rows.length, page: 1, pageSize: rows.length };
  }

  const { page, pageSize, offset } = paging(req.query || {});
  const sql = `
    WITH counted AS (
      SELECT r.id, r.role_key, r.role_name, r.description, r.is_builtin,
             r.is_active, r.created_at, r.updated_at,
             COUNT(m.id)::int AS menu_count
        FROM petstore_roles r
        LEFT JOIN petstore_role_menus m ON m.role_id = r.id AND m.company_code = r.company_code
       WHERE r.company_code = $1
       GROUP BY r.id
    ), total_count AS (
      SELECT COUNT(*)::int AS total FROM counted
    ), page_rows AS (
      SELECT *
        FROM counted
       ORDER BY is_builtin DESC, id
       LIMIT $2 OFFSET $3
    )
    SELECT COALESCE(
             jsonb_agg(to_jsonb(page_rows)) FILTER (WHERE page_rows.id IS NOT NULL),
             '[]'::jsonb
           ) AS rows,
           total_count.total
      FROM total_count
      LEFT JOIN page_rows ON true
     GROUP BY total_count.total`;
  const result = await pool.query(sql, [companyCode, pageSize, offset]);
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
