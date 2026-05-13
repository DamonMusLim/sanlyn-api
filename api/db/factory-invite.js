// factory-invite.js
// Generic partner-invite endpoint (6 types: colleague / customer / factory / ocean / trucking / service).
// Routing kept under /api/db/factory-invite for backwards-compat.
//
// POST  /api/db/factory-invite
//   body: { type, factory_name (= companyName), contact_name (= contact),
//           channel ('email'|'wechat'|'phone'), channel_value,
//           contact_email?, contact_phone?, tax_id?, message?, invited_by, note? }
//
//   Behavior:
//     - if invited_by has admin role → status='approved' (skip review queue)
//     - else                        → status='pending'  (lands in admin queue)
//     - tax_id dedup: returns 409 if existing invite or active customer matches
//     - daily quota: 5 invites per inviter per 24h (defense against abuse)
//
// GET  /api/db/factory-invite?token=<tok>
//   Verify token for the registration landing page.

import crypto from "crypto";
import { getPool, setCors } from "../db.js";

var BASE_URL      = process.env.APP_BASE_URL    || "https://ai.sanlyn.cn";
var WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || "";
var DM_AK         = process.env.DM_ACCESS_KEY_ID  || "";
var DM_SK         = process.env.DM_ACCESS_KEY_SECRET || "";
var DM_REGION     = process.env.DM_REGION         || "ap-southeast-1";
var DAILY_QUOTA   = 5;

var ALLOWED_TYPES = ["colleague","customer","factory","trader","ocean","trucking","service"];

// Role-based invite permissions (enforced server-side)
var ROLE_INVITE_MAP = {
  customer:    ["factory", "trader"],
  factory:     ["customer", "ocean", "trucking", "service"],
  admin:       ["colleague","customer","factory","trader","ocean","trucking","service"],
  super_admin: ["colleague","customer","factory","trader","ocean","trucking","service"],
};

function makeToken() { return crypto.randomBytes(24).toString("hex"); }

function isAdmin(req) {
  return req.user && (req.user.role === "admin" || req.user.role === "super_admin");
}

// ── Email via AliCloud DirectMail ──
async function sendEmail({ to, type, factory_name, contact_name, message, token }) {
  if (!DM_AK || !DM_SK || !to) return { skipped: true };

  var link = BASE_URL + "/partner/register?token=" + token;
  var typeLabel = { colleague:"team", customer:"buyer", factory:"factory partner", ocean:"shipping partner", trucking:"trucking partner", service:"service partner" }[type] || "partner";
  var subject = "Sanlyn OS — invitation to join as " + typeLabel;
  var html = [
    "<p>Dear " + (contact_name || "Partner") + ",</p>",
    "<p>You have been invited to join <strong>Sanlyn OS</strong> as a <strong>" + typeLabel + "</strong>.</p>",
    message ? "<blockquote style='border-left:3px solid #2563eb;padding:6px 12px;color:#475569;background:#f1f5f9'>" + message + "</blockquote>" : "",
    "<p>Click below to register (link valid 7 days):</p>",
    "<p><a href='" + link + "' style='background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block'>Register Now →</a></p>",
    "<p style='color:#888;font-size:12px'>Or copy: " + link + "</p>",
    "<hr/><p style='color:#888;font-size:12px'>Sanlyn International Trading · ai.sanlyn.cn</p>",
  ].join("\n");

  var endpoint = DM_REGION === "cn-hangzhou" ? "https://dm.aliyuncs.com/" : "https://dm." + DM_REGION + ".aliyuncs.com/";
  var params = {
    Action: "SingleSendMail", Version: "2015-11-23", Format: "JSON",
    AccessKeyId: DM_AK, SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
    SignatureNonce: Math.random().toString(36).slice(2),
    Timestamp: new Date().toISOString().replace(/\.\d+/, "Z"),
    AccountName: "OB@sanlynos.com", FromAlias: "Sanlyn OS",
    AddressType: "1", ReplyToAddress: "false",
    ToAddress: to, Subject: subject, HtmlBody: html,
  };
  var sorted = Object.keys(params).sort()
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&");
  params.Signature = crypto.createHmac("sha1", DM_SK + "&")
    .update("POST&" + encodeURIComponent("/") + "&" + encodeURIComponent(sorted))
    .digest("base64");

  try {
    var r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: Object.keys(params).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&"),
    });
    var j = await r.json();
    return j.Code ? { ok: false, code: j.Code } : { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

// ── WeCom internal webhook (not the invitee — Sanlyn admin gets pinged) ──
async function pingAdmin({ type, factory_name, contact_name, channel, channel_value, invited_by, status }) {
  if (!WECOM_WEBHOOK) return { skipped: true };
  var body = {
    msgtype: "markdown",
    markdown: {
      content: [
        status === "pending" ? "## 🔔 New Invitation Pending Review" : "## 🤝 New Invitation Sent",
        "**Type:** " + type,
        "**Company:** " + factory_name,
        "**Contact:** " + (contact_name || "—") + "  (" + channel + ": " + channel_value + ")",
        "**Invited by:** " + (invited_by || "—"),
        status === "pending" ? "[Open Review Queue](" + BASE_URL + "/admin/invitations)" : "",
      ].filter(Boolean).join("\n"),
    },
  };
  try {
    await fetch(WECOM_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS factory_invites (
      id            SERIAL PRIMARY KEY,
      token         VARCHAR(64) UNIQUE NOT NULL,
      type          VARCHAR(20) DEFAULT 'factory',
      factory_name  VARCHAR(128),
      contact_name  VARCHAR(64),
      contact_email VARCHAR(128),
      contact_phone VARCHAR(32),
      channel       VARCHAR(16) DEFAULT 'email',
      channel_value VARCHAR(128),
      tax_id        VARCHAR(32),
      message       TEXT,
      invited_by    VARCHAR(64),
      note          TEXT,
      status        VARCHAR(20) DEFAULT 'pending',
      reviewed_by   VARCHAR(64),
      reviewed_at   TIMESTAMPTZ,
      review_note   TEXT,
      documents     JSONB DEFAULT '{}'::jsonb,
      ip            VARCHAR(45),
      user_agent    TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      expires_at    TIMESTAMPTZ,
      used_at       TIMESTAMPTZ
    )
  `);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();
  await ensureTable(pool);

  // ── GET: verify token ──
  if (req.method === "GET") {
    var token = req.query.token;
    if (!token) return res.status(400).json({ error: "token required" });
    try {
      var r = await pool.query("SELECT * FROM factory_invites WHERE token = $1", [token]);
      if (!r.rows.length)            return res.status(404).json({ error: "invite not found" });
      var inv = r.rows[0];
      if (inv.used_at)                return res.status(410).json({ error: "already used" });
      if (inv.status === "rejected")  return res.status(410).json({ error: "rejected by admin", note: inv.review_note });
      if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: "expired" });
      // Write opened_at on first visit (growth funnel: INVITED → OPENED)
      if (!inv.opened_at) {
        try {
          await pool.query(
            "UPDATE factory_invites SET opened_at = NOW() WHERE id = $1 AND opened_at IS NULL",
            [inv.id]
          );
        } catch (_) { /* opened_at column may not exist yet; non-fatal */ }
      }
      // Hide internals from public landing page
      return res.status(200).json({
        success: true,
        invite: {
          token: inv.token, type: inv.type,
          factory_name:  inv.factory_name,
          contact_name:  inv.contact_name,
          contact_email: inv.contact_email,
          contact_phone: inv.contact_phone,
          status: inv.status,
          message: inv.message,
          expires_at: inv.expires_at,
        },
      });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  var body = req.body || {};
  var type          = body.type || "factory";
  var factoryName   = body.factory_name || body.companyName;
  var contactName   = body.contact_name  || body.contact;
  var channel       = body.channel || "email";
  var channelValue  = body.channel_value || body.channelValue ||
                      (channel === "email" ? body.contact_email : body.contact_phone) || "";
  var contactEmail  = body.contact_email || (channel === "email"  ? channelValue : null);
  var contactPhone  = body.contact_phone || (channel !== "email"  ? channelValue : null);
  var taxId         = body.tax_id || null;
  var message       = body.message || null;
  var note          = body.note    || null;
  var invitedBy     = body.invited_by || (req.user && req.user.email) || "anonymous";

  // ── Validation ──
  if (!ALLOWED_TYPES.includes(type)) return res.status(400).json({ error: "invalid type" });
  if (!factoryName)                  return res.status(400).json({ error: "factory_name / companyName required" });
  if (!channelValue)                 return res.status(400).json({ error: "channel_value required" });

  // ── Role-based invite permission check ──
  var senderRole = req.user && req.user.role;
  var allowedForRole = ROLE_INVITE_MAP[senderRole] || [];
  if (senderRole && allowedForRole.length > 0 && !allowedForRole.includes(type)) {
    return res.status(403).json({
      error: "invite_not_permitted",
      message: "Your role (" + senderRole + ") cannot invite partners of type: " + type,
      allowed_types: allowedForRole,
    });
  }

  try {
    // ── Dedup by tax_id ──
    if (taxId) {
      var dup = await pool.query(
        "SELECT id, status FROM factory_invites WHERE tax_id = $1 AND status NOT IN ('rejected','expired') LIMIT 1",
        [taxId]
      );
      if (dup.rows.length) {
        return res.status(409).json({
          error: "duplicate_invite",
          message: "An invitation for this tax_id already exists",
          existing_id: dup.rows[0].id,
          existing_status: dup.rows[0].status,
        });
      }
      // Also check active customers
      try {
        var custDup = await pool.query("SELECT id, company_code FROM customers WHERE tax_no = $1 OR tax_id = $1 LIMIT 1", [taxId]);
        if (custDup.rows.length) {
          return res.status(409).json({
            error: "duplicate_customer",
            message: "A customer with this tax_id is already active",
            customer_id: custDup.rows[0].id,
          });
        }
      } catch (_) { /* tax_no/tax_id columns may differ */ }
    }

    // ── Daily quota (skip for admins) ──
    if (!isAdmin(req)) {
      var qy = await pool.query(
        "SELECT COUNT(*)::int AS c FROM factory_invites WHERE invited_by = $1 AND created_at > NOW() - INTERVAL '24 hours'",
        [invitedBy]
      );
      if (qy.rows[0].c >= DAILY_QUOTA) {
        return res.status(429).json({ error: "daily_quota_exceeded", limit: DAILY_QUOTA, used: qy.rows[0].c });
      }
    }

    // ── Status: admin = approved (skip review), else pending ──
    var status = isAdmin(req) ? "approved" : "pending";

    var token = makeToken();
    var expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    var ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || null;
    var ua = req.headers["user-agent"] || null;

    var ins = await pool.query(
      `INSERT INTO factory_invites
        (token, type, factory_name, contact_name, contact_email, contact_phone,
         channel, channel_value, tax_id, message, invited_by, note,
         status, ip, user_agent, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       RETURNING id`,
      [token, type, factoryName, contactName, contactEmail, contactPhone,
       channel, channelValue, taxId, message, invitedBy, note,
       status, ip, ua, expiresAt]
    );

    // ── Notifications ──
    var notifications = {};
    if (status === "approved") {
      // Direct invite — send registration link to the invitee right now
      if (channel === "email" && contactEmail) {
        notifications.email = await sendEmail({
          to: contactEmail, type, factory_name: factoryName,
          contact_name: contactName, message, token,
        });
      } else {
        notifications.email = { skipped: true, reason: "non-email channel — share link manually" };
      }
    }
    // Always ping Sanlyn admin (pending → review queue alert; approved → audit log)
    notifications.admin = await pingAdmin({
      type, factory_name: factoryName, contact_name: contactName,
      channel, channel_value: channelValue, invited_by: invitedBy, status,
    });

    var link = BASE_URL + "/partner/register?token=" + token;
    return res.status(200).json({
      success: true,
      invite_id: ins.rows[0].id,
      token,
      link,                               // share manually if email failed
      status,                             // 'pending' or 'approved'
      expires_at: expiresAt,
      notifications,
      ...(status === "pending" ? { message_to_inviter: "Submitted — Sanlyn will review and notify you within 1 business day" } : {}),
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
