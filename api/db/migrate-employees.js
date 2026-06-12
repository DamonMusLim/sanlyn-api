// migrate-employees.js — CREATE TABLE employees + departments
// GET → run migration and return ok
import { getPool, setCors } from "../db.js";

const migratePromise = (async () => {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS employees (
      id           VARCHAR(50)  PRIMARY KEY,
      user_id      VARCHAR(50),
      company_id   VARCHAR(50)  NOT NULL,
      department_id VARCHAR(50),
      name         VARCHAR(100) NOT NULL,
      title_key    VARCHAR(100),
      status       VARCHAR(20)  DEFAULT 'ACTIVE',
      manager_id   VARCHAR(50),
      created_at   TIMESTAMPTZ  DEFAULT NOW(),
      updated_at   TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS departments (
      id         VARCHAR(50)  PRIMARY KEY,
      company_id VARCHAR(50),
      name       VARCHAR(100),
      created_at TIMESTAMPTZ  DEFAULT NOW()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id);`);
})();

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, message: "Method not allowed" });
  try {
    await migratePromise;
    return res.status(200).json({ ok: true, message: "employees + departments tables ready" });
  } catch (err) {
    console.error("[migrate-employees]", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
