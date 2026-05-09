// /api/db/urge  — 三通道催单 API
// POST /api/db/urge
//   body: { order_id?, order_no?, target_role, message? }
//   target_role: "customer" | "factory" | "forwarder" | "driver" | "customs"
//
// Channels (in order of reliability):
//   1. WeCom webhook  — always attempted (free, ≈15 ms)
//   2. Email (SMTP)   — attempted if SMTP_HOST env set
//   3. SMS            — stub, attempted if TENCENT_SMS_SDK_APP_ID env set
//
// Audit trail: appended to orders.raw.urge_log[]
// Returns: { ok, channels: { wecom, email, sms } }

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ── WeChat ────────────────────────────────────────────────────
async function sendWecom(order_no, target_role, message) {
  const url = process.env.WECOM_WEBHOOK_URL;
  if (!url) return { skipped: true, reason: "no WECOM_WEBHOOK_URL" };
  const roleLabel = {
    customer: "客户",
    factory:  "工厂",
    forwarder:"货代",
    driver:   "司机",
    customs:  "报关行",
  }[target_role] || target_role;
  const content = [
    `📣 催单通知 — ${roleLabel}`,
    `**订单**: \`${order_no || "—"}\``,
    message ? `**备注**: ${message}` : null,
    `_已通过 Sanlyn OS 发送_`,
  ].filter(Boolean).join("\n");
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
    });
    const d = await r.json();
    return d.errcode === 0 ? { ok: true } : { ok: false, errcode: d.errcode };
  } catch (e) {
    console.error("[urge] wecom failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// ── Email ─────────────────────────────────────────────────────
async function sendEmail(recipient_email, order_no, target_role, message) {
  if (!process.env.SMTP_HOST || !recipient_email) return { skipped: true };
  // nodemailer lazy-import (optional dep)
  try {
    const nodemailer = (await import("nodemailer")).default;
    const transporter = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   Number(process.env.SMTP_PORT || 465),
      secure: process.env.SMTP_SECURE !== "false",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    const roleLabel = {
      customer: "Customer",
      factory:  "Factory",
      forwarder:"Forwarder",
      driver:   "Driver",
      customs:  "Customs Broker",
    }[target_role] || target_role;
    await transporter.sendMail({
      from:    process.env.SMTP_FROM || process.env.SMTP_USER,
      to:      recipient_email,
      subject: `[Sanlyn] Action Required — Order ${order_no}`,
      text:    [
        `Dear ${roleLabel},`,
        "",
        `This is a reminder regarding Order ${order_no}.`,
        message || "Please log in to Sanlyn OS to review the latest status and confirm your action.",
        "",
        "Sanlyn International Trade",
      ].join("\n"),
    });
    return { ok: true };
  } catch (e) {
    console.error("[urge] email failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// ── SMS stub ─────────────────────────────────────────────────
async function sendSms(phone, order_no, target_role) {
  if (!process.env.TENCENT_SMS_SDK_APP_ID) return { skipped: true };
  // TODO: integrate tencentcloud-sdk-nodejs when SMS account is set up
  // Cost: ¥0.045/条 via 腾讯云短信
  console.log("[urge] SMS stub — would send to", phone, "for order", order_no, "role", target_role);
  return { skipped: true, reason: "SMS not yet configured — set TENCENT_SMS_SDK_APP_ID" };
}

// ── Resolve contact info from order ──────────────────────────
function resolveContact(order, target_role) {
  const raw = order.raw || {};
  switch (target_role) {
    case "customer":
      return { email: raw.customer_email || null, phone: raw.customer_phone || null };
    case "factory":
      return { email: raw.factory_email  || null, phone: raw.factory_phone  || null };
    case "forwarder":
      return { email: raw.forwarder_email || null, phone: raw.forwarder_phone || null };
    case "driver":
      return { email: null, phone: raw.driver_phone || null };
    case "customs":
      return { email: raw.customs_email || null, phone: raw.customs_phone || null };
    default:
      return { email: null, phone: null };
  }
}

// ── Handler ───────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  requireAuth(req, res, async () => {
    if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

    const { order_id, order_no, target_role, message } = req.body || {};
    if (!target_role) return res.status(400).json({ error: "target_role required" });

    const pool = getPool();

    // ── 1. Resolve order ────────────────────────────────────────
    let order = null;
    let resolvedOrderNo = order_no;
    try {
      if (order_id) {
        const r = await pool.query("SELECT id, contract_no, raw FROM orders WHERE id = $1 LIMIT 1", [order_id]);
        order = r.rows[0] || null;
      } else if (order_no) {
        const r = await pool.query("SELECT id, contract_no, raw FROM orders WHERE contract_no = $1 LIMIT 1", [order_no]);
        order = r.rows[0] || null;
      }
      if (order) resolvedOrderNo = order.contract_no || order_no;
    } catch (e) {
      console.error("[urge] order lookup failed:", e.message);
    }

    const contact = order ? resolveContact(order, target_role) : { email: null, phone: null };

    // ── 2. Fire channels in parallel ────────────────────────────
    const [wecom, email, sms] = await Promise.all([
      sendWecom(resolvedOrderNo, target_role, message),
      sendEmail(contact.email, resolvedOrderNo, target_role, message),
      sendSms(contact.phone, resolvedOrderNo, target_role),
    ]);

    // ── 3. Append audit to orders.raw.urge_log ──────────────────
    if (order) {
      const entry = {
        ts:          new Date().toISOString(),
        target_role,
        order_no:    resolvedOrderNo,
        channels:    { wecom: wecom.ok || false, email: email.ok || false, sms: sms.ok || false },
        message:     message || null,
      };
      await pool.query(
        `UPDATE orders
         SET raw = jsonb_set(
           raw,
           '{urge_log}',
           COALESCE(raw->'urge_log', '[]'::jsonb) || $1::jsonb
         )
         WHERE id = $2`,
        [JSON.stringify(entry), order.id],
      ).catch(e => console.error("[urge] audit log failed:", e.message));
    }

    const ok = wecom.ok || email.ok || false;
    res.status(ok ? 200 : 207).json({ ok, channels: { wecom, email, sms } });
  });
}
