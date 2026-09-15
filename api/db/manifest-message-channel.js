// /api/db/manifest-message-channel - generate, validate, and persist pending manifest messages; never sends.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { businessCoverage, businessLens, businessMissing, notConnectedBusinessCoverage } from "./manifest-business-lens.js";
import {
  HEADER_FIELDS, LINE_FIELDS, OUTBOX, OUTBOX_FIELDS, VERSION, buildMessage, coverage,
  expr, hasValue, lineCoverage, loadDrafts, loadLines, loadOrderLineItems,
  missingCols, missingFieldCoverage, missingQtyCoverage, outboxSql, outboxState,
  qtyCoverage, qualify, qtyFieldSpecs, selectedLineCoverage, val, writeDraft,
} from "./manifest-message-build.js";

const ROLES = new Set(["admin", "superadmin", "logistics", "ops"]);

function fail(res, status, error, extra = {}) {
  return res.status(status).json({ success: false, error, ...extra });
}
function canUse(user) {
  return ROLES.has(user?.role);
}
function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
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
async function listShipments(pool, ctx, q) {
  const shipmentCols = ctx.shipmentCols, companyCols = ctx.companyCols;
  const limit = Math.min(parseInt(q.limit, 10) || 60, 120);
  const params = [], conds = [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    const searchCols = ["shipment_no", "bl_no", "company_code"].filter((n) => shipmentCols.has(n));
    if (searchCols.length) {
      params.push(`%${search}%`);
      conds.push("(" + searchCols.map((n) => `s.${n}::text ILIKE $${params.length}`).join(" OR ") + ")");
    }
  }
  const id = Number.parseInt(q.id, 10);
  if (Number.isInteger(id) && shipmentCols.has("id")) {
    params.push(id);
    conds.push(`s.id = $${params.length}`);
  }
  const dynamic = HEADER_FIELDS.map(([n]) => expr("s", shipmentCols, n)).join(", ");
  const companyCode = val("s", shipmentCols, "company_code");
  const companyJoin = ctx.hasCompanies && companyCols.has("code") && shipmentCols.has("company_code")
    ? "LEFT JOIN companies c ON c.code = s.company_code"
    : "";
  const companyParts = [];
  if (companyJoin && companyCols.has("name_cn")) companyParts.push("c.name_cn");
  if (companyJoin && companyCols.has("name_en")) companyParts.push("c.name_en");
  if (shipmentCols.has("company_code")) companyParts.push(companyCode);
  const companyName = companyParts.length ? `COALESCE(${companyParts.join(", ")})` : "NULL::text";
  const biz = businessLens(ctx);
  const createdOrder = shipmentCols.has("created_at") ? "s.created_at DESC NULLS LAST, " : "";
  params.push(limit);
  const r = await pool.query(`
    SELECT ${expr("s", shipmentCols, "id", "int")}, ${expr("s", shipmentCols, "etd")}, ${expr("s", shipmentCols, "status")},
      ${expr("s", shipmentCols, "company_code")}, ${expr("s", shipmentCols, "order_id")}, ${dynamic},
      ${companyName} AS company_name, ${biz.select}
    FROM customs_shipments s
    ${companyJoin}
    ${biz.joins.order}
    ${biz.joins.plan}
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY ${createdOrder}${shipmentCols.has("id") ? "s.id DESC" : "1"} LIMIT $${params.length}`,
    params
  );
  return r.rows;
}
async function shipmentTotal(pool) {
  const r = await pool.query("SELECT count(*)::int AS total FROM customs_shipments");
  return Number(r.rows[0]?.total || 0);
}
function notConnectedResponse() {
  return {
    success: true,
    version: VERSION,
    generated_at: new Date().toISOString(),
    send_disabled: true,
    data: [],
    drafts: [],
    state: "not_connected",
    missing: ["customs_shipments"],
    coverage: {
      total_rows: 0,
      total_rows_all: 0,
      header_fields: missingFieldCoverage(HEADER_FIELDS, "customs_shipments"),
      business_fields: notConnectedBusinessCoverage(),
      line_fields: missingFieldCoverage(LINE_FIELDS, "customs_shipment_lines").concat(missingQtyCoverage()),
      outbox_missing: [OUTBOX],
    },
    outbox: outboxState(false, [OUTBOX], [OUTBOX]),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!canUse(req.user)) return fail(res, 403, "Forbidden");
  try {
    const pool = getPool();
    const hasShipments = await tableExists(pool, "customs_shipments");
    const hasLines = await tableExists(pool, "customs_shipment_lines");
    const hasOutbox = await tableExists(pool, OUTBOX);
    const hasCompanies = await tableExists(pool, "companies");
    const hasOrderLineItems = await tableExists(pool, "order_line_items");
    const hasOrders = await tableExists(pool, "orders");
    const hasPlans = await tableExists(pool, "shipping_plans");
    if (!hasShipments) return res.status(200).json(notConnectedResponse());

    const shipmentCols = await columns(pool, "customs_shipments");
    const lineCols = hasLines ? await columns(pool, "customs_shipment_lines") : new Set();
    const outboxCols = hasOutbox ? await columns(pool, OUTBOX) : new Set();
    const companyCols = hasCompanies ? await columns(pool, "companies") : new Set();
    const oliCols = hasOrderLineItems ? await columns(pool, "order_line_items") : new Set();
    const orderCols = hasOrders ? await columns(pool, "orders") : new Set();
    const planCols = hasPlans ? await columns(pool, "shipping_plans") : new Set();
    const lensCtx = { hasCompanies, hasOrders, hasPlans, shipmentCols, companyCols, orderCols, planCols };
    const oliCtx = { hasOrderLineItems, oliCols };
    const qtySources = Object.fromEntries(qtyFieldSpecs(oliCtx).map((s) => [s.name, s.connected ? s.source : ""]));
    const outboxMissing = hasOutbox ? qualify(OUTBOX, missingCols(outboxCols, OUTBOX_FIELDS)) : [OUTBOX];
    const rawOutboxMissing = hasOutbox ? missingCols(outboxCols, OUTBOX_FIELDS) : [OUTBOX];
    const params = req.method === "GET" ? (req.query || {}) : { ...(req.query || {}), ...(req.body || {}) };
    const allShipmentRows = await shipmentTotal(pool);
    const rows = await listShipments(pool, lensCtx, params);
    const selected = rows[0] || null;
    const selectedOrderId = selected?.linked_order_id || selected?.order_id || null;
    const headerRates = coverage(rows, HEADER_FIELDS, shipmentCols).map((f) => ({ ...f, source: `customs_shipments.${f.name}` }));
    const businessRates = businessCoverage(rows, businessLens(lensCtx).availability);
    rows.forEach((r) => {
      r.business_missing = businessMissing(r, businessRates);
      r.business_missing_count = r.business_missing.length;
    });
    const allLineRates = await lineCoverage(pool, hasLines, lineCols);
    const allQtyRates = selected ? await qtyCoverage(pool, oliCtx, selectedOrderId) : missingQtyCoverage("缺 customs_shipments.order_id 或 orders.id 可关联记录");

    const drafts = await loadDrafts(pool, hasOutbox && !rawOutboxMissing.length);
    if (req.method === "GET") {
      return res.json({
        success: true,
        generated_at: new Date().toISOString(),
        data: rows,
        drafts,
        selected,
        version: VERSION,
        send_disabled: true,
        coverage: {
          total_rows: rows.length,
          total_rows_all: allShipmentRows,
          header_fields: headerRates,
          business_fields: businessRates,
          line_fields: allLineRates.concat(allQtyRates),
          outbox_missing: outboxMissing,
        },
        outbox: outboxState(hasOutbox, rawOutboxMissing, outboxMissing, drafts),
      });
    }
    if (req.method !== "POST") return fail(res, 405, "Method not allowed");
    if (!selected) return fail(res, 404, "shipment_not_found");
    const action = (req.body || {}).action;
    if (!["validate", "save"].includes(action)) return fail(res, 400, "invalid_action");
    const lines = hasLines ? await loadLines(pool, lineCols, selected.id) : [];
    const lineRates = await selectedLineCoverage(pool, hasLines, lineCols, selected.id);
    const qtyRates = await qtyCoverage(pool, oliCtx, selectedOrderId);
    const orderLineItems = await loadOrderLineItems(pool, oliCtx, selectedOrderId);
    const message = buildMessage(selected, lines, orderLineItems, shipmentCols, lineCols, qtySources, headerRates, lineRates, qtyRates, businessRates, hasOutbox && !rawOutboxMissing.length);
    if (action === "validate") return res.json({ success: true, dry_run: true, sent: false, send_disabled: true, message });
    if (!hasOutbox || rawOutboxMissing.length) return fail(res, 409, "outbox_not_connected", { missing_fields: outboxMissing, required_sql: outboxSql(hasOutbox, rawOutboxMissing) });
    if (!shipmentCols.has("id") || !hasValue(selected.id)) return fail(res, 409, "shipment_id_not_connected", { missing_fields: ["customs_shipments.id"] });
    if (!message.validation_summary.can_persist) return fail(res, 409, "cannot_persist");
    const draft = await writeDraft(pool, message, selected.id, req.user || {});
    return res.json({ success: true, sent: false, send_disabled: true, draft, message });
  } catch (err) {
    console.error("[manifest-message-channel]", err);
    return fail(res, 500, err.message);
  }
}
