// /api/db/hr-events.mjs — 集团HRM · 入转调离（人事异动事件流，档案变更留痕）
// event_type: hire入职 | regularize转正 | transfer调动 | resign离职
// 不做多级审批链（4人的店拍板人=店长本人），只做**留痕+交接清单+到期提醒**。
// POST 建异动时按类型同步更新 hr_employees 对应字段（转正→清 probation_end；离职→employment_status=left+left_at）。
import { getPool, setCors } from "./db.js";
const D = "YYYY-MM-DD";
const TYPES = ["hire", "regularize", "transfer", "resign"];
const DEFAULT_CHECKLIST = ["钥匙交回", "工服交回", "未结报销结清", "未结请假处理", "客户/供应商交接", "系统账号停用"];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const company = req.query?.company_code || req.body?.company_code || "JINFANG";
  try {
    if (req.method === "GET") {
      const { employee_id, event_type, limit = 500 } = req.query;
      const params = [company]; const conds = ["company_code=$1"];
      if (employee_id) { params.push(employee_id); conds.push(`employee_id=$${params.length}`); }
      if (event_type) { params.push(event_type); conds.push(`event_type=$${params.length}`); }
      params.push(Math.min(parseInt(limit) || 500, 2000));
      const r = await pool.query(
        `SELECT id, employee_id, employee_name, event_type, to_char(event_date,'${D}') AS event_date,
                from_value, to_value, checklist, note, operator, created_at
           FROM hr_employee_events WHERE ${conds.join(" AND ")}
          ORDER BY event_date DESC, id DESC LIMIT $${params.length}`, params);
      // 试用期将到期（30天内）提醒
      const prob = await pool.query(
        `SELECT id, name, to_char(probation_end,'${D}') AS probation_end,
                (probation_end - CURRENT_DATE) AS days_left
           FROM hr_employees
          WHERE company_code=$1 AND employment_status='active' AND probation_end IS NOT NULL
            AND probation_end <= CURRENT_DATE + 30 ORDER BY probation_end`, [company]);
      return res.status(200).json({ success: true, data: r.rows, count: r.rows.length,
        probation_due: prob.rows, default_checklist: DEFAULT_CHECKLIST });
    }
    if (req.method === "POST") {
      const b = req.body || {};
      if (!b.employee_id || !b.event_type || !b.event_date)
        return res.status(400).json({ success: false, error: "employee_id/event_type/event_date 必填" });
      if (!TYPES.includes(b.event_type))
        return res.status(400).json({ success: false, error: `event_type 只能是 ${TYPES.join("/")}` });
      const emp = await pool.query("SELECT id,name,role,position FROM hr_employees WHERE id=$1", [b.employee_id]);
      if (!emp.rows.length) return res.status(404).json({ success: false, error: "员工不存在" });
      const e = emp.rows[0];
      const checklist = b.event_type === "resign"
        ? (b.checklist || DEFAULT_CHECKLIST.map((item) => ({ item, done: false })))
        : (b.checklist || null);
      const r = await pool.query(
        `INSERT INTO hr_employee_events
           (company_code,employee_id,employee_name,event_type,event_date,from_value,to_value,checklist,note,operator)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [company, e.id, e.name, b.event_type, b.event_date, b.from_value || null, b.to_value || null,
         checklist ? JSON.stringify(checklist) : null, b.note || null, b.operator || null]);
      // 同步档案
      if (b.event_type === "resign") {
        await pool.query("UPDATE hr_employees SET employment_status='left', left_at=now() WHERE id=$1", [e.id]);
      } else if (b.event_type === "regularize") {
        await pool.query("UPDATE hr_employees SET probation_end=NULL WHERE id=$1", [e.id]);
      } else if (b.event_type === "transfer" && b.to_value) {
        await pool.query("UPDATE hr_employees SET position=$1 WHERE id=$2", [b.to_value, e.id]);
      } else if (b.event_type === "hire" && b.event_date) {
        await pool.query("UPDATE hr_employees SET hire_date=COALESCE(hire_date,$1) WHERE id=$2", [b.event_date, e.id]);
      }
      return res.status(200).json({ success: true, data: r.rows[0] });
    }
    if (req.method === "PATCH") { // 只用于勾交接清单/改备注
      const b = req.body || {};
      if (!b.id) return res.status(400).json({ success: false, error: "id 必填" });
      const sets = [], params = [];
      if ("checklist" in b) { params.push(JSON.stringify(b.checklist)); sets.push(`checklist=$${params.length}`); }
      if ("note" in b) { params.push(b.note); sets.push(`note=$${params.length}`); }
      if (!sets.length) return res.status(400).json({ success: false, error: "仅允许更新 checklist/note" });
      params.push(b.id);
      const r = await pool.query(`UPDATE hr_employee_events SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "记录不存在" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }
    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
}
