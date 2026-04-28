// factory-invite.js
// Invite a new factory to register on Sanlyn OS.
//
// POST /api/db/factory-invite
//   body: { factory_name, contact_name, contact_email?, contact_phone?,
//           channel: 'email'|'wechat'|'both', invited_by, note? }
//
// GET  /api/db/factory-invite?token=<tok>
//   Verify token, return invite details (used by factory registration page)

import crypto from "crypto";
import { getPool, setCors } from "../db.js";

var BASE_URL = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";
var WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || "";
var DM_AK  = process.env.DM_ACCESS_KEY_ID || "";
var DM_SK  = process.env.DM_ACCESS_KEY_SECRET || "";
var DM_REGION = process.env.DM_REGION || "ap-southeast-1";

// ── generate invite token ──
function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

// ── send email via AliCloud DirectMail ──
async function sendEmail({ to, factory_name, contact_name, token }) {
  if (!DM_AK || !DM_SK) return { skipped: true, reason: "no DM credentials" };

  var link = BASE_URL + "/factory/register?token=" + token;
  var subject = "Sanlyn OS — Factory Registration Invitation";
  var html = [
    "<p>Dear " + (contact_name || "Factory Partner") + ",</p>",
    "<p>You have been invited to join <strong>Sanlyn OS</strong> as a factory partner.</p>",
    "<p>Click the link below to complete your registration (valid for 7 days):</p>",
    "<p><a href='" + link + "' style='background:#2563eb;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block'>Register as Factory Partner →</a></p>",
    "<p style='color:#888;font-size:12px'>Or copy: " + link + "</p>",
    "<hr/><p style='color:#888;font-size:12px'>Sanlyn International Trading · ai.sanlyn.cn</p>",
  ].join("\n");

  var endpoint = DM_REGION === "cn-hangzhou"
    ? "https://dm.aliyuncs.com/"
    : "https://dm." + DM_REGION + ".aliyuncs.com/";

  var params = {
    Action: "SingleSendMail", Version: "2015-11-23", Format: "JSON",
    AccessKeyId: DM_AK,
    SignatureMethod: "HMAC-SHA1", SignatureVersion: "1.0",
    SignatureNonce: Math.random().toString(36).slice(2),
    Timestamp: new Date().toISOString().replace(/\.\d+/, "Z"),
    AccountName: "OB@sanlynos.com", FromAlias: "Sanlyn OS",
    AddressType: "1", ReplyToAddress: "false",
    ToAddress: to, Subject: subject, HtmlBody: html,
  };
  var sorted = Object.keys(params).sort()
    .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&");
  var sig = crypto.createHmac("sha1", DM_SK + "&")
    .update("POST&" + encodeURIComponent("/") + "&" + encodeURIComponent(sorted))
    .digest("base64");
  params.Signature = sig;

  try {
    var r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: Object.keys(params).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(params[k])).join("&"),
    });
    var j = await r.json();
    return j.Code ? { ok: false, code: j.Code } : { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── send WeCom webhook ──
async function sendWecom({ factory_name, contact_name, contact_phone, token, invited_by }) {
  if (!WECOM_WEBHOOK) return { skipped: true, reason: "no webhook" };
  var link = BASE_URL + "/factory/register?token=" + token;
  var body = {
    msgtype: "markdown",
    markdown: {
      content: [
        "## 🏭 New Factory Invitation Sent",
        "**Factory:** " + factory_name,
        "**Contact:** " + (contact_name || "—") + (contact_phone ? "  `" + contact_phone + "`" : ""),
        "**Invited by:** " + (invited_by || "admin"),
        "[Open Registration Link](" + link + ")",
      ].join("\n"),
    },
  };
  try {
    await fetch(WECOM_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();

  // ── GET: verify token ──
  if (req.method === "GET") {
    var token = req.query.token;
    if (!token) return res.status(400).json({ error: "token required" });
    try {
      var r = await pool.query(
        "SELECT * FROM factory_invites WHERE token = $1", [token]
      );
      if (!r.rows.length) return res.status(404).json({ error: "invite not found" });
      var inv = r.rows[0];
      if (inv.used_at) return res.status(410).json({ error: "already used" });
      if (new Date(inv.expires_at) < new Date()) return res.status(410).json({ error: "expired" });
      return res.status(200).json({ success: true, invite: inv });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  // ── POST: create invite ──
  if (req.method !== "POST") return res.status(405).json({ error: "GET or POST only" });

  var body = req.body || {};
  var { factory_name, contact_name, contact_email, contact_phone, channel, invited_by, note } = body;

  if (!factory_name) return res.status(400).json({ error: "factory_name required" });
  if (!contact_email && !contact_phone) return res.status(400).json({ error: "contact_email or contact_phone required" });

  var ch = channel || "email";
  var token = makeToken();
  var expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Ensure table exists (auto-create on first use)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS factory_invites (
        id          SERIAL PRIMARY KEY,
        token       VARCHAR(64) UNIQUE NOT NULL,
        factory_name VARCHAR(128),
        contact_name VARCHAR(64),
        contact_email VARCHAR(128),
        contact_phone VARCHAR(32),
        channel     VARCHAR(16) DEFAULT 'email',
        invited_by  VARCHAR(64),
        note        TEXT,
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ,
        used_at     TIMESTAMPTZ
      )
    `);

    await pool.query(
      "INSERT INTO factory_invites (token, factory_name, contact_name, contact_email, contact_phone, channel, invited_by, note, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [token, factory_name, contact_name, contact_email, contact_phone, ch, invited_by, note, expiresAt]
    );

    var notifications = {};
    if ((ch === "email" || ch === "both") && contact_email) {
      notifications.email = await sendEmail({ to: contact_email, factory_name, contact_name, token });
    }
    if (ch === "wechat" || ch === "both") {
      notifications.wecom = await sendWecom({ factory_name, contact_name, contact_phone, token, invited_by });
    }

    var link = BASE_URL + "/factory/register?token=" + token;
    return res.status(200).json({
      success: true,
      token,
      link,
      expires_at: expiresAt,
      notifications,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
