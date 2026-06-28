import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// ═══════════════════════════════════════════════════════════════
// /api/db/relationships — graph edges between companies (v2 Network)
//
// GET    ?from=<id>&type=<type>     — list edges from a company
// GET    ?to=<id>&type=<type>       — list edges into a company
// GET    ?company=<id>              — list ALL edges touching this company
// POST   { from, to, type, ... }    — create edge (idempotent on UNIQUE)
//         self-service: caller must be from_company_id OR to_company_id; admin = unrestricted
// PATCH  { id, status, volume, ... }— update edge stats / status — admin only
// DELETE ?id=<id>                   — remove (rare; usually status='ended')
//         self-service: caller must be a party to the edge; admin = unrestricted
//
// Visibility (1-hop default per blueprint v2 decision 3):
// Caller's company_id is checked against from/to. If neither, returns 403.
// (Auth layer must inject req.company_id from JWT.)
// ═══════════════════════════════════════════════════════════════

var VALID_TYPES = ['buys_from', 'sells_to', 'ships_via', 'serves', 'partners_with'];

// ── Helpers ──────────────────────────────────────────────────

// Resolve the caller's numeric company id.
// JWT carries companyCode (string); look up the integer id from customers table.
// Returns numeric id or null if not found.
var _companyIdCache = new Map(); // companyCode → { id, ts }
async function resolveCallerCompanyId(user, pool) {
  // Already numeric on the token (future-proofing)
  if (user.company_id && Number.isInteger(user.company_id)) return user.company_id;
  if (user.companyId  && Number.isInteger(user.companyId))  return user.companyId;

  var code = user.companyCode || user.company_code;
  if (!code) return null;

  var hit = _companyIdCache.get(code);
  if (hit && Date.now() - hit.ts < 60000) return hit.id;

  var r = await pool.query(
    "SELECT id FROM customers WHERE company_code = $1 LIMIT 1",
    [code]
  );
  var id = r.rows.length ? r.rows[0].id : null;
  _companyIdCache.set(code, { id, ts: Date.now() });
  return id;
}

// ── Self-service scope guard ──────────────────────────────────
// Admins bypass all checks. Non-admins must be a party to the relationship.
// fromId / toId should be integers.
// Throws an error with .status = 403 on violation.
async function assertRelationshipScope(req, pool, fromId, toId) {
  if (req.user.role === "admin" || req.user.superAdmin) return; // admin bypass

  var myId = await resolveCallerCompanyId(req.user, pool);
  if (!myId) {
    var err = new Error("Cannot resolve your company — contact an admin");
    err.status = 403;
    throw err;
  }
  if (fromId !== myId && toId !== myId) {
    var err2 = new Error("Cannot create/delete relationships for other companies");
    err2.status = 403;
    throw err2;
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // ── Auth: all methods require valid JWT ──
  if (!requireAuth(req, res)) return;

  // ── PATCH remains admin-only (stats/status updates are operational) ──
  if (req.method === "PATCH") {
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({ success: false, error: "Admin only — relationship stats updates require admin role." });
    }
  }

  try {
    var pool = getPool();
    var callerCompanyId = req.user && (req.user.company_id || req.user.companyId) || req.headers["x-company-id"];

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

      // ── self-service scope check ──
      await assertRelationshipScope(req, pool, parseInt(from_company_id), parseInt(to_company_id));

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

      // ── self-service scope check ──
      // Fetch the relationship first to verify the caller is a party to it
      var existing = await pool.query(
        "SELECT from_company_id, to_company_id FROM relationships WHERE id = $1 LIMIT 1",
        [parseInt(id)]
      );
      if (!existing.rowCount) {
        return res.status(404).json({ success: false, error: "relationship not found" });
      }
      var rel = existing.rows[0];
      await assertRelationshipScope(req, pool, rel.from_company_id, rel.to_company_id);

      await pool.query("DELETE FROM relationships WHERE id = $1", [parseInt(id)]);
      return res.status(200).json({ success: true, deleted: parseInt(id) });
    }

    return res.status(405).json({ success: false, error: "method not allowed" });
  } catch (err) {
    console.error("[relationships] error:", err);
    var status = err.status && err.status >= 400 && err.status < 600 ? err.status : 500;
    return res.status(status).json({ success: false, error: String(err.message || err) });
  }
}
