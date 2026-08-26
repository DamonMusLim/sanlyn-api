// /api/db/warehouse-info - warehouse inventory read lens, no writes.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);
const W_FIELDS = [
  ["code", "仓库编码"], ["name", "仓库名称"], ["address", "地址"],
  ["contact_name", "联系人"], ["contact_phone", "联系电话"], ["status", "状态"],
];
const FGI_FIELDS = [
  ["sku", "SKU"], ["warehouse_id", "仓库ID"], ["current_stock", "当前库存"],
  ["safety_stock", "安全库存"], ["unit", "单位"], ["factory_code", "工厂码"],
  ["last_move_at", "最近变动"],
];
const LOG_FIELDS = [
  ["sku", "SKU"], ["warehouse_id", "仓库ID"], ["type", "流水类型"],
  ["quantity", "数量"], ["at", "系统时间"], ["delivery_date", "交货日期"],
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

function coverage(rows, fields, colSet, table) {
  return fields.map(([name, label]) => {
    if (!colSet.has(name)) {
      return { table, name, label, state: "not_connected", filled: 0, total: rows.length, fill_rate: null };
    }
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { table, name, label, state: "ready", filled, total: rows.length, fill_rate: pct(filled, rows.length) };
  });
}

function selectList(alias, fields, colSet) {
  return fields.map(([name]) => colSet.has(name) ? `${alias}.${name}` : `NULL AS ${name}`).join(", ");
}

function missing(row, fields, colSet, table) {
  return fields.filter(([name]) => !colSet.has(name) || !hasValue(row[name])).map(([name, label]) => ({
    table, name, label, reason: colSet.has(name) ? "empty" : "not_connected",
  }));
}

function searchCond(alias, colSet, fields, paramNo) {
  const cols = fields.filter((name) => colSet.has(name));
  if (!cols.length) return "";
  return "(" + cols.map((name) => `${alias}.${name} ILIKE $${paramNo}`).join(" OR ") + ")";
}

async function listWarehouses(pool, sets, q) {
  if (!sets.warehouses.size) return [];
  const limit = Math.min(parseInt(q.limit, 10) || 80, 200);
  const params = [];
  const conds = [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    const cond = searchCond("w", sets.warehouses, ["code", "name"], params.length + 1);
    if (cond) params.push(`%${search}%`);
    if (cond) conds.push(cond);
  }
  params.push(limit);
  const fgiJoin = sets.finished_goods_inventory.size && sets.warehouses.has("id");
  const currentExpr = sets.finished_goods_inventory.has("current_stock") ? "SUM(f.current_stock)" : "NULL";
  const safetyExpr = sets.finished_goods_inventory.has("safety_stock") ? "SUM(f.safety_stock)" : "NULL";
  const lastMoveExpr = sets.finished_goods_inventory.has("last_move_at") ? "MAX(f.last_move_at)" : "NULL";
  const sql = `
    SELECT w.id, ${selectList("w", W_FIELDS, sets.warehouses)},
           ${fgiJoin ? "fg.sku_count" : "NULL"} AS sku_count,
           ${fgiJoin && sets.finished_goods_inventory.has("current_stock") ? "fg.current_stock_sum" : "NULL"} AS current_stock_sum,
           ${fgiJoin && sets.finished_goods_inventory.has("safety_stock") ? "fg.safety_stock_sum" : "NULL"} AS safety_stock_sum,
           ${fgiJoin && sets.finished_goods_inventory.has("last_move_at") ? "fg.last_move_at" : "NULL"} AS last_move_at
      FROM warehouses w
      ${fgiJoin ? `LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS sku_count,
               ${currentExpr} AS current_stock_sum,
               ${safetyExpr} AS safety_stock_sum,
               ${lastMoveExpr} AS last_move_at
          FROM finished_goods_inventory f
         WHERE f.warehouse_id = w.id
      ) fg ON true` : ""}
     ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
     ORDER BY w.id ASC
     LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function stockRows(pool, sets, warehouseIds, q) {
  if (!sets.finished_goods_inventory.size || !sets.finished_goods_inventory.has("warehouse_id") || !warehouseIds.length) {
    return new Map();
  }
  const params = [warehouseIds];
  const conds = ["f.warehouse_id = ANY($1::bigint[])"];
  const search = clean(q.q || q.search, 100);
  if (search) {
    const cond = searchCond("f", sets.finished_goods_inventory, ["sku", "factory_code"], params.length + 1);
    if (cond) params.push(`%${search}%`);
    if (cond) conds.push(cond);
  }
  const sql = `
    SELECT f.id, ${selectList("f", FGI_FIELDS, sets.finished_goods_inventory)}
      FROM finished_goods_inventory f
     WHERE ${conds.join(" AND ")}
     ORDER BY f.warehouse_id ASC, f.id DESC
     LIMIT 240`;
  const r = await pool.query(sql, params);
  return r.rows.reduce((m, row) => {
    const key = Number(row.warehouse_id);
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(row);
    return m;
  }, new Map());
}

async function listLogs(pool, sets) {
  if (!sets.inventory_logs.size) return [];
  const sql = `
    SELECT ${selectList("il", LOG_FIELDS, sets.inventory_logs)}
      FROM inventory_logs il
     ORDER BY ${sets.inventory_logs.has("at") ? "il.at DESC NULLS LAST, " : ""}il.id DESC
     LIMIT 240`;
  const r = await pool.query(sql);
  return r.rows;
}

async function countRows(pool, table, colSet) {
  if (!colSet.size) return null;
  const r = await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`);
  return r.rows[0]?.n ?? null;
}

function normalize(row, stock, sets) {
  const m = missing(row, W_FIELDS, sets.warehouses, "warehouses");
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    address: row.address,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    status: row.status,
    sku_count: row.sku_count,
    current_stock_sum: row.current_stock_sum,
    safety_stock_sum: row.safety_stock_sum,
    last_move_at: row.last_move_at,
    stock,
    missing_count: m.length,
    missing: m,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!READ_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "Method not allowed");

  try {
    const pool = getPool();
    const hasWarehouses = await tableExists(pool, "warehouses");
    const hasFgi = await tableExists(pool, "finished_goods_inventory");
    const hasLogs = await tableExists(pool, "inventory_logs");
    const sets = {
      warehouses: hasWarehouses ? await columns(pool, "warehouses") : new Set(),
      finished_goods_inventory: hasFgi ? await columns(pool, "finished_goods_inventory") : new Set(),
      inventory_logs: hasLogs ? await columns(pool, "inventory_logs") : new Set(),
    };
    const warehouseRows = await listWarehouses(pool, sets, req.query || {});
    const byWh = await stockRows(pool, sets, warehouseRows.map((r) => r.id).filter(Boolean), req.query || {});
    const fgiRows = Array.from(byWh.values()).flat();
    const logRows = await listLogs(pool, sets);
    const logCount = await countRows(pool, "inventory_logs", sets.inventory_logs);
    const data = warehouseRows.map((r) => normalize(r, byWh.get(Number(r.id)) || [], sets));
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      metrics: {
        warehouse_count: warehouseRows.length,
        sku_count: fgiRows.length,
        log_count: logCount,
      },
      warehouses: data,
      selected: data[0] || null,
      coverage: {
        warehouses: coverage(warehouseRows, W_FIELDS, sets.warehouses, "warehouses"),
        finished_goods_inventory: coverage(fgiRows, FGI_FIELDS, sets.finished_goods_inventory, "finished_goods_inventory"),
        inventory_logs: coverage(logRows, LOG_FIELDS, sets.inventory_logs, "inventory_logs"),
      },
      not_connected: [
        !hasWarehouses && "缺表 warehouses",
        hasWarehouses && !warehouseRows.length && "warehouses 无可读取记录",
        !hasFgi && "缺表 finished_goods_inventory",
        hasFgi && !fgiRows.length && "finished_goods_inventory 无可读取记录",
        !hasLogs && "缺表 inventory_logs",
        hasLogs && !Number(logCount) && "inventory_logs 无可读取记录",
      ].filter(Boolean),
    });
  } catch (err) {
    console.error("[warehouse-info]", err);
    return fail(res, 500, err.message);
  }
}
