import { attachLaneWeeks } from "./_lane-weeks.js";

function send(res, status, body){
  res.status(status).json(body);
}

function text(v){
  return String(v == null ? "" : v).trim();
}

function numOrNull(v){
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ymd(date){
  var d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + "-" + (m < 10 ? "0" + m : String(m)) + "-" + (day < 10 ? "0" + day : String(day));
}

function addDays(date, days){
  if (days == null) return null;
  var n = Number(days);
  if (!Number.isFinite(n)) return null;
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

function dateFromOffset(today, offset){
  var d = addDays(today, offset);
  return d ? ymd(d) : null;
}

async function hasDemoRows(pool, demoSetId){
  try {
    const { rows } = await pool.query(
      "SELECT 1 FROM demo.forwarder_shipping_plans WHERE demo_set_id = $1 LIMIT 1",
      [demoSetId]
    );
    return rows.length > 0;
  } catch (e) {
    return false;
  }
}

function emptyDemoBody(token){
  return {
    ok:true,
    demo:true,
    forwarder_co:token.forwarder_co || "",
    company_id:token.company_id || null,
    preferred_carriers:[],
    lanes:[],
    carrier_catalog:[],
  };
}

function shipment(row, events, today){
  var etd = dateFromOffset(today, row.etd_offset_days) || row.etd || null;
  var eta = dateFromOffset(today, row.eta_offset_days) || row.eta || null;
  var delivery = dateFromOffset(today, row.delivery_offset_days);
  var delayCount = events.length;
  var first = events[0] || null;
  var last = events[events.length - 1] || null;
  var state = etd ? (text(row.current_status_cn) || "已订舱") : "货好未发 / 待订舱";
  return {
    plan_id:row.id,
    demo_plan_id:row.demo_plan_id,
    bl_no:null,
    etd:etd,
    delivery_date:delivery,
    container_qty:numOrNull(row.container_qty),
    gross_weight_kg:numOrNull(row.gross_weight_kg),
    cargo_description:text(row.cargo_description) || null,
    booked_carrier:etd ? (text(row.carrier_code).toUpperCase() || null) : null,
    booking_voyage:etd ? ([text(row.vessel), text(row.voyage)].filter(Boolean).join(" ") || null) : null,
    booked_etd:etd,
    booked_eta:eta,
    booking_state:state,
    arrived:false,
    is_pending:true,
    bill_settled:false,
    closed:false,
    delivery_change_count:delayCount,
    delivery_change_summary:delayCount ? {
      original_date:first ? first.old_value : null,
      current_date:last ? last.new_value : delivery,
      text:"原定 " + (first ? first.old_value : "") + " → 已推迟 " + delayCount + " 次 → 现 " + (last ? last.new_value : delivery),
    } : null,
    delivery_change_events:events,
  };
}

function makeLane(row){
  return {
    lane_key:text(row.pol) + "::" + text(row.pod),
    pol:text(row.pol),
    pod:text(row.pod),
    pod_terminal_unconfirmed:row.pod_terminal_unconfirmed === true,
    order_count:0,
    nearest_etd:null,
    total_containers:0,
    box_summary:null,
    cargo_types:[],
    summary_text:null,
    gw_total:0,
    hot:false,
    countdown_hint:null,
    shipments:[],
    missing:[],
    carriers:[],
    stale_orders:0,
    pending_orders:0,
    pending_containers:0,
    _box:{},
    _cargo:{},
    _carriers:{},
    _etds:[],
  };
}

function cargoCategory(v){
  var s = text(v);
  if (!s) return "";
  return s.split(/[;；,，、\n/|]+/).map(text).filter(Boolean)[0] || "";
}

function addCarrier(lane, row, etd){
  var code = text(row.carrier_code).toUpperCase();
  if (!code) return;
  var carrier = lane._carriers[code] || (lane._carriers[code] = {
    name:code,
    boxes:{},
    latest:null,
    prices:{},
    charge:null,
  });
  var ct = text(row.container_type).toUpperCase().replace(/\s+/g, "").replace("HC", "HQ");
  if (ct) carrier.boxes[ct] = true;
  if (etd && (!carrier.latest || etd > carrier.latest.v)) carrier.latest = { v:etd };
  var n = numOrNull(row.freight_cost);
  if (ct && n != null) carrier.prices[ct] = n;
  var port = numOrNull(row.port_surcharge_total);
  if (ct && port != null) carrier.charge = { box:ct, total:port };
}

function finishLane(lane){
  var boxes = Object.keys(lane._box).sort();
  lane.box_summary = boxes.length ? boxes.map(function(k){ return lane._box[k] + "×" + k; }).join(" / ") : null;
  lane.cargo_types = lane.cargo_types.length ? lane.cargo_types : null;
  lane.gw_total = lane.gw_total || null;
  lane.nearest_etd = lane._etds.sort()[0] || null;
  lane.countdown_hint = lane.nearest_etd;
  lane.hot = !!lane.nearest_etd;
  lane.carriers = Object.keys(lane._carriers).sort().map(function(code){
    var carrier = lane._carriers[code];
    var prices = {};
    Object.keys(carrier.prices).forEach(function(k){ prices[k] = carrier.prices[k]; });
    var out = {
      name:carrier.name,
      boxes:Object.keys(carrier.boxes).sort(),
      etd:carrier.latest ? carrier.latest.v.slice(5) : null,
      eta:null,
      voyage:"",
      prices:prices,
      quoted:Object.keys(prices).length > 0,
    };
    if (carrier.charge) {
      if (/40/.test(carrier.charge.box)) out.port_charge_40 = carrier.charge.total;
      else out.port_charge_20 = carrier.charge.total;
    }
    return out;
  });
  delete lane._box; delete lane._cargo; delete lane._carriers; delete lane._etds;
  return lane;
}

function eventDate(today, value, raw, key){
  var off = raw && raw[key];
  var d = dateFromOffset(today, off);
  return d || text(value) || null;
}

async function loadDemoPlans(pool, demoSetId, today){
  const { rows } = await pool.query(
    `SELECT p.*
       FROM demo.forwarder_shipping_plans p
      WHERE p.demo_set_id = $1
      ORDER BY p.lane_seq, p.plan_seq, p.id`,
    [demoSetId]
  );
  const ev = await pool.query(
    `SELECT e.demo_plan_id, e.seq, e.old_value, e.new_value, e.reason, e.actor, e.raw
       FROM demo.forwarder_delivery_change_events e
       JOIN demo.forwarder_shipping_plans p ON p.id = e.demo_plan_id
      WHERE p.demo_set_id = $1
      ORDER BY e.demo_plan_id, e.seq`,
    [demoSetId]
  );
  var byPlan = {};
  ev.rows.forEach(function(row){
    var raw = row.raw || {};
    var list = byPlan[row.demo_plan_id] || (byPlan[row.demo_plan_id] = []);
    list.push({
      seq:row.seq,
      old_value:eventDate(today, row.old_value, raw, "old_offset_days"),
      new_value:eventDate(today, row.new_value, raw, "new_offset_days"),
      reason:text(row.reason) || null,
      actor:text(row.actor) || null,
    });
  });
  return rows.map(function(row){ row._events = byPlan[row.id] || []; return row; });
}

function groupLanes(rows, today){
  var lanes = {};
  rows.forEach(function(row){
    var key = text(row.pol) + "::" + text(row.pod);
    if (key === "::") return;
    var lane = lanes[key] || (lanes[key] = makeLane(row));
    var s = shipment(row, row._events || [], today);
    lane.shipments.push(s);
    lane.order_count += 1;
    lane.pending_orders += 1;
    var qty = numOrNull(row.container_qty);
    var ct = text(row.container_type).toUpperCase().replace(/\s+/g, "").replace("HC", "HQ");
    if (qty != null) {
      lane.total_containers += qty;
      lane.pending_containers += qty;
      if (ct) lane._box[ct] = (lane._box[ct] || 0) + qty;
    }
    var gw = numOrNull(row.gross_weight_kg);
    if (gw != null) lane.gw_total += gw;
    var cat = cargoCategory(row.cargo_description);
    if (cat && !lane._cargo[cat]) { lane._cargo[cat] = true; lane.cargo_types.push(cat); }
    if (s.etd) lane._etds.push(s.etd);
    addCarrier(lane, row, s.etd);
  });
  return Object.keys(lanes).map(function(k){ return finishLane(lanes[k]); });
}

export async function handleDemoGet(pool, token, res){
  if (!token.demo_set_id) {
    return send(res, 200, emptyDemoBody(token));
  }

  var hasRows = await hasDemoRows(pool, token.demo_set_id);
  if (!hasRows) return send(res, 200, emptyDemoBody(token));

  var today = new Date();
  today.setHours(0, 0, 0, 0);
  var plans = await loadDemoPlans(pool, token.demo_set_id, today);
  var lanes = await attachLaneWeeks(pool, token.company_id, groupLanes(plans, today));
  return send(res, 200, {
    ok:true,
    demo:true,
    forwarder_co:token.forwarder_co || "",
    company_id:token.company_id || null,
    preferred_carriers:[],
    lanes:lanes,
    carrier_catalog:[],
  });
}
