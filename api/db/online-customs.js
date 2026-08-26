// /api/db/online-customs — online customs declaration read lens. No external send.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);
const DECL_FIELDS = [
  ["declaration_no", "报关单号"], ["declaration_status", "报关状态"],
  ["trade_country", "贸易国"], ["arrive_country", "运抵国"],
  ["transaction_term", "成交方式"], ["transport_mode", "运输方式"],
  ["supervision_mode", "监管方式"], ["duty_exemption", "征免性质"],
  ["declared_at", "申报日期"], ["released_at", "放行日期"],
  ["container_nos", "柜号"], ["broker_company_id", "报关行"],
  ["owner_company_id", "经营单位"], ["total_declaration_amount", "表头申报货值"],
  ["total_declaration_currency", "表头币种"],
];
const ITEM_FIELDS = [
  ["hs_code", "HS编码"], ["declaration_name_cn", "申报品名"],
  ["qty", "数量"], ["unit", "单位"], ["gross_weight_kg", "毛重"],
  ["net_weight_kg", "净重"], ["declaration_amount", "逐项申报货值"],
  ["declaration_currency", "逐项币种"], ["country_of_origin", "原产国"],
];
const SEND_FIELDS = [
  ["online_customs_status", "在线申报状态"],
  ["online_customs_sent_at", "发送时间"],
  ["online_customs_receipt_no", "申报回执号"],
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

function expr(alias, cols, name) {
  return cols.has(name) ? `${alias}.${name}` : `NULL::text AS ${name}`;
}

function coverage(rows, fields, cols) {
  const total = rows.length;
  return fields.map(([name, label]) => {
    if (!cols.has(name)) return { name, label, state: "not_connected", filled: 0, total, fill_rate: null };
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, label, state: "ready", filled, total, fill_rate: pct(filled, total) };
  });
}

function missingFor(row, fields, cols) {
  return fields
    .filter(([name]) => !cols.has(name) || !hasValue(row[name]))
    .map(([name, label]) => ({ name, label, reason: cols.has(name) ? "empty" : "not_connected" }));
}

function orderSql(cols) {
  const parts = [];
  if (cols.has("declared_at")) parts.push("d.declared_at DESC NULLS LAST");
  if (cols.has("created_at")) parts.push("d.created_at DESC NULLS LAST");
  if (cols.has("id")) parts.push("d.id DESC");
  return parts.length ? parts.join(", ") : "1";
}

function rowOut(row, declCols) {
  const missing = missingFor(row, DECL_FIELDS, declCols);
  return {
    id: row.id, declaration_no: row.declaration_no, declaration_status: row.declaration_status,
    trade_country: row.trade_country, arrive_country: row.arrive_country,
    transaction_term: row.transaction_term, transport_mode: row.transport_mode,
    supervision_mode: row.supervision_mode, duty_exemption: row.duty_exemption,
    declared_at: row.declared_at, released_at: row.released_at,
    container_nos: row.container_nos, broker: row.broker, owner_company: row.owner_company,
    total_declaration_amount: row.total_declaration_amount,
    total_declaration_currency: row.total_declaration_currency,
    items_amount: row.items_amount, line_count: row.line_count == null ? null : Number(row.line_count),
    missing_count: missing.length, missing,
  };
}

function liveCond(alias, cols) {
  return cols.has("deleted_at") ? `${alias}.deleted_at IS NULL` : "true";
}

function countExpr(cols, name) {
  if (!cols.has(name)) return `0::int AS ${name}`;
  if (name === "qty" || name === "gross_weight_kg" || name === "net_weight_kg" || name === "declaration_amount") {
    return `COUNT(*) FILTER (WHERE ${name} IS NOT NULL)::int AS ${name}`;
  }
  return `COUNT(*) FILTER (WHERE NULLIF(BTRIM(${name}), '') IS NOT NULL)::int AS ${name}`;
}

async function listDeclarations(pool, declCols, itemCols, hasItems, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 80, 200);
  const params = [], conds = declCols.has("deleted_at") ? ["d.deleted_at IS NULL"] : [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    params.push(`%${search}%`);
    const searchCols = ["declaration_no", "trade_country", "arrive_country", "container_nos"].filter((n) => declCols.has(n));
    if (searchCols.length) conds.push("(" + searchCols.map((n) => `d.${n}::text ILIKE $${params.length}`).join(" OR ") + ")");
  }
  if (q.id) {
    params.push(parseInt(q.id, 10));
    conds.push(`d.id = $${params.length}`);
  }
  const itemWhere = `i.declaration_id = d.id AND ${liveCond("i", itemCols)}`;
  const itemsAmount = itemCols.has("declaration_amount")
    ? `(SELECT SUM(i.declaration_amount) FROM customs_declaration_items i WHERE ${itemWhere}) AS items_amount`
    : "NULL::numeric AS items_amount";
  const itemAgg = hasItems
    ? `,(SELECT COUNT(*)::int FROM customs_declaration_items i WHERE ${itemWhere}) AS line_count
       ,${itemsAmount}`
    : ", NULL::int AS line_count, NULL::numeric AS items_amount";
  const brokerExpr = declCols.has("broker_company_id")
    ? "(SELECT name_cn FROM companies c WHERE c.id = d.broker_company_id) AS broker"
    : "NULL::text AS broker";
  const ownerExpr = declCols.has("owner_company_id")
    ? "(SELECT name_cn FROM companies c WHERE c.id = d.owner_company_id) AS owner_company"
    : "NULL::text AS owner_company";
  params.push(limit);
  const sql = `
    SELECT d.id, ${DECL_FIELDS.map(([name]) => expr("d", declCols, name)).join(", ")},
      ${brokerExpr}, ${ownerExpr}
      ${itemAgg}
    FROM customs_declarations d
    ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
    ORDER BY ${orderSql(declCols)} LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function itemSummary(pool, declId, itemCols) {
  const counts = ITEM_FIELDS.map(([name]) => countExpr(itemCols, name)).join(",\n      ");
  const r = await pool.query(
    `SELECT COUNT(*)::int AS lines,
      ${counts}
     FROM customs_declaration_items WHERE declaration_id = $1 AND ${liveCond("customs_declaration_items", itemCols)}`,
    [declId]
  );
  const row = r.rows[0] || {};
  return {
    lines: Number(row.lines || 0),
    fields: ITEM_FIELDS.map(([name, label]) => itemCols.has(name)
      ? { name, label, state: "ready", filled: Number(row[name] || 0), total: Number(row.lines || 0), fill_rate: pct(Number(row[name] || 0), Number(row.lines || 0)) }
      : { name, label, state: "not_connected", filled: 0, total: Number(row.lines || 0), fill_rate: null }),
  };
}

function notConnected(rates) {
  return {
    state: "not_connected",
    missing_fields: SEND_FIELDS.map(([name, label]) => ({ name, label })),
    fill_rates: rates,
    note: "缺单一窗口/在线报关通道接口、通道凭证、发送状态字段和回执字段；本页不对外发送。",
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
    if (!(await tableExists(pool, "customs_declarations"))) {
      return res.status(200).json({ success: true, generated_at: new Date().toISOString(), data: [], selected: null, coverage: { total_rows: 0, fields: [], item_fields: [], send_fields: [] }, send_channel: notConnected([]) });
    }
    const declCols = await columns(pool, "customs_declarations");
    const hasItems = await tableExists(pool, "customs_declaration_items");
    const itemCols = hasItems ? await columns(pool, "customs_declaration_items") : new Set();
    const rows = await listDeclarations(pool, declCols, itemCols, hasItems, req.query || {});
    const selected = rows[0] ? rowOut(rows[0], declCols) : null;
    const itemCoverage = selected && hasItems ? await itemSummary(pool, selected.id, itemCols) : { lines: 0, fields: [] };
    const sendCoverage = coverage(rows, SEND_FIELDS, declCols);
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      data: rows.map((r) => rowOut(r, declCols)),
      selected,
      coverage: {
        total_rows: rows.length,
        fields: coverage(rows, DECL_FIELDS, declCols),
        item_fields: itemCoverage.fields,
        item_rows: itemCoverage.lines,
        send_fields: sendCoverage,
      },
      send_channel: notConnected(sendCoverage),
    });
  } catch (err) {
    console.error("[online-customs]", err);
    return fail(res, 500, err.message);
  }
}
