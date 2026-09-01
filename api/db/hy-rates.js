// /api/db/hy-rates - read-only freight rate list data
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function clean(value) {
  return value == null ? "" : String(value).trim();
}

function intRange(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function likeParam(value) {
  const text = clean(value);
  return text ? `%${text}%` : "";
}

function addLike(where, params, column, value) {
  const text = likeParam(value);
  if (!text) return;
  params.push(text);
  where.push(`${column} ILIKE $${params.length}`);
}

function addExpired(where, params, value) {
  const mode = clean(value) || "valid";
  if (mode === "all") return;
  if (mode === "expired") {
    where.push("r.valid_to < CURRENT_DATE");
    return;
  }
  where.push("(r.valid_to IS NULL OR r.valid_to >= CURRENT_DATE)");
}

function buildWhere(query, params) {
  const where = [];
  addLike(where, params, "r.pol", query?.pol);
  addLike(where, params, "r.pod", query?.pod);
  addLike(where, params, "r.carrier", query?.carrier);
  addExpired(where, params, query?.expired);

  const unit = clean(query?.unit);
  if (unit) {
    params.push(unit);
    where.push(
      `EXISTS (
        SELECT 1 FROM v_freight_rate_fee_sell u
        WHERE u.rate_id = r.id AND u.charge_unit = $${params.length}
      )`
    );
  }
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}

function rowIds(rows) {
  return rows.map(row => row.id).filter(id => id != null);
}

async function loadRates(pool, query) {
  const params = [];
  const whereSql = buildWhere(query, params);
  const limit = intRange(query?.limit, 50, 1, 200);
  const offset = intRange(query?.offset, 0, 0, 1000000);
  const countResult = await pool.query(
    `SELECT count(*) AS total
     FROM freight_rates r
     ${whereSql}`,
    params
  );

  params.push(limit);
  params.push(offset);
  const rateResult = await pool.query(
    `SELECT r.id, r.pol, r.pod, r.via, r.carrier, r.forwarder, r.route_code,
            r.transit_days, r.valid_from, r.valid_to, r.next_sailing,
            r.min_container_qty, r.payment_method, r.space_status,
            r.applicable_commodity, r.remarks, r.currency, r.status,
            (r.valid_to < CURRENT_DATE) AS expired
     FROM freight_rates r
     ${whereSql}
     ORDER BY r.valid_to NULLS LAST, r.id
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    rows: rateResult.rows,
    total: Number(countResult.rows[0]?.total || 0),
  };
}

async function loadFees(pool, ids) {
  if (!ids.length) return [];
  const result = await pool.query(
    `SELECT rate_id, fee_id, fee_name, currency, seq, charge_unit,
            cost, sell, has_margin
     FROM v_freight_rate_fee_sell
     WHERE rate_id = ANY($1::int[])
     ORDER BY rate_id, seq NULLS LAST, fee_name, charge_unit`,
    [ids]
  );
  return result.rows;
}

function compactFees(rateRows, feeRows) {
  const units = new Set();
  const byRate = new Map();

  for (const row of feeRows) {
    if (row.charge_unit) units.add(row.charge_unit);
    const feeKey = `${row.rate_id}:${row.fee_id || ""}:${row.seq || ""}:${row.fee_name || ""}`;
    if (!byRate.has(row.rate_id)) byRate.set(row.rate_id, new Map());
    const fees = byRate.get(row.rate_id);
    if (!fees.has(feeKey)) {
      fees.set(feeKey, {
        fee_name: row.fee_name,
        currency: row.currency,
        seq: row.seq,
        has_margin: row.has_margin,
        cells: {},
      });
    }
    const fee = fees.get(feeKey);
    if (row.has_margin) fee.has_margin = true;
    if (row.charge_unit) {
      fee.cells[row.charge_unit] = { cost: row.cost, sell: row.sell };
    }
  }

  const rows = rateRows.map(rate => {
    const fees = Array.from((byRate.get(rate.id) || new Map()).values());
    fees.sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    return { ...rate, expired: Boolean(rate.expired), fees };
  });

  return {
    charge_units: Array.from(units).sort((a, b) => String(a).localeCompare(String(b))),
    rows,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  try {
    const data = await loadRates(pool, req.query || {});
    const fees = await loadFees(pool, rowIds(data.rows));
    const compact = compactFees(data.rows, fees);
    return res.json({
      success: true,
      generated_at: new Date().toISOString(),
      total: data.total,
      limit: intRange(req.query?.limit, 50, 1, 200),
      offset: intRange(req.query?.offset, 0, 0, 1000000),
      charge_units: compact.charge_units,
      rows: compact.rows,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: "Internal server error" });
  }
}
