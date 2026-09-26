// /api/db/client-report-data.js - scoped client report payload.
import { promises as fs } from "fs";
import path from "path";
import { verifyToken } from "../auth.js";
import { getPool } from "../db.js";

const COOKIE_NAME = "sanlyn_client";
const DATA_ROOT = process.env.CLIENT_REPORT_DATA_DIR || "/opt/client-report-data";
const COMPANY_CODE_RE = /^[A-Z0-9][A-Z0-9-]{1,19}$/;
const BUILD_BY_MENU_PATH = Object.freeze({
  "client/report-mgmt": "mgmt",
  "client/report-am": "am",
});
const FILE_BY_BUILD = Object.freeze({
  mgmt: "report.json",
  am: "report-am.json",
});
const MENU_PATHS = Object.freeze(Object.keys(BUILD_BY_MENU_PATH));
const PROFILE_ACCOUNT_COLUMNS = ["account_id", "account_uid", "user_id", "uid"];
const PROFILE_USERNAME_COLUMNS = ["username", "account_username"];
const PROFILE_COMPANY_COLUMNS = ["company_code", "tenant_id"];
const PROFILE_ROLE_COLUMNS = ["role_key", "role_code", "role", "role_id"];
const MENU_ROLE_COLUMNS = ["role_key", "role_code", "role", "role_id"];

export const REPORT_SCOPE_TABLE = Object.freeze({
  topLevelKeep: Object.freeze([
    "chain", "currency", "months", "prev", "cur", "generatedFrom", "kpi", "counts",
    "cats", "brands", "skusTop", "slow", "slowCount", "skuTotal", "zeroCost",
    "houseBrandCodes", "houseBrands", "houseBrandRows", "neverSold",
    "audience", // Data file marker for which report build this is, not store data.
  ]),
  topLevelStoreArrays: Object.freeze({
    stores: "Store",
    darkOutlets: "Store",
  }),
  topLevelStoreMaps: Object.freeze(["outletBreakdown", "catBrandRank", "outletFocus"]),
  topLevelDropArrays: Object.freeze(["ams"]),
  adviceKeep: Object.freeze(["gapTotal", "thresholds", "caveats", "petTypes", "fast"]),
  adviceStoreArrays: Object.freeze({
    mix: "Store",
    gaps: "Store",
    drag: "Store",
    petByStore: "Store",
  }),
  adviceSpecial: Object.freeze(["dryPricing", "transfers", "corroboration"]),
});

const RAW_CACHE = new Map();
const WARNED_DROPPED_KEYS = new Set();

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
  return res.status(401).json({ error: "unauthorized" });
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

// 与 client-auth-check.js 同源，改一处要改两处。
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
  return r.rows.map((row) => row.menu_path).filter((menuPath) => MENU_PATHS.includes(menuPath));
}

function chooseBuild(menuPaths) {
  const allowed = new Set(menuPaths);
  if (allowed.has("client/report-mgmt")) return BUILD_BY_MENU_PATH["client/report-mgmt"];
  if (allowed.has("client/report-am")) return BUILD_BY_MENU_PATH["client/report-am"];
  return null;
}

async function authorizeClient(req) {
  const token = bearerToken(req) || parseCookies(req)[COOKIE_NAME];
  const payload = verifyToken(token);
  const user = {
    uid: payload && (payload.uid || payload.id || payload.sub),
    username: payload && payload.username,
    companyCode: payload && (payload.companyCode || payload.company_code),
    tv: payload && payload.tv,
  };
  if (!payload || !user.companyCode || (!user.uid && !user.username)) return null;

  const pool = getPool();
  const account = await getAccount(pool, user);
  if (!account || account.is_active === false) return null;
  if (Object.prototype.hasOwnProperty.call(payload, "tv") && Number(user.tv) !== Number(account.token_version || 1)) {
    return null;
  }

  const roleKey = await getProfileRole(pool, user);
  if (!roleKey) return null;
  const menuPaths = await getAllowedMenuPaths(pool, roleKey, user.companyCode);
  const build = chooseBuild(menuPaths);
  if (!build) return null;
  return { pool, user, account, build };
}

function reportPath(companyCode, build) {
  if (!COMPANY_CODE_RE.test(companyCode)) return null;
  const root = path.resolve(DATA_ROOT);
  const resolved = path.resolve(root, companyCode, FILE_BY_BUILD[build]);
  if (!resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

async function readReportJson(filePath) {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      const e = new Error("report_not_ready");
      e.status = 503;
      throw e;
    }
    throw err;
  }
  const key = `${filePath}:${stat.mtimeMs}`;
  const hit = RAW_CACHE.get(key);
  if (hit) return hit;
  for (const cacheKey of RAW_CACHE.keys()) {
    if (cacheKey.startsWith(filePath + ":")) RAW_CACHE.delete(cacheKey);
  }
  const parsed = JSON.parse(await fs.readFile(filePath, "utf8"));
  RAW_CACHE.set(key, parsed);
  return parsed;
}

async function loadScope(pool, accountId, companyCode) {
  const r = await pool.query(
    `SELECT COALESCE(r.scope_all, false) AS scope_all, p.store_scope
       FROM petstore_account_profile p
       JOIN petstore_roles r ON r.id = p.role_id
      WHERE p.account_id = $1 AND p.company_code = $2
      LIMIT 1`,
    [accountId, companyCode]
  );
  const row = r.rows[0];
  if (!row) return { scopeAll: false, stores: new Set() };
  if (row.scope_all === true) return { scopeAll: true, stores: null };
  const requested = Array.isArray(row.store_scope) ? row.store_scope.map(String) : [];
  if (!requested.length) return { scopeAll: false, stores: new Set() };
  const valid = await pool.query(
    `SELECT store_code
       FROM client_store_master
      WHERE company_code = $1 AND store_code = ANY($2::text[])`,
    [companyCode, requested]
  );
  return { scopeAll: false, stores: new Set(valid.rows.map((store) => String(store.store_code))) };
}

function warnDrop(pathName, key) {
  const scopedKey = `${pathName}.${key}`;
  if (WARNED_DROPPED_KEYS.has(scopedKey)) return;
  WARNED_DROPPED_KEYS.add(scopedKey);
  console.warn(`[client-report-data] drop unknown scoped key ${scopedKey}`);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function filterArrayByField(rows, field, scope) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => row && scope.has(String(row[field]))).map(clone);
}

function filterMapByScope(value, scope) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (scope.has(String(key))) out[key] = clone(item);
  }
  return out;
}

function filterTransfers(rows, scope) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row) => row && scope.has(String(row.from)) && scope.has(String(row.to)))
    .map(clone);
}

function filterCorroboration(value, scope) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return scope.has(String(value.highStore)) && scope.has(String(value.lowStore)) ? clone(value) : undefined;
}

function filterDryPricing(value, scope) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = key === "outlets" ? filterArrayByField(item, "Store", scope) : clone(item);
  }
  return out;
}

function filterAdvice(advice, scope) {
  if (!advice || typeof advice !== "object" || Array.isArray(advice)) return {};
  const out = {};
  const keep = new Set(REPORT_SCOPE_TABLE.adviceKeep);
  const storeArrays = REPORT_SCOPE_TABLE.adviceStoreArrays;
  const special = new Set(REPORT_SCOPE_TABLE.adviceSpecial);
  for (const [key, value] of Object.entries(advice)) {
    if (keep.has(key)) {
      out[key] = clone(value);
    } else if (Object.prototype.hasOwnProperty.call(storeArrays, key)) {
      out[key] = filterArrayByField(value, storeArrays[key], scope);
    } else if (key === "dryPricing") {
      out[key] = filterDryPricing(value, scope);
    } else if (key === "transfers") {
      out[key] = filterTransfers(value, scope);
    } else if (key === "corroboration") {
      const filtered = filterCorroboration(value, scope);
      if (filtered !== undefined) out[key] = filtered;
    } else if (!special.has(key)) {
      warnDrop("advice", key);
    }
  }
  return out;
}

function filterScopedReport(report, scope) {
  const out = {};
  const topKeep = new Set(REPORT_SCOPE_TABLE.topLevelKeep);
  const storeArrays = REPORT_SCOPE_TABLE.topLevelStoreArrays;
  const storeMaps = new Set(REPORT_SCOPE_TABLE.topLevelStoreMaps);
  const dropArrays = new Set(REPORT_SCOPE_TABLE.topLevelDropArrays);
  for (const [key, value] of Object.entries(report || {})) {
    if (topKeep.has(key)) {
      out[key] = clone(value);
    } else if (Object.prototype.hasOwnProperty.call(storeArrays, key)) {
      out[key] = filterArrayByField(value, storeArrays[key], scope);
    } else if (storeMaps.has(key)) {
      out[key] = filterMapByScope(value, scope);
    } else if (key === "advice") {
      out[key] = filterAdvice(value, scope);
    } else if (dropArrays.has(key)) {
      out[key] = [];
    } else {
      warnDrop("report", key);
    }
  }
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "GET") return deny(res);

  try {
    const auth = await authorizeClient(req);
    if (!auth) return deny(res);
    const companyCode = String(auth.user.companyCode || "");
    const filePath = reportPath(companyCode, auth.build);
    if (!filePath) return res.status(403).json({ error: "forbidden" });

    const report = await readReportJson(filePath);
    const scope = await loadScope(auth.pool, auth.account.id, companyCode);
    if (scope.scopeAll) return res.status(200).json(report);
    return res.status(200).json(filterScopedReport(report, scope.stores));
  } catch (err) {
    if (err && err.status === 503) return res.status(503).json({ error: "report_not_ready" });
    console.error("[client-report-data]", err);
    return deny(res);
  }
}
