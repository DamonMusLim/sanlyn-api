import { getPool, setCors } from "../db.js";
import { resolveForwarder } from "./_forwarder-portal-auth.js";
import { normalizePort } from "../db/_official-port-charges.js";

function cleanCode(req){
  var p = req.params && req.params.code;
  if (p) return String(p).split("?")[0];
  var parts = String(req.url || "").split("?")[0].split("/").filter(Boolean);
  return parts[parts.length - 1] || "";
}

function cookieSession(req){
  var raw = String((req.headers && req.headers.cookie) || "");
  var hit = raw.split(";").map(function(p){ return p.trim(); }).find(function(p){ return p.indexOf("fwd_session=") === 0; });
  return hit ? decodeURIComponent(hit.slice("fwd_session=".length)) : "";
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

async function loadToken(pool, code, req){
  // P0根治: 只认 cookie secret, 无视 URL slug(code)
  return resolveForwarder(pool, req);
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
    // TODO: Also keep lanes with future open freight_rfqs when that signal is needed.
    `SELECT sp.id, sp.bl_no, sp.pol, sp.pod, sp.etd, sp.container_qty, sp.container_type,
            sp.carrier_code,
            sp.freight_cost, sp.thc_fee, sp.seal_fee, sp.vgm_fee, sp.doc_fee, sp.eir_fee, sp.port_surcharge_total,
            COALESCE(sp.gross_weight_kg, li.gross_weight_kg) AS gross_weight_kg,
            COALESCE(NULLIF(BTRIM(sp.cargo_description), ''), li.cargo_description) AS cargo_description,
            li.cargo_generic AS cargo_generic,
            sp.vessel, sp.voyage, sp.eta,
            sp.shipping_status, sp.status, sp.current_status_cn, sp.booking_no, sp.forwarder_booking_no, sp.booking_stage,
            sp.pol_port_id, sp.pod_port_id, sp.pod_terminal_unconfirmed, sp.port_resolution_status,
            pod_p.name_en AS pod_canon_en, pod_p.name_cn AS pod_canon_cn, pod_p.code AS pod_code, pod_p.requires_terminal AS pod_requires_terminal,
            pol_p.name_en AS pol_canon_en, pol_p.name_cn AS pol_canon_cn, pol_p.code AS pol_code
       FROM shipping_plans sp
       LEFT JOIN ports pod_p ON pod_p.id = sp.pod_port_id
       LEFT JOIN ports pol_p ON pol_p.id = sp.pol_port_id
       LEFT JOIN LATERAL (
         SELECT
           (SELECT string_agg(t.label, ' / ' ORDER BY t.label)
              FROM (
                SELECT DISTINCT COALESCE(NULLIF(BTRIM(oi.bl_description), ''), NULLIF(BTRIM(oi.product_name), '')) AS label
                  FROM order_line_items oi
                 WHERE oi.order_id = ANY(
                   SELECT o.id
                     FROM orders o
                    WHERE o.order_no = ANY(sp.order_nos)
                 )
                 ORDER BY label
                 LIMIT 3
              ) t
             WHERE t.label IS NOT NULL) AS cargo_description,
           (SELECT SUM(oi.gw_ctn * oi.qty_ctn)
              FROM order_line_items oi
             WHERE oi.order_id = ANY(
               SELECT o.id
                 FROM orders o
                WHERE o.order_no = ANY(sp.order_nos)
             )) AS gross_weight_kg,
           -- 笼统货描真源=products.cat1(宠物食品/宠物用品/…),按票聚合去重;对货代只出这个不出品名(Damon 2026-07-19)
           (SELECT string_agg(cat1, ' / ' ORDER BY cat1)
              FROM (
                SELECT DISTINCT NULLIF(BTRIM(p.cat1), '') AS cat1
                  FROM order_line_items oi
                  JOIN products p ON p.sku = oi.sku
                 WHERE oi.order_id = ANY(
                   SELECT o.id
                     FROM orders o
                    WHERE o.order_no = ANY(sp.order_nos)
                 )
              ) c
             WHERE c.cat1 IS NOT NULL) AS cargo_generic
       ) li ON TRUE
      WHERE sp.forwarder_company_id = $1
        AND (sp.etd >= CURRENT_DATE - interval '6 months' OR sp.etd IS NULL)
      ORDER BY sp.etd NULLS LAST, sp.id DESC`,
    [companyId]
  );
  return rows;
}

// 门户参考运价真源 = freight_rates 运价库(该货代自己的供应商价 gp20/hq40,绝不用 customer_*=客户价 Lens红线),
// 按 pol/pod/船司 取最新有效一条;取代原来脏的 shipping_plans.freight_cost(美金/人民币/垃圾混存)。Damon 2026-07-19。
async function loadRateBook(pool, forwarderName){
  const { rows } = await pool.query(
    // 每字段各取"最新非空"一条(运价 thc 稀疏度不同,分别取最近有值的),都在 freight_rates 库内
    `SELECT lower(btrim(pol)) AS pol, lower(btrim(pod)) AS pod, upper(btrim(carrier)) AS carrier,
            (array_agg(gp20 ORDER BY COALESCE(valid_from, created_at) DESC NULLS LAST, id DESC) FILTER (WHERE gp20 IS NOT NULL AND gp20 > 0))[1] AS gp20,
            (array_agg(hq40 ORDER BY COALESCE(valid_from, created_at) DESC NULLS LAST, id DESC) FILTER (WHERE hq40 IS NOT NULL AND hq40 > 0))[1] AS hq40,
            (array_agg(thc  ORDER BY COALESCE(valid_from, created_at) DESC NULLS LAST, id DESC) FILTER (WHERE thc  IS NOT NULL AND thc  > 0))[1] AS thc
       FROM freight_rates
      WHERE forwarder = $1 AND carrier IS NOT NULL AND btrim(carrier) <> ''
      GROUP BY lower(btrim(pol)), lower(btrim(pod)), upper(btrim(carrier))`,
    [forwarderName]
  );
  var map = {};
  (rows || []).forEach(function(r){
    map[r.pol + "||" + r.pod + "||" + r.carrier] = { "20GP": pos(r.gp20), "40HQ": pos(r.hq40), thc: pos(r.thc) };
  });
  return map;
}

function rateKey(lane, carrierName){
  return cleanText(lane && lane.pol).toLowerCase() + "||" + cleanText(lane && lane.pod).toLowerCase() + "||" + cleanText(carrierName).toUpperCase();
}

function boxType(v){
  var s = cleanText(v).toUpperCase().replace(/\s+/g, "");
  return s ? s.replace("HC", "HQ") : "";
}

function formatMD(v){
  var t = dateTime(v);
  if (t == null) return null;
  var d = new Date(t);
  var mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  var dd = String(d.getUTCDate()).padStart(2, "0");
  return mm + "/" + dd;
}

function addDays(v, days){
  var t = dateTime(v);
  if (t == null) return null;
  return new Date(t + days * 24 * 60 * 60 * 1000);
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

// 正值否则null(0.00/空 视为无值)
function pos(v){ var n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

// 剥规格括号/内联重量,归纳成短品名(WANPY三规格→一条+截断),避免整串SKU铺进装货表
function stripSpec(label){
  return cleanText(label)
    .replace(/[（(][^（）()]*[）)]/g, " ")
    .replace(/\s\d+(\.\d+)?\s*(KG|G|ML|L)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
function shortCargo(v){
  var s = cleanText(v);
  if (!s) return null;
  var parts = s.split(/\s\/\s/).map(stripSpec).filter(Boolean);
  var seen = {}, base = [];
  parts.forEach(function(p){ var k = p.toUpperCase(); if (!seen[k]) { seen[k] = 1; base.push(p); } });
  if (!base.length) return null;
  var head = base.slice(0, 2).join(" / ");
  if (head.length > 40) head = head.slice(0, 39) + "…";
  return head + (base.length > 2 ? " 等" + base.length + "项" : "");
}

// 对货代只出笼统货描,绝不泄露具体品名(Damon 2026-07-18)。任何非空输入 → {猫砂|宠物食品|宠物用品} 之一,
// 兜底也是"宠物用品"而非原品名;空输入返 null 保持"货描待补"判断不变。
function cargoGeneric(v){
  var s = cleanText(v);
  if (!s) return null;
  var u = s.toUpperCase();
  if (/猫砂|膨润土|豆腐砂|LITTER|BENTONITE|TOFU/.test(u)) return "猫砂";
  if (/猫粮|狗粮|宠物食品|零食|罐头|FOOD|TREAT|SNACK|POUCH|CANNED|\bCAN\b|JELLY|KIBBLE|STICK|BISCUIT|MEAT|LOAF|CHICKEN|SALMON|BEEF|DUCK|FISH|DENTAL|KITTEN|PUPPY/.test(u)) return "宠物食品";
  return "宠物用品";
}

// 接单状态:有船名/订舱号/shipping_status进入booked+ 即视为已接单
var BOOKED_STATES = { booked:"已订舱", arrived:"已到港", shipped:"已开船", departed:"已开船", loaded:"已装船", customs:"报关中" };
function bookingState(row){
  var cn = cleanText(row.current_status_cn);
  if (cn) return cn;
  var ss = cleanText(row.shipping_status).toLowerCase();
  return BOOKED_STATES[ss] || (ss ? "已订舱" : "");
}
function isBooked(row){
  var ss = cleanText(row.shipping_status).toLowerCase();
  if (ss && ss !== "planned" && ss !== "draft" && ss !== "pending") return true;
  if (cleanText(row.vessel) || cleanText(row.booking_no) || cleanText(row.forwarder_booking_no)) return true;
  var stage = cleanText(row.booking_stage).toLowerCase();
  return !!(stage && stage !== "none" && stage !== "pending");
}
// 到港:shipping_status=arrived或中文状态含到港
function isArrived(row){
  var ss = cleanText(row.shipping_status).toLowerCase();
  return ss === "arrived" || /到港|到达/.test(cleanText(row.current_status_cn));
}
// 结束(终态):已完结/交付/归档→移出活跃进历史(账单核销另由closed处理)
var ENDED_STATES = { closed:1, completed:1, delivered:1, archived:1, settled:1, finished:1, done:1 };
function isEnded(row){
  return !!ENDED_STATES[cleanText(row.shipping_status).toLowerCase()] || !!ENDED_STATES[cleanText(row.status).toLowerCase()];
}

function shipment(row, closed){
  var bl = cleanText(row.bl_no);
  var booked = isBooked(row);
  return {
    plan_id:row.id || null,  // 进入协同按票签发协同链接要用(2026-07-17);SELECT本就查了sp.id
    bl_no:bl || null,
    etd:row.etd || null,
    container_qty:numOrNull(row.container_qty),
    gross_weight_kg:numOrNull(row.gross_weight_kg),
    cargo_description:cleanText(row.cargo_generic) || cargoGeneric(row.cargo_description),
    booked_carrier:booked ? (cleanText(row.carrier_code).toUpperCase() || null) : null,
    booking_voyage:booked ? (cleanText(row.voyage) || cleanText(row.vessel) || null) : null,
    booked_etd:booked ? (row.etd || null) : null,
    booked_eta:booked ? (row.eta || null) : null,
    booking_state:booked ? (bookingState(row) || null) : null,
    arrived:booked && isArrived(row),
    closed:!!(bl && closed[bl]),
  };
}

function makeLane(row){
  // 规范优先分组:有 port_id 按 id 归一(裸Port Klang三写法→合并母港);无则文本兜底防回归
  var polKey = row.pol_port_id ? "P" + row.pol_port_id : normalizePort(row.pol);
  var podKey = row.pod_port_id ? "P" + row.pod_port_id : normalizePort(row.pod);
  var polDisp = cleanText(row.pol_canon_en) || cleanText(row.pol_canon_cn) || cleanText(row.pol) || "";
  var podDisp = cleanText(row.pod_canon_en) || cleanText(row.pod_canon_cn) || cleanText(row.pod) || "";
  return {
    lane_key:polKey + "::" + podKey,
    pol:polDisp,
    pod:podDisp,
    pod_terminal_unconfirmed:false,
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
    carriers:[],
    _box:{},
    _cargo:{},
    _carriers:{},
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
  addCarrier(lane, row);
  var gw = s.gross_weight_kg;
  if (gw != null) lane.gw_total += gw;

  var cat = cargoCategory(s.cargo_description);
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
  markMissing(lane, "cargo", !cleanText(s.cargo_description));
  markMissing(lane, "etd", t == null);
  markMissing(lane, "container", qty == null);
}

function addCarrier(lane, row){
  var code = cleanText(row.carrier_code).toUpperCase();
  if (!code) return;
  var carrier = lane._carriers[code] || (lane._carriers[code] = {
    name:code,
    boxes:{},
    latest:null,
    prices:{},
    charge:null,
  });
  var ct = boxType(row.container_type);
  if (ct) carrier.boxes[ct] = true;
  var t = dateTime(row.etd);
  var tk = (t == null ? -1 : t);
  if (t != null && (!carrier.latest || t > carrier.latest.t)) {
    carrier.latest = { t:t, v:row.etd };
  }
  // 运价不再取 shipping_plans.freight_cost(脏:美金/人民币/垃圾混存)——改由 finishCarriers 从 freight_rates 运价库取。
  // 历史港杂(CNY):优先port_surcharge_total,否则各费求和;取最近一条有值的
  var thc = pos(row.thc_fee), seal = pos(row.seal_fee), vgm = pos(row.vgm_fee), doc = pos(row.doc_fee), eir = pos(row.eir_fee);
  var sum = (thc||0)+(seal||0)+(vgm||0)+(doc||0)+(eir||0);
  var pcTotal = pos(row.port_surcharge_total) != null ? pos(row.port_surcharge_total) : (sum > 0 ? sum : null);
  if (ct && pcTotal != null && (!carrier.charge || tk >= carrier.charge.t)) {
    carrier.charge = { t:tk, box:ct, total:pcTotal };
  }
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

function finishCarriers(lane, rateBook){
  lane.carriers = Object.keys(lane._carriers).sort().map(function(code){
    var carrier = lane._carriers[code];
    var etd = carrier.latest ? carrier.latest.v : null;
    var prices = {};
    // 运价真源=freight_rates 运价库,按 pol/pod/船司 匹配该货代供应商价;无匹配则留空(前端显"待填"),绝不回退脏 freight_cost
    var rb = (rateBook || {})[rateKey(lane, carrier.name)] || null;
    if (rb) Object.keys(carrier.boxes).forEach(function(b){ if (rb[b] != null) prices[b] = rb[b]; });
    var out = {
      name:carrier.name,
      boxes:Object.keys(carrier.boxes).sort(),
      etd:formatMD(etd),
      eta:formatMD(addDays(etd, 8)),
      voyage:"",
      prices:prices,
      quoted:Object.keys(prices).length > 0,
    };
    // 港杂也接 freight_rates 运价库(thc,与运价统一口径),挂 40 柜列;无匹配留空前端显"待填",不再用 shipping_plans.port_surcharge_total
    if (rb && rb.thc != null) out.port_charge_40 = rb.thc;
    return out;
  });
}

function finishLane(lane, rateBook){
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
  finishCarriers(lane, rateBook);

  delete lane._box;
  delete lane._cargo;
  delete lane._carriers;
  delete lane._etds;
  delete lane._futureEtds;
  delete lane._missing;
  return lane;
}

function groupActivePlans(rows, closed, rateBook){
  var lanes = {};
  (rows || []).forEach(function(row){
    // Lens:只显示货代已接过单的业务;没接过的不露(免货代拿到工厂信息绕过洋宝宝直接谈)
    if (!isBooked(row)) return;
    // 结束(终态)移出活跃→归历史
    if (isEnded(row)) return;
    var key = (row.pol_port_id ? "P" + row.pol_port_id : normalizePort(row.pol)) + "::" + (row.pod_port_id ? "P" + row.pod_port_id : normalizePort(row.pod));
    if (key === "::") return;
    var lane = lanes[key] || (lanes[key] = makeLane(row));
    // 该 lane 任一票码头未确认(裸母港)→整条标待确认
    if (row.pod_terminal_unconfirmed || row.pod_requires_terminal) lane.pod_terminal_unconfirmed = true;
    addPlan(lane, row, closed);
  });
  return Object.keys(lanes).map(function(k){ return finishLane(lanes[k], rateBook); })
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
  var rateBook = await loadRateBook(pool, supplierName);
  var lanes = groupActivePlans(plans, closed, rateBook);

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
  const loaded = await loadToken(pool, code, req);
  if (loaded.error) return send(res, loaded.error, loaded.body);
  return handleGet(pool, loaded.token, res);
}
