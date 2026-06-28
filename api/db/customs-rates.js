// /api/db/customs-rates.js — Customs broker flat-fee rates CRUD
// GET  : list/filter by vendor_cn, pol
// POST : create / batch create (admin)
// PATCH: update by _id (admin)
//
// Phase 8 (FAIL-CLOSED-2026-05-19): GET now requires JWT; raw JSONB (may
// contain cost breakdown / margin) is stripped for customer/factory/supplier.
import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

// Cost/margin columns redacted for non-internal roles
const CUSTOMS_COST_FIELDS = ['raw'];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT

  const pool       = getPool();
  const _role       = req.user?.role || 'customer';
  const _isInternal = _role === 'admin' || _role === 'finance' || _role === 'logistics';

  // ── GET ──────────────────────────────────────────────────
  if (req.method === "GET") {
    try {
      const { vendor, pol, limit = 1000 } = req.query;
      let query = "SELECT * FROM customs_rates";
      const params = [], conds = [];
      if (vendor) { params.push("%" + vendor + "%"); conds.push("vendor_cn ILIKE $" + params.length); }
      if (pol)    { params.push("%" + pol    + "%"); conds.push("pol ILIKE $"       + params.length); }
      if (conds.length) query += " WHERE " + conds.join(" AND ");
      params.push(parseInt(limit));
      query += " ORDER BY base_fee ASC NULLS LAST, updated_at DESC NULLS LAST LIMIT $" + params.length;
      let rows = (await pool.query(query, params)).rows;

      // Phase 8: strip cost fields for non-internal callers
      if (!_isInternal) {
        rows = rows.map(r => {
          const out = { ...r };
          for (const f of CUSTOMS_COST_FIELDS) delete out[f];
          return out;
        });
      }

      return res.status(200).json(rows);
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── POST (admin) ─────────────────────────────────────────
  if (req.method === "POST") {
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({ error: "Forbidden: admin only" });
    }
    try {
      const body    = req.body || {};
      const records = Array.isArray(body) ? body : [body];
      const inserted = [];
      for (const r of records) {
        const result = await pool.query(
          `INSERT INTO customs_rates
             (vendor_cn, pol, base_fee, extra_per_desc, max_free_descs,
              currency, notes, valid_from, valid_to, raw)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING *`,
          [
            r.vendor_cn || "", r.pol || "",
            r.base_fee != null ? r.base_fee : 80,   // 行情默认 ¥80/票
            r.extra_per_desc != null ? r.extra_per_desc : 0,
            r.max_free_descs != null ? r.max_free_descs : 0,
            r.currency || "CNY",
            r.notes || "",
            r.valid_from || null, r.valid_to || null,
            JSON.stringify(r.raw || {}),
          ]
        );
        inserted.push(result.rows[0]);
      }
      return res.status(201).json({ success: true, data: inserted, count: inserted.length });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ── PATCH (admin) ────────────────────────────────────────
  if (req.method === "PATCH") {
    if (!req.user || req.user.role !== "admin") {
      return res.status(403).json({ error: "Forbidden: admin only" });
    }
    try {
      const { _id, patch } = req.body || {};
      if (!_id || !patch) {
        return res.status(400).json({ success: false, error: "_id and patch required" });
      }
      const ALLOWED = ["vendor_cn","pol","base_fee","extra_per_desc","max_free_descs","currency","notes","valid_from","valid_to","raw"];
      const sets = [], params = [];
      for (const [k, v] of Object.entries(patch)) {
        if (!ALLOWED.includes(k)) continue;
        params.push(typeof v === "object" && v !== null ? JSON.stringify(v) : v);
        sets.push(`${k} = $${params.length}`);
      }
      if (!sets.length) return res.status(400).json({ success: false, error: "no valid fields" });
      sets.push("updated_at = NOW()");
      params.push(_id);
      const r = await pool.query(
        `UPDATE customs_rates SET ${sets.join(", ")} WHERE _id = $${params.length} RETURNING *`,
        params
      );
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
