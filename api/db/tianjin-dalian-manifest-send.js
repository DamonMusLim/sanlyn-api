// /api/db/tianjin-dalian-manifest-send — Tianjin/Dalian manifest readiness lens. Read-only.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { normalizeCargoType } from "./lib/cargo-type-enum.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);
const HEADER_FIELDS = [
  ["shipment_no", "舱单编号"], ["company_code", "委托单位"], ["carrier", "船公司"],
  ["vessel", "船名"], ["voyage", "航次"], ["bl_no", "提单号"], ["pol", "装港"],
  ["pod", "卸港"], ["cargo_type", "货物类型"], ["transport_terms", "运输条款"],
  ["payment_method", "付款方式"], ["bl_type", "提单类型"], ["place_of_issue", "签发地"],
  ["shipping_agent", "订舱代理"], ["shipper_name", "发货人"], ["shipper_address", "发货人地址"],
  ["consignee_name", "收货人"], ["consignee_address", "收货人地址"],
  ["notify_name", "通知人"], ["notify_address", "通知人地址"],
  ["place_of_receipt", "收货地"], ["final_destination", "最终目的地"],
];
const PORT_FIELDS = [["pol", "装港"], ["place_of_issue", "签发地"], ["shipping_agent", "订舱代理"]];
const LINE_FIELDS = [
  ["declaration_name", "申报品名"], ["hs_code", "HS编码"], ["ctns", "箱数"],
  ["gw_kg", "毛重"], ["amount", "逐项货值"],
];
const SEND_FIELDS = [
  ["tjdl_manifest_status", "天津/大连舱单发送状态"],
  ["tjdl_manifest_sent_at", "天津/大连舱单发送时间"],
  ["tjdl_manifest_receipt_no", "天津/大连舱单回执号"],
];
const PORT_HINTS = ["%TIANJIN%", "%XINGANG%", "%TSN%", "%TXG%", "%CNTSN%", "%CNTXG%", "%天津%", "%新港%", "%DALIAN%", "%DLC%", "%CNDLC%", "%大连%"];

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}
function canRead(user) {
  return READ_ROLES.has(user?.role);
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
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1 LIMIT 1`,
    [table]
  );
  return r.rowCount > 0;
}
async function columns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}
function expr(alias, colSet, name) {
  return colSet.has(name) ? `${alias}.${name}` : `NULL::text AS ${name}`;
}
function coverage(rows, fields, colSet) {
  const total = rows.length;
  return fields.map(([name, label]) => {
    if (!colSet.has(name)) return { name, label, state: "not_connected", filled: 0, total, fill_rate: null };
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, label, state: "ready", filled, total, fill_rate: pct(filled, total) };
  });
}
function cargoEnumCoverage(rows, colSet) {
  if (!colSet.has("cargo_type")) return { name: "cargo_type_enum", label: "货物属性内部枚举", state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
  const filled = rows.filter((r) => normalizeCargoType(r.cargo_type).state === "ready").length;
  return { name: "cargo_type_enum", label: "货物属性内部枚举", state: "ready", filled, total: rows.length, fill_rate: pct(filled, rows.length) };
}
function missingFor(row, fields, colSet) {
  return fields.filter(([name]) => !colSet.has(name) || !hasValue(row[name]))
    .map(([name, label]) => ({ name, label, reason: colSet.has(name) ? "empty" : "not_connected" }));
}
function searchCond(cols, idx) {
  const names = ["shipment_no", "bl_no", "company_code", "carrier", "vessel", "voyage", "pol", "pod"].filter((n) => cols.has(n));
  if (!names.length) return "";
  return "(" + names.map((n) => `s.${n} ILIKE $${idx}`).join(" OR ") + ")";
}
function portCond(cols, params) {
  const names = PORT_FIELDS.map(([name]) => name).filter((n) => cols.has(n));
  if (!names.length) return "";
  params.push(PORT_HINTS);
  const idx = params.length;
  return "(" + names.map((n) => `upper(COALESCE(s.${n}::text,'')) LIKE ANY($${idx}::text[])`).join(" OR ") + ")";
}
function orderSql(cols) {
  const parts = [];
  if (cols.has("etd")) parts.push("s.etd DESC NULLS LAST");
  if (cols.has("created_at")) parts.push("s.created_at DESC NULLS LAST");
  if (cols.has("id")) parts.push("s.id DESC");
  return parts.length ? parts.join(", ") : "1";
}
function rowOut(row, headerCols) {
  const missing = missingFor(row, HEADER_FIELDS, headerCols);
  const cargoType = normalizeCargoType(headerCols.has("cargo_type") ? row.cargo_type : null);
  if (cargoType.state === "unmapped") missing.push({ name: "cargo_type_enum", label: "货物属性内部枚举", reason: "unmapped" });
  return {
    id: row.id, shipment_no: row.shipment_no, company_code: row.company_code, company_name: row.company_name,
    bl_no: row.bl_no, carrier: row.carrier, vessel: row.vessel, voyage: row.voyage, pol: row.pol, pod: row.pod,
    etd: row.etd, status: row.status, shipping_agent: row.shipping_agent, place_of_issue: row.place_of_issue,
    shipper_name: row.shipper_name, consignee_name: row.consignee_name, notify_name: row.notify_name,
    cargo_type_enum: cargoType.code, cargo_type_label: cargoType.label,
    cargo_type_raw: cargoType.raw, cargo_type_state: headerCols.has("cargo_type") ? cargoType.state : "not_connected",
    line_count: row.line_count == null ? null : Number(row.line_count),
    container_count: row.container_count == null ? null : Number(row.container_count),
    missing_count: missing.length, missing,
  };
}
async function listShipments(pool, cols, hasContainers, hasLines, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 80, 200);
  const params = [], conds = [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    params.push(`%${search}%`);
    const cond = searchCond(cols, params.length);
    if (cond) conds.push(cond);
  } else {
    const cond = portCond(cols, params);
    if (cond) conds.push(cond);
  }
  if (q.id && cols.has("id")) {
    params.push(parseInt(q.id, 10));
    conds.push(`s.id = $${params.length}`);
  }
  const idExpr = cols.has("id") ? "s.id" : "NULL::text";
  const containerAgg = hasContainers && cols.has("id") ? ", (SELECT COUNT(*)::int FROM customs_shipment_containers ct WHERE ct.shipment_id = s.id) AS container_count" : ", NULL::int AS container_count";
  const lineAgg = hasLines && cols.has("id") ? ", (SELECT COUNT(*)::int FROM customs_shipment_lines ln WHERE ln.shipment_id = s.id) AS line_count" : ", NULL::int AS line_count";
  params.push(limit);
  const sql = `
    SELECT ${idExpr} AS id, ${HEADER_FIELDS.map(([name]) => expr("s", cols, name)).join(", ")},
      ${expr("s", cols, "etd")}, ${expr("s", cols, "status")},
      ${cols.has("company_code") ? "COALESCE(c.name_cn, c.name_en, s.company_code)" : "NULL::text"} AS company_name
      ${containerAgg}${lineAgg}
    FROM customs_shipments s
    ${cols.has("company_code") ? "LEFT JOIN companies c ON c.code = s.company_code" : ""}
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY ${orderSql(cols)} LIMIT $${params.length}`;
  return (await pool.query(sql, params)).rows;
}
async function lineSummary(pool, hasLines, lineCols, shipmentId) {
  if (!hasLines || !shipmentId) return { state: "not_connected", total_rows: 0, fields: coverage([], LINE_FIELDS, lineCols) };
  const parts = LINE_FIELDS.map(([name]) => lineCols.has(name)
    ? `COUNT(*) FILTER (WHERE NULLIF(BTRIM(${name}::text), '') IS NOT NULL)::int AS ${name}`
    : `0::int AS ${name}`);
  const r = await pool.query(`SELECT COUNT(*)::int AS total_rows, ${parts.join(", ")} FROM customs_shipment_lines WHERE shipment_id = $1`, [shipmentId]);
  const row = r.rows[0] || { total_rows: 0 }, total = Number(row.total_rows || 0);
  return { state: total ? "ready" : "not_connected", total_rows: total, fields: LINE_FIELDS.map(([name, label]) => lineCols.has(name)
    ? { name, label, state: "ready", filled: Number(row[name] || 0), total, fill_rate: pct(Number(row[name] || 0), total) }
    : { name, label, state: "not_connected", filled: 0, total, fill_rate: null }) };
}
function notConnected(rates) {
  return {
    state: "not_connected",
    missing_fields: SEND_FIELDS.map(([name, label]) => ({ name, label })),
    fill_rates: rates,
    note: "缺天津/大连口岸舱单申报通道、通道凭证、发送状态字段和回执字段；本页不对外发送。",
  };
}
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!canRead(req.user)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");
  try {
    const pool = getPool();
    if (!(await tableExists(pool, "customs_shipments"))) {
      return res.status(200).json({ success: true, generated_at: new Date().toISOString(), data: [], selected: null, line_summary: null, coverage: { total_rows: 0, fields: [], port_fields: [], line_fields: [], send_fields: [] }, send_channel: notConnected([]) });
    }
    const headerCols = await columns(pool, "customs_shipments");
    const hasContainers = await tableExists(pool, "customs_shipment_containers");
    const hasLines = await tableExists(pool, "customs_shipment_lines");
    const lineCols = hasLines ? await columns(pool, "customs_shipment_lines") : new Set();
    const rows = await listShipments(pool, headerCols, hasContainers, hasLines, req.query || {});
    const wantId = clean(req.query?.id, 80);
    const selectedRow = rows.find((r) => String(r.id) === wantId) || rows[0];
    const sendCoverage = coverage(rows, SEND_FIELDS, headerCols);
    const selected = selectedRow ? rowOut(selectedRow, headerCols) : null;
    const lines = await lineSummary(pool, hasLines, lineCols, selectedRow?.id);
    return res.status(200).json({
      success: true, generated_at: new Date().toISOString(),
      data: rows.map((r) => rowOut(r, headerCols)), selected, line_summary: lines,
      coverage: {
        total_rows: rows.length,
        fields: coverage(rows, HEADER_FIELDS, headerCols).concat(cargoEnumCoverage(rows, headerCols)),
        port_fields: coverage(rows, PORT_FIELDS, headerCols),
        line_fields: lines.fields,
        send_fields: sendCoverage,
      },
      send_channel: notConnected(sendCoverage),
    });
  } catch (err) {
    console.error("[tianjin-dalian-manifest-send]", err);
    return fail(res, 500, err.message);
  }
}
