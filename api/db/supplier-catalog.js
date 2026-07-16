// /api/db/supplier-catalog.js - 供应商款式报价填报
// 供应商填 材质/规格/图片/退版费/未含税价/开票点数; 含税价=未含税*(1+点数/100) 自动算. 供应商只看自己(supplier_code作用域).
import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";
import { writeAudit } from "./audit-helper.js";
import { getOSSClient } from "../oss-direct.js";

const ROLES = new Set(["supplier", "sanlyn", "admin"]);
function json(res, s, p) { return res.status(s).json(p); }
function clean(v, n = 200) { return String(v == null ? "" : v).trim().slice(0, n); }
function role(req) { const r = clean(req.user?.role || "", 40).toLowerCase(); return ROLES.has(r) ? r : null; }
function isInternal(r) { return r === "sanlyn" || r === "admin"; }
function codes(u) {
  const raw = Array.isArray(u.companyCodes) && u.companyCodes.length ? u.companyCodes : (u.companyCode ? [u.companyCode] : []);
  return raw.map(x => clean(x, 80)).filter(Boolean);
}
function num(v) { if (v === undefined || v === null || v === "") return null; const n = Number(v); return Number.isFinite(n) ? n : null; }

function dstr(v) { if (!v) return ""; return String(v).slice(0, 10); }
function n(v) { return v == null ? null : Number(v); }
function ossBucket() { return process.env.OSS_BUCKET || "sanlyn-files"; }
function ossRegion() { return process.env.OSS_REGION || "oss-cn-hongkong"; }
function ossPublicUrl(key) { return `https://${ossBucket()}.${ossRegion()}.aliyuncs.com/${key}`; }
function cleanFilename(v) {
  const base = String(v || "plate-file").split(/[\\/]/).pop() || "plate-file";
  return base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 160) || "plate-file";
}
function cleanContentType(v) {
  const s = clean(v || "application/octet-stream", 120);
  return /^[\w.+-]+\/[\w.+-]+$/.test(s) ? s : "application/octet-stream";
}
function pubRow(r) {
  const ex = n(r.price_ex_tax);
  const pt = n(r.tax_point);
  const inc = ex == null ? null : Math.round(ex * (1 + (pt || 0) / 100) * 10000) / 10000;
  const cum = Number(r.cumulative_qty || 0);
  const thr = n(r.plate_fee_refund_qty);
  const refunded = thr != null && thr > 0 && cum >= thr;
  return {
    sku_code: r.sku_code, name: r.name || "", brand: r.brand || "",
    barcode: r.barcode || "", supplier_item_code: r.supplier_item_code || "",
    material: r.material || "", spec: r.spec || "", unit: r.unit || "",
    image_url: r.image_url || "", plate_image_url: r.plate_image_url || "",
    plate_status: r.plate_status || "", plate_uploaded_at: r.plate_uploaded_at || "",
    plate_nas_location: r.plate_nas_location || "", plate_archived_at: r.plate_archived_at || "",
    moq: n(r.moq), lead_time_days: n(r.lead_time_days),
    price_ex_tax: ex, tax_point: pt, price_inc_tax: inc,
    plate_fee: n(r.plate_fee), plate_fee_refund_qty: thr, cumulative_qty: cum, plate_fee_refunded: refunded,
    quote_date: dstr(r.quote_date), quote_valid_until: dstr(r.quote_valid_until),
    status: r.status || "active", notes: r.notes || "",
    flavors: Array.isArray(r.flavors) ? r.flavors : [],
  };
}

async function listRows(pool, r, scope, req) {
  const vals = [];
  let where = "1=1";
  let billCode = "";
  if (!isInternal(r)) { vals.push(scope); where += ` AND supplier_code = ANY($${vals.length}::text[])`; billCode = scope[0] || ""; }
  else { const sc = clean(req.query.supplier_code || ""); if (sc) { vals.push(sc); where += ` AND supplier_code = $${vals.length}`; } billCode = sc; }
  const q = `SELECT pm.sku_code, pm.name, pm.brand, pm.barcode, pm.supplier_item_code,
                    pm.material, pm.spec, pm.unit, pm.image_url, pm.plate_image_url,
                    pm.plate_status, pm.plate_uploaded_at::text AS plate_uploaded_at,
                    pm.plate_nas_location, pm.plate_archived_at::text AS plate_archived_at,
                    pm.moq, pm.lead_time_days, pm.price_ex_tax, pm.tax_point,
                    pm.plate_fee, pm.plate_fee_refund_qty, pm.quote_date::text AS quote_date, pm.quote_valid_until::text AS quote_valid_until,
                    pm.status, pm.notes, pm.flavors,
                    COALESCE((SELECT SUM(COALESCE(d.real_qty, d.order_qty))
                                FROM inbound_deliveries d WHERE d.material_sku = pm.sku_code), 0) AS cumulative_qty
               FROM packaging_materials pm WHERE ${where.replace(/supplier_code/g, "pm.supplier_code")}
                AND COALESCE(pm.status,'active') <> 'inactive'
              ORDER BY pm.brand NULLS LAST, pm.sku_code LIMIT 500`;
  const rows = (await pool.query(q, vals)).rows.map(pubRow);
  let supplier = null;
  if (billCode) {
    const s = await pool.query("SELECT code,name,tax_no,bank_name,bank_account,bank_code,address,contact,phone FROM suppliers WHERE code=$1", [billCode]);
    supplier = s.rows[0] || null;
  }
  return { rows, supplier };
}

const WRITABLE = ["name", "brand", "barcode", "supplier_item_code", "material", "spec", "unit",
  "image_url", "plate_image_url", "status", "notes", "moq", "lead_time_days", "plate_fee", "price_ex_tax", "tax_point",
  "plate_fee_refund_qty", "quote_date", "quote_valid_until"];
const TEXTF = new Set(["name", "brand", "barcode", "supplier_item_code", "material", "spec", "unit", "image_url", "plate_image_url", "status", "notes"]);
const DATEF = new Set(["quote_date", "quote_valid_until"]);
function dstr2(v) { if (!v) return ""; if (v instanceof Date) return v.getFullYear() + "-" + String(v.getMonth() + 1).padStart(2, "0") + "-" + String(v.getDate()).padStart(2, "0"); return String(v).slice(0, 10); }
async function saveRow(client, req, r, scope, row) {
  const sku = clean(row.sku_code, 80);
  if (!sku) throw new Error("sku_code required");
  const vals = [sku];
  let where = "sku_code = $1";
  if (!isInternal(r)) { vals.push(scope); where += ` AND supplier_code = ANY($2::text[])`; }
  const cur = await client.query(`SELECT * FROM packaging_materials WHERE ${where} FOR UPDATE`, vals);
  if (!cur.rows.length) throw new Error("sku out of scope");
  const p = cur.rows[0];
  const before = {}, after = {}, sets = [], sv = [];
  for (const f of WRITABLE) {
    if (row[f] === undefined) continue;
    let nv, ov;
    if (DATEF.has(f)) { nv = clean(row[f], 20) || null; ov = dstr2(p[f]) || null; }
    else if (TEXTF.has(f)) { nv = clean(row[f], 300); ov = p[f] || ""; }
    else { nv = num(row[f]); ov = p[f] == null ? null : Number(p[f]); }
    if (String(nv) !== String(ov)) {
      sv.push(nv); sets.push(`${f}=$${sv.length}`);
      before[f] = ov; after[f] = nv;
    }
  }
  if (sets.length) { sv.push(p.id); await client.query(`UPDATE packaging_materials SET ${sets.join(",")}, updated_at=NOW() WHERE id=$${sv.length}`, sv); }
  return { sku, before, after, changed: Object.keys(after).length > 0 };
}

async function save(req, res, pool, r, scope) {
  if (!(r === "supplier" || isInternal(r))) return json(res, 403, { success: false, error: "save forbidden" });
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [req.body || {}];
  const client = await pool.connect();
  let results = [];
  try {
    await client.query("BEGIN");
    for (const row of rows) results.push(await saveRow(client, req, r, scope, row));
    await client.query("COMMIT");
  } catch (e) { await client.query("ROLLBACK"); throw e; } finally { client.release(); }
  for (const c of results) if (c.changed) {
    try { await writeAudit(pool, req, { action: "supplier-catalog.edit", entity_type: "bag", entity_id: c.sku, before: c.before, after: c.after, note: "供应商款式填报" }); } catch (_) {}
  }
  return json(res, 200, { success: true, saved: results.map(c => c.sku) });
}

async function create(req, res, pool, r, scope) {
  if (!(r === "supplier" || isInternal(r))) return json(res, 403, { success: false, error: "create forbidden" });
  const supplierCode = isInternal(r) ? clean(req.body?.supplier_code || "", 80) : (scope[0] || "");
  if (!supplierCode) throw new Error("supplier_code required");
  const base = supplierCode.replace(/[^A-Za-z0-9]/g, "");
  let sku = "";
  for (let i = 0; i < 5; i++) {
    sku = `BAG-${base}-${Date.now()}${i ? `-${i}` : ""}`;
    try {
      await pool.query("INSERT INTO packaging_materials(sku_code, supplier_code, status, name) VALUES($1,$2,'active',$3)", [sku, supplierCode, "新款式(待填)"]);
      break;
    } catch (e) {
      if (e.code !== "23505" || i === 4) throw e;
    }
  }
  try { await writeAudit(pool, req, { action: "supplier-catalog.create", entity_type: "bag", entity_id: sku, before: {}, after: { sku_code: sku, supplier_code: supplierCode, status: "active" }, note: "供应商新增款式" }); } catch (_) {}
  return json(res, 200, { success: true, sku_code: sku });
}

async function deleteRow(req, res, pool, r, scope) {
  if (!(r === "supplier" || isInternal(r))) return json(res, 403, { success: false, error: "delete forbidden" });
  const sku = clean(req.body?.sku_code || "", 80);
  if (!sku) throw new Error("sku_code required");
  const vals = [sku];
  let where = "sku_code=$1";
  if (!isInternal(r)) { vals.push(scope); where += " AND supplier_code=ANY($2::text[])"; }
  const ret = await pool.query(`UPDATE packaging_materials SET status='inactive', updated_at=NOW() WHERE ${where} RETURNING supplier_code`, vals);
  if (!ret.rowCount) throw new Error("sku out of scope");
  try { await writeAudit(pool, req, { action: "supplier-catalog.delete", entity_type: "bag", entity_id: sku, before: { status: "active" }, after: { status: "inactive" }, note: "供应商停用款式" }); } catch (_) {}
  return json(res, 200, { success: true });
}

function cleanFlavors(v) {
  if (!Array.isArray(v)) throw new Error("flavors invalid");
  const out = [];
  const seen = new Set();
  for (const x of v) {
    const s = clean(x, 40);
    if (!s || seen.has(s)) continue;
    seen.add(s); out.push(s);
    if (out.length > 30) throw new Error("flavors invalid");
  }
  return out;
}

async function setFlavors(req, res, pool, r, scope) {
  if (!(r === "supplier" || isInternal(r))) return json(res, 403, { success: false, error: "save forbidden" });
  const sku = clean(req.body?.sku_code || "", 80);
  if (!sku) throw new Error("sku_code required");
  const flavors = cleanFlavors(req.body?.flavors);
  const vals = [JSON.stringify(flavors), sku];
  let where = "sku_code=$2";
  if (!isInternal(r)) { vals.push(scope); where += " AND supplier_code=ANY($3::text[])"; }
  const ret = await pool.query(`UPDATE packaging_materials SET flavors=$1::jsonb, updated_at=NOW() WHERE ${where}`, vals);
  if (!ret.rowCount) throw new Error("sku out of scope");
  try { await writeAudit(pool, req, { action: "supplier-catalog.set-flavors", entity_type: "bag", entity_id: sku, before: {}, after: { flavors }, note: "供应商款式口味标签" }); } catch (_) {}
  return json(res, 200, { success: true, flavors });
}

async function assertSkuScope(pool, r, scope, sku) {
  const vals = [sku];
  let where = "sku_code=$1";
  if (!isInternal(r)) { vals.push(scope); where += " AND supplier_code=ANY($2::text[])"; }
  const ret = await pool.query(`SELECT sku_code FROM packaging_materials WHERE ${where} LIMIT 1`, vals);
  if (!ret.rowCount) throw new Error("sku out of scope");
}

async function plateSign(req, res, pool, r, scope) {
  if (!(r === "supplier" || isInternal(r))) return json(res, 403, { success: false, error: "plate-sign forbidden" });
  const sku = clean(req.body?.sku_code || "", 80);
  if (!sku) throw new Error("sku_code required");
  await assertSkuScope(pool, r, scope, sku);
  const key = `temp/plate/${sku}-${Date.now()}-${cleanFilename(req.body?.filename)}`;
  const ct = cleanContentType(req.body?.content_type);
  const client = getOSSClient();
  return json(res, 200, {
    success: true,
    put_url: client.signatureUrl(key, { method: "PUT", expires: 14400, "Content-Type": ct }),
    key,
    public_url: ossPublicUrl(key),
  });
}

async function plateSent(req, res, pool, r, scope) {
  if (!(r === "supplier" || isInternal(r))) return json(res, 403, { success: false, error: "plate-sent forbidden" });
  const sku = clean(req.body?.sku_code || "", 80);
  const key = clean(req.body?.key || "", 300);
  if (!sku) throw new Error("sku_code required");
  if (!key || !key.startsWith(`temp/plate/${sku}-`)) throw new Error("key invalid");
  const vals = [ossPublicUrl(key), sku];
  let where = "sku_code=$2";
  if (!isInternal(r)) { vals.push(scope); where += " AND supplier_code=ANY($3::text[])"; }
  const ret = await pool.query(`UPDATE packaging_materials
     SET plate_image_url=$1, plate_status='待转存', plate_uploaded_at=NOW(), updated_at=NOW()
   WHERE ${where} RETURNING plate_image_url, plate_status, plate_uploaded_at::text AS plate_uploaded_at`, vals);
  if (!ret.rowCount) throw new Error("sku out of scope");
  try { await writeAudit(pool, req, { action: "supplier-catalog.plate-sent", entity_type: "bag", entity_id: sku, before: {}, after: { key, plate_status: "待转存" }, note: "供应商发送版图" }); } catch (_) {}
  return json(res, 200, { success: true, ...ret.rows[0] });
}

async function plateArchived(req, res, pool, r) {
  if (!isInternal(r)) return json(res, 403, { success: false, error: "plate-archived forbidden" });
  const sku = clean(req.body?.sku_code || "", 80);
  const nasLocation = clean(req.body?.nas_location || "", 300);
  if (!sku) throw new Error("sku_code required");
  const ret = await pool.query(`UPDATE packaging_materials
     SET plate_nas_location=$1, plate_status='已存NAS', plate_archived_at=NOW(), updated_at=NOW()
   WHERE sku_code=$2 RETURNING plate_nas_location, plate_status, plate_archived_at::text AS plate_archived_at`, [nasLocation, sku]);
  if (!ret.rowCount) throw new Error("sku out of scope");
  try { await writeAudit(pool, req, { action: "supplier-catalog.plate-archived", entity_type: "bag", entity_id: sku, before: {}, after: { plate_nas_location: nasLocation, plate_status: "已存NAS" }, note: "版图已存NAS" }); } catch (_) {}
  return json(res, 200, { success: true, ...ret.rows[0] });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) extractUser(req);
  if (!req.user) return json(res, 401, { success: false, error: "Unauthorized" });
  const r = role(req);
  if (!r) return json(res, 403, { success: false, error: "role forbidden" });
  const scope = codes(req.user);
  if (!isInternal(r) && !scope.length) return json(res, 403, { success: false, error: "scope missing" });
  const pool = getPool();
  try {
    if (req.method === "GET") return json(res, 200, { success: true, role: r, can_edit: r === "supplier" || isInternal(r), org_name: clean(req.user?.company || ""), ...(await listRows(pool, r, scope, req)) });
    const action = clean(req.query.action || req.body?.action || "", 40);
    if (req.method === "PATCH" && action === "save") return await save(req, res, pool, r, scope);
    if (req.method === "PATCH" && action === "set-flavors") return await setFlavors(req, res, pool, r, scope);
    if (req.method === "PATCH" && action === "create") return await create(req, res, pool, r, scope);
    if (req.method === "PATCH" && action === "delete") return await deleteRow(req, res, pool, r, scope);
    if (req.method === "PATCH" && action === "plate-sign") return await plateSign(req, res, pool, r, scope);
    if (req.method === "PATCH" && action === "plate-sent") return await plateSent(req, res, pool, r, scope);
    if (req.method === "PATCH" && action === "plate-archived") return await plateArchived(req, res, pool, r);
    return json(res, 405, { success: false, error: "method/action not allowed" });
  } catch (e) {
    const code = /required|invalid/.test(e.message) ? 400 : (/scope|forbidden/.test(e.message) ? 403 : 500);
    if (code === 500) { console.error("[supplier-catalog]", e); return json(res, 500, { success: false, error: "internal error" }); }
    return json(res, code, { success: false, error: e.message });
  }
}
