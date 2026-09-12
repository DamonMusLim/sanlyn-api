// 服务项目主数据。洗护/美容的项目库,预约时选它。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { requireVisible, requireWritable } from "../moduleGate.js";

const clean = (v, m = 80) => { const s = String(v ?? "").trim(); return s ? s.slice(0, m) : null; };
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const numOrNull = (v) => v === undefined || v === null || v === "" ? null : Number(v);
const intOrNull = (v) => v === undefined || v === null || v === "" ? null : parseInt(v, 10);
const PRICING_METHODS = new Set(["fixed", "weight_tier", "per_course", "per_day"]);
const CATEGORY_CODES = new Set(["grooming", "training", "boarding", "medical"]);

function operatorFromReq(req) {
  return String(req.user?.username || req.user?.name || req.user?.account || "admin").trim().slice(0, 80) || "admin";
}

function bad(res, code, error) {
  return res.status(code).json({ error });
}

function validateMoney(res, name, value, required = false) {
  const n = numOrNull(value);
  if (required && n === null) { bad(res, 400, `${name}必填`); return null; }
  if (n !== null && (!Number.isFinite(n) || n < 0)) { bad(res, 400, `${name}不能为负数`); return null; }
  return n;
}

function validateDuration(res, value) {
  const n = intOrNull(value);
  if (n !== null && (!Number.isInteger(n) || n <= 0)) { bad(res, 400, "duration_min必须是正整数"); return null; }
  return n;
}

function validateText(res, name, value, max) {
  const s = String(value ?? "").trim();
  if (s.length > max) { bad(res, 400, `${name}不能超过${max}字`); return null; }
  return s || null;
}

function validatePricingMethod(res, value) {
  const s = clean(value, 40);
  if (!PRICING_METHODS.has(s)) { bad(res, 400, "计价方式不支持"); return null; }
  return s;
}

function validateCategoryCode(res, value) {
  const s = clean(value, 40);
  if (!CATEGORY_CODES.has(s)) { bad(res, 400, "分类码不支持"); return null; }
  return s;
}

function validateCapacity(res, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) { bad(res, 400, "每时段容量必须是正整数"); return null; }
  return n;
}

function validateWeightPriceJson(res, value) {
  let data = value;
  if (typeof value === "string") {
    try { data = JSON.parse(value); } catch { bad(res, 400, "档位表不是合法的 JSON"); return null; }
  }
  if (!data || typeof data !== "object" || !data.unit || !Array.isArray(data.tiers)) {
    bad(res, 400, "档位表缺 unit 或 tiers"); return null;
  }
  if (data.unit !== "jin") { bad(res, 400, "档位单位只支持「斤」(jin)"); return null; }
  if (!data.tiers.length) { bad(res, 400, "档位表至少要有一档"); return null; }

  const tiers = [];
  for (let idx = 0; idx < data.tiers.length; idx += 1) {
    const tier = data.tiers[idx];
    const min = Number(tier?.min);
    const max = Number(tier?.max);
    const price = Number(tier?.price);
    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(price)) {
      bad(res, 400, `第 ${idx + 1} 档 min/max/price 必须是数字`); return null;
    }
    if (min >= max) { bad(res, 400, `第 ${idx + 1} 档 min 必须小于 max`); return null; }
    if (price < 0) { bad(res, 400, `第 ${idx + 1} 档价格不能为负数`); return null; }
    tiers.push({ min, max, price });
  }

  tiers.sort((a, b) => a.min - b.min);
  if (tiers[0].min !== 0) { bad(res, 400, "首档必须从 0 斤开始"); return null; }
  for (let i = 0; i < tiers.length - 1; i += 1) {
    if (tiers[i].max < tiers[i + 1].min) {
      bad(res, 400, `第 ${i + 1} 档和第 ${i + 2} 档之间有缺口(${tiers[i].max}斤 到 ${tiers[i + 1].min}斤 没人管)`);
      return null;
    }
    if (tiers[i].max > tiers[i + 1].min) {
      bad(res, 400, `第 ${i + 1} 档和第 ${i + 2} 档重叠了(${tiers[i + 1].min}斤 被算了两次)`);
      return null;
    }
  }
  return JSON.stringify({ unit: "jin", tiers });
}

async function createItem(req, res, body, storeCode) {
  const gate = await requireWritable(req, res, "booking", storeCode); if (!gate) return;
  const name = validateText(res, "name", body.name, 80); if (res.headersSent) return;
  if (!name) return bad(res, 400, "name必填");
  const requestedStoreCode = has(body, "store_code") ? validateText(res, "store_code", body.store_code, 32) : null; if (res.headersSent) return;
  if (requestedStoreCode && requestedStoreCode !== storeCode) return bad(res, 400, "不能给别的门店建服务项目");
  const category = validateText(res, "category", body.category, 20); if (res.headersSent) return;
  const duration_min = validateDuration(res, body.duration_min); if (res.headersSent) return;
  const price = validateMoney(res, "price", body.price); if (res.headersSent) return;
  const member_price = validateMoney(res, "member_price", body.member_price); if (res.headersSent) return;
  const pricing_method = validatePricingMethod(res, body.pricing_method || "fixed"); if (res.headersSent) return;
  const category_code = validateCategoryCode(res, body.category_code || "grooming"); if (res.headersSent) return;
  const capacity_per_slot = validateCapacity(res, body.capacity_per_slot ?? 2); if (res.headersSent) return;
  const weight_price_json = pricing_method === "weight_tier" ? validateWeightPriceJson(res, body.weight_price_json) : null; if (res.headersSent) return;
  const sort_order = intOrNull(body.sort_order);
  if (sort_order !== null && !Number.isInteger(sort_order)) return bad(res, 400, "sort_order必须是整数");

  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO service_items (
       store_code, name, category, duration_min, price, pet_size, is_active, sort_order,
       note, image_url, member_price, is_mini_program_enabled, other_status, service_description,
       pricing_method, category_code, capacity_per_slot, weight_price_json, updated_at
     ) VALUES (
       $1, $2, $3, $4, COALESCE($5, 0), $6, true, COALESCE($7, 0),
       $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, now()
     ) RETURNING id`,
    [
      storeCode, name, category, duration_min, price, clean(body.pet_size, 40), sort_order,
      clean(body.note, 500), clean(body.image_url, 500), member_price,
      body.is_mini_program_enabled === undefined ? null : Boolean(body.is_mini_program_enabled),
      clean(body.other_status, 80), clean(body.service_description, 1000),
      pricing_method, category_code, capacity_per_slot, weight_price_json,
    ],
  );
  const id = rows[0].id;
  console.log(`[service-items] action=create id=${id} by=${operatorFromReq(req)}`);
  return res.status(200).json({ ok: true, id });
}

function applyOptionalFields(res, body, values) {
  if (has(body, "name")) { values.name = validateText(res, "name", body.name, 80); if (res.headersSent) return; }
  if (has(body, "category")) { values.category = validateText(res, "category", body.category, 20); if (res.headersSent) return; }
  if (has(body, "duration_min")) { values.duration_min = validateDuration(res, body.duration_min); if (res.headersSent) return; }
  if (has(body, "price")) { values.price = validateMoney(res, "price", body.price); if (res.headersSent) return; }
  if (has(body, "pet_size")) values.pet_size = clean(body.pet_size, 40);
  if (has(body, "sort_order")) values.sort_order = intOrNull(body.sort_order);
  if (has(body, "note")) values.note = clean(body.note, 500);
  if (has(body, "image_url")) values.image_url = clean(body.image_url, 500);
  if (has(body, "member_price")) { values.member_price = validateMoney(res, "member_price", body.member_price); if (res.headersSent) return; }
  if (has(body, "is_mini_program_enabled")) values.is_mini_program_enabled = Boolean(body.is_mini_program_enabled);
  if (has(body, "other_status")) values.other_status = clean(body.other_status, 80);
  if (has(body, "service_description")) values.service_description = clean(body.service_description, 1000);
  if (has(body, "pricing_method")) { values.pricing_method = validatePricingMethod(res, body.pricing_method); if (res.headersSent) return; }
  if (has(body, "category_code")) { values.category_code = validateCategoryCode(res, body.category_code); if (res.headersSent) return; }
  if (has(body, "capacity_per_slot")) { values.capacity_per_slot = validateCapacity(res, body.capacity_per_slot); }
}

async function updateItem(req, res, body, storeCode) {
  const gate = await requireWritable(req, res, "booking", storeCode); if (!gate) return;
  const id = intOrNull(body.id); if (!id) return bad(res, 400, "id必填");
  if (has(body, "store_code")) return bad(res, 400, "store_code不可修改");

  const values = {
    name: null, category: null, duration_min: null, price: null, pet_size: null, sort_order: null,
    note: null, image_url: null, member_price: null, is_mini_program_enabled: null, other_status: null,
    service_description: null, pricing_method: null, category_code: null, capacity_per_slot: null, weight_price_json: null,
  };
  applyOptionalFields(res, body, values); if (res.headersSent) return;

  const pool = getPool();
  let setWeightJson = has(body, "weight_price_json");
  if (has(body, "pricing_method") || has(body, "weight_price_json")) {
    const current = await pool.query(`SELECT pricing_method, weight_price_json FROM service_items WHERE id=$1 AND store_code=$2`, [id, storeCode]);
    if (!current.rowCount) return bad(res, 404, "服务项目不存在");
    const effectivePricing = values.pricing_method || current.rows[0].pricing_method;
    if (effectivePricing === "weight_tier") {
      if (has(body, "weight_price_json")) values.weight_price_json = validateWeightPriceJson(res, body.weight_price_json);
      else if (!current.rows[0].weight_price_json) return bad(res, 400, "改成按体重计价必须同时提供档位表");
      else setWeightJson = false;
    } else {
      values.weight_price_json = null;
      setWeightJson = true;
    }
    if (res.headersSent) return;
  }

  if (has(body, "sort_order") && values.sort_order !== null && !Number.isInteger(values.sort_order)) return bad(res, 400, "sort_order必须是整数");
  if (has(body, "name") && !values.name) return bad(res, 400, "name必填");
  const { rowCount } = await pool.query(
    `UPDATE service_items SET
       name = CASE WHEN $2 THEN $3 ELSE name END,
       category = CASE WHEN $4 THEN $5 ELSE category END,
       duration_min = CASE WHEN $6 THEN $7 ELSE duration_min END,
       price = CASE WHEN $8 THEN $9 ELSE price END,
       pet_size = CASE WHEN $10 THEN $11 ELSE pet_size END,
       sort_order = CASE WHEN $12 THEN $13 ELSE sort_order END,
       note = CASE WHEN $14 THEN $15 ELSE note END,
       image_url = CASE WHEN $16 THEN $17 ELSE image_url END,
       member_price = CASE WHEN $18 THEN $19 ELSE member_price END,
       is_mini_program_enabled = CASE WHEN $20 THEN $21 ELSE is_mini_program_enabled END,
       other_status = CASE WHEN $22 THEN $23 ELSE other_status END,
       service_description = CASE WHEN $24 THEN $25 ELSE service_description END,
       pricing_method = CASE WHEN $26 THEN $27 ELSE pricing_method END,
       category_code = CASE WHEN $28 THEN $29 ELSE category_code END,
       capacity_per_slot = CASE WHEN $30 THEN $31 ELSE capacity_per_slot END,
       weight_price_json = CASE WHEN $32 THEN $33 ELSE weight_price_json END,
       updated_at = now()
     WHERE id = $1 AND store_code = $34`,
    [
      id, has(body, "name"), values.name, has(body, "category"), values.category,
      has(body, "duration_min"), values.duration_min, has(body, "price"), values.price,
      has(body, "pet_size"), values.pet_size, has(body, "sort_order"), values.sort_order,
      has(body, "note"), values.note, has(body, "image_url"), values.image_url,
      has(body, "member_price"), values.member_price, has(body, "is_mini_program_enabled"), values.is_mini_program_enabled,
      has(body, "other_status"), values.other_status, has(body, "service_description"), values.service_description,
      has(body, "pricing_method"), values.pricing_method, has(body, "category_code"), values.category_code,
      has(body, "capacity_per_slot"), values.capacity_per_slot, setWeightJson, values.weight_price_json, storeCode,
    ],
  );
  if (!rowCount) return bad(res, 404, "服务项目不存在");
  console.log(`[service-items] action=update id=${id} by=${operatorFromReq(req)}`);
  return res.status(200).json({ ok: true, id });
}

async function deleteItem(req, res, body, storeCode) {
  const gate = await requireWritable(req, res, "booking", storeCode); if (!gate) return;
  const id = intOrNull(body.id); if (!id) return bad(res, 400, "id必填");
  const pool = getPool();
  const active = await pool.query(
    `SELECT count(*)::int AS n FROM appointments WHERE service_item_id=$1 AND store_code=$2 AND status IN ('booked','arrived','doing')`,
    [id, storeCode],
  );
  const n = Number(active.rows[0]?.n || 0);
  if (n > 0) return bad(res, 409, `这个服务还有 ${n} 个未完成的预约,不能停用。等做完或取消后再停。`);
  const { rowCount } = await pool.query(`UPDATE service_items SET is_active=false, updated_at=now() WHERE id=$1 AND store_code=$2`, [id, storeCode]);
  if (!rowCount) return bad(res, 404, "服务项目不存在");
  console.log(`[service-items] action=delete id=${id} by=${operatorFromReq(req)}`);
  return res.status(200).json({ ok: true, id });
}

async function restoreItem(req, res, body, storeCode) {
  const gate = await requireWritable(req, res, "booking", storeCode); if (!gate) return;
  const id = intOrNull(body.id); if (!id) return bad(res, 400, "id必填");
  const pool = getPool();
  const { rowCount } = await pool.query(`UPDATE service_items SET is_active=true, updated_at=now() WHERE id=$1 AND store_code=$2`, [id, storeCode]);
  if (!rowCount) return bad(res, 404, "服务项目不存在");
  console.log(`[service-items] action=restore id=${id} by=${operatorFromReq(req)}`);
  return res.status(200).json({ ok: true, id });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "POST"].includes(req.method)) return res.status(405).json({ error: "method not allowed" });
  if (!requireAuth(req, res)) return;
  const storeCode = clean(req.method === "GET" ? req.query?.storeCode : req.body?.storeCode, 32) || "63350001";
  if (req.method === "GET" && !(await requireVisible(req, res, "booking", storeCode))) return;
  try {
    if (req.method === "POST") {
      const body = req.body || {};
      const action = clean(body.action, 20);
      if (action === "create") return await createItem(req, res, body, storeCode);
      if (action === "update") return await updateItem(req, res, body, storeCode);
      if (action === "delete") return await deleteItem(req, res, body, storeCode);
      if (action === "restore") return await restoreItem(req, res, body, storeCode);
      return bad(res, 400, "action不支持");
    }
    const pageSize = Math.min(Math.max(parseInt(req.query?.pageSize, 10) || 20, 1), 200);
    const page = Math.max(parseInt(req.query?.pageNumber, 10) || 1, 1);
    const activeOnly = String(req.query?.activeOnly || "") === "1";
    const pool = getPool();
    const { rows } = await pool.query(`SELECT count(*) OVER() AS __total, id, name, category, duration_min, price, pet_size,
        CASE WHEN is_active THEN '启用' ELSE '停用' END AS status_cn, sort_order, note, updated_at,
        is_mini_program_enabled, member_price, image_url, service_description,
        pricing_method, category_code, capacity_per_slot, weight_price_json
   FROM service_items WHERE store_code = $1 AND (NOT $4::boolean OR is_active)
  ORDER BY sort_order, id LIMIT $2 OFFSET $3`, [storeCode, pageSize, (page - 1) * pageSize, activeOnly]);
    const total = rows.length ? Number(rows[0].__total || rows.length) : 0;
    return res.status(200).json({ rows: rows.map(({ __total, ...r }) => r), total, pageNumber: page, pageSize });
  } catch (e) {
    console.error("[service-items] failed", e);
    return res.status(500).json({ error: "服务项目操作失败" });
  }
}
