// wx-mini-login.js — 小程序微信登录（无JWT,自成鉴权,mount在authMiddleware之前）
// 流程：wx.login的code → jscode2session换openid → 查account_identities(wechat_mini)
//   已绑 → 直接签JWT返回
//   未绑 → 返回 need_bind;前端引导输入Sanlyn账号密码 → 带 code+username+password 再来 → 校验密码后落绑定 → 签JWT
import { getPool, setCors } from "./db.js";
import { generateToken } from "./auth.js";
import bcrypt from "bcryptjs";

const APPID = process.env.WX_MINI_APPID;
const SECRET = process.env.WX_MINI_SECRET;

async function code2session(code) {
  const url = `https://api.weixin.qq.com/sns/jscode2session?appid=${APPID}&secret=${SECRET}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const r = await fetch(url);
  return r.json(); // { openid, session_key, unionid? } | { errcode, errmsg }
}

async function loadAccount(pool, accountId) {
  const r = await pool.query(
    `SELECT a.id, a.username, a.role, a.company, a.supplier_role, a.company_code,
            a.company_codes, a.raw, COALESCE(a.token_version,1) AS token_version,
            COALESCE(a.is_active,true) AS is_active
       FROM accounts a WHERE a.id = $1`, [accountId]);
  return r.rows[0] || null;
}

function signFor(u) {
  let rawObj = u.raw || {};
  if (typeof rawObj === "string") { try { rawObj = JSON.parse(rawObj); } catch { rawObj = {}; } }
  const access = Array.isArray(rawObj.access) ? rawObj.access : [];
  const companyCodes = Array.isArray(u.company_codes) ? u.company_codes : (u.company_codes ? [u.company_codes] : []);
  return generateToken({
    uid: u.id, username: u.username, role: u.role, company: u.company,
    supplierRole: u.supplier_role, companyCode: u.company_code, companyCodes,
    access, tv: u.token_version || 1,
  });
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!APPID || !SECRET) return res.status(500).json({ error: "小程序凭证未配置" });

  const { code, username, password } = req.body || {};
  if (!code) return res.status(400).json({ error: "code required" });

  const sess = await code2session(code);
  if (!sess.openid) return res.status(400).json({ error: "wx登录失败", detail: sess.errmsg || sess });
  const openid = sess.openid;

  const pool = getPool();

  // 已绑定？
  const bound = await pool.query(
    `SELECT account_id FROM account_identities WHERE provider='wechat_mini' AND subject=$1 LIMIT 1`, [openid]);
  if (bound.rowCount > 0) {
    const acc = await loadAccount(pool, bound.rows[0].account_id);
    if (!acc || acc.is_active === false) return res.status(403).json({ error: "账号已停用" });
    return res.status(200).json({ token: signFor(acc), user: { uid: acc.id, username: acc.username, role: acc.role } });
  }

  // 未绑：需要账号密码首次绑定
  if (!username || !password) {
    return res.status(200).json({ need_bind: true, message: "首次使用请输入 Sanlyn 账号密码绑定" });
  }
  const r = await pool.query(
    `SELECT id, username, password, COALESCE(is_active,true) AS is_active FROM accounts WHERE username=$1 LIMIT 1`, [username]);
  const u = r.rows[0];
  if (!u || u.is_active === false) return res.status(401).json({ error: "账号不存在或已停用" });
  const stored = u.password || "";
  const ok = stored.startsWith("$2") ? await bcrypt.compare(password, stored) : stored === password;
  if (!ok) return res.status(401).json({ error: "密码错误" });

  await pool.query(
    `INSERT INTO account_identities (account_id, provider, subject, verified_at, raw)
     VALUES ($1,'wechat_mini',$2,NOW(),$3::jsonb)
     ON CONFLICT (provider,subject) DO UPDATE SET account_id=EXCLUDED.account_id, verified_at=NOW()`,
    [String(u.id), openid, JSON.stringify({ unionid: sess.unionid || null })]);

  const acc = await loadAccount(pool, u.id);
  return res.status(200).json({ token: signFor(acc), user: { uid: acc.id, username: acc.username, role: acc.role }, bound: true });
}
