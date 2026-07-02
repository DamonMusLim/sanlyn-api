// api/public/forwarder-services.js — 公开货代门户·全链服务报价(v3a拖车)
// GET  /api/public/forwarder-services/:code?service=truck
// POST /api/public/forwarder-services/:code/quote  { rfq_id, service, detail }
// 免登录(/api/public/ 已在 auth 直通), 自校验 token+过期; Lens fail-closed。
import { getPool, setCors } from "../db.js";

function asNumber(v, fb){ var n = Number(v); return Number.isFinite(n) ? n : fb; }
function cleanText(v, max){ var s = String(v == null ? "" : v).trim(); return s ? s.slice(0, max || 200) : ""; }
function publicArea(v){
  var s = cleanText(v, 80); if (!s) return "";
  s = s.replace(/[0-9０-９]+[号號栋棟幢室楼樓层層\-#A-Za-z]*.*$/g, "");
  s = s.split(/[，,;；]/)[0];
  var m = s.match(/(.{1,18}?(市|区|县|鎮|镇|City|Area))/i);
  return cleanText(m ? m[1] : s, 32);
}
function pickPlanValue(plan, keys){ for (var i=0;i<keys.length;i++){ var v = plan && plan[keys[i]]; if (v != null && v !== "") return v; } return ""; }
function buildShipment(plan){
  plan = plan || {};
  var pickupRaw = pickPlanValue(plan, ["pickup_city","origin_city","loading_city","factory_city","pickup_area","origin_area","loading_area"]);
  return {
    pol: plan.pol || "", pod: plan.pod || "",
    ctnr_type: plan.container_type || plan.ctnr_type || "",
    ctnr_count: asNumber(plan.container_qty || plan.ctnr_count, 0),
    gross_weight_kg: plan.gross_weight_kg || null,
    product_summary: plan.product_summary || plan.cargo_description || "",
    etd: plan.etd || null,
    origin_area: publicArea(pickupRaw || plan.pol || ""),
  };
}
function buildMyQuote(row){
  if (!row.item_id) return null;
  return { id: row.item_id, usd_rate: row.usd_rate == null ? null : Number(row.usd_rate),
    currency: row.currency || "CNY", notes: row.notes || "", detail: row.quote_detail_json || null,
    created_at: row.item_created_at || null };
}
async function validateToken(pool, code){
  var r = await pool.query("SELECT code, forwarder_co, expires_at FROM forwarder_portal_tokens WHERE code = $1 LIMIT 1", [code]);
  if (!r.rows.length) return { err:[404, { ok:false, error:"链接无效" }] };
  var t = r.rows[0];
  if (t.expires_at && new Date(t.expires_at).getTime() < Date.now()) return { err:[410, { ok:false, error:"链接已过期" }] };
  return { token:t };
}
function normalizeTruckDetail(detail, shipQty, shipType){
  detail = detail || {};
  var mode = detail.pricing_mode === "per_shipment" ? "per_shipment" : "per_container";
  var amount = asNumber(detail.amount, NaN);
  var qty = asNumber(detail.container_qty, shipQty || 1);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("拖车费金额必须大于 0");
  if (!Number.isFinite(qty) || qty <= 0) qty = 1;
  var total = mode === "per_container" ? amount * qty : amount;
  return { total:total, detail:{
    pricing_mode:mode, pickup_place:publicArea(detail.pickup_place), amount:amount,
    container_type:cleanText(detail.container_type || shipType, 40), container_qty:qty,
    includes_empty_pickup_return: !!detail.includes_empty_pickup_return,
    waiting_fee_rule:cleanText(detail.waiting_fee_rule, 240), remarks:cleanText(detail.remarks, 500),
  }};
}
async function doGet(req, res, pool, code){
  var service = (req.query && req.query.service) || "truck";
  if (service !== "truck") return res.status(400).json({ ok:false, error:"service 暂未开放" });
  var auth = await validateToken(pool, code);
  if (auth.err) return res.status(auth.err[0]).json(auth.err[1]);
  var q = await pool.query(
    `SELECT r.id AS rfq_id, r.service_type, r.shipping_plan_id AS plan_id, r.status,
            to_jsonb(sp) AS plan_json,
            i.id AS item_id, i.usd_rate, i.currency, i.notes, i.quote_detail_json, i.created_at AS item_created_at
       FROM freight_rfqs r
       JOIN shipping_plans sp ON sp.id = r.shipping_plan_id
       LEFT JOIN freight_rfq_items i ON i.rfq_id = r.id AND i.forwarder_co = $1
      WHERE r.service_type = 'truck' AND r.status = 'open'
      ORDER BY COALESCE(sp.etd, NOW()) ASC, r.created_at DESC NULLS LAST`,
    [auth.token.forwarder_co]);
  var rfqs = q.rows.map(function(row){
    return { rfq_id:row.rfq_id, service_type:row.service_type, plan_id:row.plan_id,
      shipment:buildShipment(row.plan_json), my_quote:buildMyQuote(row), status:row.status };
  });
  return res.json({ ok:true, service:"truck", forwarder_co:auth.token.forwarder_co, rfqs:rfqs });
}
async function doPost(req, res, pool, code){
  var auth = await validateToken(pool, code);
  if (auth.err) return res.status(auth.err[0]).json(auth.err[1]);
  var body = req.body || {};
  if (body.service !== "truck") return res.status(400).json({ ok:false, error:"service 必须为 truck" });
  var rfqId = cleanText(body.rfq_id, 80);
  if (!rfqId) return res.status(400).json({ ok:false, error:"rfq_id 必填" });
  var rq = await pool.query(
    `SELECT r.id, r.service_type, r.status, r.shipping_plan_id AS plan_id, to_jsonb(sp) AS plan_json
       FROM freight_rfqs r JOIN shipping_plans sp ON sp.id = r.shipping_plan_id WHERE r.id = $1 LIMIT 1`, [rfqId]);
  if (!rq.rows.length) return res.status(404).json({ ok:false, error:"找不到 RFQ" });
  var rfq = rq.rows[0];
  if (rfq.service_type !== "truck") return res.status(400).json({ ok:false, error:"RFQ 服务类型不匹配" });
  if (rfq.status !== "open") return res.status(409).json({ ok:false, error:"RFQ 已关闭" });
  var shipment = buildShipment(rfq.plan_json);
  var normalized;
  try { normalized = normalizeTruckDetail(body.detail, shipment.ctnr_count, shipment.ctnr_type); }
  catch (e){ return res.status(400).json({ ok:false, error:e.message }); }
  var fwd = auth.token.forwarder_co;
  var upd = await pool.query(
    `UPDATE freight_rfq_items SET usd_rate=$3, currency='CNY', notes=$4, quote_detail_json=$5::jsonb
      WHERE rfq_id=$1 AND forwarder_co=$2 RETURNING id`,
    [rfqId, fwd, normalized.total, normalized.detail.remarks || null, JSON.stringify(normalized.detail)]);
  var itemId = upd.rows[0] && upd.rows[0].id;
  if (!itemId){
    var ins = await pool.query(
      `INSERT INTO freight_rfq_items (rfq_id, forwarder_co, usd_rate, currency, notes, quote_detail_json)
       VALUES ($1,$2,$3,'CNY',$4,$5::jsonb) RETURNING id`,
      [rfqId, fwd, normalized.total, normalized.detail.remarks || null, JSON.stringify(normalized.detail)]);
    itemId = ins.rows[0] && ins.rows[0].id;
  }
  return res.json({ ok:true, item_id:itemId, usd_rate:normalized.total, currency:"CNY", detail:normalized.detail });
}
export default async function handler(req, res){
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.end();
  const pool = getPool();
  var code = (req.params && req.params.code) || String(req.url || "").split("?")[0].split("/").filter(Boolean)[2];
  var isQuote = /\/quote(\?|$)/.test(req.url || "");
  try {
    if (req.method === "POST" && isQuote) return await doPost(req, res, pool, decodeURIComponent(code));
    if (req.method === "GET") return await doGet(req, res, pool, decodeURIComponent(code));
    return res.status(404).json({ ok:false, error:"Not found" });
  } catch (e){
    console.error("[forwarder-services]", e.message);
    return res.status(500).json({ ok:false, error:e.message || "server error" });
  }
}
