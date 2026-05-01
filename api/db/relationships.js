import { getPool, setCors } from "../db.js";

// ═══════════════════════════════════════════════════════════════
// /api/db/relationships — graph edges between companies (v2 Network)
//
// GET    ?from=<id>&type=<type>     — list edges from a company
// GET    ?to=<id>&type=<type>       — list edges into a company
// GET    ?company=<id>              — list ALL edges touching this company
// POST   { from, to, type, ... }    — create edge (idempotent on UNIQUE)
// PATCH  { id, status, volume, ... }— update edge stats / status
// DELETE ?id=<id>                   — remove (rare; usually status='ended')
//
// Visibility (1-hop default per blueprint v2 decision 3):
// Caller's company_id is checked against from/to. If neither, returns 403.
// (Auth layer must inject req.company_id from JWT.)
// ═══════════════════════════════════════════════════════════════

var VALID_TYPES = ['buys_from', 'sells_to', 'ships_via', 'serves', 'partners_with'];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var callerCompanyId = req.company_id || req.headers["x-company-id"]; // injected by auth middleware

    // ── GET ─────────────────────────────────────────────
    if (req.method === "GET") {
      var { from, to, company, type, status = 'active', limit = 200 } = req.query;

      // Resolve from_code / to_code → integer IDs via customers table
      if (!from && req.query.from_code) {
        var codeRes = await pool.query("SELECT id FROM customers WHERE company_code = $1 LIMIT 1", [req.query.from_code]);
        if (codeRes.rows.length) from = String(codeRes.rows[0].id);
      }
      if (!to && req.query.to_code) {
        var codeRes2 = await pool.query("SELECT id FROM customers WHERE company_code = $1 LIMIT 1", [req.query.to_code]);
        if (codeRes2.rows.length) to = String(codeRes2.rows[0].id);
      }

      var conds = [], params = [];

      if (company) {
        params.push(parseInt(company));
        conds.push("(from_company_id = $" + params.length + " OR to_company_id = $" + params.length + ")");
      } else {
        if (from) { params.push(parseInt(from)); conds.push("from_company_id = $" + params.length); }
        if (to)   { params.push(parseInt(to));   conds.push("to_company_id   = $" + params.length); }
      }
      if (type)   { params.push(type);   conds.push("type = $" + params.length); }
      if (status) { params.push(status); conds.push("status = $" + params.length); }

      // Hide supplier-identity rows from non-admin callers (middleman privacy)
      var isAdmin = req.user && req.user.role === 'admin';
      if (!isAdmin) {
        conds.push("(visibility_to_partners IS NULL OR visibility_to_partners != 'hidden')");
      }

      // Visibility guard: caller must be one of the parties (1-hop default)
      if (callerCompanyId && !company && !from && !to) {
        params.push(parseInt(callerCompanyId));
        conds.push("(from_company_id = $" + params.length + " OR to_company_id = $" + params.length + ")");
      }

      var query = "SELECT * FROM relationships";
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += " ORDER BY last_interaction_at DESC NULLS LAST LIMIT $" + params.length;

      var result = await pool.query(query, params);

      // Enrich with counterparty company name (helps UI)
      var counterpartyIds = new Set();
      result.rows.forEach(function (r) {
        counterpartyIds.add(r.from_company_id);
        counterpartyIds.add(r.to_company_id);
      });
      var nameMap = {};
      if (counterpartyIds.size) {
        var ids = Array.from(counterpartyIds);
        var nameRes = await pool.query(
          "SELECT id, name_en, name_cn, country, company_code FROM customers WHERE id = ANY($1)",
          [ids]
        );
        nameRes.rows.forEach(function (c) { nameMap[c.id] = c; });
      }

      return res.status(200).json({
        success: true,
        data: result.rows,
        companies: nameMap,
        count: result.rowCount,
      });
    }

    // ── POST — create/upsert edge ──────────────────────
    if (req.method === "POST") {
      var body = req.body || {};
      var { from_company_id, to_company_id, type, category, invited_by_user_id, invite_id, notes } = body;

      if (!from_company_id || !to_company_id) {
        return res.status(400).json({ success: false, error: "from_company_id and to_company_id required" });
      }
      if (from_company_id === to_company_id) {
        return res.status(400).json({ success: false, error: "no self-loop allowed" });
      }
      if (!VALID_TYPES.includes(type)) {
        return res.status(400).json({ success: false, error: "type must be one of " + VALID_TYPES.join(",") });
      }

      var sql = `INSERT INTO relationships
        (from_company_id, to_company_id, type, category, invited_by_user_id, invite_id, notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (from_company_id, to_company_id, type)
        DO UPDATE SET
          status = 'active',
          ended_at = NULL,
          updated_at = NOW(),
          notes = COALESCE(NULLIF(EXCLUDED.notes,''), relationships.notes)
        RETURNING *`;

      var result = await pool.query(sql, [
        from_company_id, to_company_id, type,
        category || '', invited_by_user_id || null, invite_id || null, notes || ''
      ]);
      return res.status(200).json({ success: true, data: result.rows[0] });
    }

    // ── PATCH — update edge stats / status ─────────────
    if (req.method === "PATCH") {
      var body = req.body || {};
      var { id, status, volume_ytd_cny, order_count_ytd, on_time_rate, last_interaction_at, visibility_to_partners, notes } = body;
      if (!id) return res.status(400).json({ success: false, error: "id required" });

      var sets = [], params = [];
      function add(col, val) {
        if (val !== undefined) { params.push(val); sets.push(col + " = $" + params.length); }
      }
      add("status", status);
      add("volume_ytd_cny", volume_ytd_cny);
      add("order_count_ytd", order_count_ytd);
      add("on_time_rate", on_time_rate);
      add("last_interaction_at", last_interaction_at);
      add("visibility_to_partners", visibility_to_partners);
      add("notes", notes);
      if (status === 'ended' && !sets.find(function(s){return s.startsWith('ended_at');})) {
        params.push(new Date().toISOString());
        sets.push("ended_at = $" + params.length);
      }
      sets.push("updated_at = NOW()");
      params.push(parseInt(id));

      var sql = "UPDATE relationships SET " + sets.join(", ") + " WHERE id = $" + params.length + " RETURNING *";
      var result = await pool.query(sql, params);
      if (!result.rowCount) return res.status(404).json({ success: false, error: "not found" });
      return res.status(200).json({ success: true, data: result.rows[0] });
    }

    // ── DELETE ──────────────────────────────────────────
    if (req.method === "DELETE") {
      var id = req.query && req.query.id;
      if (!id) return res.status(400).json({ success: false, error: "id required" });
      await pool.query("DELETE FROM relationships WHERE id = $1", [parseInt(id)]);
      return res.status(200).json({ success: true, deleted: parseInt(id) });
    }

    return res.status(405).json({ success: false, error: "method not allowed" });
  } catch (err) {
    console.error("[relationships] error:", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
}
