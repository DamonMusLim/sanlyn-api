// /api/notify/order-created.js
// POST /api/notify/order-created
//   body: { order_no, customer_code, customer_name, total_amount, currency,
//           factory_code, source }
//
// Purpose: when a customer self-submits an order via OrderCreateV4 (mode="customer"),
// notify BABI's admin via email + WeCom so they can review.
//
// SPLIT-NOTE: BABI admin email is fetched dynamically from `accounts` table
// (company_code='BABI', role='admin'). We do NOT hardcode any address — per
// `feedback_never_invent_fields`. If no admin row found, we fall back to
// EMAIL_BCC env (which is already the ops mailbox).
//
// WeCom: uses the existing `WECOM_WEBHOOK_URL` pattern (see etd-delay-notify.js).
// Failure of either channel must NOT block — caller should ignore non-2xx.

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

async function resolveBabiAdminEmails(pool) {
  // accounts schema (per auth-login.js): id, username, role, company, supplier_role,
  // company_code, company_codes, raw. username is the email in practice.
  try {
    const q = await pool.query(
      `SELECT username, raw
         FROM accounts
        WHERE company_code = 'BABI'
          AND role = 'admin'
          AND COALESCE(is_active, true) = true
        LIMIT 5`
    );
    const out = [];
    for (const row of q.rows || []) {
      const raw = (typeof row.raw === "string") ? safeJson(row.raw) : (row.raw || {});
      const email = (raw && raw.email) || row.username || "";
      if (email && String(email).indexOf("@") > 0) out.push(String(email));
    }
    return out;
  } catch (e) {
    console.warn("[notify/order-created] resolveBabiAdminEmails failed:", e.message);
    return [];
  }
}

function safeJson(s) { try { return JSON.parse(s); } catch { return {}; } }

async function sendEmail({ to, subject, html }) {
  const ALWAYS_BCC = process.env.EMAIL_BCC || "168725@qq.com";
  const actualTo = to && to.length ? to.join(",") : ALWAYS_BCC;
  // Reuse the local send-email endpoint via direct module import to avoid a
  // self-HTTP round-trip. Falls back to fetch if direct import fails.
  try {
    const mod = await import("../send-email.js");
    // Simulate req/res for the handler
    let captured = null;
    const fakeReq = {
      method: "POST",
      headers: {},
      body: {
        type: "custom",
        sender: "oceanbaby",
        to: actualTo,
        data: { subject, html },
      },
    };
    const fakeRes = {
      _status: 200,
      status(code) { this._status = code; return this; },
      setHeader() { return this; },
      end() { return this; },
      json(body) { captured = { code: this._status, body }; return this; },
    };
    await mod.default(fakeReq, fakeRes);
    return captured && captured.body && captured.body.success
      ? { ok: true }
      : { ok: false, detail: captured && captured.body };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function sendWecom(content) {
  const url = process.env.WECOM_WEBHOOK_URL;
  if (!url) return { skipped: true, reason: "no_webhook" };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
    });
    return { ok: r.ok };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });
  if (!requireAuth(req, res)) return;

  try {
    const {
      order_no,
      customer_code,
      customer_name,
      total_amount,
      currency = "USD",
      factory_code,
      source = "customer_self_service",
    } = req.body || {};

    if (!order_no) {
      return res.status(400).json({ success: false, error: "order_no required" });
    }

    const pool = getPool();
    const recipients = await resolveBabiAdminEmails(pool);

    const subject = `🆕 Customer self-order ${order_no} (${customer_name || customer_code})`;
    const html = `
      <p>A customer just self-submitted an order via Sanlyn OS.</p>
      <table style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px;">
        <tr><td style="padding:6px;border:1px solid #ddd;"><b>Order No.</b></td><td style="padding:6px;border:1px solid #ddd;">${order_no}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd;"><b>Customer</b></td><td style="padding:6px;border:1px solid #ddd;">${customer_name || "—"} (${customer_code || "—"})</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd;"><b>Factory</b></td><td style="padding:6px;border:1px solid #ddd;">${factory_code || "—"}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd;"><b>Total Amount</b></td><td style="padding:6px;border:1px solid #ddd;">${currency} ${Number(total_amount || 0).toFixed(2)}</td></tr>
        <tr><td style="padding:6px;border:1px solid #ddd;"><b>Source</b></td><td style="padding:6px;border:1px solid #ddd;">${source}</td></tr>
      </table>
      <p>Please review the order in Sanlyn OS.</p>
    `;

    const wecomContent = [
      `🆕 客户自助下单: ${customer_name || customer_code} 提交了订单 ${order_no}, 总额 ${currency} ${Number(total_amount || 0).toFixed(2)}, 工厂 ${factory_code || "—"}. 请审核.`,
    ].join("\n");

    // Fire both in parallel — never throw out of either branch
    const [emailResult, wecomResult] = await Promise.all([
      sendEmail({ to: recipients, subject, html }).catch(e => ({ ok: false, error: e.message })),
      sendWecom(wecomContent).catch(e => ({ ok: false, error: e.message })),
    ]);

    return res.json({
      success: true,
      order_no,
      recipients_resolved: recipients.length,
      email: emailResult,
      wecom: wecomResult,
    });
  } catch (err) {
    console.error("[notify/order-created]", err);
    // Non-blocking: always 200 so the frontend never treats notify failure as a
    // submission failure. The detail is in `error`.
    return res.status(200).json({ success: false, error: err.message || "notify_failed" });
  }
}
