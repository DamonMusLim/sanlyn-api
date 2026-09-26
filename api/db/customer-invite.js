import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { checkRateLimit, recordFailure } from "../portal/login-ratelimit.js";

const SET_PASSWORD_BASE = "https://client.sanlyn.cn/set-password.html";
const GENERIC_MESSAGE = "如果该邮箱已注册,我们已发送设置密码的链接";
const FROM = "OCEANBABY <ob@sanlynos.com>";

async function buildTransport() {
  if (!process.env.SMTP_HOST) return null;
  const nodemailer = (await import("nodemailer")).default;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== "false",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

function sha256(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

function rawToken() {
  return crypto.randomBytes(24).toString("hex");
}

function clean(v, max = 256) {
  return String(v || "").trim().slice(0, max);
}

function firstEmail(value) {
  return String(value || "").split(/[\s/,;]+/).map((x) => x.trim()).find(Boolean) || "";
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function maskEmail(email) {
  const [name, domain] = String(email || "").split("@");
  if (!name || !domain) return "";
  const head = name.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, name.length - 2))}@${domain}`;
}

function ipOf(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown";
}

function isAdminRole(user) {
  const role = String(user?.role || "").toLowerCase();
  return role === "admin" || role === "internal";
}

async function insertMagicLink(pool, account, email) {
  const raw = rawToken();
  const meta = {
    company_code: account.company_code || "",
    account_id: account.id,
    email,
  };
  await pool.query(
    `INSERT INTO magic_links
       (token_hash, recipient_role, meta, access_log, expires_at, created_at, created_by)
     VALUES
       ($1, 'customer_set_password', $2::jsonb, '[]'::jsonb,
        NOW() + INTERVAL '24 hours', NOW(), 'customer-invite')`,
    [sha256(raw), JSON.stringify(meta)]
  );
  return raw;
}

async function sendInvite(email, token) {
  const link = `${SET_PASSWORD_BASE}?token=${encodeURIComponent(token)}`;
  const live = process.env.DOC_MAIL_LIVE === "1";
  if (!live) return { sent: false, dryrun: true };

  const transport = await buildTransport();
  if (!transport) return { sent: false, skipped: "smtp_not_configured" };

  await transport.sendMail({
    from: FROM,
    to: email,
    subject: "Set your OCEANBABY customer portal password",
    text: link,
  });
  return { sent: true };
}

async function findByCompanyCode(pool, companyCode) {
  const { rows } = await pool.query(
    `SELECT a.id, a.company_code,
            COALESCE(NULLIF(co.contact_email,''), NULLIF(co.einvoice_email,''), NULLIF(co.biz_contact_email,''), NULLIF(co.fin_contact_email,''), NULLIF(c.contact_email,'')) AS contact_email
       FROM accounts a
  LEFT JOIN companies co ON co.code = a.company_code
  LEFT JOIN customers c ON c.company_code = a.company_code
      WHERE a.role = 'customer'
        AND a.company_code = $1
      ORDER BY a.id
      LIMIT 1`,
    [companyCode]
  );
  const row = rows[0];
  if (!row) return null;
  const email = firstEmail(row.contact_email);
  return email ? { id: row.id, company_code: row.company_code, email } : null;
}

async function findActiveByEmail(pool, email) {
  const { rows } = await pool.query(
    `SELECT a.id, a.company_code,
            COALESCE(NULLIF(co.contact_email,''), NULLIF(co.einvoice_email,''), NULLIF(co.biz_contact_email,''), NULLIF(co.fin_contact_email,''), NULLIF(c.contact_email,'')) AS contact_email
       FROM accounts a
  LEFT JOIN companies co ON co.code = a.company_code
  LEFT JOIN customers c ON c.company_code = a.company_code
      WHERE a.role = 'customer'
        AND COALESCE(a.is_active, true) IS TRUE
        AND COALESCE(c.is_active, true) IS TRUE
        AND (co.contact_email ILIKE $1 OR co.einvoice_email ILIKE $1 OR co.biz_contact_email ILIKE $1 OR co.fin_contact_email ILIKE $1 OR c.contact_email ILIKE $1)
      ORDER BY a.id
      LIMIT 20`,
    [`%${email}%`]
  );
  const row = rows.find((r) => String(r.contact_email || "").toLowerCase().includes(email));
  return row ? { id: row.id, company_code: row.company_code, email } : null;
}

async function handleAdmin(req, res, pool, companyCode) {
  if (!requireAuth(req, res)) return;
  if (!isAdminRole(req.user)) return res.status(403).json({ ok: false, error: "forbidden" });

  const account = await findByCompanyCode(pool, companyCode);
  if (!account) return res.status(404).json({ ok: false, error: "customer_account_or_email_not_found" });

  const token = await insertMagicLink(pool, account, account.email);
  const mail = await sendInvite(account.email, token);
  return res.status(200).json({
    ok: true,
    sent: mail.sent === true,
    email_masked: maskEmail(account.email),
  });
}

async function handleSelfService(req, res, pool, email) {
  const ip = ipOf(req);
  const ipKey = `ip:${ip}`;
  const emailKey = `ip:username:${ip}:${email || "blank"}`;
  if (checkRateLimit(ipKey) || checkRateLimit(emailKey)) {
    recordFailure(ipKey);
    recordFailure(emailKey);
    return res.status(200).json({ ok: true, message: GENERIC_MESSAGE });
  }
  recordFailure(ipKey);
  recordFailure(emailKey);

  if (validEmail(email)) {
    const account = await findActiveByEmail(pool, email);
    if (account) {
      const token = await insertMagicLink(pool, account, account.email);
      await sendInvite(account.email, token);
    }
  }
  return res.status(200).json({ ok: true, message: GENERIC_MESSAGE });
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  const pool = getPool();
  const body = req.body || {};
  const companyCode = clean(body.company_code, 64);
  const email = clean(body.email, 256).toLowerCase();

  if (companyCode) return handleAdmin(req, res, pool, companyCode);
  return handleSelfService(req, res, pool, email);
}
