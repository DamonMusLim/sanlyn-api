// migrate-employees-v2.js — employees + payroll_sheets 补字段
import { getPool, setCors } from "../db.js";

const migratePromise = (async () => {
  const pool = getPool();
  // employees: 身份证 + 固定薪酬
  await pool.query(`
    ALTER TABLE employees
      ADD COLUMN IF NOT EXISTS employee_no    VARCHAR(20),
      ADD COLUMN IF NOT EXISTS id_type        VARCHAR(30) DEFAULT '居民身份证',
      ADD COLUMN IF NOT EXISTS id_number      VARCHAR(30),
      ADD COLUMN IF NOT EXISTS monthly_income NUMERIC(12,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS pension        NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS medical        NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS unemployment   NUMERIC(10,2) DEFAULT 0,
      ADD COLUMN IF NOT EXISTS housing_fund   NUMERIC(10,2) DEFAULT 0
  `);
  // payroll_sheets: 失业保险单独列
  await pool.query(`
    ALTER TABLE payroll_sheets
      ADD COLUMN IF NOT EXISTS unemployment_insurance NUMERIC(15,2) DEFAULT 0
  `);
})();

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, message: "GET only" });
  try {
    await migratePromise;
    return res.status(200).json({ ok: true, message: "employees v2 + payroll_sheets.unemployment_insurance ready" });
  } catch (err) {
    console.error("[migrate-employees-v2]", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
