// api/db/contracts.js — Contracts CRUD API
// GET: list contracts (with optional filters: type, status, party_a_code, party_b_code)
// POST: create or update a contract

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { Pool } = require("pg");
  const pool = new Pool({
    host: process.env.PG_HOST,
    port: parseInt(process.env.PG_PORT || "5432"),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: false,
  });

  try {
    /* ═══ GET: list contracts ═══ */
    if (req.method === "GET") {
      const { type, status, party_a_code, party_b_code, company_code } = req.query;
      let where = [];
      let params = [];
      let idx = 1;

      if (type) { where.push("type = $" + idx); params.push(type); idx++; }
      if (status) { where.push("status = $" + idx); params.push(status); idx++; }
      if (party_a_code) { where.push("party_a_code = $" + idx); params.push(party_a_code); idx++; }
      if (party_b_code) { where.push("party_b_code = $" + idx); params.push(party_b_code); idx++; }
      // company_code matches either party_a or party_b (for customer portal view)
      if (company_code) {
        where.push("(party_a_code = $" + idx + " OR party_b_code = $" + (idx + 1) + ")");
        params.push(company_code, company_code);
        idx += 2;
      }

      const whereClause = where.length > 0 ? " WHERE " + where.join(" AND ") : "";
      const sql = "SELECT * FROM contracts" + whereClause + " ORDER BY created_at DESC";
      const result = await pool.query(sql, params);

      // Parse raw JSONB
      const data = result.rows.map(function(r) {
        if (r.raw && typeof r.raw === "string") {
          try { r.raw = JSON.parse(r.raw); } catch(e) {}
        }
        return r;
      });

      await pool.end();
      return res.status(200).json({ success: true, data: data, count: data.length });
    }

    /* ═══ POST: create or update contract ═══ */
    if (req.method === "POST") {
      const body = req.body || {};
      const {
        id, contract_no, type, status,
        party_a, party_a_code, party_b, party_b_code,
        sign_date, start_date, end_date,
        file_url, file_name,
        raw, created_by,
      } = body;

      /* Update existing contract */
      if (id) {
        const fields = [];
        const params = [];
        let idx = 1;

        const addField = function(col, val) {
          if (val !== undefined) {
            fields.push(col + " = $" + idx);
            params.push(col === "raw" && typeof val === "object" ? JSON.stringify(val) : val);
            idx++;
          }
        };

        addField("contract_no", contract_no);
        addField("type", type);
        addField("status", status);
        addField("party_a", party_a);
        addField("party_a_code", party_a_code);
        addField("party_b", party_b);
        addField("party_b_code", party_b_code);
        addField("sign_date", sign_date || null);
        addField("start_date", start_date || null);
        addField("end_date", end_date || null);
        addField("file_url", file_url);
        addField("file_name", file_name);
        addField("raw", raw);

        // Always update timestamp
        fields.push("updated_at = NOW()");

        if (fields.length === 1) {
          await pool.end();
          return res.status(400).json({ error: "No fields to update" });
        }

        params.push(id);
        const sql = "UPDATE contracts SET " + fields.join(", ") + " WHERE id = $" + idx + " RETURNING *";
        const result = await pool.query(sql, params);
        await pool.end();

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Contract not found" });
        }
        return res.status(200).json({ success: true, data: result.rows[0] });
      }

      /* Create new contract */
      if (!contract_no || !type) {
        await pool.end();
        return res.status(400).json({ error: "contract_no and type are required" });
      }

      const rawStr = raw && typeof raw === "object" ? JSON.stringify(raw) : (raw || "{}");

      const sql = `INSERT INTO contracts 
        (contract_no, type, status, party_a, party_a_code, party_b, party_b_code, 
         sign_date, start_date, end_date, file_url, file_name, raw, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        RETURNING *`;

      const result = await pool.query(sql, [
        contract_no, type, status || "draft",
        party_a || null, party_a_code || null,
        party_b || null, party_b_code || null,
        sign_date || null, start_date || null, end_date || null,
        file_url || null, file_name || null,
        rawStr, created_by || null,
      ]);

      await pool.end();
      return res.status(201).json({ success: true, data: result.rows[0] });
    }

    await pool.end();
    return res.status(405).json({ error: "Method not allowed" });

  } catch (err) {
    try { await pool.end(); } catch(e) {}
    console.error("contracts API error:", err);
    // Handle unique constraint violation
    if (err.code === "23505") {
      return res.status(409).json({ success: false, error: "合同编号已存在", detail: err.detail });
    }
    return res.status(500).json({ success: false, error: err.message });
  }
}
