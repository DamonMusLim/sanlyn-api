// /api/db/em-aci-send — Canada eManifest/ACI declaration-channel read lens. Read-only.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);
const PLAN_FIELDS = [
  ["shipment_no", "订舱号"], ["bl_no", "提单号"], ["so_no", "SO号"],
  ["carrier_code", "承运人"], ["vessel", "船名"], ["voyage", "航次"],
  ["pol", "装港"], ["pod", "加拿大卸港"], ["etd", "ETD"], ["eta", "ETA"],
  ["place_of_receipt", "收货地"], ["final_destination", "最终目的地"],
  ["container_type", "箱型"], ["container_qty", "柜量"],
];
const PARTY_FIELDS = [
  ["shipper_name", "发货人"], ["shipper_address", "发货人地址"],
  ["consignee_name", "收货人"], ["consignee_address", "收货人地址"],
  ["notify_name", "通知人"], ["notify_address", "通知人地址"],
];
const LINE_FIELDS = [
  ["declaration_name", "申报品名"], ["hs_code", "HS编码"],
  ["ctns", "箱数"], ["gw_kg", "毛重"], ["amount", "逐项申报货值"],
];
const SEND_FIELDS = [
  ["em_aci_send_status", "EM&ACI发送状态"], ["em_aci_sent_at", "EM&ACI发送时间"],
  ["em_aci_receipt_no", "EM&ACI回执号"], ["em_aci_ccn", "Cargo Control Number"],
  ["em_aci_filer_code", "申报方代码"],
];
const CA_HINTS = [
  "%CA%", "%CAN%", "%CANADA%", "%VANCOUVER%", "%MONTREAL%", "%TORONTO%",
  "%HALIFAX%", "%PRINCE RUPERT%", "%SAINT JOHN%", "%QUEBEC%",
];

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
function missingFor(row, fields, colSet) {
  return fields
    .filter(([name]) => !colSet.has(name) || !hasValue(row[name]))
    .map(([name, label]) => ({ name, label, reason: colSet.has(name) ? "empty" : "not_connected" }));
}
function searchCond(cols, idx) {
  const names = ["shipment_no", "bl_no", "so_no", "vessel", "voyage", "pod", "final_destination"].filter((n) => cols.has(n));
  if (!names.length) return "";
  return "(" + names.map((n) => `s.${n} ILIKE $${idx}`).join(" OR ") + ")";
}
function caCond(cols, params) {
  const names = ["pod", "final_destination"].filter((n) => cols.has(n));
  if (!names.length) return "";
  params.push(CA_HINTS);
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
function rowOut(row, planCols, customsCols) {
  const missing = missingFor(row, PLAN_FIELDS, planCols).concat(missingFor(row, PARTY_FIELDS, customsCols));
  return {
    id: row.id, customs_id: row.customs_id, shipment_no: row.shipment_no, bl_no: row.bl_no, so_no: row.so_no,
    carrier_code: row.carrier_code, vessel: row.vessel, voyage: row.voyage, pol: row.pol, pod: row.pod,
    etd: row.etd, eta: row.eta, place_of_receipt: row.place_of_receipt, final_destination: row.final_destination,
    container_type: row.container_type, container_qty: row.container_qty, shipper_name: row.shipper_name,
    consignee_name: row.consignee_name, notify_name: row.notify_name,
    line_count: row.line_count == null ? null : Number(row.line_count), missing_count: missing.length, missing,
  };
}
async function listPlans(pool, planCols, hasCustoms, customsCols, hasLines, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 80, 200);
  const params = [], conds = planCols.has("deleted_at") ? ["s.deleted_at IS NULL"] : [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    params.push(`%${search}%`);
    const cond = searchCond(planCols, params.length);
    if (cond) conds.push(cond);
  } else {
    const cond = caCond(planCols, params);
    if (cond) conds.push(cond);
  }
  const idExpr = planCols.has("id") ? "s.id" : (planCols.has("_id") ? "s._id" : "NULL::text");
  const joins = [];
  if (hasCustoms && planCols.has("bl_no") && customsCols.has("bl_no")) joins.push("cs.bl_no = s.bl_no");
  if (hasCustoms && planCols.has("shipment_no") && customsCols.has("shipment_no")) joins.push("cs.shipment_no = s.shipment_no");
  const canJoin = joins.length > 0;
  const joinCustoms = canJoin ? "LEFT JOIN customs_shipments cs ON (" + joins.join(" OR ") + ")" : "";
  const customsId = canJoin && customsCols.has("id") ? "cs.id AS customs_id" : "NULL::int AS customs_id";
  const lineAgg = hasLines && canJoin ? ", (SELECT COUNT(*)::int FROM customs_shipment_lines ln WHERE ln.shipment_id = cs.id) AS line_count" : ", NULL::int AS line_count";
  const partyCols = PARTY_FIELDS.map(([name]) => expr("cs", canJoin ? customsCols : new Set(), name)).join(", ");
  params.push(limit);
  const sql = `
    SELECT ${idExpr} AS id, ${customsId}, ${PLAN_FIELDS.map(([name]) => expr("s", planCols, name)).join(", ")},
      ${partyCols}${lineAgg}
    FROM shipping_plans s
    ${joinCustoms}
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY ${orderSql(planCols)} LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows;
}
async function lineSummary(pool, hasLines, lineCols, customsId) {
  if (!hasLines || !customsId) return { state: "not_connected", total_rows: 0, fields: coverage([], LINE_FIELDS, lineCols) };
  const parts = LINE_FIELDS.map(([name]) => lineCols.has(name)
    ? `COUNT(*) FILTER (WHERE NULLIF(BTRIM(${name}::text), '') IS NOT NULL)::int AS ${name}`
    : `0::int AS ${name}`);
  const r = await pool.query(`SELECT COUNT(*)::int AS total_rows, ${parts.join(", ")} FROM customs_shipment_lines WHERE shipment_id = $1`, [customsId]);
  const row = r.rows[0] || { total_rows: 0 }, total = Number(row.total_rows || 0);
  return {
    state: total ? "ready" : "not_connected",
    total_rows: total,
    fields: LINE_FIELDS.map(([name, label]) => lineCols.has(name)
      ? { name, label, state: "ready", filled: Number(row[name] || 0), total, fill_rate: pct(Number(row[name] || 0), total) }
      : { name, label, state: "not_connected", filled: 0, total, fill_rate: null }),
  };
}
function notConnected(rates) {
  return {
    state: "not_connected",
    missing_fields: SEND_FIELDS.map(([name, label]) => ({ name, label })),
    fill_rates: rates,
    note: "缺加拿大eManifest/ACI或第三方申报通道接口、通道凭证、Cargo Control Number、申报方代码、发送状态字段和回执字段；本页不对外发送。",
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
    if (!(await tableExists(pool, "shipping_plans"))) {
      return res.status(200).json({ success: true, generated_at: new Date().toISOString(), data: [], selected: null, line_summary: null, coverage: { total_rows: 0, fields: [], party_fields: [], send_fields: [] }, send_channel: notConnected([]) });
    }
    const planCols = await columns(pool, "shipping_plans");
    const hasCustoms = await tableExists(pool, "customs_shipments");
    const customsCols = hasCustoms ? await columns(pool, "customs_shipments") : new Set();
    const hasLines = await tableExists(pool, "customs_shipment_lines");
    const lineCols = hasLines ? await columns(pool, "customs_shipment_lines") : new Set();
    const rows = await listPlans(pool, planCols, hasCustoms, customsCols, hasLines, req.query || {});
    const wantId = clean(req.query?.id, 80);
    const selectedRow = rows.find((r) => String(r.id) === wantId) || rows[0];
    const sendCoverage = coverage(rows, SEND_FIELDS, planCols);
    const selectedLineSummary = await lineSummary(pool, hasLines, lineCols, selectedRow?.customs_id);
    return res.status(200).json({
      success: true, generated_at: new Date().toISOString(),
      data: rows.map((r) => rowOut(r, planCols, customsCols)),
      selected: selectedRow ? rowOut(selectedRow, planCols, customsCols) : null,
      line_summary: selectedLineSummary,
      coverage: {
        total_rows: rows.length,
        fields: coverage(rows, PLAN_FIELDS, planCols),
        party_fields: coverage(rows, PARTY_FIELDS, customsCols),
        line_fields: selectedLineSummary.fields,
        send_fields: sendCoverage,
      },
      send_channel: notConnected(sendCoverage),
    });
  } catch (err) {
    console.error("[em-aci-send]", err);
    return fail(res, 500, err.message);
  }
}
