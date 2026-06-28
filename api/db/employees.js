// employees.js — CRUD 员工档案 v2（含身份证+固定薪酬字段）
// GET  ?company_id=xxx          → { employees: [...] }
// POST { companyId, name, idType, idNumber, monthlyIncome, pension, medical, unemployment, housingFund, ... }
// PATCH ?id=xxx { ...fields }   → { employee }
import { getPool, setCors } from "../db.js";
import { randomUUID } from "crypto";

const COLS = `id, user_id, company_id, department_id, name, title_key, status, manager_id,
  employee_no, id_type, id_number, monthly_income, pension, medical, unemployment, housing_fund`;

function mapRow(row) {
  return {
    id:            row.id,
    userId:        row.user_id,
    companyId:     row.company_id,
    departmentId:  row.department_id,
    name:          row.name,
    titleKey:      row.title_key,
    status:        row.status,
    managerId:     row.manager_id,
    employeeNo:    row.employee_no,
    idType:        row.id_type   || '居民身份证',
    idNumber:      row.id_number || '',
    monthlyIncome: Number(row.monthly_income || 0),
    pension:       Number(row.pension        || 0),
    medical:       Number(row.medical        || 0),
    unemployment:  Number(row.unemployment   || 0),
    housingFund:   Number(row.housing_fund   || 0),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  try {
    // ── GET ──
    if (req.method === "GET") {
      const companyId = req.query.company_id;
      if (!companyId) return res.status(400).json({ ok: false, message: "company_id is required" });
      const r = await pool.query(
        `SELECT ${COLS} FROM employees WHERE company_id=$1 ORDER BY name`, [companyId]
      );
      return res.status(200).json({ employees: r.rows.map(mapRow) });
    }

    // ── POST ──
    if (req.method === "POST") {
      const {
        id, userId=null, companyId, departmentId=null, name, titleKey=null,
        status="ACTIVE", managerId=null, employeeNo=null,
        idType='居民身份证', idNumber=null,
        monthlyIncome=0, pension=0, medical=0, unemployment=0, housingFund=0,
      } = req.body || {};
      if (!companyId || !name) return res.status(400).json({ ok: false, message: "companyId and name required" });
      const empId = id || "emp-" + randomUUID().replace(/-/g, "").slice(0, 8);
      const r = await pool.query(
        `INSERT INTO employees (id,user_id,company_id,department_id,name,title_key,status,manager_id,
           employee_no,id_type,id_number,monthly_income,pension,medical,unemployment,housing_fund)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (id) DO UPDATE SET
           name=EXCLUDED.name, title_key=EXCLUDED.title_key, status=EXCLUDED.status,
           employee_no=EXCLUDED.employee_no, id_type=EXCLUDED.id_type, id_number=EXCLUDED.id_number,
           monthly_income=EXCLUDED.monthly_income, pension=EXCLUDED.pension,
           medical=EXCLUDED.medical, unemployment=EXCLUDED.unemployment,
           housing_fund=EXCLUDED.housing_fund, updated_at=NOW()
         RETURNING ${COLS}`,
        [empId, userId, companyId, departmentId, name, titleKey, status, managerId,
         employeeNo, idType, idNumber,
         Number(monthlyIncome)||0, Number(pension)||0, Number(medical)||0,
         Number(unemployment)||0, Number(housingFund)||0]
      );
      return res.status(201).json({ ok: true, employee: mapRow(r.rows[0]) });
    }

    // ── PATCH ──
    if (req.method === "PATCH") {
      const id = req.query.id;
      if (!id) return res.status(400).json({ ok: false, message: "id required" });
      const {
        name, titleKey, status, employeeNo,
        idType, idNumber, monthlyIncome, pension, medical, unemployment, housingFund,
      } = req.body || {};
      const sets = [], vals = [], idx = () => `$${vals.length}`;
      if (name          !== undefined) { vals.push(name);                 sets.push(`name=${idx()}`); }
      if (titleKey      !== undefined) { vals.push(titleKey);             sets.push(`title_key=${idx()}`); }
      if (status        !== undefined) { vals.push(status);               sets.push(`status=${idx()}`); }
      if (employeeNo    !== undefined) { vals.push(employeeNo);           sets.push(`employee_no=${idx()}`); }
      if (idType        !== undefined) { vals.push(idType);               sets.push(`id_type=${idx()}`); }
      if (idNumber      !== undefined) { vals.push(idNumber);             sets.push(`id_number=${idx()}`); }
      if (monthlyIncome !== undefined) { vals.push(Number(monthlyIncome)||0); sets.push(`monthly_income=${idx()}`); }
      if (pension       !== undefined) { vals.push(Number(pension)||0);   sets.push(`pension=${idx()}`); }
      if (medical       !== undefined) { vals.push(Number(medical)||0);   sets.push(`medical=${idx()}`); }
      if (unemployment  !== undefined) { vals.push(Number(unemployment)||0); sets.push(`unemployment=${idx()}`); }
      if (housingFund   !== undefined) { vals.push(Number(housingFund)||0); sets.push(`housing_fund=${idx()}`); }
      if (sets.length === 0) return res.status(400).json({ ok: false, message: "no fields to update" });
      vals.push(id);
      const r = await pool.query(
        `UPDATE employees SET ${sets.join(",")}, updated_at=NOW() WHERE id=$${vals.length} RETURNING ${COLS}`,
        vals
      );
      if (r.rowCount === 0) return res.status(404).json({ ok: false, message: "not found" });
      return res.status(200).json({ ok: true, employee: mapRow(r.rows[0]) });
    }

    return res.status(405).json({ ok: false, message: "Method not allowed" });
  } catch (err) {
    console.error("[employees]", err);
    return res.status(500).json({ ok: false, message: err.message });
  }
}
