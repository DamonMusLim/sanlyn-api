// migrate-payroll.js — CREATE TABLE payroll_sheets
import { getPool, setCors } from "../db.js";

const migratePromise = (async () => {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payroll_sheets (
      id                        VARCHAR(50)  PRIMARY KEY,
      employee_id               VARCHAR(50)  NOT NULL,
      company_id                VARCHAR(50)  NOT NULL,
      period_id                 VARCHAR(7)   NOT NULL,
      base_salary               NUMERIC(15,2) DEFAULT 0,
      bonus                     NUMERIC(15,2) DEFAULT 0,
      allowance                 NUMERIC(15,2) DEFAULT 0,
      deduction                 NUMERIC(15,2) DEFAULT 0,
      gross_pay                 NUMERIC(15,2) DEFAULT 0,
      personal_social_insurance NUMERIC(15,2) DEFAULT 0,
      personal_medical_insurance NUMERIC(15,2) DEFAULT 0,
      personal_housing_fund     NUMERIC(15,2) DEFAULT 0,
      personal_tax              NUMERIC(15,2) DEFAULT 0,
      net_pay                   NUMERIC(15,2) DEFAULT 0,
      employer_social_insurance NUMERIC(15,2) DEFAULT 0,
      employer_medical_insurance NUMERIC(15,2) DEFAULT 0,
      employer_housing_fund     NUMERIC(15,2) DEFAULT 0,
      payroll_status            VARCHAR(20)  DEFAULT 'DRAFT',
      created_by                VARCHAR(50),
      cancel_reason             TEXT,
      approved_by               VARCHAR(50),
      approved_at               TIMESTAMPTZ,
      created_at                TIMESTAMPTZ  DEFAULT NOW(),
      updated_at                TIMESTAMPTZ  DEFAULT NOW(),
      UNIQUE(employee_id, period_id)
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_payroll_company_period ON payroll_sheets(company_id, period_id);`);
})();

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, message: "Method not allowed" });
  try {
    await migratePromise;
    return res.status(200).json({ ok: true, message: "payroll_sheets table ready" });
  } catch (err) {
    console.error("[migrate-payroll]", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
