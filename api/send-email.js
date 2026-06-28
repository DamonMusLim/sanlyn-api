// /api/send-email.js
// Vercel Serverless Function — 阿里云 DirectMail 发送邮件
// 发件人：OB@sanlynos.com（外贸）或 PB@sanlynos.com（国内采购）

import crypto from "crypto";

// ── CORS ────────────────────────────────────────────────────
function setCors(req, res) {
  const allowed = [
    "https://sanlyn-os.vercel.app",
    "https://ai.sanlynos.com",
    "http://localhost:5173",
    "http://localhost:3000",
  ];
  const origin = req.headers.origin || "";
  if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── 发件人配置 ───────────────────────────────────────────────
const SENDERS = {
  oceanbaby: {
    name: "Ocean Baby | Sanlyn OS",
    email: "OB@sanlynos.com",
  },
  petbaby: {
    name: "Pet Baby | Sanlyn OS",
    email: "PB@sanlynos.com",
  },
};

const ALWAYS_BCC   = process.env.EMAIL_BCC || "168725@qq.com";
const TEST_MODE    = process.env.EMAIL_TEST_MODE === "true";

// ── DirectMail RPC 签名 ──────────────────────────────────────
function dmSign(params, secret) {
  const sorted = Object.keys(params).sort().map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`
  ).join("&");
  const strToSign = `POST&${encodeURIComponent("/")}&${encodeURIComponent(sorted)}`;
  return crypto.createHmac("sha1", secret + "&").update(strToSign).digest("base64");
}

async function sendViaDM({ fromAlias, fromName, to, subject, htmlBody, replyTo }) {
  const ak = process.env.DM_ACCESS_KEY_ID;
  const sk = process.env.DM_ACCESS_KEY_SECRET;
  const region = process.env.DM_REGION || "ap-southeast-1";
  const endpoint = region === "cn-hangzhou"
    ? "https://dm.aliyuncs.com/"
    : `https://dm.${region}.aliyuncs.com/`;

  const params = {
    Action: "SingleSendMail",
    Version: "2015-11-23",
    Format: "JSON",
    AccessKeyId: ak,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: Math.random().toString(36).slice(2),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    AccountName: fromAlias,
    FromAlias: fromName,
    AddressType: "1",
    ToAddress: to,
    Subject: subject,
    HtmlBody: htmlBody,
    ReplyToAddress: "false",
  };

  if (replyTo) params.ReplyToAddress = replyTo;

  params.Signature = dmSign(params, sk);

  const body = Object.keys(params).map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`
  ).join("&");

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return res.json();
}

// ── 邮件模板 ─────────────────────────────────────────────────
function buildEmail(type, data) {
  const t = {

    pi: {
      subject: `Proforma Invoice - ${data.contractNo || ""}`,
      html: `<p>Dear ${data.customerName || "Sir/Madam"},</p>
<p>Please find attached the Proforma Invoice for your reference.</p>
<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;">
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Contract No.</b></td><td style="padding:6px;border:1px solid #ddd;">${data.contractNo || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Amount</b></td><td style="padding:6px;border:1px solid #ddd;">${data.currency || "USD"} ${data.amount || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Payment Terms</b></td><td style="padding:6px;border:1px solid #ddd;">${data.paymentTerms || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>ETD</b></td><td style="padding:6px;border:1px solid #ddd;">${data.etd || "-"}</td></tr>
</table>
<p>Please confirm the order and arrange payment at your earliest convenience.</p>
<p>Best regards,<br>${data.senderName || "Sanlyn Team"}</p>`,
    },

    po: {
      subject: `Purchase Order - ${data.contractNo || ""}`,
      html: `<p>Dear ${data.factoryName || "Factory"},</p>
<p>Please find the Purchase Order details as follows:</p>
<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;">
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>PO No.</b></td><td style="padding:6px;border:1px solid #ddd;">${data.contractNo || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Product</b></td><td style="padding:6px;border:1px solid #ddd;">${data.productName || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Quantity</b></td><td style="padding:6px;border:1px solid #ddd;">${data.quantity || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Required Delivery Date</b></td><td style="padding:6px;border:1px solid #ddd;">${data.deliveryDate || "-"}</td></tr>
</table>
<p>Please confirm receipt and advise the production schedule.</p>
<p>Best regards,<br>${data.senderName || "Sanlyn Purchasing"}</p>`,
    },

    delivery_confirm: {
      subject: `Delivery Schedule Confirmed - ${data.contractNo || ""}`,
      html: `<p>Dear ${data.customerName || "Sir/Madam"},</p>
<p>The factory has confirmed the production schedule for your order.</p>
<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;">
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Contract No.</b></td><td style="padding:6px;border:1px solid #ddd;">${data.contractNo || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Confirmed Delivery Date</b></td><td style="padding:6px;border:1px solid #ddd;">${data.deliveryDate || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Estimated Shipment</b></td><td style="padding:6px;border:1px solid #ddd;">${data.etd || "-"}</td></tr>
</table>
<p>Kindly arrange the payment to ensure timely shipment.</p>
<p>Best regards,<br>${data.senderName || "Sanlyn Team"}</p>`,
    },

    shipping_notice: {
      subject: `Shipping Notice - ${data.shipmentNo || data.contractNo || ""}`,
      html: `<p>Dear ${data.recipientName || "Sir/Madam"},</p>
<p>Please be informed of the following shipping schedule:</p>
<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;">
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Shipment No.</b></td><td style="padding:6px;border:1px solid #ddd;">${data.shipmentNo || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Vessel / Voyage</b></td><td style="padding:6px;border:1px solid #ddd;">${data.vessel || "-"} / ${data.voyage || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>POL</b></td><td style="padding:6px;border:1px solid #ddd;">${data.pol || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>POD</b></td><td style="padding:6px;border:1px solid #ddd;">${data.pod || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>ETD</b></td><td style="padding:6px;border:1px solid #ddd;">${data.etd || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>ETA</b></td><td style="padding:6px;border:1px solid #ddd;">${data.eta || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Cut-off Date</b></td><td style="padding:6px;border:1px solid #ddd;">${data.cutoffDate || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Container No.</b></td><td style="padding:6px;border:1px solid #ddd;">${data.containerNo || "-"}</td></tr>
</table>
${data.soUrl ? `<p>SO Document: <a href="${data.soUrl}">Download SO</a></p>` : ""}
<p>Please arrange accordingly.</p>
<p>Best regards,<br>${data.senderName || "Sanlyn Logistics"}</p>`,
    },

    documents: {
      subject: `Shipping Documents - ${data.contractNo || ""}`,
      html: `<p>Dear ${data.customerName || "Sir/Madam"},</p>
<p>Please find the shipping documents for your order:</p>
<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;">
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Contract No.</b></td><td style="padding:6px;border:1px solid #ddd;">${data.contractNo || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>B/L No.</b></td><td style="padding:6px;border:1px solid #ddd;">${data.blNo || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Vessel</b></td><td style="padding:6px;border:1px solid #ddd;">${data.vessel || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>ETA</b></td><td style="padding:6px;border:1px solid #ddd;">${data.eta || "-"}</td></tr>
</table>
<ul>
  ${data.blUrl ? `<li><a href="${data.blUrl}">Bill of Lading (B/L)</a></li>` : ""}
  ${data.invoiceUrl ? `<li><a href="${data.invoiceUrl}">Commercial Invoice</a></li>` : ""}
  ${data.packingListUrl ? `<li><a href="${data.packingListUrl}">Packing List</a></li>` : ""}
  ${data.piUrl ? `<li><a href="${data.piUrl}">Proforma Invoice</a></li>` : ""}
</ul>
<p>Please confirm receipt.</p>
<p>Best regards,<br>${data.senderName || "Sanlyn Team"}</p>`,
    },

    payment_reminder: {
      subject: `Payment Reminder - ${data.contractNo || ""}`,
      html: `<p>Dear ${data.customerName || "Sir/Madam"},</p>
<p>This is a friendly reminder regarding the outstanding payment.</p>
<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:14px;">
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Contract No.</b></td><td style="padding:6px;border:1px solid #ddd;">${data.contractNo || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Total Amount</b></td><td style="padding:6px;border:1px solid #ddd;">${data.currency || "USD"} ${data.totalAmount || "-"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Paid</b></td><td style="padding:6px;border:1px solid #ddd;">${data.currency || "USD"} ${data.paidAmount || "0"}</td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Balance Due</b></td><td style="padding:6px;border:1px solid #ddd;color:#e53e3e;"><b>${data.currency || "USD"} ${data.balanceAmount || "-"}</b></td></tr>
  <tr><td style="padding:6px;border:1px solid #ddd;"><b>Due Date</b></td><td style="padding:6px;border:1px solid #ddd;">${data.dueDate || "-"}</td></tr>
</table>
<p>Kindly arrange the payment at your earliest convenience.</p>
<p>Best regards,<br>${data.senderName || "Sanlyn Finance"}</p>`,
    },

    custom: {
      subject: data.subject || "Message from Sanlyn",
      html: data.html || `<p>${data.text || ""}</p>`,
    },
  };

  return t[type] || t.custom;
}

// ── Main handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const {
      type = "custom",
      sender = "oceanbaby",
      to,
      data = {},
    } = req.body;

    if (!to && !TEST_MODE) {
      return res.status(400).json({ success: false, error: "Missing recipient (to)" });
    }

    const senderConfig = SENDERS[sender] || SENDERS.oceanbaby;
    const { subject, html } = buildEmail(type, data);

    // 测试模式：只发给 BCC
    const actualTo = TEST_MODE ? ALWAYS_BCC : (Array.isArray(to) ? to[0] : to);
    const actualSubject = TEST_MODE ? `[TEST] ${subject}` : subject;

    const dmResult = await sendViaDM({
      fromAlias: senderConfig.email,
      fromName: senderConfig.name,
      to: actualTo,
      subject: actualSubject,
      htmlBody: html,
    });

    // 非测试模式，额外发一份给 BCC
    if (!TEST_MODE && ALWAYS_BCC && ALWAYS_BCC !== actualTo) {
      await sendViaDM({
        fromAlias: senderConfig.email,
        fromName: senderConfig.name,
        to: ALWAYS_BCC,
        subject: `[COPY] ${subject}`,
        htmlBody: html,
      }).catch(e => console.warn("[BCC]", e.message));
    }

    console.log(`[send-email] ${TEST_MODE ? "TEST " : ""}${type} → ${actualTo}`, dmResult);

    if (dmResult.EnvId || dmResult.RequestId) {
      return res.status(200).json({ success: true, type, to: actualTo, testMode: TEST_MODE });
    } else {
      return res.status(500).json({ success: false, error: dmResult.Message || "DirectMail error", detail: dmResult });
    }

  } catch (err) {
    console.error("[send-email] error:", err);
    return res.status(500).json({ success: false, error: err.message || "Send failed" });
  }
}
