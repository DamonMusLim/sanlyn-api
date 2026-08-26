// /api/db/cargo-info - container cargo read lens, no writes or external sends.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance"]);
const CB_FIELDS = [
  ["container_no", "箱号"], ["seal_no", "封号"], ["container_type", "箱型"],
  ["contract_no", "合同/订单号"], ["bl_no", "提单号"], ["booking_no", "订舱号"],
  ["cargo_weight_kg", "货重kg"], ["tare_kg", "皮重kg"], ["vgm_kg", "VGMkg"],
  ["pickup_time", "提箱时间"], ["truck_plate", "车牌"], ["driver_name", "司机"],
  ["driver_phone", "司机电话"], ["loading_address", "装货地址"],
];
const C_FIELDS = [
  ["container_no", "箱号"], ["seal_no", "封号"], ["container_type", "箱型"],
  ["gross_weight_kg", "毛重kg"], ["total_cbm", "体积CBM"], ["loaded_at", "装柜时间"],
];
const OC_FIELDS = [["ctn_count", "箱数"], ["cbm", "订单CBM"]];

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

function searchCond(alias, colSet, fields, paramNo) {
  const cols = fields.filter((name) => colSet.has(name));
  if (!cols.length) return "";
  return "(" + cols.map((name) => `${alias}.${name} ILIKE $${paramNo}`).join(" OR ") + ")";
}

function missing(row, fields, colSet, table) {
  return fields.filter(([name]) => !colSet.has(name) || !hasValue(row[name])).map(([name, label]) => ({
    table, name, label, reason: colSet.has(name) ? "empty" : "not_connected",
  }));
}

async function listBookings(pool, colSet, q) {
  if (!colSet.size) return [];
  const limit = Math.min(parseInt(q.limit, 10) || 80, 200);
  const params = [];
  const conds = [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    const cond = searchCond("cb", colSet, ["container_no", "bl_no", "contract_no"], params.length + 1);
    if (cond) params.push(`%${search}%`);
    if (cond) conds.push(cond);
  }
  params.push(limit);
  const order = (colSet.has("pickup_time") ? "cb.pickup_time DESC NULLS LAST, " : "") + "cb.id DESC";
  const sql = `
    SELECT cb.id, 'container_bookings' AS source, ${selectList("cb", CB_FIELDS, colSet)}
      FROM container_bookings cb
     ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
     ORDER BY ${order}
     LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows;
}

async function listContainers(pool, sets, q) {
  if (!sets.containers.size) return [];
  const limit = Math.min(parseInt(q.limit, 10) || 80, 200);
  const params = [];
  const conds = [];
  const search = clean(q.q || q.search, 100);
  if (search) {
    const cond = searchCond("c", sets.containers, ["container_no", "seal_no"], params.length + 1);
    if (cond) params.push(`%${search}%`);
    if (cond) conds.push(cond);
  }
  params.push(limit);
  const sg = sets.shipment_group.size && sets.containers.has("shipment_group_id");
  const oc = sets.order_containers.has("container_id");
  const order = (sets.containers.has("loaded_at") ? "c.loaded_at DESC NULLS LAST, " : "") + "c.id DESC";
  const sql = `
    SELECT c.id, 'containers' AS source, ${selectList("c", C_FIELDS, sets.containers)},
           ${sg ? "sg.bl_master" : "NULL"} AS bl_no,
           ${sg ? "sg.vessel" : "NULL"} AS vessel,
           ${sg ? "sg.voyage" : "NULL"} AS voyage,
           ${sg ? "sg.pol" : "NULL"} AS pol,
           ${sg ? "sg.pod" : "NULL"} AS pod,
           ${oc ? "(SELECT COUNT(*)::int FROM order_containers oc WHERE oc.container_id = c.id)" : "NULL"} AS linked_orders,
           ${oc && sets.order_containers.has("ctn_count") ? "(SELECT SUM(oc.ctn_count) FROM order_containers oc WHERE oc.container_id = c.id)" : "NULL"} AS ctn_count,
           ${oc && sets.order_containers.has("cbm") ? "(SELECT SUM(oc.cbm) FROM order_containers oc WHERE oc.container_id = c.id)" : "NULL"} AS cbm
     FROM containers c
      ${sg ? "LEFT JOIN shipment_group sg ON sg.id = c.shipment_group_id" : ""}
     ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
     ORDER BY ${order}
     LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  return r.rows;
}

function normalize(row, fieldSpec, colSet, table) {
  const m = missing(row, fieldSpec, colSet, table);
  return {
    source: row.source,
    id: row.id,
    container_no: row.container_no,
    seal_no: row.seal_no,
    container_type: row.container_type,
    bl_no: row.bl_no,
    booking_no: row.booking_no,
    contract_no: row.contract_no,
    cargo_weight_kg: row.cargo_weight_kg,
    tare_kg: row.tare_kg,
    vgm_kg: row.vgm_kg,
    gross_weight_kg: row.gross_weight_kg,
    total_cbm: row.total_cbm,
    ctn_count: row.ctn_count,
    cbm: row.cbm,
    truck_plate: row.truck_plate,
    driver_name: row.driver_name,
    driver_phone: row.driver_phone,
    loading_address: row.loading_address,
    pickup_time: row.pickup_time,
    loaded_at: row.loaded_at,
    linked_orders: row.linked_orders,
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
    const hasCb = await tableExists(pool, "container_bookings");
    const hasContainers = await tableExists(pool, "containers");
    const sets = {
      container_bookings: hasCb ? await columns(pool, "container_bookings") : new Set(),
      containers: hasContainers ? await columns(pool, "containers") : new Set(),
      shipment_group: await tableExists(pool, "shipment_group") ? await columns(pool, "shipment_group") : new Set(),
      order_containers: await tableExists(pool, "order_containers") ? await columns(pool, "order_containers") : new Set(),
    };
    const bookingRows = await listBookings(pool, sets.container_bookings, req.query || {});
    const containerRows = await listContainers(pool, sets, req.query || {});
    const data = bookingRows.map((r) => normalize(r, CB_FIELDS, sets.container_bookings, "container_bookings"))
      .concat(containerRows.map((r) => normalize(r, C_FIELDS.concat(OC_FIELDS), sets.containers, "containers")));
    return res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      data,
      selected: data[0] || null,
      coverage: {
        total_rows: data.length,
        container_bookings: coverage(bookingRows, CB_FIELDS, sets.container_bookings, "container_bookings"),
        containers: coverage(containerRows, C_FIELDS, sets.containers, "containers"),
        order_containers: coverage(containerRows, OC_FIELDS, sets.order_containers, "order_containers"),
      },
      not_connected: [
        !hasCb && "缺表 container_bookings",
        !hasContainers && "缺表 containers",
        !sets.shipment_group.size && "缺表 shipment_group 或未授权读取字段",
        !sets.order_containers.size && "缺表 order_containers 或未授权读取字段",
      ].filter(Boolean),
    });
  } catch (err) {
    console.error("[cargo-info]", err);
    return fail(res, 500, err.message);
  }
}
