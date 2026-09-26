import { normalizePort } from "../db/_official-port-charges.js";

function text(v) {
  return String(v == null ? "" : v).trim();
}

function stripLeadingCn(v) {
  var raw = text(v);
  var stripped = raw.replace(/^[\u4e00-\u9fff]+/, "").trim();
  return stripped || raw;
}

function portCacheKey(v) {
  return stripLeadingCn(v).toUpperCase().replace(/\s+/g, "");
}

function pos(v) {
  var n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export const LOCAL_PORT_ALIASES = {
  QINGDAO: ["QINGDAO", "青岛"],
  XIAMEN: ["XIAMEN", "厦门"],
  NINGBO: ["NINGBO", "宁波"],
  TIANJIN: ["TIANJIN", "天津"],
  SHANGHAI: ["SHANGHAI", "上海"],
  LIANYUNGANG: ["LIANYUNGANG", "连云港"],
  DALIAN: ["DALIAN", "大连"],
  PORTKLANG: ["PORT KLANG", "PORT KELANG", "KLANG", "KELANG", "巴生港", "巴生"],
  PORTKLANGWESTPORT: ["PORT KLANG WESTPORT", "PORT KLANG WEST", "PORT KELANG WEST", "PORT KELANG WESTPORT", "PKG WESTPORT", "巴生西"],
  PORTKLANGNORTHPORT: ["PORT KLANG NORTHPORT", "PORT KLANG NORTH", "PKG NORTHPORT", "巴生北"],
  KOTAKINABALU: ["KOTA KINABALU", "亚庇"],
  PASIRGUDANG: ["PASIR GUDANG", "新山"],
  CHITTAGONG: ["CHITTAGONG", "吉大港"],
};

var localPortCache = null;
var localPortCacheLoading = null;
var lastPortCacheWarnAt = 0;

// 与 forwarder-services.js:ensurePortCache 同源,改一处要改两处
export async function ensureLocalPortCache(pool) {
  if (localPortCache) return localPortCache;
  if (!localPortCacheLoading) {
    localPortCacheLoading = pool.query(
      "SELECT name_cn, unlocode, code FROM ports WHERE COALESCE(name_cn, '') <> ''"
    ).then(function(q) {
      var map = {};
      (q.rows || []).forEach(function(r) {
        var name = text(r.name_cn);
        [r.unlocode, r.code, r.name_cn].forEach(function(v) {
          var key = portCacheKey(v);
          if (name && key) map[key] = name;
        });
      });
      localPortCache = map;
      localPortCacheLoading = null;
      return map;
    }).catch(function(e) {
      var now = Date.now();
      if (now - lastPortCacheWarnAt > 60000) {
        lastPortCacheWarnAt = now;
        console.warn("[_lane-weeks] ports cache unavailable; using static aliases", e && e.message);
      }
      localPortCacheLoading = null;
      return {};
    });
  }
  return localPortCacheLoading;
}

export const MARKET_CARRIER_ALIASES = {
  "IAL运达航运": "IAL",
  "ESL阿联酋": "ESL",
  "GFS格飞驰": "GFS",
  "南星": "NAMSUNG",
  "SML森罗": "SML",
  "CSL可达利": "CSL",
  "SKR长锦": "SKR",
  "WIN-FAST永发": "WIN-FAST",
  "HAL兴亚": "HAL",
  "ASL亚海": "ASL",
  "外运集运": "外运",
  "TGL亿发": "TGL",
  "TCLC太海集运": "TCLC",
  "合德海运": "合德",
  "SLG海杰航运": "SLG",
  "CUL中联航运": "CUL",
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

function localDateFromYmd(v) {
  var m = text(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function cleanDate(v) {
  var s = text(v);
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  return v ? ymd(v) : null;
}

function etaFields(etd, transitDays, eta) {
  var realEta = cleanDate(eta);
  if (realEta) return { eta_est: realEta, eta_is_estimated: false };
  if (!etd || transitDays == null) return { eta_est: null, eta_is_estimated: false };
  var etdDate = localDateFromYmd(etd);
  if (!etdDate) return { eta_est: null, eta_is_estimated: false };
  return { eta_est: ymd(addDays(etdDate, transitDays)), eta_is_estimated: true };
}

function normCarrier(v) {
  return text(v).toUpperCase().replace(/\s+/g, " ");
}

export function normScheduleCarrier(v) {
  return text(v).toUpperCase().replace(/\s+/g, "");
}

export function marketCarrierCode(v) {
  var direct = normScheduleCarrier(v);
  if (MARKET_CARRIER_ALIASES[direct]) return normScheduleCarrier(MARKET_CARRIER_ALIASES[direct]);
  var aliases = Object.keys(MARKET_CARRIER_ALIASES);
  for (var i = 0; i < aliases.length; i++) {
    if (direct === normScheduleCarrier(MARKET_CARRIER_ALIASES[aliases[i]])) return direct;
  }
  var first = text(v).split(/\s+/)[0] || "";
  return /^[A-Za-z0-9-]+$/.test(first) ? normScheduleCarrier(first) : "";
}

export function marketCarrierAliasKeys(codes) {
  var wanted = {};
  (codes || []).forEach(function(code) {
    var normalized = normScheduleCarrier(code);
    if (normalized) wanted[normalized] = true;
  });
  return Object.keys(MARKET_CARRIER_ALIASES).filter(function(alias) {
    return wanted[normScheduleCarrier(MARKET_CARRIER_ALIASES[alias])] === true;
  });
}

function normBox(v) {
  var s = text(v).toUpperCase().replace(/\s+/g, "").replace("HC", "HQ");
  if (s === "20" || s === "20GP") return "20GP";
  if (s === "40" || s === "40GP" || s === "40HQ") return "40HQ";
  return s;
}

export function isPendingShipment(row) {
  return !isShippedShipment(row) && !isStaleShipment(row);
}

function isShippedShipment(row) {
  return !!(text(row && row.bl_no) && row && row.eta != null);
}

export function isStaleShipment(row, todayYmd) {
  if (isShippedShipment(row)) return false;
  var etd = cleanDate(row && row.etd);
  if (!etd) return false;
  return etd < (todayYmd || ymd(new Date()));
}

export function addPendingPlan(lane, row, shipment, qty, box) {
  if (!lane || !shipment) return;
  if (lane.stale_orders == null) lane.stale_orders = 0;
  if (isStaleShipment(row)) {
    lane.stale_orders += 1;
    return;
  }
  if (!shipment.is_pending) return;
  if (lane.pending_orders == null) lane.pending_orders = 0;
  if (lane.pending_containers == null) lane.pending_containers = 0;
  if (!lane._pendingBox) lane._pendingBox = {};
  lane.pending_orders += 1;
  if (qty != null) {
    lane.pending_containers += qty;
    if (box) lane._pendingBox[box] = (lane._pendingBox[box] || 0) + qty;
  }
}

export function finishPendingLane(lane) {
  if (!lane) return lane;
  if (lane.stale_orders == null) lane.stale_orders = 0;
  if (lane.pending_orders == null) lane.pending_orders = 0;
  if (lane.pending_containers == null) lane.pending_containers = 0;
  var box = lane._pendingBox || {};
  var keys = Object.keys(box).sort();
  lane.pending_boxes = keys.length ? keys.map(function(k) { return box[k] + "×" + k; }).join(" / ") : null;
  delete lane._pendingBox;
  return lane;
}

export function localNormalizePort(v) {
  var clean = stripLeadingCn(v);
  var cached = localPortCache && localPortCache[portCacheKey(clean)];
  var official = cached || normalizePort(clean);
  var direct = portCacheKey(clean);
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
      slot_shared: false,
      slot_carriers: [],
      eta_est: null,
      eta_is_estimated: false,
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
  var aliasKeys = marketCarrierAliasKeys(codes);
  if (!codes.length) return [];
  const { rows } = await pool.query(
    `SELECT ms.pol_name, ms.pod_name, ms.carrier, ms.vessel, ms.voyage,
            ms.etd, ms.eta, ms.transit_days, ms.slot_shared, ms.slot_carriers, ms.id
       FROM market_sailings ms
      WHERE ms.etd >= $1::date
        AND ms.etd < $2::date
        AND (
          upper(substring(btrim(COALESCE(ms.carrier, '')) from '^[A-Za-z0-9-]+')) = ANY($3::text[])
          OR upper(regexp_replace(btrim(COALESCE(ms.carrier, '')), '\\s+', '', 'g')) = ANY($4::text[])
        )
      ORDER BY ms.etd ASC, ms.id ASC`,
    [from, to, codes, aliasKeys]
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
    var transitDays = pos(row.transit_days);
    var eta = etaFields(etd, transitDays, row.eta);
    var entry = {
      etd: etd,
      voyage: text(row.voyage) || null,
      vessel: text(row.vessel) || null,
      transit_days: transitDays,
      slot_shared: row.slot_shared === true,
      slot_carriers: Array.isArray(row.slot_carriers) ? row.slot_carriers : [],
      eta_est: eta.eta_est,
      eta_is_estimated: eta.eta_is_estimated,
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
  week.slot_shared = hit.slot_shared;
  week.slot_carriers = hit.slot_carriers;
  week.eta_est = hit.eta_est;
  week.eta_is_estimated = hit.eta_is_estimated;
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
  if (pool) await ensureLocalPortCache(pool);
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
