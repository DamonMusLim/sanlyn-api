// customer-invite.js
// Self-service customer account activation via one-time token.
//
// POST /api/db/customer-invite/generate
//   Auth: admin/owner/ops only
//   body: { username }
//   → { ok, activateUrl, expiresAt }
//
// GET  /api/db/customer-invite/validate?token=<raw>
//   No auth — public token check
//   → { valid, username, company, companyCode }
//
// POST /api/db/customer-invite/activate
//   No auth — token is the credential
//   body: { token, password }
//   → { ok }
//
// Security:
//   - raw token never stored; SHA-256 hash stored in magic_links
//   - token is single-use (used_at set on activate)
//   - 24h TTL hard-coded
//   - Only sets password for accounts.role='customer'
import crypto     from "crypto";
import bcrypt     from "bcryptjs";
import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const BASE_URL = process.env.FRONTEND_BASE_URL || "https://ai.sanlyn.cn";
const TTL_HOURS = 24;

function sha256(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function genRaw() {
  return crypto.randomBytes(32).toString("hex"); // 64 hex chars
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();
  const path = (req.path || req.url || "").replace(/\?.*/, "");
  const seg  = path.split("/").filter(Boolean).pop() || "";

  // ── POST /generate ──────────────────────────────────────────
  if (req.method === "POST" && seg === "generate") {
    if (!requireAuth(req, res)) return;
    const role = req.user && req.user.role;
    if (!role || !["admin", "owner", "ops"].includes(String(role).toLowerCase())) {
      return res.status(403).json({ error: "Forbidden — admin/owner/ops only" });
    }

    const { username } = req.body || {};
    if (!username) return res.status(400).json({ error: "username required" });

    // Confirm account exists, is customer, scope is CN-00042
    const acct = await pool.query(
      "SELECT id, username, company, company_code FROM accounts WHERE username = $1 AND role = 'customer' LIMIT 1",
      [username]
    );
    if (!acct.rows[0]) {
      return res.status(404).json({ error: "Customer account not found: " + username });
    }
    const u = acct.rows[0];

    // Revoke any existing pending activation tokens for this username
    await pool.query(
      `UPDATE magic_links SET revoked_at = NOW()
       WHERE recipient_role = 'customer_activation'
         AND meta->>'username' = $1
         AND revoked_at IS NULL
         AND used_at IS NULL`,
      [username]
    );

    const raw   = genRaw();
    const hash  = sha256(raw);
    const meta  = JSON.stringify({ username: u.username, company_code: u.company_code });
    const expAt = new Date(Date.now() + TTL_HOURS * 3600 * 1000).toISOString();

    await pool.query(
      `INSERT INTO magic_links
         (token_hash, recipient_role, meta, expires_at, access_log, created_at)
       VALUES ($1, 'customer_activation', $2, $3, '[]'::jsonb, NOW())`,
      [hash, meta, expAt]
    );

    const activateUrl = `${BASE_URL}/activate?token=${raw}`;

    return res.status(200).json({
      ok:          true,
      activateUrl,
      expiresAt:   expAt,
      username:    u.username,
      company:     u.company,
      companyCode: u.company_code,
    });
  }

  // ── GET /validate?token=<raw> ────────────────────────────────
  if (req.method === "GET" && seg === "validate") {
    const raw = req.query && req.query.token;
    if (!raw || raw.length < 16) return res.status(400).json({ error: "token required" });

    const hash = sha256(raw);
    const { rows } = await pool.query(
      `SELECT id, meta, expires_at, used_at, revoked_at
         FROM magic_links
        WHERE token_hash = $1
          AND recipient_role = 'customer_activation'
          AND expires_at > NOW()
          AND revoked_at IS NULL
        LIMIT 1`,
      [hash]
    );

    if (!rows.length) return res.status(200).json({ valid: false, reason: "invalid_or_expired" });
    const row  = rows[0];
    const meta = typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta;

    // Fetch company name from accounts
    const acct = await pool.query(
      "SELECT company, company_code FROM accounts WHERE username = $1 LIMIT 1",
      [meta.username]
    );
    const acctRow = acct.rows[0] || {};

    return res.status(200).json({
      valid:       true,
      username:    meta.username,
      company:     acctRow.company     || "",
      companyCode: acctRow.company_code || meta.company_code || "",
      expiresAt:   row.expires_at,
      used:        !!row.used_at,
    });
  }

  // ── POST /activate ───────────────────────────────────────────
  if (req.method === "POST" && seg === "activate") {
    const { token: raw, password } = req.body || {};
    if (!raw || raw.length < 16) return res.status(400).json({ error: "token required" });
    if (!password || password.length < 8) {
      return res.status(400).json({ error: "password must be at least 8 characters" });
    }

    const hash = sha256(raw);
    const { rows } = await pool.query(
      `SELECT id, meta, expires_at, used_at, revoked_at
         FROM magic_links
        WHERE token_hash = $1
          AND recipient_role = 'customer_activation'
          AND expires_at > NOW()
          AND revoked_at IS NULL
          AND used_at IS NULL
        LIMIT 1`,
      [hash]
    );

    if (!rows.length) return res.status(401).json({ error: "invalid_or_expired_token" });

    const row  = rows[0];
    const meta = typeof row.meta === "string" ? JSON.parse(row.meta) : row.meta;
    const username = meta.username;

    const pwHash = await bcrypt.hash(password, 12);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Set password, clear firstLogin, fix stale raw fields
      await client.query(
        `UPDATE accounts
            SET password   = $1,
                updated_at = NOW(),
                raw        = raw
                             || '{"firstLogin":false}'::jsonb
                             || jsonb_build_object('activatedAt', NOW()::text,
                                                   'companyCode',   company_code,
                                                   'companyCodes',  company_codes)
          WHERE username = $2 AND role = 'customer'`,
        [pwHash, username]
      );

      // Mark token used
      await client.query(
        "UPDATE magic_links SET used_at = NOW() WHERE token_hash = $1",
        [hash]
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    return res.status(200).json({ ok: true, message: "Password set. You can now log in." });
  }

  return res.status(404).json({ error: "Use /generate, /validate, or /activate" });
}
