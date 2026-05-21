import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

// Phase 8 (FAIL-CLOSED-2026-05-19): cost columns hidden from non-internal roles.
// gp20/hq40 = carrier cost (Sanlyn pays); customer_gp20/hq40 = sale price (customer sees).
// raw JSONB may contain margin/cost breakdown — also redacted for non-internal.
const COST_FIELDS = ['gp20', 'hq40', 'raw'];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT

  const _role       = req.user?.role || 'customer';
  const _isInternal = _role === 'admin' || _role === 'finance' || _role === 'logistics';

  // ── Create / update a freight rate (internal roles only) ──
  // Was GET-only (405 on write) — that's why no rate could be entered. Maps the
  // UI's legacy field names (rate_20gp/rate_40hq/valid_until/notes) onto the real
  // columns (gp20/hq40/valid_to/remarks).
  if (req.method === "POST" || req.method === "PATCH") {
    if (!_isInternal) return res.status(403).json({ error: "Forbidden: internal roles only" });
    try {
      const pool = getPool();
      const b = req.body || {};
      const ALIASES = { rate_20gp:"gp20", rate_40hq:"hq40", valid_until:"valid_to", notes:"remarks" };
      const m = { ...b };
      for (const [a, c] of Object.entries(ALIASES)) { if (m[a] != null && m[c] == null) m[c] = m[a]; }
      const WRITE_COLS = [
        "pol","pod","carrier","forwarder","route_code","via",
        "gp20","hq40","customer_gp20","customer_hq40","profit_20gp","profit_40hq",
        "transit_days","thc","freetime","local_charge_code",
        "valid_from","valid_to","eta_date","this_week","next_week","next_sailing",
        "remarks","status",
      ];
      const cols = [], vals = [];
      for (const c of WRITE_COLS) {
        if (!(c in m) || m[c] === undefined) continue;
        vals.push(m[c] === "" ? null : m[c]);
        cols.push(c);
      }
      if (req.method === "POST") {
        if (!m.pol || !m.pod) return res.status(400).json({ error: "pol and pod are required" });
        if (!cols.length) return res.status(400).json({ error: "no fields to insert" });
        const ph = cols.map((_, i) => "$" + (i + 1));
        const r = await pool.query(
          "INSERT INTO freight_rates (" + cols.join(", ") + ", created_at, updated_at) VALUES (" + ph.join(", ") + ", NOW(), NOW()) RETURNING *",
          vals
        );
        return res.status(200).json({ success: true, data: r.rows[0] });
      }
      const id = req.query?.id || b.id;
      if (!id) return res.status(400).json({ error: "id required" });
      if (!cols.length) return res.status(400).json({ error: "no fields to patch" });
      const sets = cols.map((c, i) => c + " = $" + (i + 1));
      vals.push(id);
      const r = await pool.query(
        "UPDATE freight_rates SET " + sets.join(", ") + ", updated_at = NOW() WHERE id = $" + vals.length + " RETURNING *",
        vals
      );
      if (r.rowCount === 0) return res.status(404).json({ error: "rate not found" });
      return res.status(200).json({ success: true, data: r.rows[0] });
    } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
  }

  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    const pool = getPool();
    const { pol, pod, carrier, limit = 1000 } = req.query;
    // LEFT JOIN port_charges: 同 (pol, pod, carrier) 最新一条 sale_price_* 作为本地港杂
    // 若 port_charges 该条空 → 返回 null，前端显示 "on request"
    let query = `
      SELECT f.id, f.pol, f.pod, f.carrier,
        f.route_code AS "routeCode", f.gp20, f.hq40,
        f.customer_gp20 AS "customerGp20", f.customer_hq40 AS "customerHq40",
        f.this_week AS "thisWeek", f.next_week AS "nextWeek",
        f.next_sailing AS "nextSailing",
        f.valid_from AS "validFrom", f.valid_to AS "validTo",
        f.transit_days AS "transitDays", f.thc, f.remarks, f.raw,
        f.forwarder, f.via, f.freetime, f.local_charge_code AS "localChargeCode",
        f.eta_date AS "etaDate", f.status,
        f.created_at AS "createdAt", f.updated_at AS "updatedAt",
        pc.sale_price_20gp AS "portGp20",
        pc.sale_price_40hq AS "portHq40",
        pc.free_time AS "portFreeTime"
      FROM freight_rates f
      LEFT JOIN LATERAL (
        SELECT sale_price_20gp, sale_price_40hq, free_time
        FROM port_charges
        WHERE pol = f.pol AND pod = f.pod AND carrier = f.carrier
          AND (enabled IS NULL OR enabled IN ('1','true','y','yes'))
        ORDER BY updated_at DESC NULLS LAST, created_at DESC
        LIMIT 1
      ) pc ON TRUE`;
    const params = [], conds = [];
    if (pol) { params.push(`%${pol}%`); conds.push(`f.pol ILIKE $${params.length}`); }
    if (pod) { params.push(`%${pod}%`); conds.push(`f.pod ILIKE $${params.length}`); }
    if (carrier) { params.push(`%${carrier}%`); conds.push(`f.carrier ILIKE $${params.length}`); }
    if (conds.length) query += " WHERE " + conds.join(" AND ");
    params.push(parseInt(limit));
    query += ` ORDER BY f.created_at DESC LIMIT $${params.length}`;
    let rows = (await pool.query(query, params)).rows;

    // Phase 8: strip cost fields for non-internal callers
    if (!_isInternal) {
      rows = rows.map(r => {
        const out = { ...r };
        for (const f of COST_FIELDS) delete out[f];
        return out;
      });
    }

    return res.status(200).json(rows);
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
