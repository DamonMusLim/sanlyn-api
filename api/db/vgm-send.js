// /api/db/vgm-send — VGM declaration-channel read lens. Read-only, no external send.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);
const PLAN_FIELDS = [
  ["shipment_no", "订舱号"], ["bl_no", "提单号"], ["so_no", "SO号"],
  ["carrier_code", "船公司"], ["vessel", "船名"], ["voyage", "航次"],
  ["pol", "装港"], ["pod", "卸港"], ["etd", "ETD"], ["vgm_cutoff", "截VGM"],
  ["container_type", "箱型"], ["container_qty", "柜量"],
];
const CONTAINER_FIELDS = [
  ["container_no", "柜号"], ["seal_no", "封号"], ["container_type", "箱型"],
  ["tare_weight_kg", "皮重kg"], ["cargo_weight_kg", "货重kg"],
  ["vgm_weight_kg", "VGM kg"], ["vgm_kg", "VGM kg"], ["weight_ticket_url", "磅单"],
];
const SEND_FIELDS = [
  ["vgm_send_status", "VGM发送状态"],
  ["vgm_sent_at", "VGM发送时间"],
  ["vgm_receipt_no", "VGM回执号"],
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

function searchCond(planCols, paramIndex) {
  const cols = ["shipment_no", "bl_no", "so_no"].filter((name) => planCols.has(name));
  if (!cols.length) return "";
  return "(" + cols.map((name) => `s.${name} ILIKE $${paramIndex}`).join(" OR ") + ")";
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

function planOut(row, planCols) {
  const missing = missingFor(row, PLAN_FIELDS, planCols);
  return {
    id: row.id, shipment_no: row.shipment_no, bl_no: row.bl_no, so_no: row.so_no,
    carrier_code: row.carrier_code, vessel: row.vessel, voyage: row.voyage,
    pol: row.pol, pod: row.pod, etd: row.etd, vgm_cutoff: row.vgm_cutoff,
    container_type: row.container_type, container_qty: row.container_qty,
    container_rows: Number(row.container_rows || 0), vgm_ready_rows: Number(row.vgm_ready_rows || 0),
    missing_count: missing.length, missing,
  };
}

function containerOut(row, cbCols) {
  return {
    id: row.id, container_no: row.container_no, seal_no: row.seal_no,
    container_type: row.container_type, tare_weight_kg: row.tare_weight_kg,
    cargo_weight_kg: row.cargo_weight_kg,
    vgm_weight_kg: row.vgm_weight_kg ?? row.vgm_kg,
    weight_ticket_url: row.weight_ticket_url,
    missing: missingFor(row, CONTAINER_FIELDS, cbCols),
  };
}

async function listPlans(pool, planCols, hasCb, cbCols, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 80, 200);
  const params = [];
  const conds = planCols.has("deleted_at") ? ["s.deleted_at IS NULL"] : [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    params.push(`%${search}%`);
    const cond = searchCond(planCols, params.length);
    if (cond) conds.push(cond);
  }
  const idExpr = planCols.has("id") ? "s.id" : (planCols.has("_id") ? "s._id" : "NULL::text");
  const vgmExpr = cbCols.has("vgm_weight_kg") ? "vgm_weight_kg" : (cbCols.has("vgm_kg") ? "vgm_kg" : "");
  const cbAgg = hasCb
    ? `, (SELECT COUNT(*)::int FROM container_bookings cb WHERE cb.bl_no = s.bl_no) AS container_rows
       , (SELECT COUNT(*)::int FROM container_bookings cb WHERE cb.bl_no = s.bl_no
            AND NULLIF(BTRIM(cb.container_no), '') IS NOT NULL
            AND ${vgmExpr ? `cb.${vgmExpr} IS NOT NULL` : "false"}) AS vgm_ready_rows`
    : ", 0::int AS container_rows, 0::int AS vgm_ready_rows";
  params.push(limit);
  const sql = `
    SELECT ${idExpr} AS id, ${PLAN_FIELDS.map(([name]) => expr("s", planCols, name)).join(", ")}${cbAgg}
    FROM shipping_plans s
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY s.etd DESC NULLS LAST, s.created_at DESC NULLS LAST LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function listContainers(pool, cbCols, blNo) {
  if (!blNo) return [];
  const cols = CONTAINER_FIELDS.map(([name]) => expr("cb", cbCols, name)).join(", ");
  const r = await pool.query(
    `SELECT cb.id, ${cols} FROM container_bookings cb WHERE cb.bl_no = $1 ORDER BY cb.id ASC`,
    [blNo]
  );
  return r.rows;
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
      return res.status(200).json({ success: true, generated_at: new Date().toISOString(), data: [], selected: null, containers: [], coverage: { total_rows: 0, fields: [] }, send_channel: notConnected([], []) });
    }
    const planCols = await columns(pool, "shipping_plans");
    const hasCb = await tableExists(pool, "container_bookings");
    const cbCols = hasCb ? await columns(pool, "container_bookings") : new Set();
    const rows = await listPlans(pool, planCols, hasCb, cbCols, req.query || {});
    const wantId = clean(req.query?.id, 80);
    const selectedRow = rows.find((r) => String(r.id) === wantId) || rows[0];
    const selected = selectedRow ? planOut(selectedRow, planCols) : null;
    const containers = hasCb && selected ? await listContainers(pool, cbCols, selected.bl_no) : [];
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      data: rows.map((r) => planOut(r, planCols)),
      selected,
      containers: containers.map((r) => containerOut(r, cbCols)),
      coverage: {
        total_rows: rows.length,
        fields: coverage(rows, PLAN_FIELDS, planCols),
        container_fields: coverage(containers, CONTAINER_FIELDS, cbCols),
        send_fields: coverage(rows, SEND_FIELDS, planCols),
      },
      send_channel: notConnected(SEND_FIELDS, coverage(rows, SEND_FIELDS, planCols)),
    });
  } catch (err) {
    console.error("[vgm-send]", err);
    return fail(res, 500, err.message);
  }
}

function notConnected(fields, rates) {
  return {
    state: "not_connected",
    missing_fields: fields.map(([name, label]) => ({ name, label })),
    fill_rates: rates,
    note: "缺VGM发送通道接口、船公司/平台凭证、发送状态字段和回执字段；本页不对外发送。",
  };
}
