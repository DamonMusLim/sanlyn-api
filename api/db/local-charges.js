// /api/db/local-charges.js — Port charges / local charges CRUD
// GET: list all, filter by carrier/pol/company
// POST: create or update a local charges record
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
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
      // ?history=<charge_id> → 涨价历史时间线（最新在前）
      if (req.query.history) {
        const cid = parseInt(req.query.history, 10);
        if (!Number.isFinite(cid)) return res.status(400).json({ success:false, error:"bad history id" });
        const h = await pool.query(
          `SELECT * FROM local_charges_history WHERE charge_id = $1 ORDER BY changed_at DESC, id DESC`, [cid]);
        return res.status(200).json(h.rows);
      }
      const { carrier, pol, pod, company, limit = 1000 } = req.query;
      const parsedLimit = parseInt(limit);
      const buildListQuery = ({ includeCarrier }) => {
        let query = "SELECT * FROM local_charges", params = [], conds = [];
        if (includeCarrier && carrier) { params.push("%" + carrier + "%"); conds.push("carrier ILIKE $" + params.length); }
        if (pol) { params.push("%" + pol + "%"); conds.push("pol ILIKE $" + params.length); }
        if (pod) { params.push("%" + pod + "%"); conds.push("pod ILIKE $" + params.length); }
        if (company) { params.push("%" + company + "%"); conds.push("company_name ILIKE $" + params.length); }
        if (conds.length) query += " WHERE " + conds.join(" AND ");
        params.push(parsedLimit);
        query += " ORDER BY created_at DESC LIMIT $" + params.length;
        return { query, params };
      };

      const exactQuery = buildListQuery({ includeCarrier: true });
      const result = await pool.query(exactQuery.query, exactQuery.params);
      if (!carrier) return res.status(200).json(result.rows);
      if (result.rows.length) {
        return res.status(200).json(result.rows.map((row) => ({ ...row, match: "exact" })));
      }
      if (pol || pod) {
        const routeQuery = buildListQuery({ includeCarrier: false });
        const routeResult = await pool.query(routeQuery.query, routeQuery.params);
        return res.status(200).json(routeResult.rows.map((row) => ({ ...row, match: "route" })));
      }
      return res.status(200).json(result.rows.map((row) => ({ ...row, match: "exact" })));
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

  // PATCH: update one record by id (auth required). The DB trigger logs price/fee changes
  // into local_charges_history automatically (涨价历史). updated_by ← JWT user.
  if (req.method === "PATCH") {
    if (!requireAuth(req, res)) return; // 401 if no valid JWT
    try {
      const body = req.body || {};
      const id = parseInt(body.id, 10);
      if (!Number.isFinite(id)) return res.status(400).json({ success:false, error:"id required" });
      // whitelist editable columns (never let id / charge_code / created_at through)
      const EDITABLE = ["carrier","pol","pod","company_name","container_type","fees","cost_total",
        "sell_total","free_time","remarks","raw","locked","locked_at","effective_from","valid_from",
        "valid_until","charge_name","amount","charge_type","applicable_trade","currency","notes",
        "prev_cost_total","prev_sell_total"];
      const JSON_COLS = ["fees","free_time","raw"];
      const sets = [], params = [];
      for (const k of EDITABLE) {
        if (Object.prototype.hasOwnProperty.call(body, k)) {
          params.push(JSON_COLS.includes(k) ? JSON.stringify(body[k] ?? null) : body[k]);
          sets.push(`${k} = $${params.length}`);
        }
      }
      if (!sets.length) return res.status(400).json({ success:false, error:"no editable fields" });
      const u = req.user || {};
      params.push(u.name || u.username || u.email || u.role || "admin");
      sets.push(`updated_by = $${params.length}`);
      sets.push(`updated_at = now()`);
      params.push(id);
      const result = await pool.query(
        `UPDATE local_charges SET ${sets.join(", ")} WHERE id = $${params.length} RETURNING *`, params);
      if (!result.rows.length) return res.status(404).json({ success:false, error:"not found" });
      return res.status(200).json({ success: true, data: result.rows[0] });
    } catch (err) {
      return res.status(500).json({ success:false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
