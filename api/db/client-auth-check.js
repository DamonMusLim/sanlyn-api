// /api/db/client-auth-check.js - nginx auth_request gate for client portal.
import { verifyToken } from "../auth.js";
import { getPool } from "../db.js";

const COOKIE_NAME = "sanlyn_client";
const BUILD_BY_MENU_PATH = Object.freeze({
  "client/report-mgmt": "mgmt",
  "client/report-am": "am",
});
const MENU_PATHS = Object.freeze(Object.keys(BUILD_BY_MENU_PATH));
const PROFILE_ACCOUNT_COLUMNS = ["account_id", "account_uid", "user_id", "uid"];
const PROFILE_USERNAME_COLUMNS = ["username", "account_username"];
const PROFILE_COMPANY_COLUMNS = ["company_code", "tenant_id"];
const PROFILE_ROLE_COLUMNS = ["role_key", "role_code", "role", "role_id"];
const MENU_ROLE_COLUMNS = ["role_key", "role_code", "role", "role_id"];

function parseCookies(req) {
  const header = String((req.headers && req.headers.cookie) || "");
  const out = {};
  for (const part of header.split(";")) {
    const pos = part.indexOf("=");
    if (pos < 0) continue;
    const key = part.slice(0, pos).trim();
    const val = part.slice(pos + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

function bearerToken(req) {
  const header = String((req.headers && req.headers.authorization) || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function deny(res) {
  return res.status(401).end();
}

function ident(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
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

async function getAccount(pool, user) {
  const params = [String(user.uid || ""), String(user.username || ""), String(user.companyCode || "")];
  try {
    const r = await pool.query(
      `SELECT id, username, COALESCE(is_active, true) AS is_active,
              COALESCE(token_version, 1) AS token_version
         FROM accounts
        WHERE company_code = $3
          AND (id::text = $1 OR username = $2)
        LIMIT 1`,
      params
    );
    return r.rows[0] || null;
  } catch (err) {
    if (!err || err.code !== "42703") throw err;
    const r = await pool.query(
      `SELECT id, username, COALESCE(is_active, true) AS is_active,
              1 AS token_version
         FROM accounts
        WHERE company_code = $3
          AND (id::text = $1 OR username = $2)
        LIMIT 1`,
      params
    );
    return r.rows[0] || null;
  }
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
  const row = r.rows[0];
  return row && row.role_key ? row.role_key : null;
}

async function getAllowedMenuPaths(pool, roleKey, companyCode) {
  const columns = await getColumns(pool, "petstore_role_menus");
  const roleCol = firstColumn(columns, MENU_ROLE_COLUMNS);
  if (!roleCol || !columns.has("menu_path") || !columns.has("can_view")) return [];

  const checks = [`m.${ident(roleCol)}::text = $1`, "m.menu_path = ANY($2::text[])"];
  const params = [String(roleKey), MENU_PATHS];
  if (columns.has("is_active")) checks.push("COALESCE(m.is_active, true) = true");
  checks.push("COALESCE(m.can_view, false) = true");
  if (columns.has("company_code")) {
    params.push(String(companyCode));
    checks.push(`m.company_code::text = $${params.length}`);
  }
  const r = await pool.query(
    `SELECT m.menu_path
       FROM petstore_role_menus m
      WHERE ${checks.join(" AND ")}`,
    params
  );
  return r.rows.map((row) => row.menu_path).filter((path) => MENU_PATHS.includes(path));
}

function chooseBuild(menuPaths) {
  const allowed = new Set(menuPaths);
  if (allowed.has("client/report-mgmt")) return BUILD_BY_MENU_PATH["client/report-mgmt"];
  if (allowed.has("client/report-am")) return BUILD_BY_MENU_PATH["client/report-am"];
  return null;
}

export default async function handler(req, res) {
  if (req.method !== "GET") return deny(res);

  const token = bearerToken(req) || parseCookies(req)[COOKIE_NAME];
  const payload = verifyToken(token);
  const user = {
    uid: payload && (payload.uid || payload.id || payload.sub),
    username: payload && payload.username,
    companyCode: payload && (payload.companyCode || payload.company_code),
    tv: payload && payload.tv,
  };
  if (!payload || !user.companyCode || (!user.uid && !user.username)) return deny(res);

  try {
    const pool = getPool();
    const account = await getAccount(pool, user);
    if (!account || account.is_active === false) return deny(res);
    if (Object.prototype.hasOwnProperty.call(payload, "tv") && Number(user.tv) !== Number(account.token_version || 1)) {
      return deny(res);
    }

    const roleKey = await getProfileRole(pool, user);
    if (!roleKey) return deny(res);

    const menuPaths = await getAllowedMenuPaths(pool, roleKey, user.companyCode);
    const build = chooseBuild(menuPaths);
    if (!build) return deny(res);

    res.setHeader("X-Client-Build", build);
    return res.status(204).end();
  } catch (err) {
    console.error("[client-auth-check]", err);
    return deny(res);
  }
}
