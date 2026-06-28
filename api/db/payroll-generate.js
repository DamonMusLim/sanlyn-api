// payroll-generate.js — 工资单生成 + 银行代发 + 税务局格式
// POST ?action=copy-employees  → 按员工默认值建本月工资单（实发用 default_net_pay）
// POST ?action=bank-batch      → 返回银行代发批量 rows（与工资发放批量文件-行内格式一致）
// POST ?action=excel-rows      → 返回自然人电子税务局导入 rows
// POST ?action=mark-paid       → 标记本月已发
import { getPool, setCors } from "../db.js";
import { randomUUID } from "crypto";

const EMP = `id, name, id_type, id_number, bank_account, bank_province,
  monthly_income, pension, medical, unemployment, housing_fund, default_net_pay`;

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ ok: false, message: "POST only" });

  const { action } = req.query;
  const pool = getPool();

  try {
    const { companyId, periodId } = req.body || {};
    if (!companyId || !periodId) {
      return res.status(400).json({ ok: false, message: "companyId and periodId required" });
    }

    // ── 复制员工默认值 → 本月工资单 ──────────────────────
    if (action === "copy-employees") {
      const emps = await pool.query(
        `SELECT ${EMP} FROM employees WHERE company_id=$1 AND status='ACTIVE'`, [companyId]
      );
      if (emps.rowCount === 0) return res.status(400).json({ ok: false, message: "no active employees" });
      let created = 0, skipped = 0;
      for (const e of emps.rows) {
        const gross  = Number(e.monthly_income  || 0);
        const pen    = Number(e.pension         || 0);
        const med    = Number(e.medical         || 0);
        const unem   = Number(e.unemployment    || 0);
        const house  = Number(e.housing_fund    || 0);
        // 实发 = 存档的固定到手金额（含个税扣减），没填则退回 gross-四险
        const bank   = Number(e.default_net_pay || 0) || Math.round((gross-pen-med-unem-house)*100)/100;
        const id     = "pr-" + randomUUID().replace(/-/g,"").slice(0,8);
        try {
          await pool.query(
            `INSERT INTO payroll_sheets
               (id, employee_id, company_id, period_id, base_salary, gross_pay,
                personal_social_insurance, personal_medical_insurance,
                unemployment_insurance, personal_housing_fund,
                personal_tax, net_pay, bank_amount, paid_status, payroll_status)
             VALUES ($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,0,$10,$10,'UNPAID','DRAFT')
             ON CONFLICT (employee_id,period_id) DO NOTHING`,
            [id, e.id, companyId, periodId, gross, pen, med, unem, house, bank]
          );
          created++;
        } catch { skipped++; }
      }
      return res.status(200).json({ ok: true, created, skipped, total: emps.rowCount });
    }

    // ── 银行代发批量（工资发放批量文件-行内 格式）─────────
    if (action === "bank-batch") {
      const year  = periodId.slice(0,4);
      const month = String(parseInt(periodId.slice(5,7)));
      const r = await pool.query(
        `SELECT e.bank_account, e.name, ps.bank_amount,
                e.bank_province, e.id_type, e.id_number
         FROM payroll_sheets ps
         JOIN employees e ON ps.employee_id = e.id
         WHERE ps.company_id=$1 AND ps.period_id=$2 ORDER BY e.name`,
        [companyId, periodId]
      );
      if (r.rowCount === 0) return res.status(400).json({ ok: false, message: "no records for this period" });
      const rows = r.rows.map(row => ({
        账号:         row.bank_account   || "",
        户名:         row.name,
        金额:         Number(row.bank_amount || 0),
        账号所属省份: row.bank_province  || "福建",
        证件类型:     row.id_type        || "居民身份证",
        证件号码:     row.id_number      || "",
        用途:         "工资",
        附言:         `${year}-${month}月`,
      }));
      const total = rows.reduce((s,r) => s + r["金额"], 0);
      return res.status(200).json({ ok: true, period: periodId, rows, total });
    }

    // ── 税务局导入格式 ─────────────────────────────────────
    if (action === "excel-rows") {
      const r = await pool.query(
        `SELECT e.employee_no, e.id_type, e.id_number, e.name,
                ps.gross_pay, ps.personal_social_insurance,
                ps.personal_medical_insurance, ps.unemployment_insurance,
                ps.personal_housing_fund
         FROM payroll_sheets ps
         JOIN employees e ON ps.employee_id = e.id
         WHERE ps.company_id=$1 AND ps.period_id=$2 ORDER BY e.name`,
        [companyId, periodId]
      );
      const rows = r.rows.map(row => ({
        工号:           row.employee_no || "",
        证件类型:       row.id_type     || "居民身份证",
        证件号码:       row.id_number   || "",
        姓名:           row.name,
        本期收入:       Number(row.gross_pay                  || 0),
        本期免税收入:   0,
        基本养老保险费: Number(row.personal_social_insurance   || 0),
        基本医疗保险费: Number(row.personal_medical_insurance  || 0),
        失业保险费:     Number(row.unemployment_insurance      || 0),
        住房公积金:     Number(row.personal_housing_fund       || 0),
        大病医疗: 0, 商业健康保险: 0, 税延养老保险: 0, 其他: 0,
      }));
      return res.status(200).json({ ok: true, period: periodId, rows });
    }

    // ── 标记已发 ─────────────────────────────────────────
    if (action === "mark-paid") {
      const r = await pool.query(
        `UPDATE payroll_sheets SET paid_status='PAID', paid_at=NOW()
         WHERE company_id=$1 AND period_id=$2 RETURNING id`,
        [companyId, periodId]
      );
      return res.status(200).json({ ok: true, updated: r.rowCount });
    }

    return res.status(400).json({ ok: false, message: "unknown action" });
  } catch (err) {
    console.error("[payroll-generate]", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
