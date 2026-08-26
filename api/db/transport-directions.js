// 六方向运输模块 · read-only lens over shipping_plans.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance", "operator", "ceo", "superadmin"]);
const VERSION = "v2026.08.26-1";
const BASE_FIELDS = [
  ["shipment_no", "CY号"], ["booking_no", "订舱号"], ["so_no", "SO号"], ["bl_no", "提单号"],
  ["customer", "客户"], ["pol", "起运地"], ["pod", "目的地"], ["etd", "ETD"], ["eta", "ETA"],
  ["carrier_code", "承运人"], ["forwarder_cn", "货代"], ["trucking_cn", "车队"], ["flow_status", "状态"],
];
const SOURCE_FIELDS = [
  ["transport_mode", "运输方式"], ["shipment_type", "运输类型"], ["service_type", "服务类型"],
  ["trade_mode", "贸易方式"], ["direction", "方向"], ["freight_mode", "货运方式"], ["is_import", "进口标记"],
];
const RAW_KEYS = ["transport_mode", "shipment_type", "service_type", "trade_mode", "direction", "freight_mode", "import_export", "shipping_mode"];
const DIRECTIONS = [
  ["import", "进口", /进口|import|inbound/i],
  ["air", "空运", /空运|air|flight/i],
  ["land", "陆运", /陆运|公路|卡车|拖车|truck|trucking|road/i],
  ["rail", "铁路", /铁路|rail|train/i],
  ["domestic_water", "内贸水运", /内贸水运|内贸|内河|驳船|domestic.*(water|barge|ship)|coastal/i],
  ["self_consolidation", "自拼", /自拼|自拼箱|拼箱|lcl|consolid/i],
];

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}

function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

function pct(filled, total) {
  if (!total) return null;
  return Math.round((filled * 1000) / total) / 10;
}

async function tableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(r.rows[0]?.name);
}

async function columns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function col(alias, name, colSet) {
  return colSet.has(name) ? `${alias}.${name}` : `NULL AS ${name}`;
}

function rawExpr(key, colSet) {
  return colSet.has("raw") ? `NULLIF(BTRIM(s.raw->>'${key}'), '') AS raw_${key}` : `NULL::text AS raw_${key}`;
}

function coverage(rows, fields, colSet) {
  return fields.map(([name, label]) => {
    if (!colSet.has(name)) return { table: "shipping_plans", name, label, state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { table: "shipping_plans", name, label, state: filled ? "ready" : "not_connected", filled, total: rows.length, fill_rate: pct(filled, rows.length) };
  });
}

function rawCoverage(rows, colSet) {
  return RAW_KEYS.map((name) => {
    if (!colSet.has("raw")) return { table: "shipping_plans.raw", name, label: `raw.${name}`, state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
    const key = `raw_${name}`;
    const filled = rows.filter((r) => hasValue(r[key])).length;
    return { table: "shipping_plans.raw", name, label: `raw.${name}`, state: filled ? "ready" : "not_connected", filled, total: rows.length, fill_rate: pct(filled, rows.length) };
  });
}

function sourceText(row) {
  return SOURCE_FIELDS.map(([name]) => row[name]).concat(RAW_KEYS.map((name) => row[`raw_${name}`])).filter(hasValue).join(" ");
}

function classify(row) {
  const text = sourceText(row);
  const hit = DIRECTIONS.find(([, , re]) => re.test(text));
  return hit ? { key: hit[0], label: hit[1], basis: "shipping_plans 方向/运输方式真实字段" } : null;
}

function missing(row, colSet) {
  return BASE_FIELDS.filter(([name]) => !colSet.has(name) || !hasValue(row[name])).map(([name, label]) => ({
    table: "shipping_plans", name, label, reason: colSet.has(name) ? "empty" : "not_connected",
  }));
}

function searchConds(colSet, params, q) {
  const search = clean(q.q || q.search, 100);
  if (!search) return [];
  params.push(`%${search}%`);
  const cols = ["shipment_no", "booking_no", "so_no", "bl_no", "customer", "pol", "pod"]
    .filter((name) => colSet.has(name)).map((name) => `s.${name}::text ILIKE $${params.length}`);
  return cols.length ? [`(${cols.join(" OR ")})`] : [];
}

async function listRows(pool, colSet, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 180, 240);
  const params = [];
  const conds = [];
  if (colSet.has("deleted_at")) conds.push("s.deleted_at IS NULL");
  conds.push(...searchConds(colSet, params, q));
  params.push(limit);
  const fields = BASE_FIELDS.concat(SOURCE_FIELDS).map(([name]) => col("s", name, colSet)).join(", ");
  const raw = RAW_KEYS.map((name) => rawExpr(name, colSet)).join(", ");
  const id = colSet.has("id") ? "s.id" : "NULL::int AS id";
  const planId = colSet.has("_id") ? "s._id" : "NULL::text AS _id";
  const order = colSet.has("etd") ? "s.etd DESC NULLS LAST" : (colSet.has("updated_at") ? "s.updated_at DESC NULLS LAST" : "1");
  const r = await pool.query(
    `SELECT ${id}, ${planId}, ${fields}, ${raw}
       FROM shipping_plans s
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      ORDER BY ${order}
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

function rowOut(row, colSet) {
  const dir = classify(row);
  const miss = missing(row, colSet);
  return {
    id: row.id, plan_id: row._id, direction_key: dir?.key || null, direction_label: dir?.label || null,
    direction_basis: dir?.basis || null, source_text: sourceText(row) || null,
    shipment_no: row.shipment_no, booking_no: row.booking_no, so_no: row.so_no, bl_no: row.bl_no,
    customer: row.customer, pol: row.pol, pod: row.pod, etd: row.etd, eta: row.eta,
    carrier_code: row.carrier_code, forwarder_cn: row.forwarder_cn, trucking_cn: row.trucking_cn,
    status: row.flow_status, missing_count: miss.length, missing: miss,
  };
}

function directionStats(data, sourceRates) {
  const total = data.length;
  return DIRECTIONS.map(([key, label]) => {
    const rows = data.filter((r) => r.direction_key === key);
    return {
      key, label, rows: rows.length, state: rows.length ? "ready" : "not_connected",
      fill_rate: rows.length ? pct(rows.length, total) : null,
      missing_fields: rows.length ? [] : SOURCE_FIELDS.map(([name, fieldLabel]) => ({ table: "shipping_plans", name, label: fieldLabel })),
      note: rows.length ? "依据 shipping_plans 真实方向/运输方式字段命中" : `未接入: 缺可识别 ${label} 的方向字段值；当前填充率 ${sourceRates}`,
    };
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!READ_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "GET required");

  try {
    const pool = getPool();
    if (!(await tableExists(pool, "shipping_plans"))) {
      const fields = coverage([], SOURCE_FIELDS, new Set()).concat(rawCoverage([], new Set()));
      return res.status(200).json({ success: true, version: VERSION, generated_at: new Date().toISOString(), data: [], selected: null,
        directions: directionStats([], "未接入"), coverage: { total_rows: 0, fields, missing_tables: ["shipping_plans"] } });
    }
    const colSet = await columns(pool, "shipping_plans");
    const rows = await listRows(pool, colSet, req.query || {});
    let data = rows.map((r) => rowOut(r, colSet));
    const wanted = clean(req.query?.direction, 60);
    if (wanted) data = data.filter((r) => r.direction_key === wanted);
    const fields = coverage(rows, SOURCE_FIELDS, colSet).concat(rawCoverage(rows, colSet));
    const sourceRates = fields.map((f) => `${f.table}.${f.name} ${f.fill_rate == null ? "未接入" : f.fill_rate + "%"}`).join("；");
    return res.status(200).json({
      success: true, version: VERSION, generated_at: new Date().toISOString(), data, selected: data[0] || null,
      directions: directionStats(rows.map((r) => rowOut(r, colSet)), sourceRates),
      coverage: { total_rows: rows.length, fields, missing_tables: [] },
    });
  } catch (err) {
    console.error("[transport-directions]", err);
    return fail(res, 500, err.message);
  }
}
