var SERVICES = ["truck", "customs", "insurance"];
var RANK = { not_invited:0, invited:1, quoted:2, awarded:3 };

export const SERVICE_STATUS_SQL = `
SELECT r.shipping_plan_id,
       COALESCE(r.service_type, 'ocean') AS service_type,
       r.status AS rfq_status,
       i.id AS item_id,
       i.selected,
       i.usd_rate,
       i.freight_usd,
       i.total_usd,
       i.port_surcharge,
       i.thc,
       i.doc_fee
  FROM freight_rfqs r
  LEFT JOIN freight_rfq_items i
    ON i.rfq_id = r.id
   AND (($2::int IS NOT NULL AND i.forwarder_company_id = $2)
     OR ($2::int IS NULL AND $3::text <> '' AND i.forwarder_co = $3))
 WHERE r.shipping_plan_id = ANY($1::int[])
   AND COALESCE(r.service_type, 'ocean') = ANY($4::text[])
 ORDER BY r.shipping_plan_id, service_type, r.id`;

function text(v) {
  return String(v == null ? "" : v).trim();
}

function emptyCounts() {
  return { not_invited:0, invited:0, quoted:0, awarded:0 };
}

function emptyBucket() {
  return {
    state:"not_invited",
    counts:emptyCounts(),
  };
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

function pricePositive(row) {
  return ["usd_rate", "freight_usd", "total_usd", "port_surcharge", "thc", "doc_fee"].some(function(k) {
    var n = Number(row && row[k]);
    return Number.isFinite(n) && n > 0;
  });
}

function better(a, b) {
  return RANK[a] >= RANK[b] ? a : b;
}

function rowState(row) {
  if (!row) return "not_invited";
  if (text(row.rfq_status).toLowerCase() === "awarded" || row.selected === true) return "awarded";
  if (row.item_id == null) return "invited";
  return pricePositive(row) ? "quoted" : "invited";
}

function buildPlanMap(rows) {
  var map = {};
  (rows || []).forEach(function(row) {
    var pid = Number(row.shipping_plan_id);
    var svc = text(row.service_type).toLowerCase();
    if (!Number.isInteger(pid) || SERVICES.indexOf(svc) === -1) return;
    var bySvc = map[pid] || (map[pid] = {});
    bySvc[svc] = better(rowState(row), bySvc[svc] || "not_invited");
  });
  return map;
}

function laneStatus(ids, byPlan) {
  var out = {};
  SERVICES.forEach(function(svc) {
    var bucket = emptyBucket();
    ids.forEach(function(pid) {
      var state = byPlan[pid] && byPlan[pid][svc] ? byPlan[pid][svc] : "not_invited";
      bucket.counts[state] += 1;
      bucket.state = better(state, bucket.state);
    });
    out[svc] = bucket;
  });
  return out;
}

export async function attachForwarderServiceStatus(pool, token, lanes) {
  var companyId = token && token.company_id ? Number(token.company_id) : null;
  var forwarderCo = text(token && token.forwarder_co);
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
  if (!all.length || (!companyId && !forwarderCo)) return lanes;

  var rows = (await pool.query(SERVICE_STATUS_SQL, [all, companyId, forwarderCo, SERVICES])).rows;
  var byPlan = buildPlanMap(rows);
  (lanes || []).forEach(function(lane) {
    lane.service_status = laneStatus(lanePlans.get(lane) || [], byPlan);
  });
  return lanes;
}
