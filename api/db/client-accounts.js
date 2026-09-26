import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { writeAudit } from "./audit-helper.js";

const ROLE_MGMT = "client_mgmt";
const ROLE_AM = "client_am";
const CLIENT_ADMIN_MENU = "client/admin";
const ROLE_MENUS = Object.freeze({
  [ROLE_MGMT]: ["client/report-mgmt", CLIENT_ADMIN_MENU],
  [ROLE_AM]: ["client/report-am"],
});
const PROFILE_ACCOUNT_COLUMNS = ["account_id", "account_uid", "user_id", "uid"];
const PROFILE_USERNAME_COLUMNS = ["username", "account_username"];
const PROFILE_COMPANY_COLUMNS = ["company_code", "tenant_id"];
const PROFILE_ROLE_COLUMNS = ["role_key", "role_code", "role", "role_id"];
const MENU_ROLE_COLUMNS = ["role_key", "role_code", "role", "role_id"];
const INVITE_BASE_URL = "https://client.sanlyn.cn/set-password.html";
const INVITE_HOST_RE = /^[a-z0-9-]+\.sanlyn\.cn$/i;
const TTL_HOURS = 24;

function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function ident(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function clean(value, max = 200) {
  return String(value || "").trim().slice(0, max);
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function inviteBaseUrl(req) {
  const host = String((req && req.headers && req.headers.host) || "").replace(/:\d+$/, "");
  return INVITE_HOST_RE.test(host) ? `https://${host}/set-password/` : INVITE_BASE_URL;
}

function parseRaw(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function assertRole(role) {
  if (!Object.prototype.hasOwnProperty.call(ROLE_MENUS, role)) {
    const err = new Error("invalid_role");
    err.status = 400;
    throw err;
  }
}

async function getColumns(pool, tableName) {
  const r = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_name = $1
        AND table_schema = ANY(current_schemas(false))`,
    [tableName]
  );
  return new Set(r.rows.map((row) => row.column_name));
}

function firstColumn(columns, candidates) {
  return candidates.find((name) => columns.has(name)) || null;
}

async function getActorAccount(pool, user) {
  const r = await pool.query(
    `SELECT id, username, company, company_code, COALESCE(is_active, true) AS is_active
       FROM accounts
      WHERE company_code = $3
        AND (id::text = $1 OR username = $2)
      LIMIT 1`,
    [String(user.uid || ""), String(user.username || ""), String(user.companyCode || "")]
  );
  return r.rows[0] || null;
}

async function getProfileRole(pool, user) {
  const columns = await getColumns(pool, "petstore_account_profile");
  const companyCol = firstColumn(columns, PROFILE_COMPANY_COLUMNS);
  const roleCol = firstColumn(columns, PROFILE_ROLE_COLUMNS);
  if (!companyCol || !roleCol) return null;

  const params = [String(user.companyCode)];
  const checks = [`p.${ident(companyCol)}::text = $1`];
  const accountChecks = [];
  for (const col of PROFILE_ACCOUNT_COLUMNS) {
    if (!columns.has(col) || !user.uid) continue;
    params.push(String(user.uid));
    accountChecks.push(`p.${ident(col)}::text = $${params.length}`);
  }
  for (const col of PROFILE_USERNAME_COLUMNS) {
    if (!columns.has(col) || !user.username) continue;
    params.push(String(user.username));
    accountChecks.push(`p.${ident(col)}::text = $${params.length}`);
  }
  if (!accountChecks.length) return null;
  checks.push(`(${accountChecks.join(" OR ")})`);
  if (columns.has("is_active")) checks.push("COALESCE(p.is_active, true) = true");

  const r = await pool.query(
    `SELECT p.${ident(roleCol)}::text AS role_key
       FROM petstore_account_profile p
      WHERE ${checks.join(" AND ")}
      LIMIT 1`,
    params
  );
  return r.rows[0] && r.rows[0].role_key ? r.rows[0].role_key : null;
}

async function requireClientAdmin(pool, req, res) {
  if (!requireAuth(req, res)) return null;
  const user = {
    uid: req.user && (req.user.uid || req.user.id || req.user.sub),
    username: req.user && req.user.username,
    companyCode: req.user && (req.user.companyCode || req.user.company_code),
  };
  if (!user.companyCode || (!user.uid && !user.username)) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  const account = await getActorAccount(pool, user);
  if (!account || account.is_active === false) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  const roleKey = await getProfileRole(pool, user);
  const menuColumns = await getColumns(pool, "petstore_role_menus");
  const roleCol = firstColumn(menuColumns, MENU_ROLE_COLUMNS);
  const checks = [`m.${ident(roleCol)}::text = $1`, "m.menu_path = $2", "COALESCE(m.can_view, false) = true"];
  const params = [String(roleKey || ""), CLIENT_ADMIN_MENU];
  if (menuColumns.has("is_active")) checks.push("COALESCE(m.is_active, true) = true");
  if (menuColumns.has("company_code")) {
    params.push(String(user.companyCode));
    checks.push(`m.company_code::text = $${params.length}`);
  }
  const allowed = roleCol && menuColumns.has("menu_path") && menuColumns.has("can_view")
    ? await pool.query(`SELECT 1 FROM petstore_role_menus m WHERE ${checks.join(" AND ")} LIMIT 1`, params)
    : { rows: [] };
  if (!allowed.rows.length) {
    res.status(403).json({ error: "forbidden" });
    return null;
  }
  return { ...user, account };
}

async function ensureRoleId(db, companyCode, roleKey) {
  assertRole(roleKey);
  const found = await db.query(
    "SELECT id FROM petstore_roles WHERE company_code = $1 AND role_key = $2 LIMIT 1",
    [companyCode, roleKey]
  );
  if (found.rows.length) return found.rows[0].id;
  const created = await db.query(
    `INSERT INTO petstore_roles (company_code, role_key, role_name, is_builtin, is_active)
     SELECT $1, $2, $2, false, true
     WHERE NOT EXISTS (
       SELECT 1 FROM petstore_roles WHERE company_code = $1 AND role_key = $2
     )
     RETURNING id`,
    [companyCode, roleKey]
  );
  if (created.rows.length) return created.rows[0].id;
  const reread = await db.query(
    "SELECT id FROM petstore_roles WHERE company_code = $1 AND role_key = $2 LIMIT 1",
    [companyCode, roleKey]
  );
  if (reread.rows.length) return reread.rows[0].id;
  throw new Error("role_create_failed");
}

async function ensureRoleMenus(db, companyCode, role) {
  const roleId = await ensureRoleId(db, companyCode, role);
  const columns = await getColumns(db, "petstore_role_menus");
  if (!columns.has("role_id") || !columns.has("menu_path") || !columns.has("can_view")) {
    throw new Error("petstore_role_menus missing required columns");
  }
  if (role === ROLE_AM) {
    const revokeParams = [roleId, CLIENT_ADMIN_MENU];
    const revokeChecks = ["role_id = $1", "menu_path = $2"];
    if (columns.has("company_code")) {
      revokeParams.push(companyCode);
      revokeChecks.push(`company_code::text = $${revokeParams.length}`);
    }
    const revokeSet = ["can_view = false"];
    if (columns.has("updated_at")) revokeSet.push("updated_at = NOW()");
    await db.query(`UPDATE petstore_role_menus SET ${revokeSet.join(", ")} WHERE ${revokeChecks.join(" AND ")}`, revokeParams);
  }
  for (const menuPath of ROLE_MENUS[role]) {
    const params = [roleId, menuPath];
    const checks = ["role_id = $1", "menu_path = $2"];
    if (columns.has("company_code")) {
      params.push(companyCode);
      checks.push(`company_code::text = $${params.length}`);
    }
    const setParts = ["can_view = true"];
    if (columns.has("is_active")) setParts.push("is_active = true");
    if (columns.has("updated_at")) setParts.push("updated_at = NOW()");
    const updated = await db.query(`UPDATE petstore_role_menus SET ${setParts.join(", ")} WHERE ${checks.join(" AND ")}`, params);
    if (updated.rowCount > 0) continue;

    const insert = { role_id: roleId, menu_path: menuPath, can_view: true };
    if (columns.has("company_code")) insert.company_code = companyCode;
    if (columns.has("is_active")) insert.is_active = true;
    if (columns.has("created_at")) insert.created_at = "NOW()";
    if (columns.has("updated_at")) insert.updated_at = "NOW()";
    await insertRow(db, "petstore_role_menus", insert);
  }
}

async function upsertProfile(db, account, companyCode, role) {
  const roleId = await ensureRoleId(db, companyCode, role);
  const columns = await getColumns(db, "petstore_account_profile");
  const companyCol = firstColumn(columns, PROFILE_COMPANY_COLUMNS);
  const accountCol = firstColumn(columns, PROFILE_ACCOUNT_COLUMNS);
  const usernameCol = firstColumn(columns, PROFILE_USERNAME_COLUMNS);
  if (!companyCol || !columns.has("role_id") || (!accountCol && !usernameCol)) {
    throw new Error("petstore_account_profile missing required columns");
  }
  const params = [companyCode];
  const checks = [`${ident(companyCol)}::text = $1`];
  const accountChecks = [];
  if (accountCol) {
    params.push(String(account.id));
    accountChecks.push(`${ident(accountCol)}::text = $${params.length}`);
  }
  if (usernameCol) {
    params.push(String(account.username || account.email));
    accountChecks.push(`${ident(usernameCol)}::text = $${params.length}`);
  }
  checks.push(`(${accountChecks.join(" OR ")})`);
  const setParts = [`role_id = $${params.length + 1}`];
  params.push(roleId);
  if (columns.has("is_active")) setParts.push("is_active = true");
  if (columns.has("updated_at")) setParts.push("updated_at = NOW()");
  const updated = await db.query(`UPDATE petstore_account_profile SET ${setParts.join(", ")} WHERE ${checks.join(" AND ")}`, params);
  if (updated.rowCount > 0) return;

  const insert = { [companyCol]: companyCode, role_id: roleId };
  if (accountCol) insert[accountCol] = account.id;
  if (usernameCol) insert[usernameCol] = account.username || account.email;
  if (columns.has("is_active")) insert.is_active = true;
  if (columns.has("created_at")) insert.created_at = "NOW()";
  if (columns.has("updated_at")) insert.updated_at = "NOW()";
  await insertRow(db, "petstore_account_profile", insert);
}

async function insertRow(db, table, values) {
  const cols = Object.keys(values);
  const params = [];
  const placeholders = cols.map((col) => {
    if (values[col] === "NOW()") return "NOW()";
    params.push(values[col]);
    return `$${params.length}`;
  });
  return db.query(
    `INSERT INTO ${ident(table)} (${cols.map(ident).join(", ")}) VALUES (${placeholders.join(", ")})`,
    params
  );
}

async function listAccounts(pool, actor) {
  const cols = await getColumns(pool, "accounts");
  const nameExpr = cols.has("display_name") ? "a.display_name" : cols.has("name") ? "a.name" : "NULL";
  const activeExpr = cols.has("is_active") ? "COALESCE(a.is_active, true)" : "true";
  const passwordExpr = cols.has("password") ? "(a.password IS NOT NULL AND a.password <> '')" : "false";
  const r = await pool.query(
    `SELECT a.id, a.username, a.email, ${nameExpr} AS display_name, a.raw,
            ${activeExpr} AS is_active, ${passwordExpr} AS password_set
       FROM accounts a
      WHERE a.company_code = $1 AND a.role = 'customer'
      ORDER BY lower(COALESCE(a.email, a.username))`,
    [actor.companyCode]
  );
  const roles = await loadProfileRoles(pool, actor.companyCode);
  return r.rows.map((row) => {
    const raw = parseRaw(row.raw);
    return {
      id: row.id,
      email: row.email || "",
      username: row.username || "",
      display_name: row.display_name || raw.display_name || "",
      role: roles.get(String(row.id)) || roles.get(String(row.username)) || "",
      status: row.is_active ? "active" : "disabled",
      password_set: !!row.password_set,
    };
  });
}

async function loadProfileRoles(pool, companyCode) {
  const columns = await getColumns(pool, "petstore_account_profile");
  const companyCol = firstColumn(columns, PROFILE_COMPANY_COLUMNS);
  const accountCol = firstColumn(columns, PROFILE_ACCOUNT_COLUMNS);
  const usernameCol = firstColumn(columns, PROFILE_USERNAME_COLUMNS);
  const out = new Map();
  if (!companyCol || !columns.has("role_id") || (!accountCol && !usernameCol)) return out;
  const selected = [
    accountCol ? `p.${ident(accountCol)}::text AS account_id` : "NULL AS account_id",
    usernameCol ? `p.${ident(usernameCol)}::text AS username` : "NULL AS username",
    "r.role_key",
  ];
  const r = await pool.query(
    `SELECT ${selected.join(", ")}
       FROM petstore_account_profile p
       JOIN petstore_roles r ON r.id = p.role_id AND r.company_code::text = p.${ident(companyCol)}::text
      WHERE p.${ident(companyCol)}::text = $1`,
    [companyCode]
  );
  for (const row of r.rows) {
    if (row.account_id) out.set(String(row.account_id), row.role_key);
    if (row.username) out.set(String(row.username), row.role_key);
  }
  return out;
}

async function getTargetAccount(pool, actor, accountId) {
  const r = await pool.query(
    `SELECT id, username, email, role, company_code, COALESCE(is_active, true) AS is_active
       FROM accounts
      WHERE company_code = $1 AND role = 'customer' AND id::text = $2
      LIMIT 1`,
    [actor.companyCode, String(accountId || "")]
  );
  return r.rows[0] || null;
}

async function createAccount(pool, req, actor, body) {
  const email = clean(body.email, 320).toLowerCase();
  const displayName = clean(body.display_name || body.displayName, 120);
  const role = clean(body.role, 60);
  if (!email || !validEmail(email)) return { status: 400, json: { error: "invalid_email" } };
  assertRole(role);

  const accountsCols = await getColumns(pool, "accounts");
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await ensureRoleMenus(db, actor.companyCode, role);
    const raw = { display_name: displayName };
    const insert = {
      username: email,
      email,
      role: "customer",
      company_code: actor.companyCode,
      password: null,
      raw: JSON.stringify(raw),
    };
    if (accountsCols.has("company")) insert.company = actor.account.company || "";
    if (accountsCols.has("company_codes")) insert.company_codes = [actor.companyCode];
    if (accountsCols.has("display_name")) insert.display_name = displayName;
    if (accountsCols.has("is_active")) insert.is_active = true;
    if (accountsCols.has("created_at")) insert.created_at = "NOW()";
    if (accountsCols.has("updated_at")) insert.updated_at = "NOW()";
    for (const key of Object.keys(insert)) {
      if (!accountsCols.has(key)) delete insert[key];
    }
    const cols = Object.keys(insert);
    const vals = [];
    const ph = cols.map((col) => {
      if (insert[col] === "NOW()") return "NOW()";
      vals.push(insert[col]);
      return `$${vals.length}`;
    });
    const created = await db.query(
      `INSERT INTO accounts (${cols.map(ident).join(", ")})
       VALUES (${ph.join(", ")})
       RETURNING id, username, email`,
      vals
    );
    const account = created.rows[0];
    await upsertProfile(db, account, actor.companyCode, role);
    const invite = await createInviteLink(db, req, actor, account);
    await db.query("COMMIT");
    writeAudit(pool, req, {
      action: "client_account.create",
      entity_type: "account",
      entity_id: account.id,
      after: { email, role, company_code: actor.companyCode },
    }).catch(() => {});
    return { status: 200, json: { ok: true, account: { id: account.id, email, display_name: displayName, role, status: "active", password_set: false }, invite_link: invite.url, expires_at: invite.expiresAt } };
  } catch (err) {
    await db.query("ROLLBACK");
    if (err && err.code === "23505") return { status: 400, json: { error: "email_taken" } };
    throw err;
  } finally {
    db.release();
  }
}

async function createInviteLink(db, req, actor, account) {
  const token = crypto.randomBytes(24).toString("hex");
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();
  await db.query(
    `UPDATE magic_links SET revoked_at = NOW()
      WHERE recipient_role = 'customer_set_password'
        AND meta->>'account_id' = $1
        AND used_at IS NULL
        AND revoked_at IS NULL`,
    [String(account.id)]
  );
  await db.query(
    `INSERT INTO magic_links
       (token_hash, recipient_role, meta, expires_at, access_log, created_at, created_by)
     VALUES ($1, 'customer_set_password', $2::jsonb, $3, '[]'::jsonb, NOW(), $4)`,
    [tokenHash, JSON.stringify({ account_id: String(account.id), email: account.email || account.username, company_code: actor.companyCode }), expiresAt, actor.username || actor.account.username || ""]
  );
  return { url: `${inviteBaseUrl(req)}?token=${token}`, expiresAt };
}

async function setRole(pool, req, actor, body) {
  const role = clean(body.role, 60);
  assertRole(role);
  const account = await getTargetAccount(pool, actor, body.account_id || body.id);
  if (!account) return { status: 404, json: { error: "account_not_found" } };
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    await ensureRoleMenus(db, actor.companyCode, role);
    await upsertProfile(db, account, actor.companyCode, role);
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
  writeAudit(pool, req, { action: "client_account.set_role", entity_type: "account", entity_id: account.id, after: { role } }).catch(() => {});
  return { status: 200, json: { ok: true } };
}

async function setStatus(pool, req, actor, body) {
  const account = await getTargetAccount(pool, actor, body.account_id || body.id);
  if (!account) return { status: 404, json: { error: "account_not_found" } };
  const isActive = Object.prototype.hasOwnProperty.call(body, "is_active")
    ? body.is_active === true
    : clean(body.status, 20) === "active";
  await pool.query("UPDATE accounts SET is_active = $1, updated_at = NOW() WHERE id::text = $2 AND company_code = $3", [isActive, String(account.id), actor.companyCode]);
  writeAudit(pool, req, { action: "client_account.set_status", entity_type: "account", entity_id: account.id, after: { is_active: isActive } }).catch(() => {});
  return { status: 200, json: { ok: true } };
}

async function inviteLink(pool, req, actor, body) {
  const account = await getTargetAccount(pool, actor, body.account_id || body.id);
  if (!account) return { status: 404, json: { error: "account_not_found" } };
  const db = await pool.connect();
  try {
    const invite = await createInviteLink(db, req, actor, account);
    writeAudit(pool, req, { action: "client_account.invite_link", entity_type: "account", entity_id: account.id, after: { email: account.email || account.username } }).catch(() => {});
    return { status: 200, json: { ok: true, invite_link: invite.url, expires_at: invite.expiresAt } };
  } finally {
    db.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const pool = getPool();
  try {
    const actor = await requireClientAdmin(pool, req, res);
    if (!actor) return;
    const body = req.body || {};
    const action = clean(body.action, 40);
    if (action === "list") return res.status(200).json({ ok: true, accounts: await listAccounts(pool, actor) });
    if (action === "create") return send(res, await createAccount(pool, req, actor, body));
    if (action === "set_role") return send(res, await setRole(pool, req, actor, body));
    if (action === "set_status") return send(res, await setStatus(pool, req, actor, body));
    if (action === "invite_link") return send(res, await inviteLink(pool, req, actor, body));
    return res.status(400).json({ error: "invalid_action" });
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error("[client-accounts]", err);
    return res.status(status).json({ error: err.message || "server_error" });
  }
}

function send(res, result) {
  return res.status(result.status).json(result.json);
}
