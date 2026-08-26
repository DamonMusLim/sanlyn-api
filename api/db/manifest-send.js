// /api/db/manifest-send — Shanghai manifest declaration-channel read lens.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { normalizeCargoType } from "./lib/cargo-type-enum.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);
const BASE_FIELDS = [
  ["shipment_no", "舱单编号"], ["company_code", "委托单位"], ["carrier", "船公司"],
  ["vessel", "船名"], ["voyage", "航次"], ["bl_no", "提单号"], ["pol", "装港"],
  ["pod", "卸港"], ["cargo_type", "货物类型"], ["transport_terms", "运输条款"],
  ["payment_method", "付款方式"], ["bl_type", "提单类型"], ["place_of_issue", "签发地"],
  ["shipper_name", "发货人"], ["shipper_address", "发货人地址"],
  ["consignee_name", "收货人"], ["consignee_address", "收货人地址"],
  ["notify_name", "通知人"], ["notify_address", "通知人地址"],
  ["place_of_receipt", "收货地"], ["final_destination", "最终目的地"],
];
const SEND_FIELDS = [
  ["declaration_channel_status", "申报通道状态"],
  ["declaration_channel_sent_at", "发送时间"],
  ["declaration_channel_receipt_no", "申报回执号"],
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
    if (!colSet.has(name)) {
      return { name, label, state: "not_connected", filled: 0, total, fill_rate: null };
    }
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, label, state: "ready", filled, total, fill_rate: pct(filled, total) };
  });
}

function cargoEnumCoverage(rows, colSet) {
  if (!colSet.has("cargo_type")) {
    return { name: "cargo_type_enum", label: "货物属性内部枚举", state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
  }
  const filled = rows.filter((r) => normalizeCargoType(r.cargo_type).state === "ready").length;
  return { name: "cargo_type_enum", label: "货物属性内部枚举", state: "ready", filled, total: rows.length, fill_rate: pct(filled, rows.length) };
}

function missingFor(row, fields, colSet) {
  return fields
    .filter(([name]) => !colSet.has(name) || !hasValue(row[name]))
    .map(([name, label]) => ({ name, label, reason: colSet.has(name) ? "empty" : "not_connected" }));
}

function rowOut(row, fields, colSet) {
  const missing = missingFor(row, fields, colSet);
  const cargoType = normalizeCargoType(colSet.has("cargo_type") ? row.cargo_type : null);
  if (cargoType.state === "unmapped") {
    missing.push({ name: "cargo_type_enum", label: "货物属性内部枚举", reason: "unmapped" });
  }
  return {
    id: row.id,
    shipment_no: row.shipment_no,
    company_code: row.company_code,
    company_name: row.company_name,
    bl_no: row.bl_no,
    vessel: row.vessel,
    voyage: row.voyage,
    carrier: colSet.has("carrier") ? row.carrier : null,
    etd: row.etd,
    status: row.status,
    cargo_type_enum: cargoType.code,
    cargo_type_label: cargoType.label,
    cargo_type_raw: cargoType.raw,
    cargo_type_state: colSet.has("cargo_type") ? cargoType.state : "not_connected",
    line_count: Number(row.line_count || 0),
    container_count: Number(row.container_count || 0),
    missing_count: missing.length,
    missing,
  };
}

async function listShipments(pool, colSet, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 80, 200);
  const params = [];
  const conds = [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    params.push(`%${search}%`);
    conds.push(`(s.shipment_no ILIKE $${params.length} OR s.bl_no ILIKE $${params.length} OR s.company_code ILIKE $${params.length})`);
  }
  if (q.id) {
    params.push(parseInt(q.id, 10));
    conds.push(`s.id = $${params.length}`);
  }
  const selectCols = BASE_FIELDS.filter(([name]) => colSet.has(name)).map(([name]) => `s.${name}`).join(", ");
  params.push(limit);
  const sql = `
    SELECT s.id, s.etd, s.status, ${selectCols || "s.shipment_no"},
      COALESCE(c.name_cn, c.name_en, s.company_code) AS company_name,
      (SELECT COUNT(*)::int FROM customs_shipment_containers ct WHERE ct.shipment_id = s.id) AS container_count,
      (SELECT COUNT(*)::int FROM customs_shipment_lines ln WHERE ln.shipment_id = s.id) AS line_count
    FROM customs_shipments s
    LEFT JOIN companies c ON c.code = s.company_code
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY s.created_at DESC, s.id DESC LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function summary(pool, id) {
  const r = await pool.query(
    `SELECT
      COUNT(*)::int AS lines,
      COUNT(*) FILTER (WHERE NULLIF(BTRIM(declaration_name), '') IS NOT NULL)::int AS declaration_name,
      COUNT(*) FILTER (WHERE NULLIF(BTRIM(hs_code), '') IS NOT NULL)::int AS hs_code,
      COUNT(*) FILTER (WHERE ctns IS NOT NULL)::int AS ctns,
      COUNT(*) FILTER (WHERE gw_kg IS NOT NULL)::int AS gw_kg,
      COUNT(*) FILTER (WHERE amount IS NOT NULL)::int AS amount,
      SUM(ctns) AS total_ctns, SUM(gw_kg) AS total_gw_kg, SUM(amount) AS total_amount
     FROM customs_shipment_lines WHERE shipment_id = $1`,
    [id]
  );
  return r.rows[0] || {};
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!canRead(req.user)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");

  try {
    const pool = getPool();
    const colSet = await columns(pool, "customs_shipments");
    const rows = await listShipments(pool, colSet, req.query || {});
    const fields = coverage(rows, BASE_FIELDS, colSet).concat(cargoEnumCoverage(rows, colSet));
    const sendCoverage = coverage(rows, SEND_FIELDS, colSet);
    const selected = rows[0] ? rowOut(rows[0], BASE_FIELDS, colSet) : null;
    const lineSummary = selected ? await summary(pool, selected.id) : null;
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      data: rows.map((r) => rowOut(r, BASE_FIELDS, colSet)),
      selected,
      line_summary: lineSummary,
      coverage: { total_rows: rows.length, fields, send_fields: sendCoverage },
      send_channel: {
        state: "not_connected",
        missing_fields: SEND_FIELDS.map(([name, label]) => ({ name, label })),
        note: "缺申报通道发送接口、发送状态字段和回执字段；本页不对外发送。",
      },
    });
  } catch (err) {
    console.error("[manifest-send]", err);
    return fail(res, 500, err.message);
  }
}
