// factory-invite-complete.js
// Public endpoint — invitee completes registration after clicking link.
//
// POST /api/db/factory-invite-complete
//   body: { token, legal_name, tax_id, legal_rep, legal_id_no, address,
//           phone, email, bank_name, bank_account, password, documents }
//
// Effects:
//   - Verify token (must be approved + not used + not expired)
//   - Insert/update customers row (status='pending_activation')
//   - Hash password, create accounts row
//   - Mark invite used_at
//   - Notify Sanlyn admin (WeCom) — final review queue
//
// NOTE: account is NOT activated until admin reviews documents.
//       customers.is_active = false until then.

import crypto from "crypto";
import { getPool, setCors } from "../db.js";

var WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || "";
var BASE_URL      = process.env.APP_BASE_URL    || "https://ai.sanlyn.cn";

function hashPassword(plain) {
  // Match existing auth-login.js scheme — sha256 + salt
  var salt = crypto.randomBytes(16).toString("hex");
  var hash = crypto.createHash("sha256").update(salt + plain).digest("hex");
  return salt + ":" + hash;
}

async function pingAdmin(payload) {
  if (!WECOM_WEBHOOK) return { skipped: true };
  var body = {
    msgtype: "markdown",
    markdown: {
      content: [
        "## ✅ Partner Completed Registration",
        "**Type:** " + payload.type,
        "**Company:** " + payload.legal_name,
        "**Tax ID:** `" + payload.tax_id + "`",
        "**Legal Rep:** " + payload.legal_rep,
        "**Documents:** " + Object.keys(payload.documents || {}).length + " uploaded",
        "[Review Account](" + BASE_URL + "/admin/invitations)",
      ].join("\n"),
    },
  };
  try {
    await fetch(WECOM_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  var pool = getPool();
  var b = req.body || {};
  var { token, legal_name, tax_id, legal_rep, legal_id_no, address,
        phone, email, bank_name, bank_account, password, documents } = b;

  if (!token || !legal_name || !tax_id || !legal_rep || !password) {
    return res.status(400).json({ error: "missing required fields" });
  }
  if (password.length < 8) return res.status(400).json({ error: "password too short" });

  try {
    // ── Verify token ──
    var inv = await pool.query("SELECT * FROM factory_invites WHERE token = $1", [token]);
    if (!inv.rows.length)              return res.status(404).json({ error: "invite not found" });
    var invite = inv.rows[0];
    if (invite.used_at)                return res.status(410).json({ error: "already used" });
    if (invite.status === "rejected")  return res.status(410).json({ error: "rejected" });
    if (invite.status !== "approved")  return res.status(403).json({ error: "invite not yet approved by Sanlyn" });
    if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: "expired" });

    // ── Dedup customer by tax_id ──
    var existing = await pool.query(
      "SELECT id, is_active FROM customers WHERE tax_no = $1 OR tax_id = $1 LIMIT 1",
      [tax_id]
    ).catch(() => ({ rows: [] }));
    if (existing.rows.length && existing.rows[0].is_active) {
      return res.status(409).json({ error: "company already registered and active" });
    }

    // ── Begin transaction ──
    var client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Generate unique company_code (e.g., based on type + legal_name initials)
      var prefix = (invite.type || "PARTNER").slice(0,2).toUpperCase();
      var rand   = Math.random().toString(36).slice(2, 7).toUpperCase();
      var company_code = prefix + "-" + rand;

      // Map invite type → customers.role
      var roleMap = { factory: "factory", customer: "buyer", trader: "trader", ocean: "forwarder", trucking: "trucking", service: "service", colleague: "staff" };
      var role = roleMap[invite.type] || "partner";

      // Upsert customer (pending activation)
      var c;
      if (existing.rows.length) {
        c = await client.query(
          `UPDATE customers SET
            name = $1, name_en = $1,
            tax_id = $2, address = $3, phone_e164 = $4, contact_email = $5,
            bank_name = $6, bank_account = $7,
            role = $8, is_active = false,
            raw = COALESCE(raw, '{}'::jsonb) || $9::jsonb,
            updated_at = NOW()
           WHERE id = $10 RETURNING id, company_code`,
          [legal_name, tax_id, address, phone, email, bank_name, bank_account, role,
           JSON.stringify({ legal_rep, legal_id_no, documents, registered_via_invite: invite.id }),
           existing.rows[0].id]
        );
      } else {
        c = await client.query(
          `INSERT INTO customers
            (company_code, name, name_en, tax_id, address, phone_e164, contact_email,
             bank_name, bank_account, role, is_active, raw, created_at, updated_at)
           VALUES ($1, $2, $2, $3, $4, $5, $6, $7, $8, $9, false, $10::jsonb, NOW(), NOW())
           RETURNING id, company_code`,
          [company_code, legal_name, tax_id, address, phone, email, bank_name, bank_account, role,
           JSON.stringify({ legal_rep, legal_id_no, documents, registered_via_invite: invite.id })]
        );
      }
      var customerId = c.rows[0].id;
      var finalCode  = c.rows[0].company_code;

      // Create account (login credentials) — username = email, hashed password
      var passwordHash = hashPassword(password);
      var username = email || (legal_rep + "@" + finalCode);

      await client.query(
        `INSERT INTO accounts (username, password, role, company_code, is_active, created_at)
         VALUES ($1, $2, $3, $4, false, NOW())
         ON CONFLICT (username) DO UPDATE SET
           password = EXCLUDED.password,
           role = EXCLUDED.role,
           company_code = EXCLUDED.company_code`,
        [username, passwordHash, role, finalCode]
      );

      // Mark invite as used + transition status to 'registered' (admin still needs to activate)
      await client.query(
        "UPDATE factory_invites SET used_at = NOW(), status = 'registered', documents = $1::jsonb WHERE id = $2",
        [JSON.stringify(documents || {}), invite.id]
      );

      await client.query("COMMIT");

      // ── Link factory to the inviting buyer's allowedFactories ──
      // invited_by = buyer's company_code. We append the new factory's company_code
      // so the buyer can immediately see the factory in their order creation dropdown.
      if (invite.invited_by && invite.type === "factory") {
        try {
          await pool.query(`
            UPDATE customers
            SET raw = jsonb_set(
              COALESCE(raw, '{}'),
              '{allowedFactories}',
              COALESCE(raw->'allowedFactories', '[]') || $1::jsonb
            )
            WHERE company_code = $2
          `, [
            JSON.stringify([{ key: finalCode, introducedBySanlyn: false, commissionRate: 0 }]),
            invite.invited_by,
          ]);
        } catch (linkErr) {
          // Non-fatal — relationship can be added manually via admin
          console.error("[invite-complete] allowedFactories link failed:", linkErr.message);
        }
      }

      // Notify admin (outside tx)
      pingAdmin({ type: invite.type, legal_name, tax_id, legal_rep, documents });

      return res.status(200).json({
        success: true,
        company_code: finalCode,
        customer_id: customerId,
        username,
        message: "Registration submitted. Sanlyn will review your documents and activate your account within 1 business day.",
      });
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
