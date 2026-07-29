// /api/db/hr-staff-auth.mjs — 员工端登录（**公开路径**，手机号+密码）
//
//   POST {action:"login", phone, password}        → 校验成功返回限权 JWT(role=staff)
//   POST {action:"change_password", token, old, new}
//
// 🔒 为什么不是"只用手机号"：员工端要能看**自己的身份证和合同**，只凭手机号登录
//    等于同事之间互相知道号码就能看对方证件。所以必须有密码。
//    没走短信验证码是因为目前没有短信通道（订单线也卡在这），店长建档时设初始密码、员工首登强制改。
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
      const pw = String(b.password || "");
      if (!phone || !pw) return res.status(400).json({ success: false, error: "请填手机号和密码" });

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
      if (e.employment_status !== "active") {
        return res.status(403).json({ success: false, error: "该员工已离职，账号已停用" });
      }
      if (!e.password_hash) {
        return res.status(403).json({ success: false, error: "还没设密码，找店长给你设一个" });
      }
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

    return res.status(400).json({ success: false, error: "action 只能是 login / change_password" });
  } catch (err) {
    console.error("[hr-staff-auth]", err.message);
    return res.status(500).json({ success: false, error: "服务异常，稍后再试" });
  }
}
