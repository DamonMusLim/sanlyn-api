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
//   ⚠️ 必须同时加进 auth.js 的 PUBLIC_PATHS 才能免登录访问。
import { getPool, setCors } from "./db.js";

const LIM = { name: 40, phone: 30, gender: 10, intro: 800, expected_pay: 60, answer: 600 };
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
      const job = await pool.query(
        `SELECT id FROM hr_job_posts WHERE company_code=$1 AND is_open=true ORDER BY id LIMIT 1`, [company]);
      const jobId = job.rows.length ? job.rows[0].id : null;

      // 答案只保留 {q,a}，且逐条截断
      const answers = (Array.isArray(b.answers) ? b.answers.slice(0, 20) : [])
        .map((x) => ({ q: cut(x?.q, 200), a: cut(x?.a, LIM.answer) }))
        .filter((x) => x.q);

      const r = await pool.query(
        `INSERT INTO hr_applicants
           (company_code, job_post_id, name, phone, gender, birth_year, intro,
            available_days, available_shifts, earliest_start, expected_pay, answers, status, source_ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'new',$13)
         RETURNING id`,
        [company, jobId, cut(b.name, LIM.name), cut(b.phone, LIM.phone), cut(b.gender, LIM.gender),
         Number.isInteger(b.birth_year) && b.birth_year > 1900 && b.birth_year < 2100 ? b.birth_year : null,
         cut(b.intro, LIM.intro), JSON.stringify(arr(b.available_days, 7)),
         JSON.stringify(arr(b.available_shifts, 8)),
         /^\d{4}-\d{2}-\d{2}$/.test(String(b.earliest_start || "")) ? b.earliest_start : null,
         cut(b.expected_pay, LIM.expected_pay), JSON.stringify(answers), cut(ip, 60)]);

      return res.status(200).json({
        success: true, id: r.rows[0].id,
        message: "收到了！我们看过之后会电话联系你，谢谢 🐾",
      });
    }

    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (err) {
    console.error("[hr-apply]", err.message);
    return res.status(500).json({ success: false, error: "提交失败，请稍后再试" });
  }
}
