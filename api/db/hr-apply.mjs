// /api/db/hr-apply.mjs — 招聘自助投递（**公开无登录**，候选人手机直接填）
//
//   GET  ?company_code=JINFANG → 在招职位：介绍/环境照片/可选班次/面试问题
//   POST {name,phone,...}      → 提交应聘（status 恒为 new，候选人无任何读取他人数据的能力）
//
// 🔒 这是全系统少数几个**公开可写**的接口，安全按"陌生人能打"来设计：
//   1. **只写不读**：GET 只返回职位公开信息(不含任何应聘者数据)；POST 只 INSERT，不返回别人的东西。
//   2. **限流**：同 IP 10分钟内最多 3 次提交，防刷库。
//   3. **字段长度硬截断**：所有文本入库前截断，防超长 payload。
//   4. **状态锁死 new**：候选人改不了自己的录用状态。
//   5. 不接受任何 id/status/reviewed_by 等字段（就算传了也忽略）。
//   6. 查进度只认**提交时发的回执号**，不支持按手机号查 —— 否则等于开了个手机号枚举接口。
//   ⚠️ 必须同时加进 auth.js 的 PUBLIC_PATHS 才能免登录访问。
import crypto from "node:crypto";
import { getPool, setCors } from "./db.js";

const LIM = { name: 40, phone: 30, gender: 10, intro: 800, expected_pay: 60, answer: 600 };
const POSITIONS = ["店员", "主管"];   // 只是**意向**;真岗位和权限由店长录用时定。
// 「店长」不在选项里 —— 那是 Damon 自己,在 admin 后台审批,不占员工席位。
// 层级:店长(Damon,后台) > 主管(以后从店员提) > 店员。
const cut = (v, n) => (v == null ? null : String(v).slice(0, n));
const arr = (v, n = 12) => (Array.isArray(v) ? v.slice(0, n).map((x) => cut(x, 60)) : []);

// 简易内存限流：同 IP 10 分钟 3 次（重启即清，够挡住随手刷）
const hits = new Map();
const WINDOW = 10 * 60 * 1000, MAX = 3;
function tooMany(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW);
  if (list.length >= MAX) { hits.set(ip, list); return true; }
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();   // 防内存涨
  return false;
}
function clientIp(req) {
  return String(req.headers["x-forwarded-for"] || "").split(",")[0].trim()
    || req.socket?.remoteAddress || "unknown";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const company = cut(req.query?.company_code || req.body?.company_code || "JINFANG", 30);

  try {
    // 申请人查自己的进度：只认**提交时发的回执号**，不支持按手机号查。
    // 按手机号查 = 白送一个「这个号在不在册」的枚举接口，公网接口不能开这个口子。
    if (req.method === "GET" && req.query?.apply_token) {
      const t = cut(req.query.apply_token, 80);
      const a = (await pool.query(
        "SELECT name, status, desired_position, hired_employee_id FROM hr_applicants WHERE apply_token=$1",
        [t])).rows[0];
      if (!a) return res.status(404).json({ success: false, error: "这个申请找不到了，重新填一次吧" });
      const stage = a.status === "hired" ? "hired"
                  : a.status === "rejected" ? "rejected" : "pending";
      return res.status(200).json({ success: true, stage, name: a.name,
        desired_position: a.desired_position,
        message: stage === "hired" ? "店长已经确认了，回登录页设一个自己的密码就能进来"
               : stage === "rejected" ? "这次没能一起共事，谢谢你来 🐾"
               : "认证中 · 店长还没确认，确认后这里会变" });
    }

    if (req.method === "GET") {
      const r = await pool.query(
        `SELECT id, title, intro, requirements, pay_range, work_place, images, questions, shift_options
           FROM hr_job_posts WHERE company_code=$1 AND is_open=true ORDER BY id LIMIT 1`, [company]);
      if (!r.rows.length) {
        return res.status(200).json({ success: true, open: false, message: "目前没有在招岗位" });
      }
      return res.status(200).json({ success: true, open: true, job: r.rows[0] });
    }

    if (req.method === "POST") {
      const ip = clientIp(req);
      if (tooMany(ip)) {
        return res.status(429).json({ success: false, error: "提交太频繁了，请稍后再试" });
      }
      const b = req.body || {};
      if (!b.name || !String(b.name).trim()) {
        return res.status(400).json({ success: false, error: "请填写姓名" });
      }
      if (!b.phone || !/^[\d\-+ ]{6,20}$/.test(String(b.phone))) {
        return res.status(400).json({ success: false, error: "请填写正确的手机号" });
      }
      // 同一个手机号已经在申请中 → 把原来的回执还给他，不建第二条（他多半是丢了链接）
      const phoneC = cut(b.phone, LIM.phone);
      const old = (await pool.query(
        `SELECT apply_token, status FROM hr_applicants
          WHERE company_code=$1 AND phone=$2 AND status NOT IN ('rejected')
          ORDER BY id DESC LIMIT 1`, [company, phoneC])).rows[0];
      if (old && old.apply_token) {
        return res.status(200).json({ success: true, apply_token: old.apply_token, again: true,
          message: old.status === "hired" ? "你已经通过了，回登录页设密码就行"
                                          : "你之前已经交过了，正在等店长确认" });
      }

      const job = await pool.query(
        `SELECT id FROM hr_job_posts WHERE company_code=$1 AND is_open=true ORDER BY id LIMIT 1`, [company]);
      const jobId = job.rows.length ? job.rows[0].id : null;

      // 答案只保留 {q,a}，且逐条截断
      const answers = (Array.isArray(b.answers) ? b.answers.slice(0, 20) : [])
        .map((x) => ({ q: cut(x?.q, 200), a: cut(x?.a, LIM.answer) }))
        .filter((x) => x.q);

      const token = crypto.randomBytes(24).toString("base64url");
      const pos = POSITIONS.includes(String(b.desired_position || "")) ? b.desired_position : null;
      const r = await pool.query(
        `INSERT INTO hr_applicants
           (company_code, job_post_id, name, phone, gender, birth_year, intro,
            available_days, available_shifts, earliest_start, expected_pay, answers, status, source_ip,
            apply_token, desired_position)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new',$13,$14,$15)
         RETURNING id`,
        [company, jobId, cut(b.name, LIM.name), cut(b.phone, LIM.phone), cut(b.gender, LIM.gender),
         Number.isInteger(b.birth_year) && b.birth_year > 1900 && b.birth_year < 2100 ? b.birth_year : null,
         cut(b.intro, LIM.intro), JSON.stringify(arr(b.available_days, 7)),
         JSON.stringify(arr(b.available_shifts, 8)),
         /^\d{4}-\d{2}-\d{2}$/.test(String(b.earliest_start || "")) ? b.earliest_start : null,
         cut(b.expected_pay, LIM.expected_pay), JSON.stringify(answers), cut(ip, 60),
         token, pos]);

      return res.status(200).json({
        success: true, id: r.rows[0].id, apply_token: token,
        message: "收到了！等店长确认，确认后你就能设密码进来 🐾",
      });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    console.error("[hr-apply]", err.message);
    return res.status(500).json({ success: false, error: "提交失败，请稍后再试" });
  }
}
