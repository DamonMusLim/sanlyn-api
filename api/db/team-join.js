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

import bcrypt from "bcryptjs";
import { getPool, setCors } from "../db.js";

// Must match auth-login.js verifyPassword() — it ONLY accepts bcrypt hashes
// ($2a$/$2b$ prefix) and treats anything else as plaintext to auto-upgrade.
// Using sha256+salt here would create permanently unloggable accounts.
async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
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
    // Treat placeholder/empty admin-side emails as "no hint" so invitee can self-claim
    const emailHint = inv.email && inv.email.indexOf("@") > 0 ? inv.email : null;

    return res.status(200).json({
      ok: true,
      invite: {
        email: emailHint, // null = invitee can use any email; non-null = invitee must match (double-gate)
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

  const { token, email: rawEmail, password } = req.body || {};
  if (!token)    return res.status(400).json({ error: "token required" });
  if (!password) return res.status(400).json({ error: "password required" });
  if (String(password).length < 8) return res.status(400).json({ error: "password must be at least 8 chars" });

  // Email is now invitee-supplied (2026-05-18: admin may have left blank because they didn't
  // know the exact address). Validate format here; if invite has a hinted email, require match.
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: "email_invalid" });
  }

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

    // ── Double-gate validation ──
    // Gate 1: token exists (already verified above).
    // Gate 2: if admin pre-set an email on the invite, invitee email MUST match.
    //         If admin left it blank, invitee can self-claim any valid email.
    const hintedEmail = i.email && i.email.indexOf("@") > 0 ? i.email.toLowerCase() : null;
    if (hintedEmail && hintedEmail !== email) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "email_mismatch", message: "Email doesn't match the invite hint." });
    }

    // Reject if email already has an account (use password-reset flow instead)
    const dup = await client.query("SELECT id FROM accounts WHERE username = $1 LIMIT 1", [email]);
    if (dup.rows[0]) { await client.query("ROLLBACK"); return res.status(409).json({ error: "email_already_registered" }); }

    const passwordHash = await hashPassword(password);

    // HQ scope → store company_codes[] alongside primary company_code
    const hqCodes = i.raw && i.raw.scope === "headquarters" && Array.isArray(i.raw.company_codes) ? i.raw.company_codes : null;

    // ── Auto-activate vs pending-review ──
    // If admin pre-specified the email (hintedEmail), the email match itself was the verification
    // gate — account becomes active immediately, ready to sign in.
    // If admin did NOT pre-specify (link shared via WeChat, anyone could click), the account
    // must be is_active=false and wait for admin approval. Prevents random people from joining
    // just because they obtained a link.
    const requiresReview = !hintedEmail;
    const isActive = !requiresReview;

    if (hqCodes) {
      await client.query(
        `INSERT INTO accounts (username, password, role, company_code, company_codes, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [email, passwordHash, i.role, i.company_code, hqCodes, isActive]
      );
    } else {
      await client.query(
        `INSERT INTO accounts (username, password, role, company_code, is_active, created_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
        [email, passwordHash, i.role, i.company_code, isActive]
      );
    }

    // Track final status: 'accepted' if active, 'pending_review' if awaiting admin approval
    const newStatus = requiresReview ? "pending_review" : "accepted";
    await client.query(
      "UPDATE team_invites SET status = $1, used_at = NOW(), email = $2 WHERE id = $3",
      [newStatus, email, i.id]
    );

    await client.query("COMMIT");
    return res.status(200).json({
      ok: true,
      message: requiresReview ? "account_pending_review" : "account_created",
      pending_review: requiresReview,
      username: email,
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
