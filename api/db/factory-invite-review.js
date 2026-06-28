// factory-invite-review.js
// Admin endpoint: approve or reject a pending invitation.
//
// POST /api/db/factory-invite-review
//   body: { id, action: 'approve'|'reject', note? }
//
// On approve  → status='approved' + send registration email to invitee
// On reject   → status='rejected' (review_note required)

import crypto from "crypto";
import { getPool, setCors } from "../db.js";

var BASE_URL  = process.env.APP_BASE_URL    || "https://ai.sanlyn.cn";
var DM_AK     = process.env.DM_ACCESS_KEY_ID  || "";
var DM_SK     = process.env.DM_ACCESS_KEY_SECRET || "";
var DM_REGION = process.env.DM_REGION         || "ap-southeast-1";

async function sendApprovalEmail({ to, factory_name, contact_name, type, message, token }) {
  if (!DM_AK || !DM_SK || !to) return { skipped: true };

  var link = BASE_URL + "/partner/register?token=" + token;
  var typeLabel = { colleague:"team", customer:"buyer", factory:"factory partner", ocean:"shipping partner", trucking:"trucking partner", service:"service partner" }[type] || "partner";
  var subject = "Sanlyn OS — your invitation has been approved";
  var html = [
    "<p>Dear " + (contact_name || "Partner") + ",</p>",
    "<p>Your invitation to join <strong>Sanlyn OS</strong> as a <strong>" + typeLabel + "</strong> has been approved.</p>",
    message ? "<blockquote style='border-left:3px solid #2563eb;padding:6px 12px;color:#475569;background:#f1f5f9'>" + message + "</blockquote>" : "",
    "<p>Click below to complete registration (link valid 7 days):</p>",
    "<p><a href='" + link + "' style='background:#10b981;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;display:inline-block'>Register Now →</a></p>",
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
  var sorted = Object.keys(params).sort().map(k => encodeURIComponent(k)+"="+encodeURIComponent(params[k])).join("&");
  params.Signature = crypto.createHmac("sha1", DM_SK + "&")
    .update("POST&" + encodeURIComponent("/") + "&" + encodeURIComponent(sorted)).digest("base64");

  try {
    var r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: Object.keys(params).map(k => encodeURIComponent(k)+"="+encodeURIComponent(params[k])).join("&"),
    });
    var j = await r.json();
    return j.Code ? { ok: false, code: j.Code } : { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });

  if (!req.user || (req.user.role !== "admin" && req.user.role !== "super_admin")) {
    return res.status(403).json({ error: "admin only" });
  }

  var pool = getPool();
  var { id, action, note } = req.body || {};
  if (!id || !action)                return res.status(400).json({ error: "id + action required" });
  if (!["approve","reject","activate"].includes(action)) return res.status(400).json({ error: "action must be approve|reject|activate" });
  if (action === "reject" && !note)  return res.status(400).json({ error: "note required when rejecting" });

  try {
    var cur = await pool.query("SELECT * FROM factory_invites WHERE id = $1", [id]);
    if (!cur.rows.length)   return res.status(404).json({ error: "invite not found" });
    var inv = cur.rows[0];

    // ── activate: after factory has completed registration, admin enables account ──
    if (action === "activate") {
      if (inv.status !== "registered") {
        return res.status(409).json({ error: "can only activate after factory completes registration", current_status: inv.status });
      }
      // Get the customer created by this invite
      var custQ = await pool.query(
        "SELECT id, company_code FROM customers WHERE (raw->>'registered_via_invite')::int = $1 LIMIT 1",
        [id]
      );
      if (!custQ.rows.length) return res.status(404).json({ error: "no customer record found for this invite" });
      var cust = custQ.rows[0];

      await pool.query("UPDATE customers SET is_active = true, updated_at = NOW() WHERE id = $1", [cust.id]);
      await pool.query("UPDATE accounts SET is_active = true WHERE company_code = $1", [cust.company_code]);
      await pool.query(
        "UPDATE factory_invites SET status='active', reviewed_by=$1, reviewed_at=NOW(), review_note=$2 WHERE id=$3",
        [req.user.email, note || "Account activated by admin", id]
      );

      // WeCom ping
      if (WECOM_WEBHOOK) {
        fetch(WECOM_WEBHOOK, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ msgtype:"markdown", markdown:{ content:`## ✅ Partner Account Activated\n**Company:** ${cust.company_code}\n**Type:** ${inv.type}\n**Activated by:** ${req.user.email}` } }),
        }).catch(() => {});
      }

      return res.status(200).json({ success: true, id, status: "active", company_code: cust.company_code });
    }

    // ── approve / reject: standard first-pass review ──
    if (inv.status !== "pending") {
      return res.status(409).json({ error: "already reviewed", current_status: inv.status });
    }

    var nextStatus = action === "approve" ? "approved" : "rejected";
    await pool.query(
      "UPDATE factory_invites SET status=$1, reviewed_by=$2, reviewed_at=NOW(), review_note=$3 WHERE id=$4",
      [nextStatus, req.user.email, note || null, id]
    );

    var email = { skipped: true };
    if (action === "approve" && inv.contact_email) {
      email = await sendApprovalEmail({
        to: inv.contact_email,
        factory_name: inv.factory_name,
        contact_name: inv.contact_name,
        type: inv.type,
        message: inv.message,
        token: inv.token,
      });
    }

    return res.status(200).json({
      success: true,
      id, status: nextStatus,
      reviewed_by: req.user.email,
      email,
      link: BASE_URL + "/partner/register?token=" + inv.token,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
