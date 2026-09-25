import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function cleanText(value, max = 120) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function json(res, status, data) {
  return res.status(status).json(data);
}

function forbidden(message) {
  const err = new Error(message);
  err.statusCode = 403;
  throw err;
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

async function currentAccountId(pool, user, companyCode) {
  const uid = user?.uid || user?.id || user?.sub;
  const username = cleanText(user?.username || user?.account, 160);
  if (!uid && !username) return null;
  const r = await pool.query(
    `SELECT id
       FROM accounts
      WHERE company_code = $3
        AND (
          ($1::text IS NOT NULL AND id::text = $1::text)
          OR ($2::text IS NOT NULL AND username = $2)
        )
      LIMIT 1`,
    [uid ? String(uid) : null, username, companyCode],
  );
  return r.rows[0]?.id || null;
}

async function myMenus(user) {
  const pool = getPool();
  const companyCode = await tenantCompanyCode(pool, user);
  if (!companyCode) forbidden("account_company_required");

  const accountId = await currentAccountId(pool, user, companyCode);
  if (!accountId) forbidden("account_forbidden");

  const profile = await pool.query(
    `SELECT p.role_id, r.role_key, COALESCE(r.is_active, false) AS role_active
       FROM petstore_account_profile p
       LEFT JOIN petstore_roles r ON r.id = p.role_id AND r.company_code = p.company_code
      WHERE p.account_id = $1 AND p.company_code = $2
      LIMIT 1`,
    [accountId, companyCode],
  );

  const row = profile.rows[0];
  if (!row) {
    return { ok: true, configured: false, role_id: null, role_key: null, menu_paths: [], menus: [] };
  }
  if (!row.role_active) {
    return {
      ok: true,
      configured: true,
      role_id: row.role_id,
      role_key: row.role_key || null,
      menu_paths: [],
      menus: [],
    };
  }

  const menus = await pool.query(
    `SELECT menu_path, COALESCE(can_view, false) AS can_view, COALESCE(can_edit, false) AS can_edit
       FROM petstore_role_menus
      WHERE role_id = $1 AND company_code = $2
      ORDER BY menu_path`,
    [row.role_id, companyCode],
  );
  const menuRows = menus.rows.map((item) => ({
    menu_path: item.menu_path,
    can_view: item.can_view === true,
    can_edit: item.can_edit === true,
  }));
  return {
    ok: true,
    configured: true,
    role_id: row.role_id,
    role_key: row.role_key || null,
    menu_paths: menuRows.filter((item) => item.can_view).map((item) => item.menu_path),
    menus: menuRows,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "method_not_allowed" });
    }
    return json(res, 200, await myMenus(req.user));
  } catch (err) {
    return json(res, err.statusCode || 500, { ok: false, error: err.message || "server_error" });
  }
}
