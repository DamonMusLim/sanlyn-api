// /api/db/accounts.js — HARDENED (P0 hotfix 2026-04-22)
// Changes:
//   - GET now requires auth. Non-admin may only see their own row.
//   - POST (login-by-password) DELETED — clients must use /api/db/auth-login.
//   - PUT/PATCH/DELETE return 501 (not implemented here). Go through admin tooling.
//   - sanitizeRow() strips password / pwd / pwd_hash / raw.password / raw.tempToken.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const SENSITIVE_COL = new Set(["password", "pwd", "pwd_hash", "password_hash"]);
const SENSITIVE_RAW = new Set(["password", "pwd", "pwd_hash", "tempToken", "temp_token"]);

function sanitizeRow(row) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const k of Object.keys(row)) {
    if (SENSITIVE_COL.has(k)) continue;
    if (k === "raw" && row.raw && typeof row.raw === "object") {
      const r = {};
      for (const rk of Object.keys(row.raw)) {
        if (SENSITIVE_RAW.has(rk)) continue;
        r[rk] = row.raw[rk];
      }
      out.raw = r;
    } else {
      out[k] = row[k];
    }
  }
  return out;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // AUTH: every call requires a valid JWT.
  if (!requireAuth(req, res)) return; // requireAuth wrote the 401

  // Writes are not allowed on this endpoint anymore.
  if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE") {
    return res.status(501).json({
      success: false,
      error: "Not Implemented",
      message: "Account writes via this endpoint are disabled. Use /api/db/auth-login for login, or the admin account-management tooling for CRUD.",
    });
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool = getPool();
    const user = req.user || {};
    const isAdmin = user.role === "admin";
    const isSystem = user.role === "system";

    // superAdmin flag lives in raw.superAdmin (not in JWT). Check DB for it.
    let isSuperAdmin = false;
    if (!isAdmin && !isSystem && (user.uid || user.username)) {
      const selfQ = user.uid
        ? await pool.query("SELECT raw FROM accounts WHERE id=$1 LIMIT 1", [user.uid])
        : await pool.query("SELECT raw FROM accounts WHERE username=$1 LIMIT 1", [user.username]);
      if (selfQ.rowCount > 0) {
        let r = selfQ.rows[0].raw;
        if (typeof r === "string") { try { r = JSON.parse(r); } catch { r = null; } }
        isSuperAdmin = !!(r && r.superAdmin);
      }
    }

    // Select all columns (a.*) — sanitizeRow() is the SINGLE point of truth for stripping
    // secrets (password column + raw.password/tempToken/etc). This way adding a column
    // later never accidentally breaks a frontend filter that expected the field.
    const joinSQL = `SELECT a.*, c.allowed_brands, c.factory_name, c.group_code
                       FROM accounts a
                       LEFT JOIN companies c ON a.company_code = c.code`;

    if (isAdmin || isSystem || isSuperAdmin) {
      // Admin: may filter by username / role
      const { username, role, limit = 200 } = req.query || {};
      const params = [];
      const conds = [];
      if (username) { params.push(username); conds.push(`a.username = $${params.length}`); }
      if (role)     { params.push(role);     conds.push(`a.role = $${params.length}`); }
      let q = joinSQL;
      if (conds.length) q += " WHERE " + conds.join(" AND ");
      params.push(Math.min(parseInt(limit) || 200, 1000));
      q += ` ORDER BY a.created_at DESC LIMIT $${params.length}`;
      const result = await pool.query(q, params);
      const data = result.rows.map(sanitizeRow);
      return res.status(200).json({ success: true, data, count: result.rowCount });
    }

    // Non-admin: may only fetch their own row.
    const selfId = user.uid || user.userId || null;
    const selfUsername = user.username || null;
    if (!selfId && !selfUsername) {
      return res.status(403).json({ success: false, error: "Forbidden" });
    }
    const params = [];
    const conds = [];
    if (selfId)       { params.push(selfId);       conds.push(`a.id = $${params.length}`); }
    if (selfUsername) { params.push(selfUsername); conds.push(`a.username = $${params.length}`); }
    const q = joinSQL + " WHERE " + conds.join(" OR ") + " LIMIT 1";
    const result = await pool.query(q, params);
    if (result.rowCount === 0) return res.status(404).json({ success: false, error: "Not found" });
    return res.status(200).json({ success: true, data: [sanitizeRow(result.rows[0])], count: 1 });
  } catch (err) {
    console.error("[accounts]", err);
    return res.status(500).json({ success: false, error: "Internal error" });
  }
}
