// /api/db/team-join — public endpoint that consumes a team_invites token
// and creates the accounts row. Mirrors factory-invite-complete.js auth scheme
// (sha256 + salt), but is much lighter because the invite already carries
// company_code/role and the invitee has nothing else to fill except password.
//
// GET  /api/db/team-join?token=XXX        → preview invite (email, role, company name)
// POST /api/db/team-join                  → finalize, body { token, password }
//
// On finalize:
//   - Verify token exists in team_invites, status='pending', not expired
//   - Hash password
//   - INSERT accounts (username=email, password, role, company_code,
//       company_codes[] if invite.raw.scope='headquarters', is_active=true)
//   - UPDATE team_invites SET status='accepted', used_at=NOW()
//
// Customer team accounts are immediately active (no Sanlyn admin review needed —
// the inviter is the company's own admin/super_admin and is trusted).

import crypto from "crypto";
import { getPool, setCors } from "../db.js";

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return salt + ":" + hash;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ── GET: preview invite (used by team-join page to display "Hi <email>, join <company>") ──
  if (req.method === "GET") {
    const token = req.query?.token;
    if (!token) return res.status(400).json({ error: "token required" });

    const r = await pool.query(
      `SELECT ti.id, ti.email, ti.role, ti.company_code, ti.status, ti.expires_at, ti.raw,
              c.name_en AS company_name_en, c.name_cn AS company_name_cn
         FROM team_invites ti
         LEFT JOIN customers c ON c.company_code = ti.company_code
        WHERE ti.token = $1 LIMIT 1`,
      [token]
    );
    if (!r.rows[0]) return res.status(404).json({ error: "invite not found" });
    const inv = r.rows[0];
    if (inv.status !== "pending") return res.status(410).json({ error: "invite_already_" + inv.status });
    if (inv.expires_at && new Date(inv.expires_at) < new Date()) {
      return res.status(410).json({ error: "invite_expired", expires_at: inv.expires_at });
    }

    // Surface HQ scope so the join page can show "🏛 You'll see all N group companies"
    const hqScope = inv.raw && inv.raw.scope === "headquarters" ? inv.raw.company_codes : null;

    return res.status(200).json({
      ok: true,
      invite: {
        email: inv.email,
        role: inv.role,
        company_code: inv.company_code,
        company_name: inv.company_name_en || inv.company_name_cn || inv.company_code,
        hq_scope: hqScope, // null for single-company invites; array for HQ
        expires_at: inv.expires_at,
      },
    });
  }

  // ── POST: finalize → create account ──
  if (req.method !== "POST") return res.status(405).json({ error: "GET/POST only" });

  const { token, password } = req.body || {};
  if (!token)    return res.status(400).json({ error: "token required" });
  if (!password) return res.status(400).json({ error: "password required" });
  if (String(password).length < 8) return res.status(400).json({ error: "password must be at least 8 chars" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock the invite row so concurrent POSTs can't double-redeem
    const inv = await client.query(
      "SELECT id, email, role, company_code, status, expires_at, raw FROM team_invites WHERE token = $1 FOR UPDATE",
      [token]
    );
    if (!inv.rows[0]) { await client.query("ROLLBACK"); return res.status(404).json({ error: "invite not found" }); }
    const i = inv.rows[0];
    if (i.status !== "pending") { await client.query("ROLLBACK"); return res.status(410).json({ error: "invite_already_" + i.status }); }
    if (i.expires_at && new Date(i.expires_at) < new Date()) {
      await client.query("ROLLBACK");
      return res.status(410).json({ error: "invite_expired" });
    }

    // Reject if email already has an account (use password-reset flow instead)
    const dup = await client.query("SELECT id FROM accounts WHERE username = $1 LIMIT 1", [i.email]);
    if (dup.rows[0]) { await client.query("ROLLBACK"); return res.status(409).json({ error: "email_already_registered" }); }

    const passwordHash = hashPassword(password);

    // HQ scope → store company_codes[] alongside primary company_code
    const hqCodes = i.raw && i.raw.scope === "headquarters" && Array.isArray(i.raw.company_codes) ? i.raw.company_codes : null;

    if (hqCodes) {
      await client.query(
        `INSERT INTO accounts (username, password, role, company_code, company_codes, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, true, NOW())`,
        [i.email, passwordHash, i.role, i.company_code, hqCodes]
      );
    } else {
      await client.query(
        `INSERT INTO accounts (username, password, role, company_code, is_active, created_at)
         VALUES ($1, $2, $3, $4, true, NOW())`,
        [i.email, passwordHash, i.role, i.company_code]
      );
    }

    await client.query(
      "UPDATE team_invites SET status = 'accepted', used_at = NOW() WHERE id = $1",
      [i.id]
    );

    await client.query("COMMIT");
    return res.status(200).json({
      ok: true,
      message: "account_created",
      username: i.email,
      role: i.role,
      company_code: i.company_code,
      hq_scope: hqCodes,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}
