import { localNormalizePort } from "./_lane-weeks.js";

var RATE_SERVICES = ["truck", "customs"];

export const SERVICE_STATUS_SQL = `
SELECT service, factory, port, container_type, tier, rate_cny, rate_cny_ex_tax,
       tax_rate, service_nature, updated_at
  FROM forwarder_service_rates
 WHERE forwarder_company_id = $1
   AND service = ANY($2::text[])
   AND rate_cny > 0
 ORDER BY service, updated_at DESC NULLS LAST, id DESC`;

export const SERVICE_PLAN_SQL = `
SELECT sp.id,
       sp.pol,
       sp.container_type AS plan_container_type,
       sp.order_nos,
       ofac.factory,
       ofac.order_container_type
  FROM shipping_plans sp
  LEFT JOIN LATERAL (
    SELECT DISTINCT
           COALESCE(NULLIF(BTRIM(o.factory), ''), '未标注工厂') AS factory,
           o.container_type AS order_container_type
      FROM orders o
     WHERE o.order_no = ANY(sp.order_nos)
  ) ofac ON true
 WHERE sp.id = ANY($1::int[])
   AND COALESCE(sp.etd, sp.created_at::date, CURRENT_DATE) >= CURRENT_DATE - INTERVAL '6 months'
   -- 与 forwarder-services.js:getShipRows 同源:只取货代已接过单的票；改一处要改两处
   AND (
     (sp.shipping_status IS NOT NULL AND lower(sp.shipping_status) NOT IN ('planned','draft','pending'))
     OR sp.carrier_code IS NOT NULL OR sp.vessel IS NOT NULL OR sp.booking_no IS NOT NULL
   )`;

function text(v) {
  return String(v == null ? "" : v).trim();
}

function num(v) {
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normBox(v) {
  var s = text(v).toUpperCase();
  if (!s) return "";
  if (s.indexOf("20") !== -1) return "20GP";
  if (s.indexOf("40") !== -1) return "40HQ";
  return s;
}

function ymd(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  var d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function planIds(lane) {
  var seen = {};
  var out = [];
  (lane.shipments || []).forEach(function(s) {
    var id = Number(s && s.plan_id);
    if (!Number.isInteger(id) || id <= 0 || seen[id]) return;
    seen[id] = true;
    out.push(id);
  });
  return out;
}

function rateKey(row) {
  return [
    localNormalizePort(row && row.port),
    text(row && row.factory),
    normBox(row && row.container_type),
  ].join("\u0001");
}

function comboKey(combo) {
  return [combo.port, combo.factory, combo.box].join("\u0001");
}

function portKey(port) {
  return [port, "", ""].join("\u0001");
}

function factoryName(row) {
  return text(row && row.factory) || "未标注工厂";
}

function planPort(row, lanePort) {
  return localNormalizePort(row && row.pol) || lanePort;
}

function planBox(row) {
  return normBox(row && (row.plan_container_type || row.order_container_type));
}

function combosForLane(ids, rows, lanePort) {
  var idSet = {};
  ids.forEach(function(id) { idSet[id] = true; });
  var seen = {};
  var out = [];
  (rows || []).forEach(function(row) {
    var id = Number(row.id);
    if (!idSet[id]) return;
    var port = planPort(row, lanePort);
    if (lanePort && port !== lanePort) return;
    var factory = factoryName(row);
    var box = planBox(row);
    if (!port || !factory || !box) return;
    var combo = { port:port, factory:factory, box:box };
    var key = comboKey(combo);
    if (seen[key]) return;
    seen[key] = true;
    out.push(combo);
  });
  return out;
}

function portsForLane(ids, rows, lanePort) {
  var idSet = {};
  ids.forEach(function(id) { idSet[id] = true; });
  var seen = {};
  (rows || []).forEach(function(row) {
    var id = Number(row.id);
    if (!idSet[id]) return;
    var port = planPort(row, lanePort);
    if (!port || (lanePort && port !== lanePort)) return;
    seen[port] = true;
  });
  return Object.keys(seen);
}

function buildRateMap(rows) {
  var map = {};
  (rows || []).forEach(function(row) {
    var svc = text(row && row.service).toLowerCase();
    if (RATE_SERVICES.indexOf(svc) === -1) return;
    var key = rateKey(row);
    var rate = num(row && row.rate_cny);
    var exTax = num(row && row.rate_cny_ex_tax);
    var comparable = exTax != null && num(row && row.tax_rate) != null && text(row && row.service_nature) !== "";
    if (!key || rate == null || rate <= 0) return;
    var bySvc = map[svc] || (map[svc] = {});
    if (!bySvc[key]) {
      bySvc[key] = { quoted:true, comparable:comparable, updated_at:ymd(row.updated_at) };
      if (comparable) {
        bySvc[key].rate_cny = exTax;
        bySvc[key].rate_cny_max = exTax;
      }
      return;
    }
    bySvc[key].quoted = true;
    bySvc[key].comparable = bySvc[key].comparable || comparable;
    if (!comparable) return;
    bySvc[key].rate_cny = bySvc[key].rate_cny == null ? exTax : Math.min(bySvc[key].rate_cny, exTax);
    bySvc[key].rate_cny_max = bySvc[key].rate_cny_max == null ? exTax : Math.max(bySvc[key].rate_cny_max, exTax);
  });
  return map;
}

function mergeHit(best, hit) {
  if (!hit) return best;
  if (!hit.comparable) return best;
  if (!best) return { rate_cny:hit.rate_cny, rate_cny_max:hit.rate_cny_max, updated_at:hit.updated_at };
  best.rate_cny = Math.min(best.rate_cny, hit.rate_cny);
  best.rate_cny_max = Math.max(best.rate_cny_max, hit.rate_cny_max);
  return best;
}

function finishStatus(covered, total, best) {
  var out = {
    state:covered > 0 ? "has_rate" : "no_rate",
    covered:covered,
    total:total,
    comparable_ex_tax:!!best,
  };
  if (best) {
    out.rate_cny = best.rate_cny;
    if (best.rate_cny_max !== best.rate_cny) out.rate_cny_max = best.rate_cny_max;
    out.updated_at = best.updated_at;
  }
  return out;
}

function statusForTruck(combos, rates) {
  var bySvc = rates.truck || {};
  var covered = 0;
  var best = null;
  combos.forEach(function(combo) {
    var hit = bySvc[comboKey(combo)];
    if (!hit) return;
    covered += 1;
    best = mergeHit(best, hit);
  });
  return finishStatus(covered, combos.length, best);
}

function statusForCustoms(combos, ports, rates) {
  var bySvc = rates.customs || {};
  var portState = {};
  (ports || []).forEach(function(port) {
    if (port) portState[port] = { covered:false, best:null };
  });
  combos.forEach(function(combo) {
    var port = combo && combo.port;
    if (!port) return;
    var entry = portState[port] || (portState[port] = { covered:false, best:null });
    var comboHit = bySvc[comboKey(combo)], portHit = bySvc[portKey(port)];
    if (!comboHit && !portHit) return;
    entry.covered = true;
    entry.best = mergeHit(mergeHit(entry.best, comboHit), portHit);
  });
  Object.keys(portState).forEach(function(port) {
    var entry = portState[port];
    if (entry.covered) return;
    var hit = bySvc[portKey(port)];
    if (!hit) return;
    entry.best = mergeHit(entry.best, hit);
    entry.covered = true;
  });
  var total = Object.keys(portState).length;
  var covered = 0;
  var best = null;
  Object.keys(portState).forEach(function(port) {
    var entry = portState[port];
    if (!entry.covered) return;
    covered += 1;
    best = mergeHit(best, entry.best);
  });
  return finishStatus(covered, total, best);
}

export async function attachForwarderServiceStatus(pool, token, lanes) {
  var companyId = token && token.company_id ? Number(token.company_id) : null;
  if (!companyId) return lanes;

  var lanePlans = new Map();
  var all = [];
  var seen = {};
  (lanes || []).forEach(function(lane) {
    var ids = planIds(lane);
    lanePlans.set(lane, ids);
    ids.forEach(function(id) {
      if (seen[id]) return;
      seen[id] = true;
      all.push(id);
    });
  });
  if (!all.length) return lanes;

  var planRows = (await pool.query(SERVICE_PLAN_SQL, [all])).rows;
  var rateRows = (await pool.query(SERVICE_STATUS_SQL, [companyId, RATE_SERVICES])).rows;
  var rates = buildRateMap(rateRows);

  (lanes || []).forEach(function(lane) {
    var lanePort = localNormalizePort(lane && lane.pol);
    var combos = combosForLane(lanePlans.get(lane) || [], planRows, lanePort);
    var customsPorts = portsForLane(lanePlans.get(lane) || [], planRows, lanePort);
    lane.service_status = {
      truck:statusForTruck(combos, rates),
      customs:statusForCustoms(combos, customsPorts, rates),
    };
  });
  return lanes;
}
