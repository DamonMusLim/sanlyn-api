// /api/db/sku-recon.js - SKU库存对账表(工厂可填/客户只读脱敏)
import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";
import { writeAudit } from "./audit-helper.js";

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
function dstr(v) { if (!v) return ""; if (v instanceof Date) return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0"); return String(v).slice(0, 10); }
function n(v) { return v == null ? null : Number(v); }
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
  const finished_stock = Number(row.finished_stock || 0);
  const finished_safety_stock = Number(row.finished_safety_stock || 0);
  const restock_gap = Math.max(0, finished_safety_stock - finished_stock); // 补货缺口=安全值−库存
  // 客户只看: 品牌/产品/库存/安全值/补货/状态 —— 供应商/柜容量/袋子/实收/下单/差异一律不下发
  const common = {
    sku: row.sku,
    product_name: row.product_name_cn || row.product_name || "",
    brand: row.brand || "未分组",
    size: row.size || row.spec || "",
    image_url: row.image_url || "",
    finished_stock,
    finished_safety_stock,
    restock_gap,
    bag_count: Number(row.bag_count || 0),
    status: statusOf(row),
    last_order_date: dstr(row.last_order_at),
    last_delivery: dstr(row.last_delivery),
    last_order_qty: n(row.last_units),
  };
  // 单号只给客户(自己的)和内部;工厂不下发(单号前缀含客户号,防跳单)
  if (r === "customer" || isInternal(r)) common.last_order_no = row.last_order_no || "";
  if (!(r === "factory" || isInternal(r))) return common;
  return {
    ...common,
    supplier_name: row.supplier_name || "沧州冀凯塑料包装有限公司",
    container_capacity: row.container_capacity == null ? null : Number(row.container_capacity),
    bag_stock: Number(row.bag_stock || 0),
    bag_safety_stock: Number(row.bag_safety_stock || 0),
    order_qty: row.order_qty == null ? null : Number(row.order_qty),
    real_qty: row.real_qty == null ? null : Number(row.real_qty),
    diff,
    inbound_id: row.inbound_id || null,
    latest_inbound_at: row.latest_inbound_at || null,
  };
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
           fg.container_capacity, fg.supplier_name,
           COALESCE(pm.bag_stock, 0) AS bag_stock,
           COALESCE(pm.bag_safety_stock, 0) AS bag_safety_stock,
           COALESCE(pm.bag_count, 0) AS bag_count,
           COALESCE(fg.image_url, pm.image_url, p.image_url) AS image_url,
           ib.inbound_id, ib.latest_inbound_at, ib.order_qty, ib.real_qty,
           lo.last_order_no, lo.last_order_at, lo.last_delivery, lo.last_units
      FROM products p
      ${routeJoin}
 LEFT JOIN LATERAL (
       SELECT SUM(f.current_stock) AS current_stock, SUM(f.safety_stock) AS safety_stock,
              MAX(f.container_capacity) AS container_capacity, MAX(NULLIF(f.supplier_name, '')) AS supplier_name,
              MAX(NULLIF(f.image_url, '')) AS image_url
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
 LEFT JOIN LATERAL (
       SELECT o.order_no AS last_order_no, o.created_at AS last_order_at, o.delivery_date AS last_delivery,
              SUM(li.qty_ctn * COALESCE(NULLIF(li.bg_bx, 0), 1)) AS last_units
         FROM order_line_items li
         JOIN orders o ON o.id = li.order_id
        WHERE li.sku = p.sku ${r === "customer" ? "AND o.company_code = ANY($1::text[])" : ""}
        GROUP BY o.id, o.order_no, o.created_at, o.delivery_date
        ORDER BY o.created_at DESC LIMIT 1) lo ON true
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
  const before = {}, after = {};
  const DEFAULT_SUP = "沧州冀凯塑料包装有限公司";

  const fgFields = ["finished_stock", "finished_safety_stock", "container_capacity", "supplier_name", "image_url"];
  if (fgFields.some(k => row[k] !== undefined)) {
    const wh = row.warehouse_id || 1;
    let fg = (await client.query(`SELECT * FROM finished_goods_inventory WHERE sku=$1 AND warehouse_id=$2 FOR UPDATE`, [sku, wh])).rows[0] || null;
    const cur = fg || { current_stock: 0, safety_stock: 0, container_capacity: null, supplier_name: null, image_url: null };
    // 先算真实变更(不建空行)
    const plan = [];
    if (row.finished_stock !== undefined) {
      const t = qty(row.finished_stock, "finished_stock") || 0, p = Number(cur.current_stock || 0);
      if (t !== p) plan.push({ f: "current_stock", label: "成品库存", prev: p, target: t, stock: true });
    }
    if (row.finished_safety_stock !== undefined) {
      const t = qty(row.finished_safety_stock, "finished_safety_stock") || 0, p = Number(cur.safety_stock || 0);
      if (t !== p) plan.push({ f: "safety_stock", label: "安全值", prev: p, target: t });
    }
    if (row.container_capacity !== undefined) {
      const t = qty(row.container_capacity, "container_capacity"), p = cur.container_capacity == null ? null : Number(cur.container_capacity);
      if (t !== p) plan.push({ f: "container_capacity", label: "柜容量", prev: p, target: t });
    }
    if (row.supplier_name !== undefined) {
      const t = clean(row.supplier_name, 120), p = cur.supplier_name || "";
      // 默认值(冀凯)自动回填不算修改,不写不审计; 只有改成别的供应商才记
      if (t !== p && !(t === DEFAULT_SUP && !p)) plan.push({ f: "supplier_name", label: "供应商", prev: p, target: t || null });
    }
    if (row.image_url !== undefined) {
      const t = clean(row.image_url, 500), p = cur.image_url || "";
      if (t !== p) plan.push({ f: "image_url", label: "图片", prev: p ? "有图" : "", target: t ? "已更新" : "已清空", dbVal: t || null });
    }
    if (plan.length) {
      if (!fg) {
        await client.query(`INSERT INTO finished_goods_inventory(product_id, sku, unit, current_stock, safety_stock, factory_code, warehouse_id)
           VALUES($1,$2,$3,0,0,$4,$5) ON CONFLICT (sku, warehouse_id) DO NOTHING`,
          [product.id, sku, product.unit || null, product.factory_code || null, wh]);
        fg = (await client.query(`SELECT * FROM finished_goods_inventory WHERE sku=$1 AND warehouse_id=$2 FOR UPDATE`, [sku, wh])).rows[0];
      }
      for (const c of plan) {
        const writeVal = ("dbVal" in c) ? c.dbVal : c.target;
        await client.query(`UPDATE finished_goods_inventory SET ${c.f}=$1, ${c.stock ? "last_move_at=NOW(), " : ""}updated_at=NOW() WHERE id=$2`, [writeVal, fg.id]);
        if (c.stock) {
          await client.query(`INSERT INTO inventory_logs(product_id, sku, type, quantity, unit, before_stock, after_stock, ref_type, ref_id, warehouse_id, factory_code, note, "operator")
             VALUES($1,$2,'adjust',$3,$4,$5,$6,'sku-recon',$7,$8,$9,$10,$11)`,
            [product.id, sku, c.target - c.prev, product.unit || null, c.prev, c.target, "sku-recon-" + Date.now(), fg.warehouse_id, product.factory_code || null, "SKU库存对账保存", actor(req)]);
        }
        before[c.label] = c.prev; after[c.label] = c.target;
      }
    }
  }
  if (row.real_qty !== undefined) {
    const real = qty(row.real_qty, "real_qty");
    const d = await client.query(
      `SELECT d.id, d.real_qty FROM inbound_deliveries d
        JOIN packaging_materials m ON m.sku_code = d.material_sku
       WHERE m.product_skus @> jsonb_build_array($1::text)
         AND ($2::text IS NULL OR d.factory_code = $2)
       ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC, d.id DESC LIMIT 1 FOR UPDATE`,
      [sku, product.factory_code || null]
    );
    if (d.rows.length) {
      const prev = d.rows[0].real_qty == null ? null : Number(d.rows[0].real_qty);
      if (prev !== real) {
        await client.query(`UPDATE inbound_deliveries SET real_qty=$1, updated_at=NOW() WHERE id=$2`, [real, d.rows[0].id]);
        before["实收"] = prev; after["实收"] = real;
      }
    }
  }
  return { sku, before, after, changed: Object.keys(after).length > 0 };
}

async function save(req, res, pool, r, scopeCodes) {
  if (r !== "factory" && !isInternal(r)) return json(res, 403, { success: false, error: "save forbidden" });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [req.body || {}];
  if (!rows.length) return json(res, 400, { success: false, error: "rows required" });
  const client = await pool.connect();
  let results = [];
  try {
    await client.query("BEGIN");
    for (const row of rows) results.push(await saveRow(client, req, r, scopeCodes, row));
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  // 提交后写「修改日记」到 audit_logs;审计失败不影响已保存的数据
  for (const c of results) {
    if (!c.changed) continue;
    try {
      await writeAudit(pool, req, { action: "sku-recon.edit", entity_type: "sku", entity_id: c.sku, before: c.before, after: c.after, note: "库存比对表编辑" });
    } catch (_) { /* 审计尽力而为 */ }
  }
  return json(res, 200, { success: true, saved: results.map(c => c.sku) });
}

async function history(pool, r, scopeCodes) {
  const vals = ["sku-recon.edit"];
  let where = "a.action = $1";
  if (!isInternal(r)) {
    vals.push(scopeCodes);
    where += ` AND EXISTS (SELECT 1 FROM products p WHERE p.sku = a.entity_id AND p.factory_code = ANY($${vals.length}::text[]))`;
  }
  const q = `SELECT a.entity_id AS sku, a.before, a.after, a.diff_summary, a.operator, a.created_at
               FROM audit_logs a WHERE ${where} ORDER BY a.created_at DESC LIMIT 200`;
  return { history: (await pool.query(q, vals)).rows };
}

async function placeOrder(req, res, pool, r, scopeCodes) {
  if (!(r === "factory" || isInternal(r))) return json(res, 403, { success: false, error: "order forbidden" });
  const sku = clean(req.body?.sku, 80);
  const q = Number(req.body?.qty);
  if (!sku) return json(res, 400, { success: false, error: "sku required" });
  if (!(q > 0)) return json(res, 400, { success: false, error: "qty invalid" });
  const pv = [sku]; let pw = "sku = $1";
  if (r === "factory") { pv.push(scopeCodes); pw += " AND factory_code = ANY($2::text[])"; }
  const p = await pool.query(`SELECT factory_code FROM products WHERE ${pw} LIMIT 1`, pv);
  if (!p.rows.length) return json(res, 403, { success: false, error: "sku out of scope" });
  const bag = await pool.query(`SELECT sku_code, supplier_code FROM packaging_materials WHERE product_skus @> jsonb_build_array($1::text) LIMIT 1`, [sku]);
  const material_sku = bag.rows[0]?.sku_code || sku;
  const supplier_code = bag.rows[0]?.supplier_code || "SUP-CZJK";
  await pool.query(
    `INSERT INTO inbound_deliveries(supplier_code, factory_code, material_sku, order_qty, status, procured_by, created_by, note)
     VALUES($1,$2,$3,$4,'ordered',$5,$6,$7)`,
    [supplier_code, p.rows[0].factory_code || "CL", material_sku, q, "sanlyn", actor(req), "库存比对表补货下单 " + sku]);
  return json(res, 200, { success: true });
}

async function restockAll(req, res, pool, r, scopeCodes) {
  if (!(r === "factory" || isInternal(r))) return json(res, 403, { success: false, error: "forbidden" });
  const vals = []; let scopeSql = "";
  if (r === "factory") { vals.push(scopeCodes); scopeSql = ` AND p.factory_code = ANY($${vals.length}::text[])`; }
  const q = await pool.query(`SELECT f.sku, (f.safety_stock - f.current_stock) AS gap, p.factory_code
      FROM finished_goods_inventory f JOIN products p ON p.sku = f.sku
     WHERE f.safety_stock > f.current_stock AND f.safety_stock > 0${scopeSql}`, vals);
  let n = 0;
  for (const row of q.rows) {
    const bag = await pool.query(`SELECT sku_code, supplier_code FROM packaging_materials WHERE product_skus @> jsonb_build_array($1::text) LIMIT 1`, [row.sku]);
    await pool.query(`INSERT INTO inbound_deliveries(supplier_code, factory_code, material_sku, order_qty, status, procured_by, created_by, note)
       VALUES($1,$2,$3,$4,'ordered',$5,$6,$7)`,
      [bag.rows[0]?.supplier_code || "SUP-CZJK", row.factory_code || "CL", bag.rows[0]?.sku_code || row.sku, Number(row.gap), "sanlyn", actor(req), "一键补货 " + row.sku]);
    n++;
  }
  return json(res, 200, { success: true, ordered: n });
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
    if (req.method === "GET" && clean(req.query.view || "", 40) === "history") return json(res, 200, { success: true, role: r, ...(await history(pool, r, scopeCodes)) });
    if (req.method === "GET") return json(res, 200, { success: true, role: r, can_edit: r === "factory" || isInternal(r), org_name: clean(req.user?.company || "", 120), ...(await listRows(pool, r, scopeCodes, req)) });
    if (req.method === "PATCH" && clean(req.query.action || req.body?.action, 40) === "save") return save(req, res, pool, r, scopeCodes);
    if (req.method === "PATCH" && clean(req.query.action || req.body?.action, 40) === "order") return placeOrder(req, res, pool, r, scopeCodes);
    if (req.method === "PATCH" && clean(req.query.action || req.body?.action, 40) === "restock-all") return restockAll(req, res, pool, r, scopeCodes);
    return json(res, 405, { success: false, error: "Method/action not allowed" });
  } catch (e) {
    const code = /required|invalid/.test(e.message) ? 400 : (/scope|forbidden/.test(e.message) ? 403 : 500);
    return json(res, code, { success: false, error: e.message });
  }
}
