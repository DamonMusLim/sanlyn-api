import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function cleanText(value, max = 120) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function positiveInt(value) {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function cleanTextArray(value, max = 160) {
  if (!Array.isArray(value)) return null;
  return [...new Set(value.map((item) => cleanText(item, max)).filter(Boolean))];
}

function json(res, status, data) {
  return res.status(status).json(data);
}

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  throw err;
}

function forbidden(message) {
  const err = new Error(message);
  err.statusCode = 403;
  throw err;
}

async function tenantCompanyCode(client, user) {
  const fromToken = cleanText(user?.companyCode || user?.company_code, 80);
  if (fromToken) return fromToken;
  const uid = user?.uid || user?.id || user?.sub;
  const username = cleanText(user?.username || user?.account, 160);
  if (!uid && !username) return null;
  const r = await client.query(
    `SELECT company_code
       FROM accounts
      WHERE ($1::text IS NOT NULL AND id::text = $1::text)
         OR ($2::text IS NOT NULL AND username = $2)
      LIMIT 1`,
    [uid ? String(uid) : null, username],
  );
  return cleanText(r.rows[0]?.company_code, 80);
}

async function assertRole(client, roleId, companyCode) {
  const r = await client.query(
    `SELECT id FROM petstore_roles WHERE id = $1 AND company_code = $2`,
    [roleId, companyCode],
  );
  if (!r.rows[0]) forbidden("role_forbidden");
}

async function assertAccount(client, accountId, companyCode) {
  const r = await client.query(
    `SELECT id FROM accounts WHERE id = $1 AND company_code = $2`,
    [accountId, companyCode],
  );
  if (!r.rows[0]) forbidden("account_forbidden");
}

async function upsertRole(client, body, companyCode) {
  const roleKey = cleanText(body.role_key, 80);
  const roleName = cleanText(body.role_name, 120);
  const description = cleanText(body.description, 500);
  if (!roleKey || !roleName) badRequest("role_key_and_role_name_required");

  const builtin = await client.query(
    `SELECT id
       FROM petstore_roles
      WHERE company_code = $1 AND is_builtin = true AND role_key = $2`,
    [companyCode, roleKey],
  );
  if (builtin.rows[0]) badRequest("builtin_role_readonly");

  const result = await client.query(
    `INSERT INTO petstore_roles
       (company_code, role_key, role_name, description, is_builtin, is_active, created_at, updated_at)
     VALUES ($1, $2, $3, $4, false, true, now(), now())
     ON CONFLICT (company_code, role_key) DO UPDATE
       SET role_name = EXCLUDED.role_name,
           description = EXCLUDED.description,
           updated_at = now()
     RETURNING id`,
    [companyCode, roleKey, roleName, description],
  );
  return result.rowCount;
}

async function setRoleMenus(client, body, companyCode) {
  const roleId = positiveInt(body.role_id);
  const menuPaths = cleanTextArray(body.menu_paths, 200);
  if (!roleId || !menuPaths) badRequest("role_id_and_menu_paths_required");
  await assertRole(client, roleId, companyCode);

  const deleted = await client.query(
    `DELETE FROM petstore_role_menus WHERE role_id = $1 AND company_code = $2`,
    [roleId, companyCode],
  );
  if (menuPaths.length === 0) return deleted.rowCount;
  const result = await client.query(
    `INSERT INTO petstore_role_menus (company_code, role_id, menu_path, can_view, can_edit)
     SELECT $1, $2, path, true, false
       FROM unnest($3::text[]) AS path
     ON CONFLICT (role_id, menu_path) DO UPDATE
       SET company_code = EXCLUDED.company_code,
           can_view = EXCLUDED.can_view,
           can_edit = EXCLUDED.can_edit`,
    [companyCode, roleId, menuPaths],
  );
  return deleted.rowCount + result.rowCount;
}

async function setUserRole(client, body, companyCode) {
  const accountId = positiveInt(body.account_id);
  const roleId = positiveInt(body.role_id);
  if (!accountId || !roleId) badRequest("account_id_and_role_id_required");
  await assertAccount(client, accountId, companyCode);
  await assertRole(client, roleId, companyCode);

  const result = await client.query(
    `INSERT INTO petstore_account_profile (company_code, account_id, role_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'normal', now(), now())
     ON CONFLICT (account_id) DO UPDATE
       SET company_code = EXCLUDED.company_code,
           role_id = EXCLUDED.role_id,
           updated_at = now()`,
    [companyCode, accountId, roleId],
  );
  return result.rowCount;
}

async function setUserStores(client, body, companyCode) {
  const accountId = positiveInt(body.account_id);
  const storeCodes = cleanTextArray(body.store_codes, 80);
  if (!accountId || !storeCodes) badRequest("account_id_and_store_codes_required");
  await assertAccount(client, accountId, companyCode);

  const deleted = await client.query(
    `DELETE FROM petstore_account_stores WHERE account_id = $1 AND company_code = $2`,
    [accountId, companyCode],
  );
  if (storeCodes.length === 0) return deleted.rowCount;
  const result = await client.query(
    `INSERT INTO petstore_account_stores (company_code, account_id, store_code, is_default)
     SELECT $1, $2, code, ord = 1
       FROM unnest($3::text[]) WITH ORDINALITY AS u(code, ord)
     ON CONFLICT (account_id, store_code) DO UPDATE
       SET company_code = EXCLUDED.company_code,
           is_default = EXCLUDED.is_default`,
    [companyCode, accountId, storeCodes],
  );
  return deleted.rowCount + result.rowCount;
}

async function setUserStatus(client, body, companyCode) {
  const accountId = positiveInt(body.account_id);
  const status = cleanText(body.status, 40);
  if (!accountId || !status) badRequest("account_id_and_status_required");
  await assertAccount(client, accountId, companyCode);

  const result = await client.query(
    `UPDATE petstore_account_profile
        SET status = $2,
            updated_at = now()
      WHERE account_id = $1 AND company_code = $3`,
    [accountId, status, companyCode],
  );
  return result.rowCount;
}

async function runAction(user, body) {
  const action = cleanText(body?.action, 80);
  const actions = {
    upsert_role: upsertRole,
    set_role_menus: setRoleMenus,
    set_user_role: setUserRole,
    set_user_stores: setUserStores,
    set_user_status: setUserStatus,
  };
  if (!actions[action]) badRequest("unknown_action");

  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const companyCode = await tenantCompanyCode(client, user);
    if (!companyCode) forbidden("account_company_required");
    const affected = await actions[action](client, body || {}, companyCode);
    await client.query("COMMIT");
    return { ok: true, affected };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await runAction(req.user, req.body || {}));
  } catch (err) {
    return json(res, err.statusCode || 500, { ok: false, error: err.message || "server_error" });
  }
}
