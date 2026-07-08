// account-identities.js
// GET list identities; POST bind identity. Admin only.

import { getPool, setCors } from "../db.js";

const PROVIDERS = new Set(["wechat_mp", "wechat_mini", "email", "phone"]);

function requireAdmin(req, res) {
  if (!req.user || req.user.role !== "admin") {
    res.status(403).json({ success: false, error: "Forbidden: admin only" });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAdmin(req, res)) return;

  const pool = getPool();

  try {
    if (req.method === "GET") {
      const accountId = req.query.account_id || req.query.accountId || null;
      const provider = req.query.provider || null;
      const params = [];
      const conds = [];
      if (accountId) {
        params.push(String(accountId));
        conds.push(`ai.account_id = $${params.length}`);
      }
      if (provider) {
        if (!PROVIDERS.has(provider)) return res.status(400).json({ success: false, error: "invalid provider" });
        params.push(provider);
        conds.push(`ai.provider = $${params.length}`);
      }
      const where = conds.length ? "WHERE " + conds.join(" AND ") : "";
      const r = await pool.query(
        `SELECT ai.id, ai.account_id, a.username, ai.provider, ai.subject,
                ai.verified_at, ai.raw, ai.created_at
           FROM account_identities ai
      LEFT JOIN accounts a ON a.id::text = ai.account_id::text
          ${where}
       ORDER BY ai.created_at DESC, ai.id DESC
          LIMIT 500`,
        params
      );
      return res.status(200).json({ success: true, identities: r.rows });
    }

    if (req.method === "POST") {
      const body = req.body || {};
      const accountId = body.account_id || body.accountId;
      const provider = body.provider;
      const subject = body.subject;
      const verifiedAt = body.verified_at || body.verifiedAt || null;
      const raw = body.raw && typeof body.raw === "object" ? body.raw : {};

      if (!accountId || !provider || !subject) {
        return res.status(400).json({ success: false, error: "account_id, provider, subject required" });
      }
      if (!PROVIDERS.has(provider)) {
        return res.status(400).json({ success: false, error: "invalid provider" });
      }

      const r = await pool.query(
        `INSERT INTO account_identities (account_id, provider, subject, verified_at, raw)
         VALUES ($1, $2, $3, COALESCE($4::timestamptz, NOW()), $5::jsonb)
         ON CONFLICT (provider, subject) DO UPDATE SET
           account_id = EXCLUDED.account_id,
           verified_at = COALESCE(EXCLUDED.verified_at, account_identities.verified_at),
           raw = EXCLUDED.raw
         RETURNING id, account_id, provider, subject, verified_at, raw, created_at`,
        [String(accountId), provider, subject, verifiedAt, JSON.stringify(raw)]
      );
      return res.status(200).json({ success: true, identity: r.rows[0] });
    }

    return res.status(405).json({ success: false, error: "Method not allowed" });
  } catch (err) {
    console.error("[account-identities]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
