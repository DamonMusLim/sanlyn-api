// /api/db/inbound-collab.js - 三角色来料协同
import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";

const STATUS = new Set(["ordered", "shipped", "arrived", "cancelled"]);
const PROCURED = new Set(["sanlyn", "factory", "customer"]);
const ATTACH = new Set(["image", "artwork", "receipt"]);
const ROLES = new Set(["sanlyn", "supplier", "factory", "customer", "admin"]);
const SOURCE_FIELDS = ["order_qty", "expected_delivery", "supplier_note"];
const FACTORY_FIELDS = ["real_qty", "confirmed_delivery", "delivery_driver", "vehicle_plate", "express_no", "delivery_address", "status", "factory_note"];
const CUSTOMER_FIELDS = ["customer_note"];

const FACTORY_MATERIAL_SCOPE = `
EXISTS (
  SELECT 1 FROM jsonb_array_elements_text(pm.product_skus) ps
  JOIN products p ON p.sku = ps
  WHERE p.factory_code = $1
)`;

function json(res, status, payload) { return res.status(status).json(payload); }
function clean(v, n = 500) { return String(v == null ? "" : v).trim().slice(0, n); }
function cleanDate(v) { const s = clean(v, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; }
function cleanId(v) { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new Error("id required"); return n; }
function cleanQty(v, label = "qty", required = false) {
  if (v === undefined || v === null || v === "") { if (required) throw new Error(label + " required"); return null; }
  const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(label + " invalid"); return n;
}
function cleanEnum(v, set, label) { const s = clean(v, 30); if (!set.has(s)) throw new Error("invalid " + label); return s; }
function cleanUrl(v) { const s = clean(v, 1000); if (s && !/^https?:\/\//i.test(s)) throw new Error("invalid url"); return s; }
function actor(req) { const u = req.user || {}; return clean(u.username || u.email || u.sub || "inbound", 120); }
function codes(req) {
  const u = req.user || {};
  const raw = Array.isArray(u.companyCodes) && u.companyCodes.length ? u.companyCodes : (u.companyCode || u.company_code ? [u.companyCode || u.company_code] : []);
  return raw.map(x => clean(x, 80)).filter(Boolean);
}
function role(req) {
  const r = clean(req.user?.role || "", 40).toLowerCase();
  return ROLES.has(r) ? r : null;
}
function isInternal(r) { return r === "sanlyn" || r === "admin"; }
function writableFields(r, row) {
  if (isInternal(r)) return [...SOURCE_FIELDS, ...FACTORY_FIELDS, ...CUSTOMER_FIELDS, "procured_by", "customer_code", "note"];
  if (r === "supplier") return SOURCE_FIELDS;
  if (r === "factory") return FACTORY_FIELDS;
  return row?.procured_by === "customer" ? ["order_qty", "expected_delivery", ...CUSTOMER_FIELDS] : CUSTOMER_FIELDS;
}
function scopeWhere(r, idx) {
  if (isInternal(r)) return { sql: "true", vals: [] };
  if (r === "supplier") return { sql: `d.supplier_code = ANY($${idx}::text[])`, vals: null };
  if (r === "customer") return { sql: `d.customer_code = ANY($${idx}::text[])`, vals: null };
  return { sql: `d.factory_code = ANY($${idx}::text[])`, vals: null };
}
function publicRow(row, r) {
  const diff = row.real_qty == null || row.order_qty == null ? null : Number(row.real_qty) - Number(row.order_qty);
  const diffPct = diff == null || Number(row.order_qty) === 0 ? null : diff / Number(row.order_qty) * 100;
  const brand = row.brand || "未分组";
  if (r === "customer") {
    const out = {
      id: row.id, material_sku: row.material_sku, material_name: row.material_name,
      brand, spec: row.spec, dimensions: row.dimensions, image_url: row.image_url, status: row.status,
      expected_delivery: row.expected_delivery, confirmed_delivery: row.confirmed_delivery,
      customer_note: row.customer_note,
    };
    if (row.procured_by === "customer") {
      out.order_qty = row.order_qty;
      out.artwork_url = row.artwork_url;
      out.attachments = (row.attachments || []).filter(a => a.type === "image" || a.type === "artwork");
    }
    return out;
  }
  const base = {
    id: row.id, supplier_code: row.supplier_code, factory_code: row.factory_code, customer_code: row.customer_code,
    brand, material_sku: row.material_sku, material_name: row.material_name, image_url: row.image_url, artwork_url: row.artwork_url,
    dimensions: row.dimensions, spec: row.spec, current_stock: row.current_stock, procured_by: row.procured_by,
    order_qty: row.order_qty, real_qty: row.real_qty, diff, diff_pct: diffPct,
    expected_delivery: row.expected_delivery, confirmed_delivery: row.confirmed_delivery,
    delivery_driver: row.delivery_driver, vehicle_plate: row.vehicle_plate, express_no: row.express_no,
    delivery_address: row.delivery_address, status: row.status, note: row.note,
    supplier_note: row.supplier_note, factory_note: row.factory_note, customer_note: row.customer_note,
    last_order_at: row.last_order_at, last_order_qty: row.last_order_qty, attachments: row.attachments || [],
  };
  return base;
}

async function listDeliveries(pool, r, scopeCodes) {
  const vals = [];
  const sc = scopeWhere(r, 1);
  if (sc.vals === null) vals.push(scopeCodes);
  // TODO: MVP 先只按产品品牌分组展示；后续可复用 customer_brand_routes(customer_code+brand+factory_code+status) 做品牌授权过滤。
  const q = `
    SELECT d.*, pm.name AS material_name, pm.image_url, pm.artwork_url, pm.dimensions, pm.spec, pm.current_stock,
           COALESCE(NULLIF(bp.brand, ''), '未分组') AS brand,
           last.created_at AS last_order_at, last.order_qty AS last_order_qty,
           COALESCE(att.items, '[]'::json) AS attachments
      FROM inbound_deliveries d
 LEFT JOIN packaging_materials pm ON pm.sku_code = d.material_sku
 LEFT JOIN products bp ON bp.sku = (pm.product_skus->>0)
 LEFT JOIN LATERAL (
       SELECT x.created_at, x.order_qty FROM inbound_deliveries x
        WHERE x.material_sku = d.material_sku AND x.factory_code = d.factory_code AND x.id <> d.id
          AND (x.created_at, x.id) < (d.created_at, d.id)
        ORDER BY x.created_at DESC, x.id DESC LIMIT 1) last ON true
 LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object('id', a.id, 'type', a.attachment_type, 'url', a.url, 'created_at', a.created_at)
              ORDER BY a.created_at DESC) AS items
         FROM inbound_delivery_attachments a WHERE a.delivery_id = d.id) att ON true
     WHERE ${sc.sql}
  ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC, d.id DESC`;
  const rds = await pool.query(q, vals);
  return rds.rows.map(row => publicRow(row, r));
}

async function listMaterials(pool, r, scopeCodes) {
  if (r !== "factory" && !isInternal(r)) return [];
  const params = r === "factory" ? [scopeCodes[0]] : [];
  const where = r === "factory" ? `WHERE ${FACTORY_MATERIAL_SCOPE}` : "";
  const q = `SELECT pm.sku_code AS material_sku, pm.name AS material_name, pm.image_url, pm.artwork_url,
                    pm.dimensions, pm.spec, pm.current_stock
               FROM packaging_materials pm ${where}
           ORDER BY pm.name NULLS LAST, pm.sku_code LIMIT 500`;
  return (await pool.query(q, params)).rows;
}

async function createOrder(req, res, pool, r, scopeCodes) {
  if (!isInternal(r) && r !== "factory") return json(res, 403, { success: false, error: "order forbidden" });
  const b = req.body || {};
  const factoryCode = clean(b.factory_code || scopeCodes[0], 80);
  const supplierCode = clean(b.supplier_code, 80);
  const customerCode = clean(b.customer_code, 80) || null;
  const materialSku = clean(b.material_sku || b.sku_code, 80);
  const procuredBy = b.procured_by === undefined ? "sanlyn" : cleanEnum(b.procured_by, PROCURED, "procured_by");
  if (!supplierCode || !factoryCode || !materialSku) return json(res, 400, { success: false, error: "supplier_code, factory_code and material_sku required" });
  if (procuredBy === "customer" && !customerCode) return json(res, 400, { success: false, error: "customer_code required for customer-procured inbound" });
  if (!isInternal(r) && !scopeCodes.includes(factoryCode)) return json(res, 403, { success: false, error: "factory_code out of scope" });

  const orderQty = cleanQty(b.order_qty, "order_qty", true);
  // TODO: 一票多单分摊：后续在下单入口关联同一采购票据并分摊数量/费用。
  const mat = await pool.query(`SELECT pm.sku_code, pm.name, pm.image_url, pm.artwork_url, pm.dimensions, pm.spec, pm.current_stock
                                  FROM packaging_materials pm WHERE pm.sku_code = $1 LIMIT 1`, [materialSku]);
  if (!mat.rows.length) return json(res, 404, { success: false, error: "material not found" });
  const ins = await pool.query(
    `INSERT INTO inbound_deliveries
       (supplier_code,factory_code,customer_code,material_sku,procured_by,order_qty,expected_delivery,delivery_address,note,supplier_note,customer_note,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [supplierCode, factoryCode, customerCode, materialSku, procuredBy, orderQty,
     cleanDate(b.expected_delivery), clean(b.delivery_address, 1000) || null, clean(b.note, 500) || null,
     clean(b.supplier_note, 1000) || null, clean(b.customer_note, 1000) || null, actor(req)]
  );
  return json(res, 201, { success: true, data: publicRow({ ...ins.rows[0], material_name: mat.rows[0].name, ...mat.rows[0], attachments: [] }, r) });
}

async function loadScoped(pool, id, r, scopeCodes) {
  const sc = scopeWhere(r, 2);
  const vals = sc.vals === null ? [id, scopeCodes] : [id];
  const row = await pool.query(`SELECT * FROM inbound_deliveries d WHERE d.id = $1 AND ${sc.sql} LIMIT 1`, vals);
  return row.rows[0] || null;
}

async function updateDelivery(req, res, pool, r, scopeCodes) {
  const b = req.body || {};
  const row = await loadScoped(pool, cleanId(b.id), r, scopeCodes);
  if (!row) return json(res, 404, { success: false, error: "delivery not found in scope" });
  const allowed = writableFields(r, row), sets = ["updated_at = NOW()"], vals = [];
  for (const f of allowed) {
    if (b[f] === undefined) continue;
    let v = b[f];
    if (f === "order_qty" || f === "real_qty") v = cleanQty(v, f);
    else if (f.endsWith("_delivery")) v = cleanDate(v);
    else if (f === "status") v = cleanEnum(v, STATUS, "status");
    else if (f === "procured_by") v = cleanEnum(v, PROCURED, "procured_by");
    else v = clean(v, f.endsWith("_note") || f === "delivery_address" || f === "note" ? 1000 : 200) || null;
    vals.push(v); sets.push(`${f} = $${vals.length}`);
  }
  // TODO: real_qty 审计日志：记录每次实收数量修改的操作者、旧值、新值和时间。
  // TODO: 差异超阈值待审状态：当 real_qty 与 order_qty 偏差超过配置阈值时进入待审流程。
  if (sets.length === 1) return json(res, 400, { success: false, error: "no permitted fields to update" });
  vals.push(row.id);
  const out = await pool.query(`UPDATE inbound_deliveries SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING id`, vals);
  return json(res, 200, { success: true, data: out.rows[0] });
}

async function upload(req, res, pool, r, scopeCodes) {
  const b = req.body || {};
  const type = cleanEnum(b.attachment_type || b.type || "image", ATTACH, "attachment_type");
  const url = cleanUrl(b.url || b.image_url || b.artwork_url);
  const hasDimensions = b.dimensions !== undefined;
  if (b.id || b.delivery_id) {
    const row = await loadScoped(pool, cleanId(b.id || b.delivery_id), r, scopeCodes);
    if (!row) return json(res, 404, { success: false, error: "delivery not found in scope" });
    if (hasDimensions && !isInternal(r)) return json(res, 403, { success: false, error: "dimensions upload forbidden" });
    if (!url && type !== "receipt" && hasDimensions) {
      return json(res, 200, { success: true, data: await updateMaterial(pool, row.material_sku, type, null, b.dimensions) });
    }
    if (!url) return json(res, 400, { success: false, error: "url required" });
    // TODO: 附件对象存储签名上传：由后端签发临时上传凭证，避免前端直传任意 URL。
    const a = await pool.query(
      `INSERT INTO inbound_delivery_attachments(delivery_id, attachment_type, url, uploaded_by) VALUES($1,$2,$3,$4) RETURNING *`,
      [row.id, type, url, actor(req)]
    );
    if (type !== "receipt" && isInternal(r)) await updateMaterial(pool, row.material_sku, type, url, b.dimensions);
    return json(res, 200, { success: true, data: a.rows[0] });
  }
  const sku = clean(b.material_sku || b.sku_code, 80);
  if (!url) return json(res, 400, { success: false, error: "url required" });
  if (!sku || type === "receipt") return json(res, 400, { success: false, error: "material_sku required" });
  if (!isInternal(r)) return json(res, 403, { success: false, error: "delivery_id required for partner source upload" });
  const data = await updateMaterial(pool, sku, type, url, b.dimensions);
  return json(res, 200, { success: true, data });
}
async function updateMaterial(pool, sku, type, url, dimensions) {
  const field = type === "artwork" ? "artwork_url" : "image_url";
  url = cleanUrl(url);
  const vals = [sku], sets = [];
  if (url) { vals.push(url); sets.push(`${field} = $${vals.length}`); }
  if (dimensions !== undefined) { vals.push(clean(dimensions, 200) || null); sets.push(`dimensions = $${vals.length}`); }
  if (!sets.length) throw new Error("url or dimensions required");
  const m = await pool.query(`UPDATE packaging_materials SET ${sets.join(", ")} WHERE sku_code = $1 RETURNING sku_code AS material_sku, image_url, artwork_url, dimensions`, vals);
  if (!m.rows.length) throw new Error("material not found");
  return m.rows[0];
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) extractUser(req);
  if (!req.user) return json(res, 401, { success: false, error: "Unauthorized" });
  const r = role(req);
  if (!r) return json(res, 403, { success: false, error: "role forbidden" });
  const scopeCodes = codes(req);
  if (!scopeCodes.length) return json(res, 403, { success: false, error: "company_code scope missing" });
  const pool = getPool(), action = clean(req.query.action || req.body?.action, 40);
  try {
    if (req.method === "GET") return json(res, 200, { success: true, role: r, data: await listDeliveries(pool, r, scopeCodes), materials: await listMaterials(pool, r, scopeCodes) });
    if (req.method === "POST" && action === "order") return createOrder(req, res, pool, r, scopeCodes);
    if (req.method === "POST" && (action === "upload" || action === "upload-image")) return upload(req, res, pool, r, scopeCodes);
    if (req.method === "PATCH" && action === "update") return updateDelivery(req, res, pool, r, scopeCodes);
    return json(res, 405, { success: false, error: "Method/action not allowed" });
  } catch (e) {
    const code = /required|invalid/.test(e.message) ? 400 : (/scope|forbidden/.test(e.message) ? 403 : 500);
    return json(res, code, { success: false, error: e.message });
  }
}
