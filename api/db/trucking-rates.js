// GET /api/db/trucking-rates — truck/customs quotes from service_rates only.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERSION = "v2026.08.26-1";
const SERVICE_COLS = [
  "id", "service", "quote_owner_company_id", "executor_company_id", "payable_company_id",
  "issuing_company_id", "issuing_company", "factory_company_id", "factory_name",
  "pol", "pod", "container_type", "tier", "rate", "currency", "unit",
  "valid_from", "valid_to", "is_active", "source", "notes", "raw",
  "price_side", "pickup_place", "customs_port", "customs_type", "vehicle_type",
];
const COMPANY_TYPES = {
  truck: "trucking",
  customs: "customs_broker",
};

function clean(v, max = 160) {
  return String(v ?? "").trim().slice(0, max);
}

function truthy(v, fallback = true) {
  if (v === undefined || v === null || v === "") return fallback;
  return !["0", "false", "no", "off"].includes(String(v).trim().toLowerCase());
}

async function tableColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function maybe(cols, name, expr = `s.${name}`, alias = name) {
  return cols.has(name) ? `${expr} AS ${alias}` : `NULL AS ${alias}`;
}

function serviceSelect(cols) {
  return SERVICE_COLS.map((c) => {
    if (c === "valid_from") return maybe(cols, c, "to_char(s.valid_from,'YYYY-MM-DD')");
    if (c === "valid_to") return maybe(cols, c, "to_char(s.valid_to,'YYYY-MM-DD')");
    return maybe(cols, c);
  }).join(", ");
}

function addLike(q, params, conds, key, expr) {
  const value = clean(q[key]);
  if (!value) return;
  params.push(`%${value}%`);
  conds.push(`${expr} ILIKE $${params.length}`);
}

function addExact(q, params, conds, key, expr) {
  const value = clean(q[key], 48);
  if (!value) return;
  params.push(value);
  conds.push(`${expr} = $${params.length}`);
}

function filters(q, cols, service) {
  const params = [service];
  const conds = ["s.service = $1"];
  if (truthy(q.active_only, false) && cols.has("is_active")) {
    conds.push("s.is_active IS TRUE");
    if (cols.has("valid_to")) conds.push("(s.valid_to IS NULL OR s.valid_to >= CURRENT_DATE)");
  }
  if (cols.has("price_side")) addExact(q, params, conds, "price_side", "s.price_side");
  if (service === "truck") {
    if (cols.has("pickup_place")) addLike(q, params, conds, "pickup_place", "s.pickup_place");
    if (cols.has("pol")) addLike(q, params, conds, "pol", "s.pol");
    if (cols.has("container_type")) addExact(q, params, conds, "container_type", "s.container_type");
    if (cols.has("tier")) addExact(q, params, conds, "tier", "s.tier");
  } else {
    if (cols.has("customs_port")) addLike(q, params, conds, "customs_port", "s.customs_port");
    else if (cols.has("pol")) addLike(q, params, conds, "customs_port", "s.pol");
    if (cols.has("customs_type")) addLike(q, params, conds, "customs_type", "s.customs_type");
    if (cols.has("unit")) addExact(q, params, conds, "unit", "s.unit");
  }
  return { params, where: conds.join(" AND ") };
}

async function partners(pool, type) {
  const r = await pool.query(
    `SELECT id, code, COALESCE(NULLIF(name_cn,''), NULLIF(name_en,''), code) AS name
       FROM companies
      WHERE type = $1
      ORDER BY name`,
    [type]
  );
  return r.rows;
}

async function rates(pool, q, service, cols) {
  const built = filters(q, cols, service);
  const pickupOrder = cols.has("pickup_place") ? "s.pickup_place" : "s.factory_name";
  const vehicleOrder = cols.has("vehicle_type") ? "s.vehicle_type NULLS LAST," : "";
  const r = await pool.query(
    `SELECT ${serviceSelect(cols)},
            c.id AS company_id,
            c.code AS company_code,
            COALESCE(NULLIF(c.name_cn,''), NULLIF(c.name_en,''), c.code) AS company_name
       FROM service_rates s
       LEFT JOIN companies c ON c.id = COALESCE(s.executor_company_id, s.payable_company_id)
      WHERE ${built.where}
      ORDER BY COALESCE(${pickupOrder}, ''), s.pol NULLS LAST,
               s.container_type NULLS LAST, s.tier NULLS LAST,
               ${vehicleOrder} COALESCE(c.name_cn, c.name_en, c.code, ''), s.rate NULLS LAST`,
    built.params
  );
  return r.rows;
}

function summarize(rows, partnerCount, service) {
  if (service === "customs" && rows.length === 0) {
    return "未接入：报关报价尚无数据，需先录入";
  }
  const quoted = new Set(rows.map((r) => r.company_id).filter(Boolean)).size;
  if (partnerCount && quoted < partnerCount) return `未接入：该线路仅 ${quoted} 家有报价`;
  return rows.length ? "ready" : "未接入：该线路仅 0 家有报价";
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const service = clean(req.query.service || "truck", 16) === "customs" ? "customs" : "truck";
    const pool = getPool();
    const cols = await tableColumns(pool, "service_rates");
    const partnerRows = await partners(pool, COMPANY_TYPES[service]);
    const rateRows = await rates(pool, req.query || {}, service, cols);
    return res.status(200).json({
      success: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      service,
      source: { table: "service_rates", service_value: service },
      partners: partnerRows,
      rows: rateRows,
      state: rateRows.length ? "ready" : "not_connected",
      message: summarize(rateRows, partnerRows.length, service),
      coverage: { partner_count: partnerRows.length, quoted_partner_count: new Set(rateRows.map((r) => r.company_id).filter(Boolean)).size },
    });
  } catch (err) {
    console.error("[trucking-rates]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
