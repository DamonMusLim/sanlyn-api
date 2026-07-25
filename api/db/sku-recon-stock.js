// /api/db/sku-recon-stock.js - SKU recon stock visibility, owner stock and prefs
const INTERNAL_TYPES = new Set(["sanlyn", "admin", "trader"]);
function clean(v, n = 120) { return String(v == null ? "" : v).trim().slice(0, n); }
function dstr(v) { if (!v) return ""; if (v instanceof Date) return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0"); return String(v).slice(0, 10); }
function n(v) { return v == null ? null : Number(v); }
function roleLabel(v) { return ({ customer: "客户", factory: "工厂", supplier: "供应商", trader: "贸易公司", sanlyn: "内部", admin: "内部" })[String(v || "").toLowerCase()] || ""; }
function statusOf(row) {
  const fstock = Number(row.finished_stock || 0), fsafety = Number(row.finished_safety_stock || 0);
  if (fsafety <= 0) return "no_line";
  return fstock < fsafety ? "restock_needed" : "ok";
}
function bagStatusOf(row) {
  const stock = Number(row.bag_stock || 0), safety = Number(row.bag_safety_stock || 0);
  if (safety <= 0) return "no_line";
  return stock < safety ? "restock_needed" : "ok";
}
export function isInternal(r) { return INTERNAL_TYPES.has(r); }
export function visibleOwnerFilter(role, scopeCodes, opts = {}) {
  const p = opts.alias ? opts.alias + "." : "";
  const ownerType = opts.ownerTypeField || `${p}owner_type`;
  const ownerCode = opts.ownerCodeField || `${p}owner_code`;
  const payerType = opts.payerTypeField || `${p}payer_type`;
  const payerCode = opts.payerCodeField || `${p}payer_code`;
  const factoryCode = opts.factoryCodeField || `${p}factory_code`;
  if (isInternal(role)) return { sql: "TRUE", vals: [] };
  if (!Array.isArray(scopeCodes) || !scopeCodes.length) return { sql: "FALSE", vals: [] };
  if (role === "customer" && opts.participant) return {
    sql: `((${payerType}='CUSTOMER' AND ${payerCode}=ANY($1::text[])) OR (${ownerType}='CUSTOMER' AND ${ownerCode}=ANY($1::text[])))`,
    vals: [scopeCodes]
  };
  if (role === "customer") return { sql: `${ownerType}='CUSTOMER' AND ${ownerCode}=ANY($1::text[])`, vals: [scopeCodes] };
  if (role === "factory" && opts.factoryScope) return { sql: `${factoryCode}=ANY($1::text[])`, vals: [scopeCodes] };
  if (role === "factory") return { sql: `${ownerType}='FACTORY' AND ${ownerCode}=ANY($1::text[])`, vals: [scopeCodes] };
  return { sql: "FALSE", vals: [] };
}
function productScopeWhere(r, scopeCodes, alias, vals) {
  const p = alias ? alias + "." : "";
  if (r === "factory") {
    vals.push(scopeCodes);
    return ` AND ${p}factory_code = ANY($${vals.length}::text[])`;
  }
  if (r === "customer") {
    vals.push(scopeCodes);
    return ` AND EXISTS (
      SELECT 1 FROM customer_brand_routes cbr
       WHERE cbr.brand = ${p}brand
         AND cbr.factory_code = ${p}factory_code
         AND cbr.status = 'active'
         AND cbr.customer_code = ANY($${vals.length}::text[]))`;
  }
  if (r === "supplier") {
    vals.push(scopeCodes);
    return ` AND EXISTS (
      SELECT 1 FROM packaging_materials m
       WHERE m.product_skus @> jsonb_build_array(${p}sku)
         AND m.supplier_code = ANY($${vals.length}::text[]))`;
  }
  return "";
}
function materialScopeWhere(r, scopeCodes, alias, vals) {
  const p = alias ? alias + "." : "";
  if (r === "supplier") { vals.push(scopeCodes); return ` AND ${p}supplier_code = ANY($${vals.length}::text[])`; }
  return "";
}
// 协同表口径(2026-07-20 Damon定):库存对所有角色都看全量,不按付款方/货主过滤。
// 客户的隔离由「品牌授权路由(customer_brand_routes)」保证——只看自己品牌的款,但那些款的库存看全部。
// 货主/付款方仅用于记账与采购(历史购买仍按"有参与才可见"过滤,见 listPurchases)。
function ownerStockSql(r, scopeCodes) {
  return "m.current_stock";
}
export function publicRow(row, r) {
  const diff = row.real_qty == null && Number(row.order_qty || 0) ? null : Number(row.real_qty || 0) - Number(row.order_qty || 0);
  const finished_stock = Number(row.finished_stock || 0);
  const finished_safety_stock = Number(row.finished_safety_stock || 0);
  const restock_gap = Math.max(0, finished_safety_stock - finished_stock);
  const common = {
    sku: row.sku, barcode: row.barcode || "", product_name: row.product_name || row.product_name_cn || "",
    product_name_cn: (row.product_name_cn && row.product_name_cn !== row.product_name) ? row.product_name_cn : "",
    brand: row.brand || "未分组", size: row.size || row.spec || "", image_url: row.image_url || "",
    finished_stock, finished_safety_stock, restock_gap, restock_decision: row.restock_decision || "",
    restock_decision_by: row.restock_decision_by || "", restock_decision_at: dstr(row.restock_decision_at),
    restock_requested_at: dstr(row.restock_requested_at), restock_requested_by: row.restock_requested_by || "",
    bag_count: Number(row.bag_count || 0), status: statusOf(row),
  };
  if (r === "supplier") return {
    sku: row.sku, barcode: row.barcode || "", product_name: row.product_name || row.product_name_cn || "",
    product_name_cn: (row.product_name_cn && row.product_name_cn !== row.product_name) ? row.product_name_cn : "",
    brand: row.brand || "未分组", size: row.size || row.spec || "", image_url: row.image_url || "",
    bag_count: Number(row.bag_count || 0), bag_stock: Number(row.bag_stock || 0),
    bag_safety_stock: Number(row.bag_safety_stock || 0), bag_unit: row.bag_unit || "",
    container_capacity: row.container_capacity == null ? null : Number(row.container_capacity),
    status: bagStatusOf(row), bag_moq: Number(row.bag_moq || 0),
    restock_requested_at: dstr(row.restock_requested_at),
    restock_requested_by_role: roleLabel(String(row.restock_requested_by || "").match(/\(([^)]+)\)$/)?.[1]),
  };
  if (r === "customer") return {
    sku: row.sku, barcode: row.barcode || "", product_name: row.product_name || row.product_name_cn || "",
    product_name_cn: (row.product_name_cn && row.product_name_cn !== row.product_name) ? row.product_name_cn : "",
    brand: row.brand || "未分组", size: row.size || row.spec || "", image_url: row.image_url || "",
    bag_count: Number(row.bag_count || 0), bag_stock: Number(row.bag_stock || 0),
    bag_safety_stock: Number(row.bag_safety_stock || 0), bag_unit: row.bag_unit || "",
    container_capacity: row.container_capacity == null ? null : Number(row.container_capacity),
    status: bagStatusOf(row), restock_requested_at: dstr(row.restock_requested_at),
    restock_requested_by: row.restock_requested_by || "",
  };
  common.last_order_date = dstr(row.last_order_at);
  common.last_delivery = dstr(row.last_delivery);
  common.last_order_qty = n(row.last_units);
  if (isInternal(r)) common.last_order_no = row.last_order_no || "";
  if (isInternal(r)) common.skip_bag_stock = !!row.skip_bag_stock;
  if (!(r === "factory" || isInternal(r))) return common;
  return {
    ...common, supplier_name: row.supplier_name || "沧州冀凯塑料包装有限公司",
    container_capacity: row.container_capacity == null ? null : Number(row.container_capacity),
    bag_moq: Number(row.bag_moq || 0), bag_stock: Number(row.bag_stock || 0),
    bag_safety_stock: Number(row.bag_safety_stock || 0), bag_unit: row.bag_unit || "",
    order_qty: row.order_qty == null ? null : Number(row.order_qty), real_qty: row.real_qty == null ? null : Number(row.real_qty),
    diff, inbound_id: row.inbound_id || null, latest_inbound_at: row.latest_inbound_at || null,
  };
}
export function groupRows(rows) {
  const map = new Map();
  for (const row of rows) {
    const brand = row.brand || "未分组";
    if (!map.has(brand)) map.set(brand, { brand, sku_count: 0, bag_count: 0, rows: [] });
    const g = map.get(brand);
    g.rows.push(row); g.sku_count += 1; g.bag_count += Number(row.bag_count || 0);
  }
  return [...map.values()];
}
export async function listRows(pool, r, scopeCodes, req) {
  const vals = [];
  let where = "p.sku IS NOT NULL AND COALESCE(p.active, true)";
  where += productScopeWhere(r, scopeCodes, "p", vals);
  if (isInternal(r)) {
    const fc = clean(req.query.factory_code || "", 80);
    if (fc) { vals.push(fc); where += ` AND p.factory_code = $${vals.length}`; }
  }
  const scope = clean(req.query.scope || "", 20);
  const showAll = scope === "all" && (isInternal(r) || r === "factory");
  const canSeeSkip = scope === "all" && isInternal(r);
  if (!canSeeSkip) where += " AND COALESCE(p.skip_bag_stock, false) = false";
  // 袋子过滤只对内部/贸易公司生效:它才有 1878 个无袋子 SKU 的噪音。
  // 工厂/供应商/客户的作用域本就只有几十行,过滤会误伤(如恒安 AMD 4 款袋子数为 0)。
  if (isInternal(r) && !showAll) where += ` AND EXISTS (
      SELECT 1 FROM packaging_materials mf
       WHERE mf.product_skus @> jsonb_build_array(p.sku)${materialScopeWhere(r, scopeCodes, "mf", vals)})`;
  const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
  const pageSize = Math.min(500, Math.max(1, parseInt(req.query.page_size || "100", 10) || 100));
  const offset = (page - 1) * pageSize;
  const count = await pool.query(`SELECT COUNT(*)::int AS total FROM products p WHERE ${where}`, vals);
  vals.push(pageSize, offset);
  const limitParam = vals.length - 1, offsetParam = vals.length;
  const q = `
    SELECT p.sku, p.product_name, p.product_name_cn, p.brand, p.barcode, p.size, p.spec, p.image_url AS product_image_url,
           COALESCE(p.skip_bag_stock, false) AS skip_bag_stock,
           COALESCE(fg.current_stock, 0) AS finished_stock, COALESCE(fg.safety_stock, 0) AS finished_safety_stock,
           fg.restock_decision, fg.restock_decision_by, fg.restock_decision_at, fg.container_capacity, fg.supplier_name,
           COALESCE(pm.bag_stock, 0) AS bag_stock, COALESCE(pm.bag_safety_stock, 0) AS bag_safety_stock,
           COALESCE(pm.bag_count, 0) AS bag_count, COALESCE(pm.bag_moq, 0) AS bag_moq, COALESCE(pm.bag_unit, '') AS bag_unit,
           COALESCE(fg.image_url, pm.image_url, p.image_url) AS image_url, pm.restock_requested_at, pm.restock_requested_by,
           ib.inbound_id, ib.latest_inbound_at, ib.order_qty, ib.real_qty,
           lo.last_order_no, lo.last_order_at, lo.last_delivery, lo.last_units
      FROM (
       SELECT * FROM products p WHERE ${where}
        ORDER BY COALESCE(NULLIF(p.brand, ''), '未分组'), p.sku
        LIMIT $${limitParam} OFFSET $${offsetParam}) p
 LEFT JOIN LATERAL (
       SELECT SUM(f.current_stock) AS current_stock, SUM(f.safety_stock) AS safety_stock,
              MAX(f.restock_decision) AS restock_decision, MAX(f.restock_decision_at) AS restock_decision_at,
              MAX(f.restock_decision_by) AS restock_decision_by, MAX(f.container_capacity) AS container_capacity,
              MAX(NULLIF(f.supplier_name, '')) AS supplier_name, MAX(NULLIF(f.image_url, '')) AS image_url
         FROM finished_goods_inventory f WHERE f.sku = p.sku) fg ON true
 LEFT JOIN LATERAL (
       SELECT SUM(${ownerStockSql(r, scopeCodes)}) AS bag_stock, SUM(m.safety_stock) AS bag_safety_stock,
              COUNT(DISTINCT m.id) AS bag_count, MAX(NULLIF(m.image_url, '')) AS image_url, MAX(NULLIF(m.unit, '')) AS bag_unit,
              MAX(m.restock_requested_at) AS restock_requested_at, MAX(NULLIF(m.restock_requested_by, '')) AS restock_requested_by, MAX(m.moq) AS bag_moq
         FROM packaging_materials m
        WHERE m.product_skus @> jsonb_build_array(p.sku)${materialScopeWhere(r, scopeCodes, "m", vals)}) pm ON true
 LEFT JOIN LATERAL (
       SELECT (array_agg(d.id ORDER BY d.updated_at DESC NULLS LAST, d.created_at DESC, d.id DESC))[1] AS inbound_id,
              MAX(d.updated_at) AS latest_inbound_at, SUM(d.order_qty) AS order_qty,
              SUM(d.real_qty) FILTER (WHERE d.real_qty IS NOT NULL) AS real_qty
         FROM inbound_deliveries d JOIN packaging_materials m ON m.sku_code = d.material_sku
        WHERE m.product_skus @> jsonb_build_array(p.sku)
          AND (p.factory_code IS NULL OR d.factory_code = p.factory_code)) ib ON true
 LEFT JOIN LATERAL (
       SELECT o.order_no AS last_order_no, o.created_at AS last_order_at, o.delivery_date AS last_delivery,
              SUM(li.qty_ctn * COALESCE(NULLIF(li.bg_bx, 0), 1)) AS last_units
         FROM order_line_items li JOIN orders o ON o.id = li.order_id
        WHERE li.sku = p.sku ${r === "customer" ? "AND o.company_code = ANY($1::text[])" : ""}
        GROUP BY o.id, o.order_no, o.created_at, o.delivery_date ORDER BY o.created_at DESC LIMIT 1) lo ON true
  ORDER BY COALESCE(NULLIF(p.brand, ''), '未分组'), p.sku`;
  const rows = (await pool.query(q, vals)).rows.map(row => publicRow(row, r));
  return { rows, groups: groupRows(rows), total: count.rows[0]?.total || 0, page, page_size: pageSize };
}
export const PO_STATUSES = ["draft", "sent", "supplier_filled", "confirmed", "shipped", "received"];
export function normalizePoStatus(v) {
  const s = clean(v, 40).toLowerCase();
  if (s === "ordered") return "draft";
  return PO_STATUSES.includes(s) ? s : "draft";
}
export function publicPurchaseRow(row, r, scopeCodes) {
  const ownPayer = row.payer_type === "CUSTOMER" && scopeCodes.includes(row.payer_code || "");
  const ownOwner = row.owner_type === "CUSTOMER" && scopeCodes.includes(row.owner_code || "");
  const out = {
    id: row.id, material_sku: row.material_sku || "", material_name: row.material_name || "",
    order_qty: n(row.order_qty), real_qty: n(row.real_qty), status: normalizePoStatus(row.status),
    created_at: row.created_at || "", updated_at: row.updated_at || "",
    payer_type: row.payer_type || "", payer_code: row.payer_code || "",
    owner_type: row.owner_type || "", owner_code: row.owner_code || "",
  };
  if (r === "customer") {
    out.payer_type = ownPayer ? row.payer_type : "";
    out.payer_code = ownPayer ? row.payer_code : "";
    out.owner_type = ownOwner ? row.owner_type : "";
    out.owner_code = ownOwner ? row.owner_code : "";
  }
  return out;
}
export async function listPurchases(pool, r, scopeCodes) {
  const f = visibleOwnerFilter(r, scopeCodes, { alias: "d", participant: r === "customer", factoryScope: r === "factory" });
  const q = `SELECT d.id, d.material_sku, COALESCE(pm.name,'') AS material_name,
                    d.order_qty, d.real_qty, d.status, d.created_at::text AS created_at,
                    d.updated_at::text AS updated_at, d.payer_type, d.payer_code, d.owner_type, d.owner_code
               FROM inbound_deliveries d
          LEFT JOIN packaging_materials pm ON pm.sku_code = d.material_sku
              WHERE ${f.sql}
           ORDER BY d.created_at DESC, d.id DESC LIMIT 300`;
  const rows = (await pool.query(q, f.vals)).rows.map(row => publicPurchaseRow(row, r, scopeCodes));
  return { purchases: rows };
}
export async function scopedPurchase(client, id, r, scopeCodes, lock = false) {
  const vals = [id];
  const f = visibleOwnerFilter(r, scopeCodes, { alias: "d", participant: r === "customer", factoryScope: r === "factory" });
  vals.push(...f.vals);
  const sql = f.sql.replace(/\$1::text\[\]/g, `$2::text[]`);
  const q = await client.query(`SELECT d.id, d.status, d.note FROM inbound_deliveries d WHERE d.id=$1 AND ${sql} LIMIT 1${lock ? " FOR UPDATE" : ""}`, vals);
  return q.rows[0] || null;
}
export async function scopedProduct(client, sku, r, scopeCodes, lock = false) {
  const vals = [sku];
  let where = "sku = $1" + productScopeWhere(r, scopeCodes, "products", vals);
  const q = `SELECT id, sku, unit, factory_code, brand, COALESCE(skip_bag_stock,false) AS skip_bag_stock FROM products WHERE ${where} LIMIT 1${lock ? " FOR UPDATE" : ""}`;
  const p = await client.query(q, vals);
  if (!p.rows.length) throw new Error("sku out of scope");
  return p.rows[0];
}
export async function bagMats(client, sku, r, scopeCodes) {
  await scopedProduct(client, sku, r, scopeCodes, true);
  const vals = [sku];
  const q = await client.query(`SELECT id,current_stock,safety_stock FROM packaging_materials WHERE product_skus @> jsonb_build_array($1::text)${materialScopeWhere(r, scopeCodes, "", vals)} FOR UPDATE`, vals);
  if (!q.rows.length) throw new Error("bag material required");
  return q.rows;
}
export async function getUserPref(pool, username, key) {
  const q = await pool.query(`SELECT pref_value FROM app_prefs WHERE scope='user' AND scope_key=$1 AND pref_key=$2 LIMIT 1`, [username, key]);
  return q.rows[0]?.pref_value || "";
}
export async function setUserPref(pool, username, key, val) {
  await pool.query(`INSERT INTO app_prefs(scope, scope_key, pref_key, pref_value)
    VALUES('user',$1,$2,$3)
    ON CONFLICT (scope, scope_key, pref_key) DO UPDATE SET pref_value=EXCLUDED.pref_value`,
    [username, clean(key, 80), clean(val, 240)]);
}
function parseParty(val) {
  const [type, ...rest] = clean(val, 240).split(":");
  const party = { payer_type: clean(type, 40).toUpperCase(), payer_code: clean(rest.join(":"), 80) };
  if (!party.payer_type || !party.payer_code) return null;
  return party;
}
export async function defaultPayer(pool, username, r, scopeCodes) {
  if (r === "customer") return { payer_type: "CUSTOMER", payer_code: scopeCodes[0] || "" };
  return parseParty(await getUserPref(pool, username, "default_payer")) || { payer_type: "INTERNAL", payer_code: "SANLYN" };
}
export async function resolvePayer(pool, username, r, scopeCodes, body) {
  if (r === "customer") return { payer_type: "CUSTOMER", payer_code: scopeCodes[0] || "" };
  const fallback = await defaultPayer(pool, username, r, scopeCodes);
  const party = clean(body?.payer_type, 40) && clean(body?.payer_code, 80)
    ? { payer_type: clean(body.payer_type, 40).toUpperCase(), payer_code: clean(body.payer_code, 80) }
    : fallback;
  if (!party.payer_type || !party.payer_code) throw new Error("payer invalid");
  return party;
}
export async function rememberPayer(pool, username, party) {
  await setUserPref(pool, username, "default_payer", `${party.payer_type}:${party.payer_code}`);
}
