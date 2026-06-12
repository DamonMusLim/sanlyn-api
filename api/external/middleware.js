// api/external/middleware.js — Magic-link token auth
// Token in URL path or X-External-Token header.
// Looks up external_tokens, logs access, attaches req.external = { token, party_type, company_id, company_name, contact_name }
import { getPool, setCors } from "../db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractToken(req) {
  // From explicit header
  const h = (req.headers["x-external-token"] || "").trim();
  if (h && UUID_RE.test(h)) return h;
  // From query param (last resort, not preferred)
  const q = (req.query && req.query.token) || "";
  if (q && UUID_RE.test(q)) return q;
  // From path - e.g. /api/external/cards?... or /portal/<uuid>/...
  // Caller should pass token explicitly via header preferred.
  return null;
}

export async function externalAuth(req, res, next) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const token = extractToken(req);
  if (!token) {
    return res.status(401).json({ error: "External token required", code: "NO_TOKEN" });
  }

  const pool = getPool();
  const { rows } = await pool.query(`
    SELECT t.token, t.party_type, t.company_id, t.contact_name, t.contact_phone,
           t.revoked_at, t.expires_at,
           c.name_cn AS company_name, c.code AS company_code
    FROM external_tokens t
    LEFT JOIN companies c ON c.id = t.company_id
    WHERE t.token = $1
  `, [token]);

  if (!rows.length) {
    return res.status(401).json({ error: "Invalid token", code: "INVALID_TOKEN" });
  }
  const t = rows[0];
  if (t.revoked_at) {
    return res.status(401).json({ error: "Token revoked", code: "REVOKED" });
  }
  if (t.expires_at && new Date(t.expires_at) < new Date()) {
    return res.status(401).json({ error: "Token expired", code: "EXPIRED" });
  }

  // Async log access (fire-and-forget, don't block response)
  const ip = (req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim();
  const ua = req.headers["user-agent"] || "";
  pool.query(`
    INSERT INTO external_token_access_log (token, path, method, ip, user_agent, status_code)
    VALUES ($1, $2, $3, $4, $5, 200)
  `, [token, req.originalUrl || req.url, req.method, ip, ua.slice(0, 500)]).catch(() => {});

  // Update last_used (idempotent, fire-and-forget)
  pool.query(`UPDATE external_tokens SET last_used_at = NOW(), last_used_ip = $1 WHERE token = $2`, [ip, token])
    .catch(() => {});

  req.external = {
    token: t.token,
    party_type: t.party_type,
    company_id: t.company_id,
    company_name: t.company_name,
    company_code: t.company_code,
    contact_name: t.contact_name,
    contact_phone: t.contact_phone,
  };

  next();
}
