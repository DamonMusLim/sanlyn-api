import crypto from "node:crypto";
import { getPool, setCors } from "../db.js";
import { checkRateLimit, recordFailure } from "../portal/login-ratelimit.js";

const BASE_URL = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";
const WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || "";
const OK_MESSAGE = "已收到申请,我们会在1个工作日内审核,通过后邮件通知您设置密码";
const LIMIT_MESSAGE = "提交太频繁,请稍后再试";

function makeToken() {
  return crypto.randomBytes(24).toString("hex");
}

function cleanText(v, max) {
  return String(v || "").trim().slice(0, max);
}

function ipOf(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown";
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function ensureTable(pool) {
  await pool.query(`CREATE TABLE IF NOT EXISTS factory_invites (
    id SERIAL PRIMARY KEY, token VARCHAR(64) UNIQUE NOT NULL,
    type VARCHAR(20) DEFAULT 'factory', factory_name VARCHAR(128),
    contact_name VARCHAR(64), contact_email VARCHAR(128), contact_phone VARCHAR(32),
    channel VARCHAR(16) DEFAULT 'email', channel_value VARCHAR(128), tax_id VARCHAR(32),
    message TEXT, invited_by VARCHAR(64), note TEXT, status VARCHAR(20) DEFAULT 'pending',
    reviewed_by VARCHAR(64), reviewed_at TIMESTAMPTZ, review_note TEXT,
    documents JSONB DEFAULT '{}'::jsonb, ip VARCHAR(45), user_agent TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(), expires_at TIMESTAMPTZ, used_at TIMESTAMPTZ
  )`);
}

async function hasColumn(pool, name) {
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_name='factory_invites' AND column_name=$1 LIMIT 1`,
    [name]
  );
  return rows.length > 0;
}

async function emailLooksActive(pool, email) {
  const probes = [
    "SELECT 1 FROM customers WHERE lower(email)=lower($1) LIMIT 1",
    "SELECT 1 FROM customers WHERE lower(contact_email)=lower($1) LIMIT 1",
    "SELECT 1 FROM accounts WHERE lower(email)=lower($1) LIMIT 1",
    "SELECT 1 FROM accounts WHERE lower(username)=lower($1) LIMIT 1",
  ];
  for (const sql of probes) {
    try {
      const { rows } = await pool.query(sql, [email]);
      if (rows.length) return true;
    } catch (_) {}
  }
  return false;
}

async function pingAdmin({ companyName, email, suspectedExisting }) {
  if (!WECOM_WEBHOOK) return { skipped: true };
  const content = ["## 新客户申请开户", `**客户:** ${companyName} / ${email}`,
    suspectedExisting ? "**内部提示:** 疑似已存在客户或账号" : "",
    `[打开审核队列](${BASE_URL}/admin/invitations)`].filter(Boolean).join("\n");
  try {
    await fetch(WECOM_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content } }),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  const body = req.body || {};
  const email = cleanText(body.email, 128).toLowerCase();
  const companyName = cleanText(body.company_name, 128);
  const ip = ipOf(req);
  const ipKey = `ip:${ip}`;
  const emailKey = `ip:username:${ip}:${email || "blank"}`;
  if (checkRateLimit(ipKey) || checkRateLimit(emailKey)) {
    recordFailure(ipKey); recordFailure(emailKey);
    return res.status(429).json({ ok: false, message: LIMIT_MESSAGE });
  }
  recordFailure(ipKey); recordFailure(emailKey);

  if (!validEmail(email)) {
    return res.status(400).json({ ok: false, message: "请填写邮箱" });
  }

  const pool = getPool();
  await ensureTable(pool);
  const token = makeToken();
  const note = "self_apply";
  const ua = req.headers["user-agent"] || null;
  const suspectedExisting = await emailLooksActive(pool, email);
  const hasSource = await hasColumn(pool, "source");
  const fields = hasSource
    ? "(token,type,status,source,contact_email,factory_name,channel,channel_value,invited_by,message,note,ip,user_agent,created_at)"
    : "(token,type,status,contact_email,factory_name,channel,channel_value,invited_by,message,note,ip,user_agent,created_at)";
  const values = hasSource
    ? [token, "customer", "pending", "self_apply", email, companyName, "email", email, "public_apply", null, note, ip, ua]
    : [token, "customer", "pending", email, companyName, "email", email, "public_apply", null, note, ip, ua];
  const marks = values.map((_, i) => `$${i + 1}`).join(",");
  await pool.query(`INSERT INTO factory_invites ${fields} VALUES (${marks},NOW())`, values);
  await pingAdmin({ companyName, email, suspectedExisting });
  return res.status(200).json({ ok: true, message: OK_MESSAGE });
}
