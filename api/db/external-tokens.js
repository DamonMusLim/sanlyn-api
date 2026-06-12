// api/db/external-tokens.js — Admin CRUD for external_tokens (Codex fixes applied)
// Authz: req.user.role must be admin OR a known admin role flag.
// Token returned ONLY on create. List returns masked tokens.

import { getPool, setCors } from "../db.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_TTL_DAYS = 180;        // 6 months default expiry
const MAX_CONTACT_NAME_LEN = 64;
const MAX_CONTACT_PHONE_LEN = 32;
const MAX_REVOKE_REASON_LEN = 256;

// ── Admin gate ──
function isAdmin(user) {
  if (!user) return false;
  // Accept multiple role conventions (sanlyn-admin has mixed legacy)
  const role = user.role || user.user_role || "";
  if (role === "admin" || role === "superadmin") return true;
  if (user.is_admin === true || user.is_superadmin === true) return true;
  if (Array.isArray(user.roles) && user.roles.includes("admin")) return true;
  return false;
}

// ── Mask token: show first 8 chars only ──
function maskToken(tok) {
  if (!tok || typeof tok !== "string" || tok.length < 12) return tok;
  return tok.slice(0, 8) + "…" + tok.slice(-4);
}

export default async function handler(req, res) {
  try {
    setCors(req, res, "GET, POST, PATCH, OPTIONS");
    if (req.method === "OPTIONS") return res.status(200).end();
    if (!req.user) return res.status(401).json({ error: "Unauthorized" });
    if (!isAdmin(req.user)) return res.status(403).json({ error: "admin_required" });

    const pool = getPool();

    // ── GET list (returns masked tokens) ──
    if (req.method === "GET") {
      const { company_id, party_type, include_revoked } = req.query || {};
      const where = []; const vals = [];
      if (company_id) {
        const cid = parseInt(company_id, 10);
        if (!cid) return res.status(400).json({ error: "invalid company_id" });
        where.push(`t.company_id = $${vals.length+1}`); vals.push(cid);
      }
      if (party_type) {
        if (!["forwarder","factory","customer"].includes(party_type)) {
          return res.status(400).json({ error: "invalid party_type" });
        }
        where.push(`t.party_type = $${vals.length+1}`); vals.push(party_type);
      }
      if (include_revoked !== "1" && include_revoked !== "true") {
        where.push("t.revoked_at IS NULL");
      }
      const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const { rows } = await pool.query(`
        SELECT t.token, t.party_type, t.company_id, t.contact_name,
               t.created_by, t.created_at, t.last_used_at,
               t.expires_at, t.revoked_at, t.revoke_reason,
               c.name_cn, c.name_en, c.code
        FROM external_tokens t
        JOIN companies c ON c.id = t.company_id
        ${clause}
        ORDER BY t.created_at DESC
        LIMIT 200
      `, vals);
      // Mask tokens, drop sensitive last_used_ip & contact_phone from list view
      return res.status(200).json({
        success: true,
        data: rows.map(r => ({ ...r, token: maskToken(r.token), token_masked: true })),
        count: rows.length,
      });
    }

    // ── POST issue ──
    if (req.method === "POST") {
      const { party_type, company_id, contact_name, contact_phone, ttl_days } = req.body || {};
      if (!party_type || !["forwarder","factory","customer"].includes(party_type)) {
        return res.status(400).json({ error: "party_type required" });
      }
      const cid = parseInt(company_id, 10);
      if (!cid) return res.status(400).json({ error: "company_id required (integer)" });
      if (contact_name && (typeof contact_name !== "string" || contact_name.length > MAX_CONTACT_NAME_LEN)) {
        return res.status(400).json({ error: "contact_name too long" });
      }
      if (contact_phone && (typeof contact_phone !== "string" || contact_phone.length > MAX_CONTACT_PHONE_LEN)) {
        return res.status(400).json({ error: "contact_phone too long" });
      }

      // Verify company exists (avoid issuing tokens for phantom companies)
      const { rows: companyCheck } = await pool.query(
        "SELECT id, code FROM companies WHERE id = $1", [cid]
      );
      if (!companyCheck.length) return res.status(404).json({ error: "company not found" });

      // Default 180-day expiry (Codex finding #7)
      const ttl = parseInt(ttl_days, 10);
      const ttlDays = (ttl > 0 && ttl <= 3650) ? ttl : DEFAULT_TTL_DAYS;

      const { rows } = await pool.query(`
        INSERT INTO external_tokens
          (party_type, company_id, contact_name, contact_phone, created_by, expires_at)
        VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' days')::INTERVAL)
        RETURNING token, party_type, company_id, contact_name, created_at, expires_at
      `, [party_type, cid,
          contact_name || null, contact_phone || null,
          req.user?.username || String(req.user?.id || "admin"),
          String(ttlDays)]);

      // Return full token ONCE — admin must save the link immediately
      return res.status(201).json({ success: true, data: rows[0] });
    }

    // ── PATCH revoke ──
    if (req.method === "PATCH") {
      const { token, action, revoke_reason } = req.body || {};
      if (!token || !UUID_RE.test(token)) return res.status(400).json({ error: "token required (uuid)" });
      if (revoke_reason && (typeof revoke_reason !== "string" || revoke_reason.length > MAX_REVOKE_REASON_LEN)) {
        return res.status(400).json({ error: "revoke_reason too long" });
      }
      if (action !== "revoke") return res.status(400).json({ error: "invalid action" });

      const { rows } = await pool.query(`
        UPDATE external_tokens
        SET revoked_at = NOW(), revoke_reason = $2
        WHERE token = $1 AND revoked_at IS NULL
        RETURNING token, revoked_at
      `, [token, revoke_reason || "manual_admin_revoke"]);
      if (!rows.length) return res.status(404).json({ error: "token not found or already revoked" });
      return res.status(200).json({ success: true, data: { token: maskToken(rows[0].token), revoked_at: rows[0].revoked_at } });
    }

    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("[external-tokens]", err);
    if (res.headersSent) return;
    return res.status(500).json({ error: "internal_error" });
  }
}
