// 订舱平台 · read-only lens over shipping_plans.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance", "operator", "ceo", "superadmin"]);
const CORE_FIELDS = [
  ["shipment_no", "CY号"], ["booking_no", "订舱号"], ["forwarder_booking_no", "货代订舱号"],
  ["so_no", "SO号"], ["carrier_code", "船公司"], ["forwarder_cn", "货代"],
  ["pol", "起运港"], ["pod", "目的港"], ["vessel", "船名"], ["voyage", "航次"],
  ["etd", "ETD"], ["eta", "ETA"], ["container_qty", "柜量"], ["container_type", "柜型"],
  ["cutoff_time", "截关时间"], ["cy_cutoff", "截港时间"], ["si_cutoff", "SI截止"],
  ["flow_status", "流程状态"], ["status", "系统状态"], ["customer", "客户"],
];
const CHANNEL_FIELDS = [
  ["booking_channel_status", "订舱通道状态"],
  ["booking_channel_sent_at", "发送时间"],
  ["booking_channel_receipt_no", "订舱回执号"],
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

function stateOf(row, colSet) {
  if (!colSet.has("booking_no") && !colSet.has("forwarder_booking_no") && !colSet.has("so_no")) return "not_connected";
  if (!hasValue(row.booking_no) && !hasValue(row.forwarder_booking_no) && !hasValue(row.so_no)) return "missing_booking";
  if (!hasValue(row.vessel) || !hasValue(row.voyage) || !hasValue(row.etd)) return "missing_schedule";
  if (!hasValue(row.forwarder_cn)) return "missing_forwarder";
  return "ready";
}

function colExpr(name, colSet) {
  return colSet.has(name) ? `s.${name}` : `NULL::text AS ${name}`;
}

function searchConds(colSet, params, q) {
  const search = clean(q.q || q.search, 100);
  if (!search) return [];
  params.push(`%${search}%`);
  const n = params.length;
  const cols = ["shipment_no", "booking_no", "forwarder_booking_no", "so_no", "bl_no", "customer", "forwarder_cn"]
    .filter((name) => colSet.has(name))
    .map((name) => `s.${name}::text ILIKE $${n}`);
  return cols.length ? [`(${cols.join(" OR ")})`] : [];
}

function bookingRefSql(colSet) {
  const refs = ["booking_no", "forwarder_booking_no", "so_no"]
    .filter((name) => colSet.has(name))
    .map((name) => `NULLIF(BTRIM(s.${name}::text), '')`);
  return refs.length ? `COALESCE(${refs.join(", ")})` : null;
}

function stateConds(colSet, params, q) {
  const state = clean(q.state, 40);
  if (!state) return [];
  const refSql = bookingRefSql(colSet);
  if (state === "ready" && refSql) return [`${refSql} IS NOT NULL`];
  if (state === "missing_booking" && refSql) return [`${refSql} IS NULL`];
  params.push(state);
  return ["$" + params.length + " = 'not_connected'"];
}

async function listRows(pool, colSet, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 100, 200);
  const params = [];
  const conds = [];
  if (colSet.has("deleted_at")) conds.push("s.deleted_at IS NULL");
  conds.push(...searchConds(colSet, params, q));
  conds.push(...stateConds(colSet, params, q));
  params.push(limit);
  const fields = CORE_FIELDS.concat(CHANNEL_FIELDS).map(([name]) => colExpr(name, colSet)).join(", ");
  const id = colSet.has("id") ? "s.id" : "NULL::int AS id";
  const sid = colSet.has("_id") ? "s._id" : "NULL::text AS _id";
  const order = colSet.has("etd") ? "s.etd DESC NULLS LAST" : (colSet.has("updated_at") ? "s.updated_at DESC NULLS LAST" : "1");
  const r = await pool.query(
    `SELECT ${id}, ${sid}, ${fields}
       FROM shipping_plans s
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      ORDER BY ${order}
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

function rowOut(row, colSet) {
  const missing = missingFor(row, CORE_FIELDS, colSet);
  return {
    id: row.id,
    plan_id: row._id,
    shipment_no: row.shipment_no,
    booking_no: row.booking_no,
    forwarder_booking_no: row.forwarder_booking_no,
    so_no: row.so_no,
    carrier_code: row.carrier_code,
    forwarder_cn: row.forwarder_cn,
    pol: row.pol,
    pod: row.pod,
    vessel: row.vessel,
    voyage: row.voyage,
    etd: row.etd,
    eta: row.eta,
    container_qty: row.container_qty,
    container_type: row.container_type,
    cutoff_time: row.cutoff_time,
    cy_cutoff: row.cy_cutoff,
    si_cutoff: row.si_cutoff,
    customer: row.customer,
    status: row.flow_status || row.status,
    state: stateOf(row, colSet),
    missing_count: missing.length,
    missing,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!canRead(req.user)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "GET required");

  try {
    const pool = getPool();
    if (!(await tableExists(pool, "shipping_plans"))) {
      return res.status(200).json({
        success: true,
        generated_at: new Date().toISOString(),
        data: [],
        selected: null,
        coverage: { total_rows: 0, fields: coverage([], CORE_FIELDS, new Set()), channel_fields: coverage([], CHANNEL_FIELDS, new Set()) },
        booking_channel: { state: "not_connected", missing_fields: CHANNEL_FIELDS.map(([name, label]) => ({ name, label })), note: "缺 shipping_plans 真源表；当前填充率 未接入。" },
      });
    }
    const colSet = await columns(pool, "shipping_plans");
    const rows = await listRows(pool, colSet, req.query || {});
    const data = rows.map((r) => rowOut(r, colSet));
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      data,
      selected: data[0] || null,
      coverage: {
        total_rows: rows.length,
        fields: coverage(rows, CORE_FIELDS, colSet),
        channel_fields: coverage(rows, CHANNEL_FIELDS, colSet),
      },
      booking_channel: {
        state: "not_connected",
        missing_fields: CHANNEL_FIELDS.map(([name, label]) => ({ name, label })),
        note: "缺订舱外部发送通道、通道状态字段和回执字段；本页只读，不向货代或船公司发送订舱。",
      },
    });
  } catch (err) {
    console.error("[booking-platform]", err);
    return fail(res, 500, err.message);
  }
}
