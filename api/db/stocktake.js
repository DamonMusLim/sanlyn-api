// /api/db/stocktake.js - 工厂成品库存盘点
import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";
import { writeAudit } from "./audit-helper.js";

const ROLES = new Set(["factory", "sanlyn", "admin"]);

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
  return clean(u.username || u.email || u.sub || "stocktake", 120);
}
function qty(v) {
  if (v === undefined || v === null || v === "") throw new Error("current_stock required");
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error("current_stock invalid");
  return n;
}
function publicRow(row) {
  return {
    sku: row.sku,
    product_name: row.product_name || row.product_name_cn || "",
    product_name_cn: (row.product_name_cn && row.product_name_cn !== row.product_name) ? row.product_name_cn : "",
    barcode: row.barcode || "",
    brand: row.brand || "未分组",
    size: row.size || row.spec || "",
    image_url: row.image_url || "",
    current_stock: Number(row.current_stock || 0),
    stocktook_at: row.stocktook_at || null,
  };
}
function scopeSql(req, r, scopeCodes, vals, requiredInternalFactory = false) {
  if (r === "factory") {
    vals.push(scopeCodes);
    return `p.factory_code = ANY($${vals.length}::text[])`;
  }
  const fc = clean(req.query.factory_code || req.body?.factory_code || "", 80);
  if (fc) {
    vals.push(fc);
    return `p.factory_code = $${vals.length}`;
  }
  if (requiredInternalFactory) throw new Error("factory_code required");
  return "true";
}

async function listRows(pool, req, r, scopeCodes) {
  const vals = [];
  const scope = scopeSql(req, r, scopeCodes, vals, false);
  const q = `
    SELECT p.sku, p.product_name, p.product_name_cn, p.barcode, p.brand, p.size, p.spec,
           COALESCE(fg.current_stock, 0) AS current_stock,
           fg.stocktook_at,
           COALESCE(fg.image_url, pm.image_url, p.image_url) AS image_url
      FROM products p
 LEFT JOIN finished_goods_inventory fg ON fg.sku = p.sku AND fg.warehouse_id = 1
 LEFT JOIN LATERAL (
       SELECT MAX(NULLIF(m.image_url, '')) AS image_url
         FROM packaging_materials m
        WHERE m.product_skus @> jsonb_build_array(p.sku)) pm ON true
     WHERE p.sku IS NOT NULL AND COALESCE(p.active, true) AND ${scope}
  ORDER BY COALESCE(NULLIF(p.brand, ''), '未分组'), p.sku`;
  const rows = (await pool.query(q, vals)).rows.map(publicRow);
  const todo = rows.filter(x => !x.stocktook_at);
  const done = rows.filter(x => x.stocktook_at);
  return { progress: { done: done.length, total: rows.length }, todo, done };
}

async function scopedProduct(client, sku, r, scopeCodes) {
  const vals = [sku];
  let where = "sku = $1";
  if (r === "factory") {
    vals.push(scopeCodes);
    where += ` AND factory_code = ANY($${vals.length}::text[])`;
  }
  const q = `SELECT id, sku, unit, factory_code FROM products WHERE ${where} LIMIT 1 FOR UPDATE`;
  const p = await client.query(q, vals);
  if (!p.rows.length) throw new Error("sku out of scope");
  return p.rows[0];
}

async function count(req, res, pool, r, scopeCodes) {
  const sku = clean(req.body?.sku, 80);
  if (!sku) throw new Error("sku required");
  const current = qty(req.body?.current_stock);
  const op = actor(req);
  const refId = "stocktake-" + Date.now();
  const client = await pool.connect();
  let product, beforeStock = 0;
  try {
    await client.query("BEGIN");
    product = await scopedProduct(client, sku, r, scopeCodes);
    const old = await client.query(
      `SELECT current_stock FROM finished_goods_inventory WHERE sku=$1 AND warehouse_id=1 FOR UPDATE`,
      [sku]
    );
    beforeStock = Number(old.rows[0]?.current_stock || 0);
    await client.query(
      `INSERT INTO finished_goods_inventory(product_id, sku, unit, current_stock, factory_code, warehouse_id, stocktook_at, last_move_at, updated_at)
       VALUES($1,$2,$3,$4,$5,1,NOW(),NOW(),NOW())
       ON CONFLICT (sku, warehouse_id) DO UPDATE SET
          product_id=EXCLUDED.product_id,
          unit=EXCLUDED.unit,
          current_stock=EXCLUDED.current_stock,
          factory_code=EXCLUDED.factory_code,
          stocktook_at=NOW(),
          last_move_at=NOW(),
          updated_at=NOW()`,
      [product.id, sku, product.unit || null, current, product.factory_code || null]
    );
    await client.query(
      `INSERT INTO inventory_logs(product_id, sku, type, quantity, unit, before_stock, after_stock, ref_type, ref_id, warehouse_id, factory_code, "operator", note)
       VALUES($1,$2,'adjust',$3,$4,$5,$6,'stocktake',$7,1,$8,$9,'工厂盘点')`,
      [product.id, sku, current - beforeStock, product.unit || null, beforeStock, current, refId, product.factory_code || null, op]
    );
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  try {
    await writeAudit(pool, req, {
      action: "stocktake.count",
      entity_type: "sku",
      entity_id: sku,
      before: { 成品库存: beforeStock },
      after: { 成品库存: current },
      note: "工厂盘点",
    });
  } catch (_) { /* 审计尽力而为 */ }
  return json(res, 200, { success: true, sku });
}

async function reset(req, res, pool, r, scopeCodes) {
  const vals = [];
  const scope = scopeSql(req, r, scopeCodes, vals, isInternal(r));
  const q = await pool.query(
    `UPDATE finished_goods_inventory f
        SET stocktook_at=NULL, updated_at=NOW()
       WHERE f.warehouse_id=1 AND f.sku IN (SELECT p.sku FROM products p WHERE ${scope})`,
    vals
  );
  return json(res, 200, { success: true, reset: q.rowCount });
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
    if (req.method === "GET") return json(res, 200, { success: true, role: r, ...(await listRows(pool, req, r, scopeCodes)) });
    const action = clean(req.query.action || req.body?.action, 40);
    if (req.method === "PATCH" && action === "count") return await count(req, res, pool, r, scopeCodes);
    if (req.method === "PATCH" && action === "reset") return await reset(req, res, pool, r, scopeCodes);
    return json(res, 405, { success: false, error: "Method/action not allowed" });
  } catch (e) {
    const code = /required|invalid/.test(e.message) ? 400 : (/scope|forbidden/.test(e.message) ? 403 : 500);
    if (code === 500) { console.error("[stocktake]", e); return json(res, 500, { success: false, error: "Internal Server Error" }); }
    return json(res, code, { success: false, error: e.message });
  }
}
