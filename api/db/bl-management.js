// 提单管理 · read-only lens over shipping_plans.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance", "operator", "ceo", "superadmin"]);
const CORE_FIELDS = [
  ["shipment_no", "CY号"], ["bl_no", "提单号"], ["mbl_no", "MBL"], ["hbl_no", "HBL"],
  ["so_no", "SO号"], ["release_type", "放单方式"], ["first_issued_at", "首次出单"],
  ["telex_released_at", "电放时间"], ["vessel", "船名"], ["voyage", "航次"],
  ["etd", "ETD"], ["eta", "ETA"], ["container_no", "柜号"], ["container_qty", "柜量"],
  ["container_type", "柜型"], ["forwarder_cn", "货代"], ["customer", "客户"],
  ["issuing_company", "出单公司"], ["status", "状态"], ["flow_status", "流程状态"],
];
const DOC_FIELDS = [
  ["bl_draft_status", "提单草稿状态"], ["bl_confirmed_at", "提单确认时间"],
  ["bl_sent_at", "提单发送时间"], ["bl_receipt_no", "提单回执号"],
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

function canRead(user) {
  return READ_ROLES.has(user?.role);
}

async function columns(pool, table) {
  const r = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function sqlExpr(name, colSet) {
  if (name === "status" && !colSet.has("status")) return "NULL::text AS status";
  if (colSet.has(name)) return `s.${name}`;
  return `NULL::text AS ${name}`;
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
  const notShipped = !hasValue(row.bl_no) && !hasValue(row.vessel);
  if (notShipped) return "pending_booking";
  if (!colSet.has("bl_no") || !hasValue(row.bl_no)) return "missing_bl";
  if (!hasValue(row.mbl_no) && !hasValue(row.hbl_no)) return "missing_master_house";
  if (!hasValue(row.release_type)) return "missing_release";
  return "ready";
}

async function listRows(pool, colSet, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 100, 200);
  const search = clean(q.q || q.search, 100);
  const state = clean(q.state, 40);
  const vals = [];
  const conds = ["s.deleted_at IS NULL"];
  if (search) {
    vals.push(`%${search}%`);
    const n = vals.length;
    const searchCols = ["shipment_no", "bl_no", "mbl_no", "hbl_no", "so_no", "customer"]
      .filter((name) => colSet.has(name))
      .map((name) => `s.${name} ILIKE $${n}`);
    if (searchCols.length) conds.push(`(${searchCols.join(" OR ")})`);
  }
  if (state === "has_bl") conds.push("NULLIF(BTRIM(s.bl_no), '') IS NOT NULL");
  if (state === "missing_bl") conds.push("NULLIF(BTRIM(s.bl_no), '') IS NULL AND NULLIF(BTRIM(s.vessel), '') IS NOT NULL");
  vals.push(limit);
  const select = CORE_FIELDS.concat(DOC_FIELDS).map(([name]) => sqlExpr(name, colSet)).join(", ");
  const r = await pool.query(
    `SELECT s.id, s._id, ${select}, s.created_at, s.updated_at
       FROM shipping_plans s
      WHERE ${conds.join(" AND ")}
      ORDER BY s.etd DESC NULLS LAST, s.updated_at DESC NULLS LAST, s.id DESC
      LIMIT $${vals.length}`,
    vals
  );
  return r.rows;
}

function rowOut(row, colSet) {
  const missing = missingFor(row, CORE_FIELDS, colSet);
  return {
    id: row.id,
    plan_id: row._id,
    shipment_no: row.shipment_no,
    bl_no: row.bl_no,
    mbl_no: row.mbl_no,
    hbl_no: row.hbl_no,
    so_no: row.so_no,
    release_type: row.release_type,
    first_issued_at: row.first_issued_at,
    telex_released_at: row.telex_released_at,
    vessel: row.vessel,
    voyage: row.voyage,
    etd: row.etd,
    eta: row.eta,
    container_no: row.container_no,
    container_qty: row.container_qty,
    container_type: row.container_type,
    forwarder_cn: row.forwarder_cn,
    customer: row.customer,
    issuing_company: row.issuing_company,
    status: row.status || row.flow_status,
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
        doc_fields: coverage(rows, DOC_FIELDS, colSet),
      },
      actions: {
        state: "not_connected",
        missing_fields: DOC_FIELDS.map(([name, label]) => ({ name, label })),
        note: "缺提单草稿/确认/发送工作流字段和外部放单通道；本页只读，不发消息、不放单。",
      },
    });
  } catch (err) {
    console.error("[bl-management]", err);
    return fail(res, 500, err.message);
  }
}
