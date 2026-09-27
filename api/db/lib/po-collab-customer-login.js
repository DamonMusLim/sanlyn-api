// po-collab-customer-login.js — 订单协同·客户版「邮箱验证码首次登录」（Damon 0927）
// Damon 原话：「他们都有邮箱了,让他们用邮箱登入,初次登入账号不就好了」
//
//   POST /login-code   {token, email}               → 给这个邮箱发 6 位验证码（15 分钟有效）
//   POST /login-verify {token, email, code, password} → 验码 + 设密码 → 没账号就建客户账号 → 直接登录（回 JWT）
//
// 🔴 安全闸
//   ① 只认【这张单的客户公司、由我方维护的邮箱】：companies.contact_email / biz_contact_email / cc_emails
//      ⛔ 不认 order_notify_emails —— 那是客户自己在页面上填的，只能当收件人，不能当身份（DeepSeek 0927 审）
//      只认链接自己那张单（忽略请求里的 sheet 参数），链接被转发出去，拿别的邮箱也激活不了
//   ② 验证码只存 hash；单码错 5 次作废、同邮箱 1 小时累计错 10 次锁；每邮箱每小时发 5 次、每 IP 每小时 20 次；
//      发码/验码都走 login-guard 锁；重设密码 token_version+1（旧会话全部失效）
//   ③ 邮箱已有账号：必须是 customer 且公司对得上才允许用验证码重设密码（内部/工厂账号一律拒绝）
//   ④ 新账号：username=邮箱、role=customer、只绑这张单的客户公司
//   ⑤ 验证码信走 mail_outbox → mini order-collab-sender（pb@ 发），⛔ 这里不直接连邮箱

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { generateToken } from "../../auth.js";
import { beginLoginAttempt, checkLoginLock, finishLoginAttempt, clientIp } from "./login-guard.js";
import { resolveCustomerToken } from "./po-collab-customer.js";

const CODE_MIN = 15, MAX_TRIES = 5, MAX_FAILS_PER_HOUR = 10, MAX_SENDS_PER_HOUR = 5, MAX_SENDS_PER_IP_HOUR = 20, PW_MIN = 8;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
const norm = (e) => String(e || "").trim().toLowerCase();
const hashCode = (email, code) => {
  if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET 未设置");   // ⛔ 不留回退 key
  return crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${norm(email)}:${code}`).digest("hex");
};
const guardKey = (email) => `oc-code:${norm(email)}`;

// 接 login-guard v2（跟 auth-login 同一套：先记一次尝试 → 查锁 → 收尾 ok/fail/blocked）
async function guardStart(pool, email, ip) {
  const attempt = await beginLoginAttempt(pool, guardKey(email), ip);
  let lock = await checkLoginLock(pool, guardKey(email), ip, attempt?.id || null);
  if (lock?.disabled) lock = null;               // 防护表坏了 → 放行（与 auth-login 一致）
  if (lock) await finishLoginAttempt(pool, attempt, "blocked");
  return { attempt, lock };
}
const guardEnd = (pool, g, outcome) => finishLoginAttempt(pool, g.attempt, outcome).catch(() => null);

// 这张单的客户公司 + 在档邮箱
async function companyOfSheet(pool, sheet) {
  const r = await pool.query(
    `SELECT c.id, c.code, c.name_en, c.name_cn, c.contact_email, c.biz_contact_email, c.cc_emails
       FROM orders o JOIN companies c ON c.code = o.company_code WHERE o.order_no=$1 LIMIT 1`, [sheet.order_no]);
  const c = r.rows[0];
  if (!c) return null;
  const emails = new Set([c.contact_email, c.biz_contact_email, ...(c.cc_emails || [])]
    .map(norm).filter((e) => EMAIL_RE.test(e)));
  return { ...c, emails };
}

const NOT_ON_FILE = "This email is not registered with us for this company. Please use the email we send your documents to, or contact us.";

// ── POST /login-code ──
export async function handleCustomerLoginCode(req, res, pool) {
  const email = norm(req.body?.email);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: "Please enter a valid email." });
  const { sheet, err } = await resolveCustomerToken(pool, req.body?.token);
  if (err) return res.status(403).json({ ok: false, error: err });
  const ip = clientIp(req);
  const g = await guardStart(pool, email, ip);
  if (g.lock) return res.status(429).json({ ok: false, error: "Too many attempts. Please try again later.", retry_after_s: g.lock.retry_after_s });

  const co = await companyOfSheet(pool, sheet);
  if (!co || !co.emails.has(email)) {
    await guardEnd(pool, g, "fail");
    return res.status(403).json({ ok: false, error: NOT_ON_FILE });
  }
  const sent = (await pool.query(
    `SELECT COUNT(*)::int n FROM collab.customer_login_code WHERE email=$1 AND created_at > NOW() - interval '1 hour'`, [email])).rows[0].n;
  if (sent >= MAX_SENDS_PER_HOUR) { await guardEnd(pool, g, "blocked"); return res.status(429).json({ ok: false, error: "Too many codes requested. Please try again in an hour." }); }
  const byIp = (await pool.query(
    `SELECT COUNT(*)::int n FROM collab.customer_login_code WHERE ip=$1 AND created_at > NOW() - interval '1 hour'`, [ip])).rows[0].n;
  if (byIp >= MAX_SENDS_PER_IP_HOUR) { await guardEnd(pool, g, "blocked"); return res.status(429).json({ ok: false, error: "Too many codes requested. Please try again in an hour." }); }

  const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
  await pool.query(
    `INSERT INTO collab.customer_login_code (email, company_code, sheet_id, code_hash, expires_at, ip)
     VALUES ($1,$2,$3,$4,NOW() + make_interval(mins => ${CODE_MIN}),$5)`, [email, co.code, sheet.id, hashCode(email, code), ip]);
  await pool.query(
    `INSERT INTO mail_outbox (tpl_key, sender_key, to_emails, cc_emails, subject, body_html, entity_type, entity_id,
                              related_contract_no, status, prepared_by, counterparty_code)
     VALUES ('order_collab_login_code','petbaby',$1::jsonb,'[]'::jsonb,$2,$3,'po_sheet',$4,NULL,'approved','order-collab-notify',NULL)`,
    [JSON.stringify([email]), `Your login code: ${code}`,
     `<p>Your login code is <b style="font-size:18px;letter-spacing:2px">${code}</b>. It expires in ${CODE_MIN} minutes.</p>`
     + `<p>If you did not request it, ignore this email.</p><p>Xiamen Pet Baby Import and Export Co., Ltd.</p>`, sheet.id]);
  await guardEnd(pool, g, "ok");
  return res.json({ ok: true, expires_min: CODE_MIN });
}

// ── POST /login-verify ──
export async function handleCustomerLoginVerify(req, res, pool) {
  const email = norm(req.body?.email), code = String(req.body?.code || "").trim(), pw = String(req.body?.password || "");
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "Please enter your email and the 6-digit code." });
  if (pw.length < PW_MIN) return res.status(400).json({ ok: false, error: `Password must be at least ${PW_MIN} characters.` });
  const { sheet, err } = await resolveCustomerToken(pool, req.body?.token);
  if (err) return res.status(403).json({ ok: false, error: err });
  const ip = clientIp(req);
  const g = await guardStart(pool, email, ip);
  if (g.lock) return res.status(429).json({ ok: false, error: "Too many attempts. Please try again later.", retry_after_s: g.lock.retry_after_s });

  const co = await companyOfSheet(pool, sheet);
  if (!co || !co.emails.has(email)) { await guardEnd(pool, g, "fail"); return res.status(403).json({ ok: false, error: NOT_ON_FILE }); }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["oc-login:" + email]);   // 同邮箱串行，防并发建两个号
    const fails = (await client.query(
      `SELECT COALESCE(SUM(tries),0)::int n FROM collab.customer_login_code WHERE email=$1 AND created_at > NOW() - interval '1 hour'`, [email])).rows[0].n;
    if (fails >= MAX_FAILS_PER_HOUR) { await client.query("ROLLBACK"); await guardEnd(pool, g, "blocked"); return res.status(429).json({ ok: false, error: "Too many attempts. Please try again in an hour." }); }
    // 最新一条未用、未过期、未超次数的码
    const row = (await client.query(
      `SELECT id, code_hash, tries FROM collab.customer_login_code
        WHERE email=$1 AND company_code=$2 AND used_at IS NULL AND expires_at > NOW() AND tries < ${MAX_TRIES}
        ORDER BY id DESC LIMIT 1 FOR UPDATE`, [email, co.code])).rows[0];
    const want = Buffer.from(hashCode(email, code)), have = Buffer.from(row ? String(row.code_hash) : "");
    const good = !!row && have.length === want.length && crypto.timingSafeEqual(have, want);
    if (!good) {
      if (row) await client.query(`UPDATE collab.customer_login_code SET tries = tries + 1 WHERE id=$1`, [row.id]);
      await client.query("COMMIT");
      await guardEnd(pool, g, "fail");
      return res.status(401).json({ ok: false, error: "The code is wrong or has expired. Please request a new one." });
    }
    await client.query(`UPDATE collab.customer_login_code SET used_at=NOW() WHERE id=$1`, [row.id]);

    const hash = await bcrypt.hash(pw, 12);
    let acct = (await client.query(
      `SELECT id, username, role, company, supplier_role, company_code, company_codes, token_version, raw
         FROM accounts WHERE lower(email)=$1 OR lower(username)=$1 ORDER BY id LIMIT 2`, [email])).rows;
    if (acct.length > 1) { await client.query("ROLLBACK"); return res.status(409).json({ ok: false, error: "Please contact us to log in with this email." }); }
    let u = acct[0];
    if (u) {
      // 已有账号：只允许本公司的客户账号用验证码重设密码
      const codes = (u.company_codes && u.company_codes.length) ? u.company_codes : [u.company_code].filter(Boolean);
      if (String(u.role || "").toLowerCase() !== "customer" || !codes.includes(co.code)) {
        await client.query("ROLLBACK");
        return res.status(403).json({ ok: false, error: "Please contact us to log in with this email." });
      }
      await client.query(
        `UPDATE accounts SET password=$2, is_active=true, updated_at=NOW(), token_version = COALESCE(token_version,1) + 1,
                raw = COALESCE(raw,'{}'::jsonb) - 'must_reset_password' || jsonb_build_object('pw_set_via','order_collab_email_code','pw_set_at',NOW())
          WHERE id=$1 RETURNING token_version`, [u.id, hash]).then((r) => { u.token_version = r.rows[0].token_version; });
    } else {
      u = (await client.query(
        `INSERT INTO accounts (username, password, role, company, company_code, company_codes, email, is_active, token_version, raw, created_at, updated_at)
         VALUES ($1::text,$2,'customer',$3,$4::text,ARRAY[$4::text],$1::text,true,1,$5::jsonb,NOW(),NOW())
         RETURNING id, username, role, company, supplier_role, company_code, company_codes, token_version, raw`,
        [email, hash, co.name_en || co.name_cn || co.code, co.code,
         JSON.stringify({ created_via: "order_collab_email_code", sheet_id: sheet.id })])).rows[0];
    }
    await client.query(
      `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail) VALUES ($1,'customer_login_activated','customer',$2,$3::jsonb)`,
      [sheet.id, email, JSON.stringify({ account_id: u.id, new_account: !acct[0] })]);
    await client.query("COMMIT");
    await guardEnd(pool, g, "ok");

    const companyCodes = (u.company_codes && u.company_codes.length) ? u.company_codes : [u.company_code].filter(Boolean);
    const raw = u.raw && typeof u.raw === "object" ? u.raw : {};
    const token = generateToken({
      uid: u.id, username: u.username, role: u.role, company: u.company, supplierRole: u.supplier_role,
      companyCode: u.company_code, companyCodes, access: Array.isArray(raw.access) ? raw.access : [], tv: u.token_version || 1,
    });
    return res.json({ ok: true, token, new_account: !acct[0] });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { client.release(); }
}
