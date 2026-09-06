import { normalizePort } from "../db/_official-port-charges.js";

function text(v) {
  return String(v == null ? "" : v).trim();
}

function pos(v) {
  var n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const LOCAL_PORT_ALIASES = {
  QINGDAO: ["QINGDAO", "青岛"],
  XIAMEN: ["XIAMEN", "厦门"],
  NINGBO: ["NINGBO", "宁波"],
  TIANJIN: ["TIANJIN", "天津"],
  SHANGHAI: ["SHANGHAI", "上海"],
  LIANYUNGANG: ["LIANYUNGANG", "连云港"],
  DALIAN: ["DALIAN", "大连"],
  PORTKLANGWESTPORT: ["PORT KLANG WESTPORT", "PKG WESTPORT", "巴生西"],
  PORTKLANGNORTHPORT: ["PORT KLANG NORTHPORT", "PKG NORTHPORT", "巴生北"],
  KOTAKINABALU: ["KOTA KINABALU", "亚庇"],
  PASIRGUDANG: ["PASIR GUDANG", "新山"],
  CHITTAGONG: ["CHITTAGONG", "吉大港"],
};

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

function normScheduleCarrier(v) {
  return text(v).toUpperCase().replace(/\s+/g, "");
}

function marketCarrierCode(v) {
  var first = text(v).split(/\s+/)[0] || "";
  return /^[A-Za-z0-9-]+$/.test(first) ? normScheduleCarrier(first) : "";
}

function normBox(v) {
  var s = text(v).toUpperCase().replace(/\s+/g, "").replace("HC", "HQ");
  if (s === "20" || s === "20GP") return "20GP";
  if (s === "40" || s === "40GP" || s === "40HQ") return "40HQ";
  return s;
}

function localNormalizePort(v) {
  var official = normalizePort(v);
  var direct = text(v).toUpperCase().replace(/\s+/g, "");
  var keys = Object.keys(LOCAL_PORT_ALIASES);
  for (var i = 0; i < keys.length; i++) {
    var aliases = LOCAL_PORT_ALIASES[keys[i]];
    for (var j = 0; j < aliases.length; j++) {
      var alias = text(aliases[j]).toUpperCase().replace(/\s+/g, "");
      if (official === alias || direct === alias) return keys[i];
    }
  }
  return official.replace(/\s+/g, "");
}

function laneKey(pol, pod, carrier) {
  return normalizePort(pol) + "::" + normalizePort(pod) + "::" + normCarrier(carrier);
}

function scheduleLaneKey(pol, pod, carrier) {
  return localNormalizePort(pol) + "::" + localNormalizePort(pod) + "::" + normScheduleCarrier(carrier);
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
      transit_days: null,
      quoted: false,
      prices: {},
    };
  });
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

async function loadSchedules(pool, carriers, from, to) {
  if (!carriers.length) return [];
  var codes = carriers.map(marketCarrierCode).filter(Boolean);
  if (!codes.length) return [];
  const { rows } = await pool.query(
    `SELECT ms.pol_name, ms.pod_name, ms.carrier, ms.vessel, ms.voyage,
            ms.etd, ms.transit_days, ms.id
       FROM market_sailings ms
      WHERE ms.etd >= $1::date
        AND ms.etd < $2::date
        AND upper(substring(btrim(COALESCE(ms.carrier, '')) from '^[A-Za-z0-9-]+')) = ANY($3::text[])
      ORDER BY ms.etd ASC, ms.id ASC`,
    [from, to, codes]
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

function betterScheduleEntry(next, prev, targetCarrier) {
  if (!prev) return next;
  var nextCarrier = normScheduleCarrier(next.carrier_code);
  var prevCarrier = normScheduleCarrier(prev.carrier_code);
  var target = normScheduleCarrier(targetCarrier);
  if (nextCarrier === target && prevCarrier !== target) return next;
  if (next.etd < prev.etd) return next;
  return prev;
}

function scheduleEntries(rows, pairs) {
  var byLane = {};
  (rows || []).forEach(function(row) {
    var carrierCode = marketCarrierCode(row.carrier);
    if (!carrierCode) return;
    var key = scheduleLaneKey(row.pol_name, row.pod_name, carrierCode);
    if (!pairs[key]) return;
    var etd = cleanDate(row.etd);
    if (!etd) return;
    var entry = {
      etd: etd,
      voyage: text(row.voyage) || null,
      vessel: text(row.vessel) || null,
      transit_days: pos(row.transit_days),
      carrier_code: carrierCode,
      schedule_source: "market_sailings",
    };
    var dedupe = [entry.vessel || "", entry.voyage || "", entry.etd].join("::");
    if (!byLane[key]) byLane[key] = {};
    byLane[key][dedupe] = betterScheduleEntry(entry, byLane[key][dedupe], carrierCode);
  });
  Object.keys(byLane).forEach(function(key) {
    byLane[key] = Object.keys(byLane[key]).map(function(dedupe) {
      return byLane[key][dedupe];
    }).sort(function(a, b) { return a.etd.localeCompare(b.etd); });
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
  week.transit_days = hit.transit_days;
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
  var schedulePairs = {};
  out.forEach(function(lane) {
    (lane.carriers || []).forEach(function(carrier) {
      var carrierCode = marketCarrierCode(carrier && carrier.name);
      if (!carrierCode) return;
      schedulePairs[scheduleLaneKey(lane.pol, lane.pod, carrierCode)] = true;
    });
  });
  if (!pool || !companyId || !meta.carriers.length) {
    out.forEach(function(lane) {
      (lane.carriers || []).forEach(function(carrier) { carrier.weeks = buildWeeks(new Date()); });
    });
    return out;
  }
  var from = template[0].from;
  var to = template[2].to;
  var schedules = scheduleEntries(await loadSchedules(pool, meta.carriers, from, to), schedulePairs);
  var rfqs = groupPriceRows(await loadRfqItems(pool, companyId, meta.carriers, from, to), meta.pairs);
  var rates = groupPriceRows(await loadRates(pool, companyId, meta.carriers, from, to), meta.pairs);
  out.forEach(function(lane) {
    (lane.carriers || []).forEach(function(carrier) {
      var key = laneKey(lane.pol, lane.pod, carrier.name);
      var scheduleKey = scheduleLaneKey(lane.pol, lane.pod, marketCarrierCode(carrier.name));
      var weeks = buildWeeks(new Date());
      weeks.forEach(function(week) { applySchedule(week, schedules[scheduleKey]); });
      applyRfqPrices(weeks, rfqs[key]);
      applyRatePrices(weeks, rates[key]);
      weeks.forEach(function(week) { week.quoted = Object.keys(week.prices).length > 0; });
      carrier.weeks = weeks;
    });
  });
  return out;
}
