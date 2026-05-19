import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

// Phase 8 (FAIL-CLOSED-2026-05-19): cost columns hidden from non-internal roles.
// gp20/hq40 = carrier cost (Sanlyn pays); customer_gp20/hq40 = sale price (customer sees).
// raw JSONB may contain margin/cost breakdown — also redacted for non-internal.
const COST_FIELDS = ['gp20', 'hq40', 'raw'];

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const _role       = req.user?.role || 'customer';
  const _isInternal = _role === 'admin' || _role === 'finance' || _role === 'logistics';

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
