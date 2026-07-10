// /api/db/sku-recon.js - SKU库存对账表(工厂可填/客户只读脱敏)
import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";

const ROLES = new Set(["factory", "customer", "sanlyn", "admin"]);

function json(res, status, payload) { return res.status(status).json(payload); }
function clean(v, n = 120) { return String(v == null ? "" : v).trim().slice(0, n); }
function role(req) {
  const r = clean(req.user?.role || "", 40).toLowerCase();
  return ROLES.has(r) ? r : null;
}
function codes(req) {
  const u = req.user || {};
  const raw = Array.isArray(u.companyCodes) && u.companyCodes.length
    ? u.companyCodes : (u.companyCode || u.company_code ? [u.companyCode || u.company_code] : []);
  return raw.map(x => clean(x, 80)).filter(Boolean);
}
function isInternal(r) { return r === "sanlyn" || r === "admin"; }
function actor(req) {
  const u = req.user || {};
  return clean(u.username || u.email || u.sub || "sku-recon", 120);
}
function qty(v, label) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(label + " invalid");
  return n;
}
function statusOf(row) {
  const order = Number(row.order_qty || 0);
  const realRaw = row.real_qty;
  const real = Number(realRaw || 0);
  const diff = realRaw == null && order ? null : real - order;
  const bag = Number(row.bag_stock || 0);
  const safety = Number(row.bag_safety_stock || 0);
  if ((safety > 0 && bag < safety) || (order > 0 && bag < order)) return "bag_short";
  if (order > 0 && realRaw == null) return "pending_receipt";
  if (diff != null && Math.abs(diff) <= 0.0001) return "matched";
  return "in_transit";
}
function publicRow(row, r) {
  const diff = row.real_qty == null && Number(row.order_qty || 0) ? null : Number(row.real_qty || 0) - Number(row.order_qty || 0);
  const base = {
    sku: row.sku,
    product_name: row.product_name_cn || row.product_name || "",
    brand: row.brand || "未分组",
    size: row.size || row.spec || "",
    image_url: row.image_url || "",
    finished_stock: Number(row.finished_stock || 0),
    finished_safety_stock: Number(row.finished_safety_stock || 0),
    bag_stock: Number(row.bag_stock || 0),
    bag_safety_stock: Number(row.bag_safety_stock || 0),
    bag_count: Number(row.bag_count || 0),
    order_qty: row.order_qty == null ? null : Number(row.order_qty),
    real_qty: row.real_qty == null ? null : Number(row.real_qty),
    diff,
    status: statusOf(row),
    inbound_id: row.inbound_id || null,
    latest_inbound_at: row.latest_inbound_at || null,
    can_edit: r === "factory" || isInternal(r),
  };
  return base;
}
function groupRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const brand = row.brand || "未分组";
    if (!map.has(brand)) map.set(brand, { brand, sku_count: 0, bag_count: 0, rows: [] });
    const g = map.get(brand);
    g.rows.push(row);
    g.sku_count += 1;
    g.bag_count += Number(row.bag_count || 0);
  }
  return [...map.values()];
}

async function listRows(pool, r, scopeCodes, req) {
  const vals = [];
  let where = "p.sku IS NOT NULL AND COALESCE(p.active, true)";
  let routeJoin = "";
  if (r === "factory") {
    vals.push(scopeCodes);
    where += ` AND p.factory_code = ANY($${vals.length}::text[])`;
  } else if (r === "customer") {
    vals.push(scopeCodes);
    where += ` AND EXISTS (
      SELECT 1 FROM customer_brand_routes cbr
       WHERE cbr.brand = p.brand
         AND cbr.factory_code = p.factory_code
         AND cbr.status = 'active'
         AND cbr.customer_code = ANY($${vals.length}::text[]))`;
  } else if (isInternal(r)) {
    const fc = clean(req.query.factory_code || "", 80);
    if (fc) { vals.push(fc); where += ` AND p.factory_code = $${vals.length}`; }
  }
  const q = `
    SELECT p.sku, p.product_name, p.product_name_cn, p.brand, p.size, p.spec, p.image_url AS product_image_url,
           COALESCE(fg.current_stock, 0) AS finished_stock,
           COALESCE(fg.safety_stock, 0) AS finished_safety_stock,
           COALESCE(pm.bag_stock, 0) AS bag_stock,
           COALESCE(pm.bag_safety_stock, 0) AS bag_safety_stock,
           COALESCE(pm.bag_count, 0) AS bag_count,
           COALESCE(pm.image_url, p.image_url) AS image_url,
           ib.inbound_id, ib.latest_inbound_at, ib.order_qty, ib.real_qty
      FROM products p
      ${routeJoin}
 LEFT JOIN LATERAL (
       SELECT SUM(f.current_stock) AS current_stock, SUM(f.safety_stock) AS safety_stock
         FROM finished_goods_inventory f WHERE f.sku = p.sku) fg ON true
 LEFT JOIN LATERAL (
       SELECT SUM(m.current_stock) AS bag_stock, SUM(m.safety_stock) AS bag_safety_stock,
              COUNT(DISTINCT m.id) AS bag_count, MAX(NULLIF(m.image_url, '')) AS image_url
         FROM packaging_materials m
        WHERE m.product_skus @> jsonb_build_array(p.sku)) pm ON true
 LEFT JOIN LATERAL (
       SELECT (array_agg(d.id ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC, d.id DESC))[1] AS inbound_id,
              MAX(d.updated_at) AS latest_inbound_at,
              SUM(d.order_qty) AS order_qty,
              SUM(d.real_qty) FILTER (WHERE d.real_qty IS NOT NULL) AS real_qty
         FROM inbound_deliveries d
         JOIN packaging_materials m ON m.sku_code = d.material_sku
        WHERE m.product_skus @> jsonb_build_array(p.sku)
          AND (p.factory_code IS NULL OR d.factory_code = p.factory_code)) ib ON true
     WHERE ${where}
  ORDER BY COALESCE(NULLIF(p.brand, ''), '未分组'), p.sku
     LIMIT 500`;
  const rows = (await pool.query(q, vals)).rows.map(row => publicRow(row, r));
  return { rows, groups: groupRows(rows) };
}

async function saveRow(client, req, r, scopeCodes, row) {
  const sku = clean(row.sku, 80);
  if (!sku) throw new Error("sku required");
  const vals = [sku];
  let where = "sku = $1";
  if (r === "factory") { vals.push(scopeCodes); where += ` AND factory_code = ANY($2::text[])`; }
  const p = await client.query(`SELECT id, sku, unit, factory_code FROM products WHERE ${where} LIMIT 1 FOR UPDATE`, vals);
  if (!p.rows.length) throw new Error("sku out of scope");
  const product = p.rows[0];

  if (row.finished_stock !== undefined) {
    const target = qty(row.finished_stock, "finished_stock");
    let inv = await client.query(
      `SELECT * FROM finished_goods_inventory WHERE sku=$1 AND warehouse_id=$2 FOR UPDATE`,
      [sku, row.warehouse_id || 1]
    );
    if (!inv.rows.length) {
      await client.query(
        `INSERT INTO finished_goods_inventory(product_id, sku, unit, current_stock, safety_stock, factory_code, warehouse_id)
         VALUES($1,$2,$3,0,0,$4,$5) ON CONFLICT (sku, warehouse_id) DO NOTHING`,
        [product.id, sku, product.unit || null, product.factory_code || null, row.warehouse_id || 1]
      );
      inv = await client.query(`SELECT * FROM finished_goods_inventory WHERE sku=$1 AND warehouse_id=$2 FOR UPDATE`, [sku, row.warehouse_id || 1]);
    }
    const before = Number(inv.rows[0].current_stock || 0);
    if (target !== before) {
      await client.query(`UPDATE finished_goods_inventory SET current_stock=$1, last_move_at=NOW(), updated_at=NOW() WHERE id=$2`, [target, inv.rows[0].id]);
      await client.query(
        `INSERT INTO inventory_logs(product_id, sku, type, quantity, unit, before_stock, after_stock, ref_type, ref_id, warehouse_id, factory_code, note, "operator")
         VALUES($1,$2,'adjust',$3,$4,$5,$6,'sku-recon',$7,$8,$9,$10,$11)`,
        [product.id, sku, target - before, product.unit || null, before, target, "sku-recon-" + Date.now(), inv.rows[0].warehouse_id, product.factory_code || null, "SKU库存对账保存", actor(req)]
      );
    }
  }
  if (row.real_qty !== undefined) {
    const real = qty(row.real_qty, "real_qty");
    const d = await client.query(
      `SELECT d.id FROM inbound_deliveries d
        JOIN packaging_materials m ON m.sku_code = d.material_sku
       WHERE m.product_skus @> jsonb_build_array($1::text)
         AND ($2::text IS NULL OR d.factory_code = $2)
       ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC, d.id DESC LIMIT 1 FOR UPDATE`,
      [sku, product.factory_code || null]
    );
    if (d.rows.length) await client.query(`UPDATE inbound_deliveries SET real_qty=$1, updated_at=NOW() WHERE id=$2`, [real, d.rows[0].id]);
  }
  return sku;
}

async function save(req, res, pool, r, scopeCodes) {
  if (r !== "factory" && !isInternal(r)) return json(res, 403, { success: false, error: "save forbidden" });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [req.body || {}];
  if (!rows.length) return json(res, 400, { success: false, error: "rows required" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const saved = [];
    for (const row of rows) saved.push(await saveRow(client, req, r, scopeCodes, row));
    await client.query("COMMIT");
    return json(res, 200, { success: true, saved });
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) extractUser(req);
  if (!req.user) return json(res, 401, { success: false, error: "Unauthorized" });
  const r = role(req);
  if (!r) return json(res, 403, { success: false, error: "role forbidden" });
  const scopeCodes = codes(req);
  if (!isInternal(r) && !scopeCodes.length) return json(res, 403, { success: false, error: "company_code scope missing" });
  const pool = getPool();
  try {
    if (req.method === "GET") return json(res, 200, { success: true, role: r, can_edit: r === "factory" || isInternal(r), ...(await listRows(pool, r, scopeCodes, req)) });
    if (req.method === "PATCH" && clean(req.query.action || req.body?.action, 40) === "save") return save(req, res, pool, r, scopeCodes);
    return json(res, 405, { success: false, error: "Method/action not allowed" });
  } catch (e) {
    const code = /required|invalid/.test(e.message) ? 400 : (/scope|forbidden/.test(e.message) ? 403 : 500);
    return json(res, code, { success: false, error: e.message });
  }
}
