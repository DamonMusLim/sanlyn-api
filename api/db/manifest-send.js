// /api/db/manifest-send — Shanghai manifest declaration-channel read lens.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { normalizeCargoType } from "./lib/cargo-type-enum.js";

const VERSION = "v2026.09.05-1";
const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);
const HEADER_FIELDS = [
  ["shipment_no", "舱单编号"], ["company_code", "委托单位"], ["carrier", "船公司"],
  ["vessel", "船名"], ["voyage", "航次"], ["bl_no", "提单号"], ["pol", "装港"],
  ["pod", "卸港"], ["cargo_type", "货物类型"], ["transport_terms", "运输条款"],
  ["payment_method", "付款方式"], ["bl_type", "提单类型"], ["bl_copies", "提单份数"],
  ["place_of_issue", "签发地"], ["payment_place", "付款地"], ["shipping_agent", "订舱代理"],
  ["shipper_name", "发货人"], ["shipper_address", "发货人地址"],
  ["shipper_country_code", "发货人国家"], ["shipper_phone", "发货人电话"],
  ["shipper_enterprise_code", "发货人企业代码"], ["shipper_aeo_code", "发货人AEO"],
  ["consignee_name", "收货人"], ["consignee_address", "收货人地址"],
  ["consignee_country_code", "收货人国家"], ["consignee_phone", "收货人电话"],
  ["consignee_enterprise_code", "收货人企业代码"], ["consignee_aeo_code", "收货人AEO"],
  ["consignee_actual_contact", "实际收货联系人"], ["consignee_actual_contact_phone", "实际收货电话"],
  ["notify_name", "通知人"], ["notify_address", "通知人地址"],
  ["notify_country_code", "通知人国家"], ["notify_phone", "通知人电话"],
  ["notify_enterprise_code", "通知人企业代码"], ["notify_aeo_code", "通知人AEO"],
  ["place_of_receipt", "收货地"], ["final_destination", "最终目的地"],
];
const LINE_FIELDS = [
  ["declaration_name", "申报品名"], ["hs_code", "HS编码"], ["ctns", "箱数"],
  ["gw_kg", "毛重"], ["amount", "逐项货值"],
];
const BUSINESS_FIELDS = [
  ["order_status", "订单进程", "orders", "status"],
  ["plan_status", "海运进程", "shipping_plans", "status"],
  ["order_type", "订单类型", "orders", "type"],
  ["business_type", "业务类型", "orders", "mode"],
  ["business_exception", "业务异常", "shipping_plans", "dq_status"],
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

async function tableExists(pool, table) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1 LIMIT 1`,
    [table]
  );
  return r.rowCount > 0;
}

function expr(alias, colSet, name, asName = name) {
  return colSet.has(name) ? `${alias}.${name} AS ${asName}` : `NULL::text AS ${asName}`;
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

function derivedCoverage(rows, fields, availability) {
  const total = rows.length;
  return fields.map(([name, label, table, column]) => {
    const ok = availability[`${table}.${column}`] === true;
    if (!ok) return { name, label, source: `${table}.${column}`, state: "not_connected", filled: 0, total, fill_rate: null };
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, label, source: `${table}.${column}`, state: "ready", filled, total, fill_rate: pct(filled, total) };
  });
}

function lineCoverageRows(total, row, lineCols) {
  return LINE_FIELDS.map(([name, label]) => {
    const source = `customs_shipment_lines.${name}`;
    if (!lineCols.has(name)) {
      return { name, label, source, state: "not_connected", filled: 0, total, fill_rate: null };
    }
    const filled = Number(row?.[name] || 0);
    return { name, label, source, state: "ready", filled, total, fill_rate: pct(filled, total) };
  });
}

function cargoEnumCoverage(rows, colSet) {
  if (!colSet.has("cargo_type")) {
    return { name: "cargo_type_enum", label: "货物属性内部枚举", state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
  }
  const filled = rows.filter((r) => normalizeCargoType(r.cargo_type).state === "ready").length;
  return { name: "cargo_type_enum", label: "货物属性内部枚举", state: "ready", filled, total: rows.length, fill_rate: pct(filled, rows.length) };
}

function searchCond(cols, idx) {
  const names = ["shipment_no", "bl_no", "company_code", "carrier", "vessel", "voyage", "pol", "pod"].filter((n) => cols.has(n));
  if (!names.length) return "";
  return "(" + names.map((n) => `s.${n} ILIKE $${idx}`).join(" OR ") + ")";
}

function orderSql(cols) {
  const parts = [];
  if (cols.has("etd")) parts.push("s.etd DESC NULLS LAST");
  if (cols.has("created_at")) parts.push("s.created_at DESC NULLS LAST");
  if (cols.has("id")) parts.push("s.id DESC");
  return parts.length ? parts.join(", ") : "1";
}

function missingFor(row, fields, colSet) {
  return fields
    .filter(([name]) => !colSet.has(name) || !hasValue(row[name]))
    .map(([name, label]) => ({ name, label, reason: colSet.has(name) ? "empty" : "not_connected" }));
}

function businessMissing(row, availability) {
  return BUSINESS_FIELDS
    .filter(([name, label, table, column]) => availability[`${table}.${column}`] !== true || !hasValue(row[name]))
    .map(([name, label, table, column]) => ({
      name,
      label,
      source: `${table}.${column}`,
      reason: availability[`${table}.${column}`] === true ? "empty" : "not_connected",
    }));
}

function rowOut(row, colSet, availability) {
  const missing = missingFor(row, HEADER_FIELDS, colSet);
  const cargoType = normalizeCargoType(colSet.has("cargo_type") ? row.cargo_type : null);
  if (cargoType.state === "unmapped") {
    missing.push({ name: "cargo_type_enum", label: "货物属性内部枚举", reason: "unmapped" });
  }
  const bizMissing = businessMissing(row, availability);
  return {
    id: row.id,
    shipment_no: row.shipment_no,
    company_code: row.company_code,
    company_name: row.company_name,
    bl_no: row.bl_no,
    vessel: row.vessel,
    voyage: row.voyage,
    carrier: colSet.has("carrier") ? row.carrier : null,
    pol: row.pol,
    pod: row.pod,
    etd: row.etd,
    status: row.status,
    shipping_agent: row.shipping_agent,
    place_of_issue: row.place_of_issue,
    payment_place: row.payment_place,
    shipper_name: row.shipper_name,
    consignee_name: row.consignee_name,
    notify_name: row.notify_name,
    order_no: row.order_no,
    contract_no: row.contract_no,
    order_status: row.order_status,
    plan_status: row.plan_status,
    order_type: row.order_type,
    business_type: row.business_type,
    business_exception: row.business_exception,
    business_missing_count: bizMissing.length,
    business_missing: bizMissing,
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

function orderJoin(ctx) {
  const c = ctx.shipmentCols, o = ctx.orderCols, conds = [];
  if (!ctx.hasOrders) return "";
  if (c.has("order_id") && o.has("id")) conds.push("o.id = s.order_id");
  if (c.has("contract_no") && o.has("contract_no")) conds.push("NULLIF(o.contract_no,'') = NULLIF(s.contract_no,'')");
  if (c.has("bl_no") && o.has("bl_no")) conds.push("NULLIF(o.bl_no,'') = NULLIF(s.bl_no,'')");
  if (c.has("shipping_plan_id") && o.has("shipping_plan_id")) conds.push("o.shipping_plan_id::text = s.shipping_plan_id::text");
  if (!conds.length) return "";
  return `LEFT JOIN LATERAL (
    SELECT ${expr("o", o, "order_no")}, ${expr("o", o, "contract_no")},
      ${expr("o", o, "status", "order_status")}, ${expr("o", o, "type", "order_type")},
      ${expr("o", o, "mode", "business_type")}
    FROM orders o WHERE ${conds.join(" OR ")} ORDER BY ${o.has("id") ? "o.id DESC" : "1"} LIMIT 1
  ) o ON true`;
}

function planJoin(ctx) {
  const c = ctx.shipmentCols, p = ctx.planCols, conds = [];
  if (!ctx.hasPlans) return "";
  if (c.has("shipping_plan_id") && p.has("id")) conds.push("sp.id::text = s.shipping_plan_id::text");
  if (c.has("shipping_plan_id") && p.has("_id")) conds.push("sp._id::text = s.shipping_plan_id::text");
  if (c.has("bl_no") && p.has("bl_no")) conds.push("NULLIF(sp.bl_no,'') = NULLIF(s.bl_no,'')");
  if (!conds.length) return "";
  return `LEFT JOIN LATERAL (
    SELECT ${expr("sp", p, "status", "plan_status")}, ${expr("sp", p, "dq_status", "business_exception")}
    FROM shipping_plans sp WHERE ${conds.join(" OR ")} ORDER BY ${p.has("id") ? "sp.id DESC" : "1"} LIMIT 1
  ) sp ON true`;
}

async function listShipments(pool, ctx, q) {
  const colSet = ctx.shipmentCols;
  const limit = Math.min(parseInt(q.limit, 10) || 80, 200);
  const params = [];
  const conds = [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    params.push(`%${search}%`);
    const cond = searchCond(colSet, params.length);
    if (cond) conds.push(cond);
  }
  const idExpr = colSet.has("id") ? "s.id" : "NULL::text";
  const containerAgg = ctx.hasContainers && colSet.has("id")
    ? ", (SELECT COUNT(*)::int FROM customs_shipment_containers ct WHERE ct.shipment_id = s.id) AS container_count"
    : ", NULL::int AS container_count";
  const lineAgg = ctx.hasLines && colSet.has("id")
    ? ", (SELECT COUNT(*)::int FROM customs_shipment_lines ln WHERE ln.shipment_id = s.id) AS line_count"
    : ", NULL::int AS line_count";
  const orderLens = orderJoin(ctx);
  const planLens = planJoin(ctx);
  params.push(limit);
  const sql = `
    SELECT ${idExpr} AS id, ${HEADER_FIELDS.map(([name]) => expr("s", colSet, name)).join(", ")},
      ${expr("s", colSet, "contract_no")}, ${expr("s", colSet, "etd")}, ${expr("s", colSet, "status")},
      ${colSet.has("company_code") ? "COALESCE(c.name_cn, c.name_en, s.company_code)" : "NULL::text"} AS company_name,
      ${orderLens ? "o.order_no, o.contract_no AS order_contract_no, o.order_status, o.order_type, o.business_type" : "NULL::text AS order_no, NULL::text AS order_contract_no, NULL::text AS order_status, NULL::text AS order_type, NULL::text AS business_type"},
      ${planLens ? "sp.plan_status, sp.business_exception" : "NULL::text AS plan_status, NULL::text AS business_exception"}
      ${containerAgg}${lineAgg}
    FROM customs_shipments s
    ${colSet.has("company_code") ? "LEFT JOIN companies c ON c.code = s.company_code" : ""}
    ${orderLens}
    ${planLens}
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY ${orderSql(colSet)} LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function lineSummary(pool, hasLines, lineCols, id) {
  if (!hasLines || !id) return { state: "not_connected", total_rows: 0, fields: lineCoverageRows(0, null, lineCols) };
  const parts = LINE_FIELDS.map(([name]) => lineCols.has(name)
    ? `COUNT(*) FILTER (WHERE NULLIF(BTRIM(${name}::text), '') IS NOT NULL)::int AS ${name}`
    : `0::int AS ${name}`);
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total_rows, ${parts.join(", ")}
     FROM customs_shipment_lines WHERE shipment_id = $1`,
    [id]
  );
  const row = r.rows[0] || { total_rows: 0 };
  const total = Number(row.total_rows || 0);
  return {
    state: total ? "ready" : "not_connected",
    total_rows: total,
    fields: lineCoverageRows(total, row, lineCols),
  };
}

function businessAvailability(ctx) {
  return {
    "orders.status": ctx.hasOrders && ctx.hasOrderJoin && ctx.orderCols.has("status"),
    "orders.type": ctx.hasOrders && ctx.hasOrderJoin && ctx.orderCols.has("type"),
    "orders.mode": ctx.hasOrders && ctx.hasOrderJoin && ctx.orderCols.has("mode"),
    "shipping_plans.status": ctx.hasPlans && ctx.hasPlanJoin && ctx.planCols.has("status"),
    "shipping_plans.dq_status": ctx.hasPlans && ctx.hasPlanJoin && ctx.planCols.has("dq_status"),
  };
}

function hasOrderJoin(ctx) {
  return Boolean(orderJoin(ctx));
}

function hasPlanJoin(ctx) {
  return Boolean(planJoin(ctx));
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
      return res.status(200).json({
        success: true,
        version: VERSION,
        generated_at: new Date().toISOString(),
        data: [],
        selected: null,
        line_summary: { state: "not_connected", total_rows: 0, fields: [] },
        coverage: { total_rows: 0, fields: [], business_fields: [], line_fields: [], send_fields: [] },
        send_channel: {
          state: "not_connected",
          missing_fields: SEND_FIELDS.map(([name, label]) => ({ name, label })),
          note: "缺 customs_shipments 舱单抬头表；本页不对外发送。",
        },
      });
    }
    const shipmentCols = await columns(pool, "customs_shipments");
    const hasContainers = await tableExists(pool, "customs_shipment_containers");
    const hasLines = await tableExists(pool, "customs_shipment_lines");
    const hasOrders = await tableExists(pool, "orders");
    const hasPlans = await tableExists(pool, "shipping_plans");
    const orderCols = hasOrders ? await columns(pool, "orders") : new Set();
    const planCols = hasPlans ? await columns(pool, "shipping_plans") : new Set();
    const lineCols = hasLines ? await columns(pool, "customs_shipment_lines") : new Set();
    const ctx = { shipmentCols, hasContainers, hasLines, hasOrders, hasPlans, orderCols, planCols };
    ctx.hasOrderJoin = hasOrderJoin(ctx);
    ctx.hasPlanJoin = hasPlanJoin(ctx);
    const availability = businessAvailability(ctx);
    const rows = await listShipments(pool, ctx, req.query || {});
    const fields = coverage(rows, HEADER_FIELDS, shipmentCols).concat(cargoEnumCoverage(rows, shipmentCols));
    const businessFields = derivedCoverage(rows, BUSINESS_FIELDS, availability);
    const sendCoverage = coverage(rows, SEND_FIELDS, shipmentCols);
    const wantId = clean(req.query?.id, 80);
    const selectedRow = rows.find((r) => String(r.id) === wantId) || rows[0] || null;
    const selected = selectedRow ? rowOut(selectedRow, shipmentCols, availability) : null;
    const lines = selected ? await lineSummary(pool, hasLines, lineCols, selected.id) : { state: "not_connected", total_rows: 0, fields: lineCoverageRows(0, null, lineCols) };
    return res.status(200).json({
      success: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      data: rows.map((r) => rowOut(r, shipmentCols, availability)),
      selected,
      line_summary: lines,
      coverage: { total_rows: rows.length, fields, business_fields: businessFields, line_fields: lines.fields, send_fields: sendCoverage },
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
