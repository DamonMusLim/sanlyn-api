// /api/db/shipment-tracking - full cargo tracking read lens over real fields only.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance", "operator", "ceo", "superadmin"]);
const PLAN_FIELDS = [
  ["shipment_no", "订舱号"], ["bl_no", "提单号"], ["contract_no", "合同号"],
  ["order_nos", "订单号"], ["pol", "起运港"], ["pod", "目的港"],
  ["vessel", "船名"], ["voyage", "航次"], ["container_no", "柜号"],
  ["container_qty", "柜量"], ["container_type", "柜型"], ["forwarder_cn", "货代"],
  ["customer", "客户"], ["current_status_cn", "船踪状态"], ["tracking_updated_at", "船踪更新时间"],
];
const STAGES = [
  { key: "factory_ready", label: "货好", table: "shipping_plans", fields: [["cargo_ready_date", "货好日期"]] },
  { key: "cutoff", label: "截关/进港", table: "shipping_plans", fields: [["cutoff_date", "截关日期"]] },
  { key: "departure", label: "开船", table: "shipping_plans", fields: [["etd", "预计开船"], ["atd", "实际开船"]] },
  { key: "ocean_tracking", label: "海上运输", table: "shipping_plans", fields: [["current_status_cn", "船踪状态"], ["tracking_updated_at", "船踪更新时间"]] },
  { key: "arrival", label: "到港", table: "shipping_plans", fields: [["eta", "预计到港"], ["ata", "实际到港"]] },
  { key: "delivery", label: "交货完成", table: "shipping_plans", fields: [["delivered_at", "交货完成时间"]] },
];

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}

function hasValue(v) {
  if (Array.isArray(v)) return v.length > 0;
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

function expr(name, colSet) {
  return colSet.has(name) ? `s.${name}` : `NULL AS ${name}`;
}

function fieldCoverage(rows, fields, colSet) {
  const total = rows.length;
  return fields.map(([name, label]) => {
    if (!colSet.has(name)) return { name, label, state: "not_connected", filled: 0, total, fill_rate: null };
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, label, state: total && filled ? "ready" : "not_connected", filled, total, fill_rate: pct(filled, total) };
  });
}

function stageCoverage(rows, stage, colSet) {
  const fields = fieldCoverage(rows, stage.fields, colSet);
  const readyFields = fields.filter((f) => f.state === "ready");
  const filled = readyFields.reduce((sum, f) => sum + f.filled, 0);
  const total = readyFields.reduce((sum, f) => sum + f.total, 0);
  const missing = fields.filter((f) => f.state !== "ready" || !f.filled);
  return {
    key: stage.key,
    label: stage.label,
    table: stage.table,
    state: !rows.length || missing.length ? "not_connected" : "ready",
    fields,
    missing_fields: missing.map((f) => ({ table: stage.table, name: f.name, label: f.label })),
    fill_rate: pct(filled, total),
  };
}

function searchSql(colSet, params, q) {
  const conds = colSet.has("deleted_at") ? ["s.deleted_at IS NULL"] : ["TRUE"];
  if (q) {
    const cols = ["shipment_no", "bl_no", "contract_no", "container_no", "vessel"]
      .filter((name) => colSet.has(name));
    if (colSet.has("_id")) cols.push("_id::text");
    if (colSet.has("id")) cols.push("id::text");
    if (cols.length) {
      params.push(`%${q}%`);
      conds.push("(" + cols.map((name) => `s.${name} ILIKE $${params.length}`).join(" OR ") + ")");
    }
  }
  return conds.join(" AND ");
}

async function listRows(pool, colSet, query) {
  const q = clean(query.q || query.search || query.contract_no || query.shipment_id, 100);
  const limit = Math.min(parseInt(query.limit, 10) || (q ? 50 : 80), 200);
  const params = [];
  params.push(limit);
  const select = PLAN_FIELDS.concat(STAGES.flatMap((s) => s.fields)).map(([name]) => expr(name, colSet)).join(", ");
  const order = [
    colSet.has("tracking_updated_at") ? "s.tracking_updated_at DESC NULLS LAST" : "",
    colSet.has("etd") ? "s.etd DESC NULLS LAST" : "",
    colSet.has("updated_at") ? "s.updated_at DESC NULLS LAST" : "",
    "s.id DESC",
  ].filter(Boolean).join(", ");
  const where = searchSql(colSet, params, q);
  const r = await pool.query(
    `SELECT s.id, ${colSet.has("_id") ? "s._id" : "NULL AS _id"}, ${select}
       FROM shipping_plans s
      WHERE ${where}
      ORDER BY ${order}
      LIMIT $1`,
    params
  );
  return r.rows;
}

function stageValue(row, stage, colSet) {
  const fields = stage.fields.map(([name, label]) => ({
    table: stage.table,
    name,
    label,
    value: colSet.has(name) ? row[name] : null,
    state: colSet.has(name) && hasValue(row[name]) ? "ready" : "not_connected",
  }));
  const ready = fields.filter((f) => f.state === "ready");
  return {
    key: stage.key,
    label: stage.label,
    state: ready.length ? "ready" : "not_connected",
    fields,
    missing_fields: fields.filter((f) => f.state !== "ready").map((f) => ({ table: f.table, name: f.name, label: f.label })),
  };
}

function rowOut(row, colSet) {
  const missing = PLAN_FIELDS
    .filter(([name]) => !colSet.has(name) || !hasValue(row[name]))
    .map(([name, label]) => ({ table: "shipping_plans", name, label }));
  return {
    id: row.id,
    plan_id: row._id,
    shipment_no: row.shipment_no,
    bl_no: row.bl_no,
    contract_no: row.contract_no,
    order_nos: row.order_nos,
    pol: row.pol,
    pod: row.pod,
    vessel: row.vessel,
    voyage: row.voyage,
    container_no: row.container_no,
    container_qty: row.container_qty,
    container_type: row.container_type,
    forwarder_cn: row.forwarder_cn,
    customer: row.customer,
    current_status_cn: row.current_status_cn,
    tracking_updated_at: row.tracking_updated_at,
    missing_count: missing.length,
    missing,
    stages: STAGES.map((s) => stageValue(row, s, colSet)),
  };
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
      return res.status(200).json({
        success: true,
        generated_at: new Date().toISOString(),
        version: "v2026.08.26-1",
        state: "not_connected",
        data: [],
        selected: null,
        coverage: { total_rows: 0, fields: [], stages: [], missing_tables: ["shipping_plans"] },
      });
    }
    const colSet = await columns(pool, "shipping_plans");
    const rows = await listRows(pool, colSet, req.query || {});
    const data = rows.map((r) => rowOut(r, colSet));
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      version: "v2026.08.26-1",
      state: rows.length ? "ready" : "not_connected",
      data,
      selected: data[0] || null,
      coverage: {
        total_rows: rows.length,
        fields: fieldCoverage(rows, PLAN_FIELDS, colSet),
        stages: STAGES.map((s) => stageCoverage(rows, s, colSet)),
        missing_tables: [],
      },
    });
  } catch (err) {
    console.error("[shipment-tracking]", err);
    return fail(res, 500, err.message);
  }
}
