import { localNormalizePort } from "./_lane-weeks.js";

var RATE_SERVICES = ["truck", "customs"];

export const SERVICE_STATUS_SQL = `
SELECT service, factory, port, container_type, rate_cny, updated_at
  FROM forwarder_service_rates
 WHERE forwarder_company_id = $1
   AND service = ANY($2::text[])
   AND rate_cny > 0
 ORDER BY service, updated_at DESC NULLS LAST, id DESC`;

export const SERVICE_PLAN_SQL = `
SELECT sp.id,
       sp.pol,
       sp.container_type AS plan_container_type,
       sp.factory_company_id AS plan_factory_company_id,
       sp.order_nos,
       sp_cf.name_cn AS plan_factory_name_cn,
       sp_cf.name_en AS plan_factory_name_en,
       sp_cf.code AS plan_factory_code,
       ofac.factory,
       ofac.factory_company_id,
       ofac.factory_name_cn,
       ofac.factory_name_en,
       ofac.factory_code,
       ofac.order_container_type
  FROM shipping_plans sp
  LEFT JOIN companies sp_cf ON sp_cf.id = sp.factory_company_id
  LEFT JOIN LATERAL (
    SELECT DISTINCT
           o.factory,
           o.factory_company_id,
           c.name_cn AS factory_name_cn,
           c.name_en AS factory_name_en,
           c.code AS factory_code,
           o.container_type AS order_container_type
      FROM orders o
      LEFT JOIN companies c ON c.id = o.factory_company_id
     WHERE o.order_no = ANY(sp.order_nos)
  ) ofac ON true
 WHERE sp.id = ANY($1::int[])`;

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
  return d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0") + "-" + String(d.getUTCDate()).padStart(2, "0");
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

function factoryName(row) {
  return text(row && row.factory)
    || text(row && row.factory_name_cn)
    || text(row && row.factory_name_en)
    || text(row && row.factory_code)
    || text(row && row.plan_factory_name_cn)
    || text(row && row.plan_factory_name_en)
    || text(row && row.plan_factory_code);
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

function buildRateMap(rows) {
  var map = {};
  (rows || []).forEach(function(row) {
    var svc = text(row && row.service).toLowerCase();
    if (RATE_SERVICES.indexOf(svc) === -1) return;
    var key = rateKey(row);
    var rate = num(row && row.rate_cny);
    if (!key || rate == null || rate <= 0) return;
    var bySvc = map[svc] || (map[svc] = {});
    if (!bySvc[key]) {
      bySvc[key] = { rate_cny:rate, updated_at:ymd(row.updated_at) };
    }
  });
  return map;
}

function statusFor(svc, combos, rates) {
  var bySvc = rates[svc] || {};
  var covered = 0;
  var first = null;
  combos.forEach(function(combo) {
    var hit = bySvc[comboKey(combo)];
    if (!hit) return;
    covered += 1;
    if (!first) first = hit;
  });
  var out = {
    state:covered > 0 ? "has_rate" : "no_rate",
    covered:covered,
    total:combos.length,
  };
  if (first) {
    out.rate_cny = first.rate_cny;
    out.updated_at = first.updated_at;
  }
  return out;
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
    lane.service_status = {
      truck:statusFor("truck", combos, rates),
      customs:statusFor("customs", combos, rates),
    };
  });
  return lanes;
}
