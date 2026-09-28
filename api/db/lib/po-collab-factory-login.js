// po-collab-factory-login.js — 采购单协同·工厂版「邮箱验证码登录 / 重设密码」

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { generateToken } from "../../auth.js";
import { clientIp } from "./login-guard.js";
import { resolveToken, FACTORY_ROLES } from "./po-collab-handlers.js";
import { EMAIL_RE, norm, splitEmails, hashCode, guardStart, guardEnd } from "./po-collab-customer-login.js";

const CODE_MIN = 15, MAX_TRIES = 5, MAX_FAILS_PER_HOUR = 10, MAX_SENDS_PER_HOUR = 5, MAX_SENDS_PER_IP_HOUR = 20, PW_MIN = 8;
const NOT_ON_FILE = "这个邮箱不是我们登记的贵司邮箱，请用我们给贵司发采购单的那个邮箱，或联系我们";

function codesOf(u) {
  return (Array.isArray(u.company_codes) && u.company_codes.length) ? u.company_codes : [u.company_code].filter(Boolean);
}

async function companyOfSheet(pool, sheet) {
  const r = await pool.query(
    `SELECT id, code, name_cn, name_en, active, contact_email, biz_contact_email, fin_contact_email, cc_emails
       FROM companies WHERE id=$1 LIMIT 1`, [sheet.factory_company_id]);
  const c = r.rows[0];
  if (!c || c.active === false || String(c.code || "").startsWith("DEPRECATED")) return null;
  const emails = new Set(splitEmails([c.contact_email, c.biz_contact_email, c.fin_contact_email, c.cc_emails]));
  return { ...c, emails };
}

async function checkSendLimits(pool, email, ip) {
  const sent = (await pool.query(
    `SELECT COUNT(*)::int n FROM collab.customer_login_code
      WHERE email=$1 AND created_at > NOW() - interval '1 hour'
        AND sheet_id IN (SELECT id FROM collab.po_sheet WHERE side='factory')`, [email])).rows[0].n;
  if (sent >= MAX_SENDS_PER_HOUR) return "email";
  const byIp = (await pool.query(
    `SELECT COUNT(*)::int n FROM collab.customer_login_code
      WHERE ip=$1 AND created_at > NOW() - interval '1 hour'
        AND sheet_id IN (SELECT id FROM collab.po_sheet WHERE side='factory')`, [ip])).rows[0].n;
  return byIp >= MAX_SENDS_PER_IP_HOUR ? "ip" : "";
}

export async function handleFactoryLoginCode(req, res, pool) {
  const email = norm(req.body?.email);
  if (!EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: "请输入有效邮箱" });
  const { sheet, err } = await resolveToken(pool, req.body?.token);
  if (err) return res.status(403).json({ ok: false, error: err });
  const ip = clientIp(req);
  const g = await guardStart(pool, email, ip, "po-code");
  if (g.lock) return res.status(429).json({ ok: false, error: "尝试次数过多，请稍后再试", retry_after_s: g.lock.retry_after_s });

  const co = await companyOfSheet(pool, sheet);
  if (!co || !co.emails.has(email)) {
    await guardEnd(pool, g, "fail");
    return res.status(403).json({ ok: false, error: NOT_ON_FILE });
  }
  if (await checkSendLimits(pool, email, ip)) {
    await guardEnd(pool, g, "blocked");
    return res.status(429).json({ ok: false, error: "验证码请求过多，请一小时后再试" });
  }

  const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
  await pool.query(
    `INSERT INTO collab.customer_login_code (email, company_code, sheet_id, code_hash, expires_at, ip)
     VALUES ($1,$2,$3,$4,NOW() + make_interval(mins => ${CODE_MIN}),$5)`, [email, co.code, sheet.id, hashCode(email, code), ip]);
  await pool.query(
    `INSERT INTO mail_outbox (tpl_key, sender_key, to_emails, cc_emails, subject, body_html, entity_type, entity_id,
                              related_contract_no, status, prepared_by, counterparty_code)
     VALUES ('order_collab_login_code','petbaby',$1::jsonb,'[]'::jsonb,$2,$3,'po_sheet',$4,NULL,'approved','order-collab-notify',NULL)`,
    [JSON.stringify([email]), `采购单协同登录验证码:${code}`,
     `<p>您的采购单协同登录验证码是 <b style="font-size:18px;letter-spacing:2px">${code}</b>，${CODE_MIN} 分钟内有效。</p>`
     + `<p>如果已有账号，本次验证会重设密码，旧密码将作废。</p><p>非本人操作请忽略本邮件。</p><p>厦门巴匕进出口有限公司</p>`, sheet.id]);
  await guardEnd(pool, g, "ok");
  return res.json({ ok: true, expires_min: CODE_MIN });
}

export async function handleFactoryLoginVerify(req, res, pool) {
  const email = norm(req.body?.email), code = String(req.body?.code || "").trim(), pw = String(req.body?.password || "");
  if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ ok: false, error: "请输入邮箱和 6 位验证码" });
  if (pw.length < PW_MIN) return res.status(400).json({ ok: false, error: `密码至少 ${PW_MIN} 位` });
  const { sheet, err } = await resolveToken(pool, req.body?.token);
  if (err) return res.status(403).json({ ok: false, error: err });
  const ip = clientIp(req);
  const g = await guardStart(pool, email, ip, "po-code");
  if (g.lock) return res.status(429).json({ ok: false, error: "尝试次数过多，请稍后再试", retry_after_s: g.lock.retry_after_s });

  const co = await companyOfSheet(pool, sheet);
  if (!co || !co.emails.has(email)) { await guardEnd(pool, g, "fail"); return res.status(403).json({ ok: false, error: NOT_ON_FILE }); }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, ["po-factory-login:" + email]);
    const fails = (await client.query(
      `SELECT COALESCE(SUM(tries),0)::int n FROM collab.customer_login_code
        WHERE email=$1 AND created_at > NOW() - interval '1 hour'
          AND sheet_id IN (SELECT id FROM collab.po_sheet WHERE side='factory')`, [email])).rows[0].n;
    if (fails >= MAX_FAILS_PER_HOUR) { await client.query("ROLLBACK"); await guardEnd(pool, g, "blocked"); return res.status(429).json({ ok: false, error: "尝试次数过多，请一小时后再试" }); }
    const row = (await client.query(
      `SELECT id, code_hash, tries FROM collab.customer_login_code
        WHERE email=$1 AND company_code=$2 AND sheet_id=$3 AND used_at IS NULL AND expires_at > NOW() AND tries < ${MAX_TRIES}
        ORDER BY id DESC LIMIT 1 FOR UPDATE`, [email, co.code, sheet.id])).rows[0];
    const want = Buffer.from(hashCode(email, code)), have = Buffer.from(row ? String(row.code_hash) : "");
    const good = !!row && have.length === want.length && crypto.timingSafeEqual(have, want);
    if (!good) {
      if (row) await client.query(`UPDATE collab.customer_login_code SET tries = tries + 1 WHERE id=$1`, [row.id]);
      await client.query("COMMIT");
      await guardEnd(pool, g, "fail");
      return res.status(401).json({ ok: false, error: "验证码错误或已过期，请重新获取" });
    }
    await client.query(`UPDATE collab.customer_login_code SET used_at=NOW() WHERE id=$1`, [row.id]);

    const hash = await bcrypt.hash(pw, 12);
    let acct = (await client.query(
      `SELECT id, username, role, company, supplier_role, company_code, company_codes, is_active, token_version, raw
         FROM accounts WHERE lower(email)=$1 OR lower(username)=$1 ORDER BY id LIMIT 2`, [email])).rows;
    if (acct.length > 1) { await client.query("ROLLBACK"); await guardEnd(pool, g, "fail"); return res.status(409).json({ ok: false, error: "请联系我们处理这个邮箱的登录" }); }
    let u = acct[0];
    if (u) {
      if (u.is_active === false) {
        await client.query("ROLLBACK"); await guardEnd(pool, g, "fail");
        return res.status(403).json({ ok: false, error: "这个账号已停用，请联系我们" });
      }
      if (!FACTORY_ROLES.includes(String(u.role || "").toLowerCase()) || !codesOf(u).includes(co.code)) {
        await client.query("ROLLBACK"); await guardEnd(pool, g, "fail");
        return res.status(403).json({ ok: false, error: "请联系我们处理这个邮箱的登录" });
      }
      await client.query(
        `UPDATE accounts SET password=$2, updated_at=NOW(), token_version = COALESCE(token_version,1) + 1,
                raw = COALESCE(raw,'{}'::jsonb) - 'must_reset_password' || jsonb_build_object('pw_set_via','po_collab_email_code','pw_set_at',NOW())
          WHERE id=$1 RETURNING token_version`, [u.id, hash]).then((r) => { u.token_version = r.rows[0].token_version; });
    } else {
      u = (await client.query(
        `INSERT INTO accounts (username, password, role, company, company_code, company_codes, email, is_active, token_version, raw, created_at, updated_at)
         VALUES ($1::text,$2,'factory',$3,$4::text,ARRAY[$4::text],$1::text,true,1,$5::jsonb,NOW(),NOW())
         RETURNING id, username, role, company, supplier_role, company_code, company_codes, token_version, raw`,
        [email, hash, co.name_cn || co.name_en || co.code, co.code,
         JSON.stringify({ created_via: "po_collab_email_code", sheet_id: sheet.id })])).rows[0];
    }
    await client.query(
      `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail) VALUES ($1,'factory_login_activated','factory',$2,$3::jsonb)`,
      [sheet.id, email, JSON.stringify({ account_id: u.id, new_account: !acct[0] })]);
    await client.query("COMMIT");
    await guardEnd(pool, g, "ok");

    const raw = u.raw && typeof u.raw === "object" ? u.raw : {};
    const token = generateToken({
      uid: u.id, username: u.username, role: u.role, company: u.company, supplierRole: u.supplier_role,
      companyCode: u.company_code, companyCodes: codesOf(u), access: Array.isArray(raw.access) ? raw.access : [], tv: u.token_version || 1,
    });
    return res.json({ ok: true, token, new_account: !acct[0] });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    await guardEnd(pool, g, "fail");
    throw e;
  } finally { client.release(); }
}
