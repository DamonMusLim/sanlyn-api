// /api/db/hr-staff-auth.mjs — 员工端登录（**公开路径**，手机号+密码）
//
//   POST {action:"login", phone, password}        → 校验成功返回限权 JWT(role=staff)
//   POST {action:"change_password", token, old, new}
//
// 🔒 为什么不是"只用手机号"：员工端要能看**自己的身份证和合同**，只凭手机号登录
//    等于同事之间互相知道号码就能看对方证件。所以必须有密码。
//    没走短信验证码是因为目前没有短信通道（订单线也卡在这）。
// 🔒 0802 改：**店长不再发初始密码**。新人先在 /m/staff 提申请(只进 hr_applicants)，
//    店长在后台一键录用建档，员工再来时凭手机号拿一枚 10 分钟的 set_password token，
//    自己设密码。申请人**不在花名册里**，employment_status 只剩 active|left。
// 🔒 防爆破：连错5次锁15分钟（记在 hr_employees.login_fail_count / locked_until）。
// 🔒 返回的 token 跟原来一样是限权的：role=staff + employee_id，进不了任何后台接口。
import crypto from "crypto";
import { getPool, setCors } from "./db.js";

const TOKEN_DAYS = 90;          // 员工自己登录的，比店长发的长效链接短
const MAX_FAIL = 5;
const LOCK_MIN = 15;
const STAFF_URL = "https://pet.sanlyn.cn/m/staff";
const OIDC_DEFAULT_ISSUER = "https://id.sanlyn.cn/oidc";
const OIDC_DEFAULT_REDIRECT = "https://api.sanlyn.cn/api/db/hr-staff-auth?action=oidc_callback";
const OIDC_STATE_TTL_MS = 10 * 60 * 1000;
const OIDC_COOKIE = "staff_oidc_state";
let oidcDiscoveryCache = null;
let oidcJwksCache = null;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function b64urlDecode(str) {
  str = String(str || "").replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  return Buffer.from(str, "base64");
}
function signStaffToken(employeeId, name) {
  const SECRET = process.env.JWT_SECRET;
  if (!SECRET) throw new Error("JWT_SECRET 未配置");
  const now = Math.floor(Date.now() / 1000);
  const seg = [b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
               b64url(JSON.stringify({ role: "staff", employee_id: employeeId, name, iat: now, exp: now + TOKEN_DAYS * 86400 }))];
  seg.push(b64url(crypto.createHmac("sha256", SECRET).update(seg.join(".")).digest()));
  return seg.join(".");
}
// 设密码专用的一次性短 token：只能调 set_password，进不了任何数据接口。
// 10 分钟到期；密码一旦设上，同一枚 token 再用也会被 password_hash 已存在挡掉。
function signSetPwToken(employeeId) {
  const SECRET = process.env.JWT_SECRET;
  if (!SECRET) throw new Error("JWT_SECRET 未配置");
  const now = Math.floor(Date.now() / 1000);
  const seg = [b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
               b64url(JSON.stringify({ role: "staff_setpw", employee_id: employeeId, iat: now, exp: now + 600 }))];
  seg.push(b64url(crypto.createHmac("sha256", SECRET).update(seg.join(".")).digest()));
  return seg.join(".");
}

// scrypt 加盐哈希（不引第三方依赖）
function hashPw(pw, salt) {
  const s = salt || crypto.randomBytes(16).toString("hex");
  return s + ":" + crypto.scryptSync(String(pw), s, 32).toString("hex");
}
function verifyPw(pw, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt] = stored.split(":");
  const a = Buffer.from(hashPw(pw, salt));
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
export { hashPw };

function oidcConfig() {
  const cfg = {
    issuer: process.env.STAFF_OIDC_ISSUER || OIDC_DEFAULT_ISSUER,
    clientId: process.env.STAFF_OIDC_CLIENT_ID,
    clientSecret: process.env.STAFF_OIDC_CLIENT_SECRET,
    redirectUri: process.env.STAFF_OIDC_REDIRECT_URI || OIDC_DEFAULT_REDIRECT,
    map: parseOidcMap(process.env.STAFF_OIDC_MAP || ""),
  };
  if (!cfg.clientId || !cfg.clientSecret || !Object.keys(cfg.map).length) return null;
  return cfg;
}
function parseOidcMap(raw) {
  const out = {};
  String(raw || "").split(",").forEach((part) => {
    const [sub, id] = part.split(":").map((x) => String(x || "").trim());
    if (sub && /^\d+$/.test(id)) out[sub] = Number(id);
  });
  return out;
}
function signState(payload) {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET 未配置");
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac("sha256", secret).update(body).digest());
  return body + "." + sig;
}
function verifyStateToken(token) {
  const secret = process.env.JWT_SECRET;
  if (!secret || !token) return null;
  const parts = String(token).split(".");
  if (parts.length !== 2) return null;
  const sig = b64url(crypto.createHmac("sha256", secret).update(parts[0]).digest());
  if (sig.length !== parts[1].length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(parts[1]))) return null;
  const payload = JSON.parse(b64urlDecode(parts[0]).toString());
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}
function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const hit = raw.split(";").map((x) => x.trim()).find((x) => x.startsWith(name + "="));
  return hit ? decodeURIComponent(hit.slice(name.length + 1)) : "";
}
function setOidcCookie(res, value) {
  res.setHeader("Set-Cookie", `${OIDC_COOKIE}=${encodeURIComponent(value)}; Max-Age=600; Path=/api/db/hr-staff-auth; HttpOnly; Secure; SameSite=Lax`);
}
function clearOidcCookie(res) {
  res.setHeader("Set-Cookie", `${OIDC_COOKIE}=; Max-Age=0; Path=/api/db/hr-staff-auth; HttpOnly; Secure; SameSite=Lax`);
}
function redirect(res, url) {
  res.statusCode = 302;
  res.setHeader("Location", url);
  return res.end();
}
function staffError(res, code) {
  clearOidcCookie(res);
  return redirect(res, `${STAFF_URL}?sso_error=${encodeURIComponent(code)}`);
}
async function oidcDiscovery(issuer) {
  if (oidcDiscoveryCache && oidcDiscoveryCache.issuer === issuer && oidcDiscoveryCache.exp > Date.now()) return oidcDiscoveryCache.doc;
  const r = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!r.ok) throw new Error("OIDC discovery failed");
  const doc = await r.json();
  oidcDiscoveryCache = { issuer, doc, exp: Date.now() + 10 * 60 * 1000 };
  return doc;
}
async function oidcJwks(jwksUri) {
  if (oidcJwksCache && oidcJwksCache.uri === jwksUri && oidcJwksCache.exp > Date.now()) return oidcJwksCache.keys;
  const r = await fetch(jwksUri);
  if (!r.ok) throw new Error("OIDC JWKS failed");
  const doc = await r.json();
  oidcJwksCache = { uri: jwksUri, keys: doc.keys || [], exp: Date.now() + 10 * 60 * 1000 };
  return oidcJwksCache.keys;
}
function verifyJwtSignature(token, jwk) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return false;
  const data = Buffer.from(parts[0] + "." + parts[1]);
  const sig = b64urlDecode(parts[2]);
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const alg = JSON.parse(b64urlDecode(parts[0]).toString()).alg;
  if (alg === "RS256") return crypto.verify("sha256", data, key, sig);
  if (alg === "ES256") return crypto.verify("sha256", data, { key, dsaEncoding: "ieee-p1363" }, sig);
  // 0926 实测 id.sanlyn.cn jwks = EC P-384 / ES384(Logto 默认),不加这行验签永远失败
  if (alg === "ES384") return crypto.verify("sha384", data, { key, dsaEncoding: "ieee-p1363" }, sig);
  return false;
}
async function verifyIdToken(token, cfg, jwksUri) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("bad id_token");
  const header = JSON.parse(b64urlDecode(parts[0]).toString());
  const keys = await oidcJwks(jwksUri);
  const jwk = keys.find((k) => (!header.kid || k.kid === header.kid) && k.alg === header.alg) ||
    keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk || !verifyJwtSignature(token, jwk)) throw new Error("bad id_token signature");
  const claims = JSON.parse(b64urlDecode(parts[1]).toString());
  const now = Math.floor(Date.now() / 1000);
  const audOk = Array.isArray(claims.aud) ? claims.aud.includes(cfg.clientId) : claims.aud === cfg.clientId;
  if (claims.iss !== cfg.issuer || !audOk || !claims.exp || claims.exp <= now) throw new Error("bad id_token claims");
  if (claims.nbf && claims.nbf > now) throw new Error("id_token not active");
  return claims;
}
async function oidcStart(req, res) {
  const cfg = oidcConfig();
  if (!cfg) return res.status(503).send("统一登录未配置");
  const doc = await oidcDiscovery(cfg.issuer);
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const nonce = b64url(crypto.randomBytes(18));
  const state = signState({ nonce, exp: Date.now() + OIDC_STATE_TTL_MS });
  setOidcCookie(res, signState({ nonce, verifier, exp: Date.now() + OIDC_STATE_TTL_MS }));
  const u = new URL(doc.authorization_endpoint);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", cfg.redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid profile email");
  u.searchParams.set("state", state);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  return redirect(res, u.toString());
}
async function oidcCallback(req, res) {
  const cfg = oidcConfig();
  if (!cfg) return staffError(res, "not_configured");
  const state = verifyStateToken(req.query?.state);
  const cookie = verifyStateToken(getCookie(req, OIDC_COOKIE));
  if (!state || !cookie || state.nonce !== cookie.nonce || !cookie.verifier) return staffError(res, "bad_state");
  if (!req.query?.code) return staffError(res, "login_failed");
  const doc = await oidcDiscovery(cfg.issuer);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: String(req.query.code),
    redirect_uri: cfg.redirectUri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: cookie.verifier,
  });
  const tr = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!tr.ok) return staffError(res, "login_failed");
  const tokens = await tr.json();
  const claims = await verifyIdToken(tokens.id_token, cfg, doc.jwks_uri);
  const employeeId = cfg.map[claims.sub];
  if (!employeeId) return staffError(res, "not_mapped");
  const pool = getPool();
  const r = await pool.query("SELECT id,name,employment_status FROM hr_employees WHERE id=$1", [employeeId]);
  if (!r.rows.length) return staffError(res, "not_mapped");
  const e = r.rows[0];
  if (e.employment_status !== "active") return staffError(res, "inactive");
  await pool.query("UPDATE hr_employees SET last_login_at=now() WHERE id=$1", [e.id]);
  clearOidcCookie(res);
  return redirect(res, `${STAFF_URL}?t=${encodeURIComponent(signStaffToken(e.id, e.name))}`);
}
export const __test = {
  b64url,
  b64urlDecode,
  parseOidcMap,
  signState,
  verifyStateToken,
  verifyIdToken,
  oidcStart,
};

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") {
    try {
      if (req.query?.action === "oidc_start") return await oidcStart(req, res);
      if (req.query?.action === "oidc_callback") return await oidcCallback(req, res);
      return res.status(400).json({ success: false, error: "action 只能是 oidc_start / oidc_callback" });
    } catch (err) {
      console.error("[hr-staff-auth:oidc]", err.message);
      if (req.query?.action === "oidc_start") return res.status(503).send("统一登录未配置");
      return staffError(res, "login_failed");
    }
  }
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "仅支持 POST" });

  const pool = getPool();
  const b = req.body || {};
  const company = b.company_code || "JINFANG";

  try {
    if (b.action === "login") {
      const phone = String(b.phone || "").trim();
      // ⚠️ 0802 修:这行原本压根不存在,login 一进来就 ReferenceError: pw is not defined → 500。
      //    也就是说员工端登录**从上线那天起就没成功过一次**,不是没人用。
      const pw = String(b.password || "");

      if (!phone) return res.status(400).json({ success: false, error: "请填手机号" });

      const r = await pool.query(
        `SELECT id,name,phone,password_hash,must_change_password,employment_status,
                login_fail_count, locked_until
           FROM hr_employees WHERE company_code=$1 AND phone=$2`, [company, phone]);
      // 统一话术，不告诉攻击者"这个号不存在"还是"密码错"
      const bad = () => res.status(401).json({ success: false, error: "手机号或密码不对" });
      // 号不存在但密码也没填 → 跟「已有密码却没填」回同一句，两种情况外面看不出区别
      if (!r.rows.length) return pw
        ? bad()
        : res.status(400).json({ success: false, error: "请填密码" });
      const e = r.rows[0];

      if (e.locked_until && new Date(e.locked_until) > new Date()) {
        return res.status(429).json({ success: false,
          error: `密码错太多次，请 ${Math.ceil((new Date(e.locked_until) - new Date()) / 60000)} 分钟后再试` });
      }
      if (e.employment_status === "left") {
        if (!pw) return res.status(400).json({ success: false, error: "请填密码" });
        return res.status(403).json({ success: false, error: "账号已停用，有问题找店长" });
      }
      if (e.employment_status !== "active") {
        // 老口径遗留(pending)。以前这里一律回「已离职」——在册的人被告知离职，是个真 bug。
        return res.status(403).json({ success: false, error: "账号还没启用，找店长看一下" });
      }
      // 刚被录用、还没设过密码：不发正式 token，只发一枚 10 分钟的设密码票。
      // 密码由员工自己设（Damon 定：店长不发初始密码）。
      if (!e.password_hash) {
        return res.status(200).json({ success: true, stage: "set_password",
          setpw_token: signSetPwToken(e.id), name: e.name,
          message: "店长已经确认你了，设一个只有你知道的密码" });
      }
      // 密码留空只有一个合法用途:刚被录用、还没设过密码(上面那支已经返回了)。
      // 走到这里说明这号已经有密码/已离职/根本不存在 —— 一律回同一句，
      // 免得空密码变成「这个号是不是刚入职的员工」的探测器。
      if (!pw) return res.status(400).json({ success: false, error: "请填密码" });
      if (!verifyPw(pw, e.password_hash)) {
        const n = (e.login_fail_count || 0) + 1;
        if (n >= MAX_FAIL) {
          await pool.query(`UPDATE hr_employees SET login_fail_count=0, locked_until=now()+interval '${LOCK_MIN} minutes' WHERE id=$1`, [e.id]);
          return res.status(429).json({ success: false, error: `密码错${MAX_FAIL}次，锁定${LOCK_MIN}分钟` });
        }
        await pool.query("UPDATE hr_employees SET login_fail_count=$1 WHERE id=$2", [n, e.id]);
        return bad();
      }
      await pool.query("UPDATE hr_employees SET login_fail_count=0, locked_until=NULL, last_login_at=now() WHERE id=$1", [e.id]);
      return res.status(200).json({
        success: true, token: signStaffToken(e.id, e.name), name: e.name,
        must_change_password: !!e.must_change_password,
      });
    }

    // 首次设密码：只认 role=staff_setpw 的短票，且该员工必须还没有密码。
    if (b.action === "set_password") {
      const { verifyToken } = await import("./auth.js");
      const claims = verifyToken(b.token);
      if (!claims || claims.role !== "staff_setpw" || !claims.employee_id) {
        return res.status(401).json({ success: false, error: "这张票过期了，回登录页重新来一次" });
      }
      const np = String(b.new_password || "");
      if (np.length < 6) return res.status(400).json({ success: false, error: "密码至少6位" });
      const r = await pool.query(
        "SELECT id,name,password_hash,employment_status FROM hr_employees WHERE id=$1", [claims.employee_id]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "员工不存在" });
      const e = r.rows[0];
      if (e.employment_status !== "active") return res.status(403).json({ success: false, error: "账号未启用" });
      if (e.password_hash) return res.status(400).json({ success: false, error: "密码已经设过了，直接登录" });
      await pool.query(
        "UPDATE hr_employees SET password_hash=$1, must_change_password=false, last_login_at=now() WHERE id=$2",
        [hashPw(np), e.id]);
      return res.status(200).json({ success: true, token: signStaffToken(e.id, e.name), name: e.name,
        message: "设好了，开工吧 🐾" });
    }

    if (b.action === "change_password") {
      const { verifyToken } = await import("./auth.js");
      const claims = verifyToken(b.token);
      if (!claims || claims.role !== "staff" || !claims.employee_id) {
        return res.status(401).json({ success: false, error: "登录已失效，请重新登录" });
      }
      const np = String(b.new_password || "");
      if (np.length < 6) return res.status(400).json({ success: false, error: "新密码至少6位" });
      const r = await pool.query("SELECT password_hash FROM hr_employees WHERE id=$1", [claims.employee_id]);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "员工不存在" });
      if (!verifyPw(String(b.old_password || ""), r.rows[0].password_hash)) {
        return res.status(401).json({ success: false, error: "原密码不对" });
      }
      await pool.query("UPDATE hr_employees SET password_hash=$1, must_change_password=false WHERE id=$2",
        [hashPw(np), claims.employee_id]);
      return res.status(200).json({ success: true, message: "密码已修改" });
    }

    return res.status(400).json({ success: false, error: "action 只能是 login / set_password / change_password" });
  } catch (err) {
    console.error("[hr-staff-auth]", err.message);
    return res.status(500).json({ success: false, error: "服务异常，稍后再试" });
  }
}
