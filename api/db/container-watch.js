// /api/db/container-watch - read-only container watch lens over real shipping fields.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance", "operator", "ceo", "superadmin"]);
const VERSION = "v2026.08.26-1";
const FIELDS = [
  ["shipment_no", "订舱号"], ["bl_no", "提单号"], ["container_no", "柜号"],
  ["container_qty", "柜量"], ["container_type", "柜型"], ["seal_no", "封号"],
  ["pol", "起运港"], ["pod", "目的港"], ["vessel", "船名"], ["voyage", "航次"],
  ["etd", "ETD"], ["eta", "ETA"], ["ata", "ATA"], ["delivered_at", "交货完成时间"],
  ["current_status_cn", "当前状态"], ["tracking_updated_at", "船踪更新时间"], ["forwarder_cn", "货代"],
  ["customer", "客户"], ["contract_no", "合同号"], ["order_nos", "订单号"],
];

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}

function has(v) {
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

function coverage(rows, colSet) {
  return FIELDS.map(([name, label]) => {
    if (!colSet.has(name)) return { name, label, table: "shipping_plans", state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
    const filled = rows.filter((r) => has(r[name])).length;
    return { name, label, table: "shipping_plans", state: filled ? "ready" : "not_connected", filled, total: rows.length, fill_rate: pct(filled, rows.length) };
  });
}

function searchWhere(colSet, params, q) {
  const conds = colSet.has("deleted_at") ? ["s.deleted_at IS NULL"] : ["TRUE"];
  if (!q) return conds.join(" AND ");
  const cols = ["shipment_no", "bl_no", "container_no", "contract_no", "vessel", "forwarder_cn", "customer"]
    .filter((name) => colSet.has(name));
  if (colSet.has("id")) cols.push("id::text");
  if (colSet.has("_id")) cols.push("_id::text");
  if (!cols.length) return conds.join(" AND ");
  params.push(`%${q}%`);
  conds.push("(" + cols.map((name) => `s.${name} ILIKE $${params.length}`).join(" OR ") + ")");
  return conds.join(" AND ");
}

async function listRows(pool, colSet, query) {
  const q = clean(query.q || query.search || query.container_no || query.bl_no, 100);
  const limit = Math.min(parseInt(query.limit, 10) || (q ? 80 : 120), 200);
  const params = [limit];
  const select = FIELDS.map(([name]) => expr(name, colSet)).join(", ");
  const order = [
    colSet.has("tracking_updated_at") ? "s.tracking_updated_at DESC NULLS LAST" : "",
    colSet.has("eta") ? "s.eta ASC NULLS LAST" : "",
    colSet.has("etd") ? "s.etd DESC NULLS LAST" : "",
    "s.id DESC",
  ].filter(Boolean).join(", ");
  const r = await pool.query(
    `SELECT s.id, ${colSet.has("_id") ? "s._id" : "NULL AS _id"}, ${select}
       FROM shipping_plans s
      WHERE ${searchWhere(colSet, params, q)}
      ORDER BY ${order}
      LIMIT $1`,
    params
  );
  return r.rows;
}

function dateOnly(v) {
  if (!has(v)) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function alertFor(row, colSet) {
  const alerts = [];
  const now = Date.now();
  const trackingAt = colSet.has("tracking_updated_at") ? dateOnly(row.tracking_updated_at) : null;
  const eta = colSet.has("eta") ? dateOnly(row.eta) : null;
  const ata = colSet.has("ata") ? dateOnly(row.ata) : null;
  const delivered = colSet.has("delivered_at") && has(row.delivered_at);
  const status = clean(row.current_status_cn, 80);
  const hasArrivalSignal = colSet.has("ata") || colSet.has("delivered_at") || (colSet.has("current_status_cn") && has(status));
  if (trackingAt && now - trackingAt.getTime() > 72 * 3600 * 1000) {
    alerts.push({ kind: "stale_tracking", label: "船踪超过72小时未更新", basis: "shipping_plans.tracking_updated_at" });
  }
  if (eta && hasArrivalSignal && eta.getTime() < now - 24 * 3600 * 1000 && !ata && !delivered && !/到港|签收|完成|delivered/i.test(status)) {
    alerts.push({ kind: "eta_overdue", label: "ETA已过未到港", basis: "shipping_plans.eta + ata/delivered_at/current_status_cn" });
  }
  return alerts;
}

function rowOut(row, colSet) {
  const missing = FIELDS
    .filter(([name]) => !colSet.has(name) || !has(row[name]))
    .map(([name, label]) => ({ table: "shipping_plans", name, label }));
  return {
    id: row.id,
    plan_id: row._id,
    alerts: alertFor(row, colSet),
    missing_count: missing.length,
    missing,
    shipment_no: row.shipment_no,
    bl_no: row.bl_no,
    container_no: row.container_no,
    container_qty: row.container_qty,
    container_type: row.container_type,
    seal_no: row.seal_no,
    pol: row.pol,
    pod: row.pod,
    vessel: row.vessel,
    voyage: row.voyage,
    etd: row.etd,
    eta: row.eta,
    ata: row.ata,
    delivered_at: row.delivered_at,
    current_status_cn: row.current_status_cn,
    tracking_updated_at: row.tracking_updated_at,
    forwarder_cn: row.forwarder_cn,
    customer: row.customer,
    contract_no: row.contract_no,
    order_nos: row.order_nos,
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
      return res.status(200).json({ success: true, version: VERSION, generated_at: new Date().toISOString(), state: "not_connected", data: [], selected: null, coverage: { total_rows: 0, fields: [], missing_tables: ["shipping_plans"] } });
    }
    const colSet = await columns(pool, "shipping_plans");
    const rows = await listRows(pool, colSet, req.query || {});
    const data = rows.map((r) => rowOut(r, colSet));
    return res.status(200).json({
      success: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      state: rows.length ? "ready" : "not_connected",
      data,
      selected: data[0] || null,
      coverage: { total_rows: rows.length, fields: coverage(rows, colSet), missing_tables: [] },
    });
  } catch (err) {
    console.error("[container-watch]", err);
    return fail(res, 500, err.message);
  }
}
