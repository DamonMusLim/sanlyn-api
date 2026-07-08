// payroll-sheets.js — 工资单 CRUD + 状态机
// GET  ?company_id=&period=YYYY-MM           → { sheets: [...] }
// GET  ?company_id= (no period)              → all periods for company
// POST { employeeId,companyId,periodId,baseSalary,bonus,allowance,deduction } → { sheet }
// PATCH ?action=calculate&id=  → 推算所有Money字段 → CALCULATED
// PATCH ?action=approve&id=    → APPROVED
// PATCH ?action=cancel&id= + body{reason}    → CANCELLED
// 认证: ac.sanlyn.cn authGate 保障，此接口无额外requireAuth (同 workbench-kpi 模式)
import { getPool, setCors } from "../db.js";
import { randomUUID } from "crypto";
import { computeFixedProfile } from "./payroll/calc.js";

const SEL = `
  id, employee_id, company_id, period_id,
  base_salary, bonus, allowance, deduction,
  gross_pay, personal_social_insurance, personal_medical_insurance,
  personal_housing_fund, personal_tax, net_pay,
  employer_social_insurance, employer_medical_insurance, employer_housing_fund,
  payroll_status, created_by, cancel_reason,
  approved_by, approved_at, created_at, updated_at
`;

function money(v) { return { amount: Number(v || 0), currency: "CNY" }; }
function round2(v) { return Math.round(Number(v || 0) * 100) / 100; }

function mapSheet(row) {
  return {
    id:                        row.id,
    employeeId:                row.employee_id,
    companyId:                 row.company_id,
    periodId:                  row.period_id,
    baseSalary:                money(row.base_salary),
    bonus:                     money(row.bonus),
    allowance:                 money(row.allowance),
    deduction:                 money(row.deduction),
    grossPay:                  money(row.gross_pay),
    personalSocialInsurance:   money(row.personal_social_insurance),
    personalMedicalInsurance:  money(row.personal_medical_insurance),
    personalHousingFund:       money(row.personal_housing_fund),
    personalTax:               money(row.personal_tax),
    netPay:                    money(row.net_pay),
    employerSocialInsurance:   money(row.employer_social_insurance),
    employerMedicalInsurance:  money(row.employer_medical_insurance),
    employerHousingFund:       money(row.employer_housing_fund),
    payrollStatus:             row.payroll_status,
    createdBy:                 row.created_by,
    cancelReason:              row.cancel_reason,
    approvedBy:                row.approved_by,
    approvedAt:                row.approved_at,
    createdAt:                 row.created_at,
    updatedAt:                 row.updated_at,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  try {
    // ── GET ───────────────────────────────────────────────
    if (req.method === "GET") {
      const { company_id, period } = req.query;
      if (!company_id) return res.status(400).json({ ok: false, message: "company_id required" });
      let r;
      if (period) {
        r = await pool.query(`SELECT ${SEL} FROM payroll_sheets WHERE company_id=$1 AND period_id=$2 ORDER BY created_at DESC`, [company_id, period]);
      } else {
        r = await pool.query(`SELECT ${SEL} FROM payroll_sheets WHERE company_id=$1 ORDER BY period_id DESC, created_at DESC`, [company_id]);
      }
      return res.status(200).json({ sheets: r.rows.map(mapSheet) });
    }

    // ── POST ──────────────────────────────────────────────
    if (req.method === "POST") {
      const { employeeId, companyId, periodId, baseSalary=0, bonus=0, allowance=0, deduction=0 } = req.body || {};
      if (!employeeId || !companyId || !periodId) {
        return res.status(400).json({ ok: false, message: "employeeId, companyId, periodId required" });
      }
      const id = "pr-" + randomUUID().replace(/-/g,"").slice(0,8);
      const createdBy = req.user?.username || req.user?.id || null;
      const r = await pool.query(
        `INSERT INTO payroll_sheets (id,employee_id,company_id,period_id,base_salary,bonus,allowance,deduction,payroll_status,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT',$9)
         RETURNING ${SEL}`,
        [id, employeeId, companyId, periodId,
         Number(baseSalary)||0, Number(bonus)||0, Number(allowance)||0, Number(deduction)||0,
         createdBy]
      );
      return res.status(201).json({ sheet: mapSheet(r.rows[0]) });
    }

    // ── PATCH ─────────────────────────────────────────────
    if (req.method === "PATCH") {
      const { action, id } = req.query;
      if (!id) return res.status(400).json({ ok: false, message: "id required" });

      if (action === "calculate") {
        const cur = await pool.query(
          `SELECT ps.base_salary, ps.bonus, ps.allowance, ps.deduction,
                  ps.personal_social_insurance, ps.personal_medical_insurance,
                  ps.unemployment_insurance, ps.personal_housing_fund, ps.net_pay,
                  e.id AS employee_profile_id,
                  e.pension, e.medical, e.unemployment, e.housing_fund, e.default_net_pay
           FROM payroll_sheets ps
           LEFT JOIN employees e ON e.id = ps.employee_id
           WHERE ps.id=$1`,
          [id]
        );
        if (cur.rowCount === 0) return res.status(404).json({ ok: false, message: "not found" });
        const row = cur.rows[0];
        const calc = computeFixedProfile(row, row.employee_profile_id ? row : null);
        const r = await pool.query(
          `UPDATE payroll_sheets SET
             gross_pay=$2, personal_social_insurance=$3, personal_medical_insurance=$4,
             unemployment_insurance=$5, personal_housing_fund=$6, personal_tax=$7, net_pay=$8,
             bank_amount=$9, employer_social_insurance=$10, employer_medical_insurance=$11,
             employer_housing_fund=$12,
             payroll_status='CALCULATED', updated_at=NOW()
           WHERE id=$1 RETURNING ${SEL}`,
          [
            id,
            calc.grossPay,
            calc.personalSocialInsurance,
            calc.personalMedicalInsurance,
            calc.unemploymentInsurance,
            calc.personalHousingFund,
            calc.personalTax,
            calc.netPay,
            calc.bankAmount,
            calc.employerSocialInsurance,
            calc.employerMedicalInsurance,
            calc.employerHousingFund,
          ]
        );
        return res.status(200).json({
          sheet: mapSheet(r.rows[0]),
          calculationMethod: calc.calculationMethod,
          calculationVersion: calc.calculationVersion,
          warnings: calc.warnings,
        });
      }

      if (action === "approve") {
        const approvedBy = req.user?.username || req.user?.id || null;
        const r = await pool.query(
          `UPDATE payroll_sheets SET payroll_status='APPROVED', approved_by=$2, approved_at=NOW(), updated_at=NOW()
           WHERE id=$1 RETURNING ${SEL}`,
          [id, approvedBy]
        );
        if (r.rowCount === 0) return res.status(404).json({ ok: false, message: "not found" });
        return res.status(200).json({ sheet: mapSheet(r.rows[0]) });
      }

      if (action === "cancel") {
        const { reason=null } = req.body || {};
        const r = await pool.query(
          `UPDATE payroll_sheets SET payroll_status='CANCELLED', cancel_reason=$2, updated_at=NOW()
           WHERE id=$1 RETURNING ${SEL}`,
          [id, reason]
        );
        if (r.rowCount === 0) return res.status(404).json({ ok: false, message: "not found" });
        return res.status(200).json({ sheet: mapSheet(r.rows[0]) });
      }

      return res.status(400).json({ ok: false, message: "unsupported action" });
    }

    return res.status(405).json({ ok: false, message: "Method not allowed" });
  } catch (err) {
    console.error("[payroll-sheets]", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
