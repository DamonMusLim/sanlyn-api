// /api/db/manifest-send — Shanghai manifest declaration-channel read lens.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { normalizeCargoType } from "./lib/cargo-type-enum.js";
import { businessCoverage, businessLens, businessMissing, notConnectedBusinessCoverage } from "./manifest-business-lens.js";

const VERSION = "v2026.09.15-1";
const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance", "operator", "ceo", "superadmin"]);
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
const OLI_LINE_FIELDS = {
  ctns: ["qty_ctn"],
  gw_kg: ["gw_kg", "gross_weight_kg", "gross_weight", "gw_ctn"],
  amount: ["declaration_amount", "declare_amount", "customs_amount"],
};
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

async function shipmentTotal(pool) {
  const r = await pool.query("SELECT COUNT(*)::int AS total FROM customs_shipments");
  return Number(r.rows[0]?.total || 0);
}

function expr(alias, colSet, name, asName = name) {
  return colSet.has(name) ? `${alias}.${name}::text AS ${asName}` : `NULL::text AS ${asName}`;
}

function firstCol(colSet, names) {
  return names.find((name) => colSet.has(name)) || "";
}

function coverage(rows, fields, colSet) {
  const total = rows.length;
  return fields.map(([name, label]) => {
    const source = `customs_shipments.${name}`;
    if (!colSet.has(name)) {
      return { name, label, source, state: "not_connected", filled: 0, total, fill_rate: null };
    }
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, label, source, state: "ready", filled, total, fill_rate: pct(filled, total) };
  });
}

function lineCoverageRows(total, row, lineCols) {
  return LINE_FIELDS.slice(0, 2).map(([name, label]) => {
    const source = `customs_shipment_lines.${name}`;
    if (!lineCols.has(name)) {
      return { name, label, source, state: "not_connected", filled: 0, total, fill_rate: null };
    }
    const filled = Number(row?.[name] || 0);
    return { name, label, source, state: "ready", filled, total, fill_rate: pct(filled, total) };
  });
}

function oliNotConnected(ctx, orderId) {
  return LINE_FIELDS.slice(2).map(([name, label]) => {
    const cols = OLI_LINE_FIELDS[name] || [];
    const linkGap = ctx.hasOrderLineItems && !ctx.oliCols.has("order_id")
      ? "；缺 order_line_items.order_id"
      : "；缺 customs_shipments.order_id 或 orders.id 可关联记录";
    const source = ctx.hasOrderLineItems
      ? `order_line_items.${cols.join("|")}${orderId ? "" : linkGap}`
      : `order_line_items 表未接入；缺 order_line_items.${cols.join("|")}`;
    return { name, label, source, state: "not_connected", filled: 0, total: 0, fill_rate: null };
  });
}

async function orderLineCoverage(pool, ctx, orderId) {
  if (!ctx.hasOrderLineItems || !orderId || !ctx.oliCols.has("order_id")) return oliNotConnected(ctx, orderId);
  const ctnCol = firstCol(ctx.oliCols, OLI_LINE_FIELDS.ctns);
  const gwDirectCol = firstCol(ctx.oliCols, OLI_LINE_FIELDS.gw_kg.filter((name) => name !== "gw_ctn"));
  const gwCtnCol = firstCol(ctx.oliCols, ["gw_ctn"]);
  const amountCol = firstCol(ctx.oliCols, OLI_LINE_FIELDS.amount);
  const gwExpr = gwDirectCol
    ? `COUNT(*) FILTER (WHERE NULLIF(BTRIM(${gwDirectCol}::text), '') IS NOT NULL)::int`
    : (gwCtnCol && ctnCol ? `COUNT(*) FILTER (WHERE ${gwCtnCol} IS NOT NULL AND ${ctnCol} IS NOT NULL)::int` : "NULL::int");
  const gwSource = gwDirectCol
    ? `order_line_items.${gwDirectCol}`
    : (gwCtnCol && ctnCol ? `order_line_items.${gwCtnCol}*${ctnCol}` : `order_line_items.${OLI_LINE_FIELDS.gw_kg.join("|")}`);
  const specs = [
    ["ctns", ctnCol ? `order_line_items.${ctnCol}` : `order_line_items.${OLI_LINE_FIELDS.ctns.join("|")}`,
      ctnCol ? `COUNT(*) FILTER (WHERE NULLIF(BTRIM(${ctnCol}::text), '') IS NOT NULL)::int` : "NULL::int"],
    ["gw_kg", gwSource, gwExpr],
    ["amount", amountCol ? `order_line_items.${amountCol}` : `order_line_items.${OLI_LINE_FIELDS.amount.join("|")}`,
      amountCol ? `COUNT(*) FILTER (WHERE NULLIF(BTRIM(${amountCol}::text), '') IS NOT NULL)::int` : "NULL::int"],
  ];
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total_rows, ${specs.map(([name, , sql]) => `${sql} AS ${name}`).join(", ")}
       FROM order_line_items WHERE order_id::text = $1`,
    [String(orderId)]
  );
  const row = r.rows[0] || { total_rows: 0 };
  const total = Number(row.total_rows || 0);
  return LINE_FIELDS.slice(2).map(([name, label]) => {
    const spec = specs.find(([key]) => key === name);
    if (!spec || row[name] === null) return { name, label, source: spec?.[1] || name, state: "not_connected", filled: 0, total, fill_rate: null };
    const filled = Number(row[name] || 0);
    return { name, label, source: spec[1], state: "ready", filled, total, fill_rate: pct(filled, total) };
  });
}

function cargoEnumCoverage(rows, colSet) {
  if (!colSet.has("cargo_type")) {
    return { name: "cargo_type_enum", label: "货物属性内部枚举", source: "customs_shipments.cargo_type", state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
  }
  const filled = rows.filter((r) => normalizeCargoType(r.cargo_type).state === "ready").length;
  return { name: "cargo_type_enum", label: "货物属性内部枚举", source: "customs_shipments.cargo_type", state: "ready", filled, total: rows.length, fill_rate: pct(filled, rows.length) };
}

function searchCond(cols, idx) {
  const names = ["shipment_no", "bl_no", "company_code", "carrier", "vessel", "voyage", "pol", "pod"].filter((n) => cols.has(n));
  if (!names.length) return "";
  return "(" + names.map((n) => `s.${n}::text ILIKE $${idx}`).join(" OR ") + ")";
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
    .map(([name, label]) => ({ name, label, source: `customs_shipments.${name}`, reason: colSet.has(name) ? "empty" : "not_connected" }));
}

function detailFields(row, fields, colSet) {
  return fields.map(([name, label]) => ({
    name,
    label,
    source: `customs_shipments.${name}`,
    state: colSet.has(name) ? "ready" : "not_connected",
    value: colSet.has(name) ? row[name] : null,
  }));
}

function rowOut(row, colSet, businessFields) {
  const missing = missingFor(row, HEADER_FIELDS, colSet);
  const cargoType = normalizeCargoType(colSet.has("cargo_type") ? row.cargo_type : null);
  if (cargoType.state === "unmapped") {
    missing.push({ name: "cargo_type_enum", label: "货物属性内部枚举", source: "customs_shipments.cargo_type", reason: "unmapped" });
  }
  const bizMissing = businessMissing(row, businessFields);
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
    header_fields: detailFields(row, HEADER_FIELDS, colSet),
    order_id: row.linked_order_id || row.shipment_order_id,
    order_no: row.order_no,
    contract_no: row.order_contract_no || row.contract_no,
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
    line_count: row.line_count == null ? null : Number(row.line_count),
    container_count: row.container_count == null ? null : Number(row.container_count),
    missing_count: missing.length,
    missing,
  };
}

function companyNameExpr(ctx) {
  if (!ctx.shipmentCols.has("company_code")) return "NULL::text";
  if (!ctx.hasCompanies || !ctx.companyCols.has("code")) return "s.company_code";
  const parts = ["name_cn", "name_en", "name"].filter((name) => ctx.companyCols.has(name)).map((name) => `c.${name}`);
  parts.push("s.company_code");
  return `COALESCE(${parts.join(", ")})`;
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
  if (q.id && colSet.has("id")) {
    params.push(clean(q.id, 80));
    conds.push(`s.id::text = $${params.length}`);
  }
  const idExpr = colSet.has("id") ? "s.id" : "NULL::text";
  const containerAgg = ctx.hasContainers && colSet.has("id") && ctx.containerCols.has("shipment_id")
    ? ", (SELECT COUNT(*)::int FROM customs_shipment_containers ct WHERE ct.shipment_id = s.id) AS container_count"
    : ", NULL::int AS container_count";
  const lineAgg = ctx.hasLines && colSet.has("id") && ctx.lineCols.has("shipment_id")
    ? ", (SELECT COUNT(*)::int FROM customs_shipment_lines ln WHERE ln.shipment_id = s.id) AS line_count"
    : ", NULL::int AS line_count";
  const lens = businessLens(ctx);
  params.push(limit);
  const sql = `
    SELECT ${idExpr} AS id, ${colSet.has("order_id") ? "s.order_id::text" : "NULL::text"} AS shipment_order_id,
      ${HEADER_FIELDS.map(([name]) => expr("s", colSet, name)).join(", ")},
      ${expr("s", colSet, "contract_no")}, ${expr("s", colSet, "etd")}, ${expr("s", colSet, "status")},
      ${companyNameExpr(ctx)} AS company_name,
      ${lens.select}
      ${containerAgg}${lineAgg}
    FROM customs_shipments s
    ${ctx.hasCompanies && colSet.has("company_code") && ctx.companyCols.has("code") ? "LEFT JOIN companies c ON c.code = s.company_code" : ""}
    ${lens.joins.order}
    ${lens.joins.plan}
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY ${orderSql(colSet)} LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function coverageShipments(pool, ctx) {
  const colSet = ctx.shipmentCols;
  const lens = businessLens(ctx);
  const sql = `
    SELECT ${colSet.has("id") ? "s.id" : "NULL::text"} AS id,
      ${colSet.has("order_id") ? "s.order_id::text" : "NULL::text"} AS shipment_order_id,
      ${HEADER_FIELDS.map(([name]) => expr("s", colSet, name)).join(", ")},
      ${expr("s", colSet, "contract_no")}, ${expr("s", colSet, "etd")}, ${expr("s", colSet, "status")},
      ${companyNameExpr(ctx)} AS company_name,
      ${lens.select}
    FROM customs_shipments s
    ${ctx.hasCompanies && colSet.has("company_code") && ctx.companyCols.has("code") ? "LEFT JOIN companies c ON c.code = s.company_code" : ""}
    ${lens.joins.order}
    ${lens.joins.plan}`;
  const r = await pool.query(sql);
  return r.rows;
}

async function lineSummary(pool, ctx, row) {
  const id = row?.id;
  const orderId = row?.linked_order_id || row?.shipment_order_id;
  if (!ctx.hasLines || !id || !ctx.lineCols.has("shipment_id")) {
    const fields = lineCoverageRows(0, null, ctx.lineCols).concat(await orderLineCoverage(pool, ctx, orderId));
    return { state: "not_connected", total_rows: 0, fields };
  }
  const parts = LINE_FIELDS.slice(0, 2).map(([name]) => ctx.lineCols.has(name)
    ? `COUNT(*) FILTER (WHERE NULLIF(BTRIM(${name}::text), '') IS NOT NULL)::int AS ${name}`
    : `0::int AS ${name}`);
  const r = await pool.query(
    `SELECT COUNT(*)::int AS total_rows, ${parts.join(", ")}
     FROM customs_shipment_lines WHERE shipment_id = $1`,
    [id]
  );
  const agg = r.rows[0] || { total_rows: 0 };
  const total = Number(agg.total_rows || 0);
  return {
    state: total ? "ready" : "not_connected",
    total_rows: total,
    fields: lineCoverageRows(total, agg, ctx.lineCols).concat(await orderLineCoverage(pool, ctx, orderId)),
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
      return res.status(200).json({
        success: true,
        version: VERSION,
        generated_at: new Date().toISOString(),
        data: [],
        selected: null,
        line_summary: { state: "not_connected", total_rows: 0, fields: [] },
        coverage: { total_rows: 0, total_rows_all: 0, fields: [], business_fields: notConnectedBusinessCoverage(0), line_fields: [], send_fields: coverage([], SEND_FIELDS, new Set()) },
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
    const hasCompanies = await tableExists(pool, "companies");
    const orderCols = hasOrders ? await columns(pool, "orders") : new Set();
    const planCols = hasPlans ? await columns(pool, "shipping_plans") : new Set();
    const companyCols = hasCompanies ? await columns(pool, "companies") : new Set();
    const hasOrderLineItems = await tableExists(pool, "order_line_items");
    const lineCols = hasLines ? await columns(pool, "customs_shipment_lines") : new Set();
    const containerCols = hasContainers ? await columns(pool, "customs_shipment_containers") : new Set();
    const oliCols = hasOrderLineItems ? await columns(pool, "order_line_items") : new Set();
    const ctx = { shipmentCols, hasContainers, hasLines, hasOrders, hasPlans, hasCompanies, hasOrderLineItems, orderCols, planCols, companyCols, lineCols, containerCols, oliCols };
    const totalRowsAll = await shipmentTotal(pool);
    const rows = await listShipments(pool, ctx, req.query || {});
    const covRows = await coverageShipments(pool, ctx);
    const fields = coverage(covRows, HEADER_FIELDS, shipmentCols).concat(cargoEnumCoverage(covRows, shipmentCols));
    const businessFields = businessCoverage(covRows, businessLens(ctx).availability);
    const sendCoverage = coverage(covRows, SEND_FIELDS, shipmentCols);
    const wantId = clean(req.query?.id, 80);
    const selectedRow = rows.find((r) => String(r.id) === wantId) || rows[0] || null;
    const selected = selectedRow ? rowOut(selectedRow, shipmentCols, businessFields) : null;
    const lines = selected ? await lineSummary(pool, ctx, selectedRow) : { state: "not_connected", total_rows: 0, fields: lineCoverageRows(0, null, lineCols).concat(oliNotConnected(ctx, null)) };
    return res.status(200).json({
      success: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      data: rows.map((r) => rowOut(r, shipmentCols, businessFields)),
      selected,
      line_summary: lines,
      coverage: { total_rows: rows.length, total_rows_all: totalRowsAll, fields, business_fields: businessFields, line_fields: lines.fields, send_fields: sendCoverage },
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
