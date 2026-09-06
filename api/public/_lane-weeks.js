import { normalizePort } from "../db/_official-port-charges.js";

function text(v) {
  return String(v == null ? "" : v).trim();
}

function pos(v) {
  var n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function ymd(date) {
  var d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return null;
  var y = d.getFullYear();
  var m = d.getMonth() + 1;
  var day = d.getDate();
  return y + "-" + (m < 10 ? "0" + m : String(m)) + "-" + (day < 10 ? "0" + day : String(day));
}

function addDays(date, days) {
  var d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

function cleanDate(v) {
  var s = text(v);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  return v ? ymd(v) : null;
}

function normCarrier(v) {
  return text(v).toUpperCase().replace(/\s+/g, " ");
}

function normBox(v) {
  var s = text(v).toUpperCase().replace(/\s+/g, "").replace("HC", "HQ");
  if (s === "20" || s === "20GP") return "20GP";
  if (s === "40" || s === "40GP" || s === "40HQ") return "40HQ";
  return s;
}

function laneKey(pol, pod, carrier) {
  return normalizePort(pol) + "::" + normalizePort(pod) + "::" + normCarrier(carrier);
}

function buildWeeks(today) {
  var labels = ["本周", "次周", "第三周"];
  var base = new Date(today.getTime());
  base.setHours(0, 0, 0, 0);
  return labels.map(function(label, idx) {
    var from = addDays(base, idx * 7);
    var to = addDays(base, (idx + 1) * 7);
    return {
      idx: idx,
      label: label,
      from: ymd(from),
      to: ymd(to),
      etd: null,
      voyage: null,
      vessel: null,
      schedule_source: null,
      quoted: false,
      prices: {},
    };
  });
}

function parseDepartures(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    var parsed = JSON.parse(v || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function inWindow(day, week) {
  return day && day >= week.from && day < week.to;
}

function mergePrice(prices, box, amount) {
  var b = normBox(box);
  var n = pos(amount);
  if (!b || n == null) return;
  if (prices[b] == null) prices[b] = n;
}

function collectPairs(lanes) {
  var carriers = {};
  var pairs = {};
  (lanes || []).forEach(function(lane) {
    (lane.carriers || []).forEach(function(carrier) {
      var code = normCarrier(carrier && carrier.name);
      if (!code) return;
      carriers[code] = true;
      pairs[laneKey(lane.pol, lane.pod, code)] = true;
    });
  });
  return { carriers: Object.keys(carriers), pairs: pairs };
}

async function loadSchedules(pool, carriers) {
  if (!carriers.length) return [];
  const { rows } = await pool.query(
    `SELECT ss.pol, ss.pod, ss.carrier_name, ss.next_sailing, ss.all_departures
       FROM ship_schedules ss
      WHERE upper(btrim(COALESCE(ss.carrier_name, ''))) = ANY($1::text[])`,
    [carriers]
  );
  return rows;
}

async function loadRfqItems(pool, companyId, carriers, from, to) {
  if (!carriers.length) return [];
  const { rows } = await pool.query(
    `SELECT i.usd_rate, i.container_type, i.etd, i.carrier, r.pol, r.pod, i.submitted_at, i.id
       FROM freight_rfq_items i
       JOIN freight_rfqs r ON r.id = i.rfq_id
      WHERE i.forwarder_company_id = $1
        AND upper(btrim(COALESCE(i.carrier, ''))) = ANY($2::text[])
        AND i.etd >= $3::date
        AND i.etd < $4::date
      ORDER BY i.submitted_at DESC NULLS LAST, i.id DESC`,
    [companyId, carriers, from, to]
  );
  return rows;
}

async function loadRates(pool, companyId, carriers, from, to) {
  if (!carriers.length) return [];
  const { rows } = await pool.query(
    `SELECT fr.gp20, fr.hq40, fr.carrier, fr.pol, fr.pod, fr.valid_from, fr.valid_to, fr.updated_at, fr.id
       FROM freight_rates fr
      WHERE fr.forwarder_company_id = $1
        AND upper(btrim(COALESCE(fr.carrier, ''))) = ANY($2::text[])
        AND COALESCE(fr.status, '') <> 'withdrawn'
        AND (fr.valid_from IS NOT NULL OR fr.valid_to IS NOT NULL)
        AND COALESCE(fr.valid_from::date, '-infinity'::date) < $4::date
        AND COALESCE(fr.valid_to::date, 'infinity'::date) >= $3::date
      ORDER BY fr.updated_at DESC NULLS LAST, fr.id DESC`,
    [companyId, carriers, from, to]
  );
  return rows;
}

function scheduleEntries(rows, pairs) {
  var byLane = {};
  (rows || []).forEach(function(row) {
    var key = laneKey(row.pol, row.pod, row.carrier_name);
    if (!pairs[key]) return;
    var deps = parseDepartures(row.all_departures);
    if (row.next_sailing) deps.push({ etd: row.next_sailing });
    deps.forEach(function(dep) {
      var etd = cleanDate(dep && dep.etd);
      if (!etd) return;
      var entry = {
        etd: etd,
        voyage: text(dep && dep.voyage) || null,
        vessel: text(dep && dep.vessel) || null,
        schedule_source: "ship_schedules",
      };
      if (!byLane[key]) byLane[key] = [];
      byLane[key].push(entry);
    });
  });
  Object.keys(byLane).forEach(function(key) {
    byLane[key].sort(function(a, b) { return a.etd.localeCompare(b.etd); });
  });
  return byLane;
}

function applySchedule(week, entries) {
  var hit = (entries || []).find(function(entry) { return inWindow(entry.etd, week); });
  if (!hit) return;
  week.etd = hit.etd;
  week.voyage = hit.voyage;
  week.vessel = hit.vessel;
  week.schedule_source = hit.schedule_source;
}

function applyRfqPrices(weeks, rows) {
  (rows || []).forEach(function(row) {
    var etd = cleanDate(row.etd);
    weeks.forEach(function(week) {
      if (inWindow(etd, week)) mergePrice(week.prices, row.container_type, row.usd_rate);
    });
  });
}

function applyRatePrices(weeks, rows) {
  (rows || []).forEach(function(row) {
    var validFrom = cleanDate(row.valid_from) || "0000-01-01";
    var validTo = cleanDate(row.valid_to) || "9999-12-31";
    weeks.forEach(function(week) {
      if (validFrom < week.to && validTo >= week.from) {
        mergePrice(week.prices, "20GP", row.gp20);
        mergePrice(week.prices, "40HQ", row.hq40);
      }
    });
  });
}

function groupPriceRows(rows, pairs) {
  var out = {};
  (rows || []).forEach(function(row) {
    var key = laneKey(row.pol, row.pod, row.carrier);
    if (!pairs[key]) return;
    if (!out[key]) out[key] = [];
    out[key].push(row);
  });
  return out;
}

export async function attachLaneWeeks(pool, companyId, lanes) {
  var out = Array.isArray(lanes) ? lanes : [];
  var meta = collectPairs(out);
  var template = buildWeeks(new Date());
  if (!pool || !companyId || !meta.carriers.length) {
    out.forEach(function(lane) {
      (lane.carriers || []).forEach(function(carrier) { carrier.weeks = buildWeeks(new Date()); });
    });
    return out;
  }
  var from = template[0].from;
  var to = template[2].to;
  var schedules = scheduleEntries(await loadSchedules(pool, meta.carriers), meta.pairs);
  var rfqs = groupPriceRows(await loadRfqItems(pool, companyId, meta.carriers, from, to), meta.pairs);
  var rates = groupPriceRows(await loadRates(pool, companyId, meta.carriers, from, to), meta.pairs);
  out.forEach(function(lane) {
    (lane.carriers || []).forEach(function(carrier) {
      var key = laneKey(lane.pol, lane.pod, carrier.name);
      var weeks = buildWeeks(new Date());
      weeks.forEach(function(week) { applySchedule(week, schedules[key]); });
      applyRfqPrices(weeks, rfqs[key]);
      applyRatePrices(weeks, rates[key]);
      weeks.forEach(function(week) { week.quoted = Object.keys(week.prices).length > 0; });
      carrier.weeks = weeks;
    });
  });
  return out;
}
