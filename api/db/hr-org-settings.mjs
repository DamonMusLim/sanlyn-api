// /api/db/hr-org-settings.mjs — 集团HRM · 组织规则配置（排班提前天数/最少在岗/标准月天数/加班倍数）
import { getPool, setCors } from "./db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  try {
    if (req.method === "GET") {
      const r = await pool.query("SELECT * FROM hr_org_settings ORDER BY company_code");
      return res.status(200).json({ success: true, data: r.rows, count: r.rows.length });
    }
    if (req.method === "PATCH") {
      const b = req.body || {};
      const code = b.company_code || "JINFANG";
      const allowed = ["display_name", "min_staff_on_duty", "shift_publish_lead_days",
                       "standard_month_days", "overtime_multiplier"];
      const sets = [], params = [];
      for (const k of allowed) if (k in b) { params.push(b[k]); sets.push(`${k}=$${params.length}`); }
      if (!sets.length) return res.status(400).json({ success: false, error: "无可更新字段" });
      sets.push("updated_at=now()");
      params.push(code);
      const r = await pool.query(
        `UPDATE hr_org_settings SET ${sets.join(", ")} WHERE company_code=$${params.length} RETURNING *`, params);
      if (!r.rows.length) return res.status(404).json({ success: false, error: "该公司无配置" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    }
    return res.status(405).json({ success: false, error: "不支持的方法" });
  } catch (e) { return res.status(500).json({ success: false, error: e.message }); }
}
