// SPOT电商 · read-only lens over petstore_ops_row.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "ops", "operator", "sales", "finance", "ceo", "superadmin"]);
const CORE_FIELDS = [
  ["product_code", "商品编码"], ["product_name", "商品名称"], ["category", "分类"],
  ["spec_text", "规格"], ["barcode", "条码"], ["own_brand", "自有品牌"],
  ["store_price", "门店价"], ["mt_price", "美团价"], ["ele_price", "饿了么价"],
  ["cost_price", "成本价"], ["market_price", "竞店价"], ["market_store", "竞店"],
  ["market_captured_at", "竞店采集时间"], ["cur_stock", "当前库存"], ["days_of_supply", "可售天数"],
  ["days_left", "效期剩余天数"], ["shelf_code", "货架位"], ["restock_verdict", "补货判断"],
];
const ONLINE_FIELDS = [
  ["online_source_sku_id", "线上SKU"], ["online_original_price", "线上原价"],
  ["online_activity_price", "线上活动价"], ["online_price_captured_at", "线上价格采集时间"],
];

function fail(res, status, error) { return res.status(status).json({ success: false, error }); }
function canRead(user) { return READ_ROLES.has(user?.role); }
function clean(v, max = 120) { return String(v ?? "").trim().slice(0, max); }
function hasValue(v) { return v !== null && v !== undefined && String(v).trim() !== ""; }
function pct(filled, total) { return total ? Math.round((filled * 1000) / total) / 10 : null; }

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

function colExpr(name, colSet) { return colSet.has(name) ? `o.${name}` : `NULL::text AS ${name}`; }
function money(v) { return v === null || v === undefined || v === "" ? null : Number(v); }

function filters(colSet, query, params) {
  const out = [];
  const q = clean(query.q || query.search, 100);
  if (q) {
    params.push(`%${q}%`);
    const n = params.length;
    const cols = ["product_code", "product_name", "barcode", "category", "market_store"].filter((x) => colSet.has(x));
    if (cols.length) out.push("(" + cols.map((x) => `o.${x}::text ILIKE $${n}`).join(" OR ") + ")");
  }
  const state = clean(query.state, 40);
  if (state === "needs_price" && colSet.has("store_price")) out.push("o.store_price IS NULL");
  if (state === "no_online") {
    const online = ["mt_price", "ele_price", "online_activity_price"].filter((x) => colSet.has(x));
    if (online.length) out.push("(" + online.map((x) => `o.${x} IS NULL`).join(" AND ") + ")");
  }
  if (state === "stock_risk" && colSet.has("cur_stock")) out.push("o.cur_stock <= 0");
  return out;
}

async function listRows(pool, colSet, query) {
  const limit = Math.min(parseInt(query.limit, 10) || 100, 200);
  const params = [];
  const where = filters(colSet, query, params);
  params.push(limit);
  const fields = CORE_FIELDS.concat(ONLINE_FIELDS).map(([name]) => colExpr(name, colSet)).join(", ");
  const order = colSet.has("market_captured_at") ? "o.market_captured_at DESC NULLS LAST" : "o.product_code";
  const r = await pool.query(
    `SELECT ${fields} FROM petstore_ops_row o
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ${order} LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

function stateOf(row, colSet) {
  if (!colSet.has("mt_price") && !colSet.has("ele_price") && !colSet.has("online_activity_price")) return "not_connected";
  if (!hasValue(row.mt_price) && !hasValue(row.ele_price) && !hasValue(row.online_activity_price)) return "no_online";
  if (!hasValue(row.store_price)) return "needs_price";
  if (colSet.has("cur_stock") && money(row.cur_stock) <= 0) return "stock_risk";
  return "ready";
}

function warnings(row, colSet) {
  const out = [];
  if (colSet.has("store_price") && colSet.has("cost_price") && money(row.store_price) != null && money(row.cost_price) != null && money(row.store_price) < money(row.cost_price)) out.push("门店价低于成本价");
  if (colSet.has("cur_stock") && money(row.cur_stock) != null && money(row.cur_stock) <= 0) out.push("库存为零或负数");
  if (colSet.has("days_left") && money(row.days_left) != null && money(row.days_left) <= 30) out.push("效期剩余30天内");
  return out;
}

function rowOut(row, colSet) {
  const missing = CORE_FIELDS.concat(ONLINE_FIELDS)
    .filter(([name]) => !colSet.has(name) || !hasValue(row[name]))
    .map(([name, label]) => ({ name, label, reason: colSet.has(name) ? "empty" : "not_connected" }));
  return { ...row, state: stateOf(row, colSet), warnings: warnings(row, colSet), missing_count: missing.length, missing };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!canRead(req.user)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "GET required");
  try {
    const pool = getPool();
    if (!(await tableExists(pool, "petstore_ops_row"))) {
      const empty = new Set();
      return res.status(200).json({ success: true, generated_at: new Date().toISOString(), data: [], selected: null, coverage: { total_rows: 0, fields: coverage([], CORE_FIELDS, empty), online_fields: coverage([], ONLINE_FIELDS, empty) }, channel: { state: "not_connected", note: "缺 petstore_ops_row 真源视图；当前填充率 未接入。" } });
    }
    const colSet = await columns(pool, "petstore_ops_row");
    const rows = await listRows(pool, colSet, req.query || {});
    const data = rows.map((r) => rowOut(r, colSet));
    return res.status(200).json({ success: true, generated_at: new Date().toISOString(), data, selected: data[0] || null, coverage: { total_rows: rows.length, fields: coverage(rows, CORE_FIELDS, colSet), online_fields: coverage(rows, ONLINE_FIELDS, colSet) }, channel: { state: "not_connected", note: "缺SPOT电商外部上架、订单回流和履约回执字段；本页只读，不向平台发送商品或价格。" } });
  } catch (err) {
    console.error("[spot-ecommerce]", err);
    return fail(res, 500, err.message);
  }
}
