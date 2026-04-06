// /api/db/local-charges.js — Port charges / local charges CRUD
// GET: list all, filter by carrier/pol/company
// POST: create or update a local charges record
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // Ensure table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS local_charges (
      id SERIAL PRIMARY KEY,
      carrier VARCHAR(50),
      pol VARCHAR(100),
      pod VARCHAR(100),
      company_name VARCHAR(200),
      container_type VARCHAR(20) DEFAULT '20GP',
      fees JSONB DEFAULT '{}',
      cost_total NUMERIC(10,2) DEFAULT 0,
      sell_total NUMERIC(10,2) DEFAULT 0,
      free_time JSONB DEFAULT '{}',
      remarks TEXT,
      raw JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  if (req.method === "GET") {
    try {
      const { carrier, pol, pod, company, limit = 1000 } = req.query;
      let query = "SELECT * FROM local_charges", params = [], conds = [];
      if (carrier) { params.push("%" + carrier + "%"); conds.push("carrier ILIKE $" + params.length); }
      if (pol) { params.push("%" + pol + "%"); conds.push("pol ILIKE $" + params.length); }
      if (pod) { params.push("%" + pod + "%"); conds.push("pod ILIKE $" + params.length); }
      if (company) { params.push("%" + company + "%"); conds.push("company_name ILIKE $" + params.length); }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += " ORDER BY created_at DESC LIMIT $" + params.length;
      const result = await pool.query(query, params);
      return res.status(200).json(result.rows);
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    try {
      const body = req.body || {};
      // Support batch insert
      const records = Array.isArray(body) ? body : [body];
      const inserted = [];

      for (const rec of records) {
        const { carrier, pol, pod, company_name, container_type, fees, cost_total, sell_total, free_time, remarks, raw } = rec;
        const result = await pool.query(
          `INSERT INTO local_charges (carrier, pol, pod, company_name, container_type, fees, cost_total, sell_total, free_time, remarks, raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
           RETURNING *`,
          [
            carrier || "", pol || "", pod || "", company_name || "",
            container_type || "20GP",
            JSON.stringify(fees || {}),
            cost_total || 0, sell_total || 0,
            JSON.stringify(free_time || {}),
            remarks || "",
            JSON.stringify(raw || {}),
          ]
        );
        inserted.push(result.rows[0]);
      }

      return res.status(201).json({ success: true, data: inserted, count: inserted.length });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
