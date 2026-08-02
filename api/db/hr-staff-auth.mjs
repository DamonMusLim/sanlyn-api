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

const TOKEN_DAYS = 30;          // 员工自己登录的，比店长发的长效链接短
const MAX_FAIL = 5;
const LOCK_MIN = 15;

function b64url(buf) {
  return Buffer.from(buf).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
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

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "仅支持 POST" });

  const pool = getPool();
  const b = req.body || {};
  const company = b.company_code || "JINFANG";

  try {
    if (b.action === "login") {
      const phone = String(b.phone || "").trim();

      if (!phone) return res.status(400).json({ success: false, error: "请填手机号" });

      const r = await pool.query(
        `SELECT id,name,phone,password_hash,must_change_password,employment_status,
                login_fail_count, locked_until
           FROM hr_employees WHERE company_code=$1 AND phone=$2`, [company, phone]);
      // 统一话术，不告诉攻击者"这个号不存在"还是"密码错"
      const bad = () => res.status(401).json({ success: false, error: "手机号或密码不对" });
      if (!r.rows.length) return bad();
      const e = r.rows[0];

      if (e.locked_until && new Date(e.locked_until) > new Date()) {
        return res.status(429).json({ success: false,
          error: `密码错太多次，请 ${Math.ceil((new Date(e.locked_until) - new Date()) / 60000)} 分钟后再试` });
      }
      if (e.employment_status === "left") {
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
