import { getPool, setCors } from "../db.js";
import { normalizePort } from "../db/_official-port-charges.js";

function cleanCode(req){
  var p = req.params && req.params.code;
  if (p) return String(p).split("?")[0];
  var parts = String(req.url || "").split("?")[0].split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function send(res, status, body){
  res.status(status).json(body);
}

function cleanText(v){
  return String(v == null ? "" : v).trim();
}

function numOrNull(v){
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function dateTime(v){
  if (!v) return null;
  var d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

async function loadToken(pool, code){
  if (!code) return { error:404, body:{ ok:false, error:"not_found" } };
  const { rows } = await pool.query(
    "SELECT code, forwarder_co, company_id, expires_at FROM forwarder_portal_tokens WHERE code = $1 LIMIT 1",
    [code]
  );
  if (!rows.length) return { error:404, body:{ ok:false, error:"not_found" } };
  var token = rows[0];
  if (token.expires_at && new Date(token.expires_at) < new Date()) {
    return { error:410, body:{ ok:false, error:"expired", message:"链接已过期" } };
  }
  return { token:token };
}

async function companyName(pool, companyId){
  const { rows } = await pool.query(
    "SELECT name_cn FROM companies WHERE id = $1 LIMIT 1",
    [companyId]
  );
  return rows[0] && rows[0].name_cn ? rows[0].name_cn : "";
}

function paidStatus(v){
  return cleanText(v).toLowerCase() === "paid";
}

function closedBills(rows){
  var byBl = {};
  (rows || []).forEach(function(row){
    var bl = cleanText(row.bl_no);
    if (!bl) return;
    var g = byBl[bl] || (byBl[bl] = { count:0, ap_paid:true, ar_paid:true, confirmed:false });
    g.count += 1;
    if (!paidStatus(row.ap_status)) g.ap_paid = false;
    if (!paidStatus(row.ar_status)) g.ar_paid = false;
    if (row.confirmed_at) g.confirmed = true;
  });
  var closed = {};
  Object.keys(byBl).forEach(function(bl){
    var g = byBl[bl];
    closed[bl] = g.count > 0 && g.ap_paid && g.ar_paid && g.confirmed;
  });
  return closed;
}

async function loadClosedMap(pool, supplierName){
  const { rows } = await pool.query(
    `SELECT bl_no, confirmed_at, ap_status, ar_status
       FROM freight_supplier_bills
      WHERE supplier = $1
        AND bl_no IS NOT NULL
        AND bl_no <> ''`,
    [supplierName]
  );
  return closedBills(rows);
}

async function loadPlans(pool, companyId){
  const { rows } = await pool.query(
    `SELECT id, bl_no, pol, pod, etd, container_qty, container_type,
            gross_weight_kg, cargo_description, vessel, voyage, customer_en
       FROM shipping_plans
      WHERE forwarder_company_id = $1
      ORDER BY etd NULLS LAST, id DESC`,
    [companyId]
  );
  return rows;
}

function boxType(v){
  var s = cleanText(v).toUpperCase().replace(/\s+/g, "");
  return s ? s.replace("HC", "HQ") : "";
}

function cargoCategory(v){
  var s = cleanText(v);
  if (!s) return "";
  var out = [];
  if (/宠物|PET/i.test(s)) out.push("宠物食品");
  if (/食品|FOOD/i.test(s) && out.indexOf("食品") === -1) out.push("食品");
  if (out.length) return out.join("/");
  return s.split(/[;；,，、\n/|]+/).map(cleanText).filter(Boolean)[0] || "";
}

function shipment(row, closed){
  var bl = cleanText(row.bl_no);
  return {
    bl_no:bl || null,
    etd:row.etd || null,
    container_qty:numOrNull(row.container_qty),
    gross_weight_kg:numOrNull(row.gross_weight_kg),
    cargo_description:cleanText(row.cargo_description) || null,
    customer_en:cleanText(row.customer_en) || null,
    closed:!!(bl && closed[bl]),
  };
}

function makeLane(row){
  var polNorm = normalizePort(row.pol);
  var podNorm = normalizePort(row.pod);
  return {
    lane_key:polNorm + "::" + podNorm,
    pol:row.pol || "",
    pod:row.pod || "",
    order_count:0,
    nearest_etd:null,
    total_containers:0,
    box_summary:null,
    cargo_types:[],
    gw_total:0,
    hot:false,
    countdown_hint:null,
    shipments:[],
    missing:[],
    _box:{},
    _cargo:{},
    _etds:[],
    _futureEtds:[],
    _missing:{},
  };
}

function markMissing(lane, key, yes){
  if (yes) lane._missing[key] = true;
}

function addPlan(lane, row, closed){
  var s = shipment(row, closed);
  if (s.closed) return;
  lane.shipments.push(s);
  lane.order_count += 1;

  var qty = numOrNull(row.container_qty);
  if (qty != null) {
    lane.total_containers += qty;
    var ct = boxType(row.container_type);
    if (ct) lane._box[ct] = (lane._box[ct] || 0) + qty;
  }
  var gw = numOrNull(row.gross_weight_kg);
  if (gw != null) lane.gw_total += gw;

  var cat = cargoCategory(row.cargo_description);
  if (cat && !lane._cargo[cat]) {
    lane._cargo[cat] = true;
    lane.cargo_types.push(cat);
  }

  var t = dateTime(row.etd);
  if (t != null) {
    lane._etds.push({ t:t, v:row.etd });
    if (t >= startOfToday()) lane._futureEtds.push({ t:t, v:row.etd });
  }

  markMissing(lane, "gw", gw == null);
  markMissing(lane, "cargo", !cleanText(row.cargo_description));
  markMissing(lane, "etd", t == null);
  markMissing(lane, "container", qty == null);
}

function startOfToday(){
  var d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function earliest(list){
  if (!list.length) return null;
  list.sort(function(a, b){ return a.t - b.t; });
  return list[0];
}

function finishLane(lane){
  var boxKeys = Object.keys(lane._box);
  if (boxKeys.length) {
    boxKeys.sort();
    lane.box_summary = boxKeys.map(function(k){ return lane._box[k] + "×" + k; }).join(" / ");
  } else if (lane.total_containers) {
    lane.box_summary = String(lane.total_containers);
  }
  if (!lane.cargo_types.length) lane.cargo_types = null;
  if (!lane.gw_total) lane.gw_total = null;

  var hit = earliest(lane._futureEtds) || earliest(lane._etds);
  lane.nearest_etd = hit ? hit.v : null;
  lane.countdown_hint = lane.nearest_etd;
  var t = hit ? hit.t : null;
  var now = Date.now();
  lane.hot = t != null && t >= now && t <= now + 7 * 24 * 60 * 60 * 1000;
  lane.missing = Object.keys(lane._missing).sort();

  delete lane._box;
  delete lane._cargo;
  delete lane._etds;
  delete lane._futureEtds;
  delete lane._missing;
  return lane;
}

function groupActivePlans(rows, closed){
  var lanes = {};
  (rows || []).forEach(function(row){
    var key = normalizePort(row.pol) + "::" + normalizePort(row.pod);
    if (key === "::") return;
    var lane = lanes[key] || (lanes[key] = makeLane(row));
    addPlan(lane, row, closed);
  });
  return Object.keys(lanes).map(function(k){ return finishLane(lanes[k]); })
    .filter(function(lane){ return lane.shipments.length > 0; })
    .sort(function(a, b){
      var at = dateTime(a.nearest_etd);
      var bt = dateTime(b.nearest_etd);
      if (at == null && bt == null) return String(a.lane_key).localeCompare(String(b.lane_key));
      if (at == null) return 1;
      if (bt == null) return -1;
      return at - bt;
    });
}

async function handleGet(pool, token, res){
  if (!token.company_id) {
    return send(res, 200, { ok:true, lanes:[] });
  }
  var supplierName = await companyName(pool, token.company_id);
  if (!supplierName) return send(res, 404, { ok:false, error:"company_not_found" });

  var closed = await loadClosedMap(pool, supplierName);
  var plans = await loadPlans(pool, token.company_id);
  var lanes = groupActivePlans(plans, closed);

  return send(res, 200, {
    ok:true,
    forwarder_co:supplierName,
    company_id:token.company_id,
    lanes:lanes,
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return send(res, 405, { ok:false, error:"method_not_allowed" });
  const pool = getPool();
  const code = cleanCode(req);
  const loaded = await loadToken(pool, code);
  if (loaded.error) return send(res, loaded.error, loaded.body);
  return handleGet(pool, loaded.token, res);
}
