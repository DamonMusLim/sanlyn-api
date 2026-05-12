// /api/db/local-charges.js — Port charges / local charges CRUD
// GET:   list all, filter by carrier/pol/company
// POST:  create record(s)
// PATCH: update rate + lock/unlock
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const PATCH_ALLOW = [
  "charge_code","charge_name","amount","currency","charge_type",
  "applicable_trade","valid_from","valid_until","notes",
  "cost_total","sell_total","remarks","carrier","pol","pod","company_name",
  "effective_from","updated_by",
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  const forCustomer = req.user?.role === "customer";

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

  // ── PATCH ──────────────────────────────────────────────────
  if (req.method === "PATCH") {
    const { id, lock, ...fields } = req.body || {};
    if (!id) return res.status(400).json({ error: "id required" });

    const pool2 = pool; // same pool
    try {
      // Handle lock/unlock toggle
      if (typeof lock === "boolean") {
        // Fetch current row to save history
        const cur = await pool2.query("SELECT * FROM local_charges WHERE id = $1", [id]);
        if (!cur.rows[0]) return res.status(404).json({ error: "not found" });
        const row = cur.rows[0];
        const prevRaw = row.raw || {};
        const history = Array.isArray(prevRaw.lock_history) ? prevRaw.lock_history : [];

        if (lock) {
          // Locking: record prev state
          history.unshift({
            at: new Date().toISOString(),
            action: "locked",
            prev_amount: row.amount,
            prev_cost_total: row.cost_total,
            prev_sell_total: row.sell_total,
            by: fields.updated_by || "admin",
          });
        } else {
          history.unshift({
            at: new Date().toISOString(),
            action: "unlocked",
            by: fields.updated_by || "admin",
          });
        }

        const newRaw = { ...prevRaw, lock_history: history };
        const r = await pool2.query(`
          UPDATE local_charges
          SET locked = $1, locked_at = $2, prev_cost_total = $3,
              updated_by = $4, raw = $5, updated_at = NOW()
          WHERE id = $6 RETURNING *
        `, [
          lock,
          lock ? new Date().toISOString() : row.locked_at,
          lock ? row.cost_total : row.prev_cost_total,
          fields.updated_by || "admin",
          JSON.stringify(newRaw),
          id,
        ]);
        return res.status(200).json({ success: true, data: r.rows[0] });
      }

      // Regular field update
      const sets = [];
      const vals = [];
      PATCH_ALLOW.forEach(k => {
        if (k in fields) {
          vals.push(fields[k]);
          sets.push(`${k} = $${vals.length}`);
        }
      });
      if (!sets.length) return res.status(400).json({ error: "no updatable fields" });
      vals.push(id);
      const sql = `UPDATE local_charges SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $${vals.length} RETURNING *`;
      const r = await pool2.query(sql, vals);
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

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
      return res.status(200).json({
        success: true,
        data: forCustomer
          ? result.rows.map(r => { const { cost_total, ...safe } = r; return safe; })
          : result.rows,
        count: result.rowCount,
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method === "POST") {
    try {
      const body = req.body || {};
      const records = Array.isArray(body) ? body : [body];
      const inserted = [];

      for (const rec of records) {
        const {
          carrier, pol, pod, company_name, container_type,
          fees, cost_total, sell_total, free_time, remarks, raw,
          charge_code, charge_name, amount, currency, charge_type,
          applicable_trade, valid_from, valid_until, notes,
        } = rec;
        const result = await pool.query(
          `INSERT INTO local_charges
             (carrier, pol, pod, company_name, container_type,
              fees, cost_total, sell_total, free_time, remarks, raw,
              charge_code, charge_name, amount, currency, charge_type,
              applicable_trade, valid_from, valid_until, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
           RETURNING *`,
          [
            carrier || "", pol || "", pod || "", company_name || "",
            container_type || "20GP",
            JSON.stringify(fees || {}),
            cost_total || 0, sell_total || 0,
            JSON.stringify(free_time || {}),
            remarks || "",
            JSON.stringify(raw || {}),
            charge_code || null, charge_name || null,
            amount != null ? Number(amount) : null,
            currency || "USD",
            charge_type || null, applicable_trade || "both",
            valid_from || null, valid_until || null,
            notes || null,
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
