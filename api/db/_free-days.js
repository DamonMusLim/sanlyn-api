import { normalizePort } from "./_official-port-charges.js";

const BOXES = ["20GP", "40GP", "40HQ"];
const FREE_DAYS_CARRIER_ALIAS = { MSK: "MAERSK" };

function text(v) {
  return String(v == null ? "" : v).trim();
}

function normCarrier(v) {
  return text(v).toUpperCase().replace(/\s+/g, " ");
}

function normBox(v) {
  return text(v).toUpperCase().replace(/\s+/g, "").replace("HC", "HQ");
}

function amountOrNull(v) {
  if (v == null || v === "") return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function emptyFreeDays() {
  return { "20GP": null, "40GP": null, "40HQ": null };
}

function freeDaysCarrier(carrier) {
  return FREE_DAYS_CARRIER_ALIAS[carrier] || carrier;
}

function fillFreeDays(rows) {
  var freeDays = emptyFreeDays();
  rows.forEach(function(row) {
    var box = normBox(row.container_type);
    if (Object.prototype.hasOwnProperty.call(freeDays, box)) {
      freeDays[box] = amountOrNull(row.free_days);
    }
  });
  return freeDays;
}

function emptyResult(inputCarrier, lookupCarrier) {
  return {
    free_days: emptyFreeDays(),
    free_days_match: "未命中",
    free_days_carrier: lookupCarrier !== inputCarrier ? lookupCarrier : null,
  };
}

export async function resolvePortCode(pool, pol) {
  var wanted = normalizePort(pol);
  if (!wanted) return { normalized: "", code: null, name_cn: "" };
  const { rows } = await pool.query(
    `SELECT code, name_cn, name_en
       FROM public.ports`
  );
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (
      normalizePort(row.code) === wanted ||
      normalizePort(row.name_cn) === wanted ||
      normalizePort(row.name_en) === wanted
    ) {
      return {
        normalized: wanted,
        code: text(row.code).toUpperCase() || null,
        name_cn: text(row.name_cn) || text(row.name_en) || text(pol),
      };
    }
  }
  return { normalized: wanted, code: null, name_cn: text(pol) };
}

export async function loadFreeDaysBatch(pool, carriers, portCode, rawPol) {
  var wantedPort = text(portCode).toUpperCase();
  var originals = [];
  var seenOriginals = {};
  (carriers || []).forEach(function(carrier) {
    var normalized = normCarrier(carrier);
    if (!normalized || seenOriginals[normalized]) return;
    seenOriginals[normalized] = true;
    originals.push(normalized);
  });

  var out = {};
  var lookupToOriginals = {};
  originals.forEach(function(carrier) {
    var lookupCarrier = freeDaysCarrier(carrier);
    out[carrier] = emptyResult(carrier, lookupCarrier);
    if (!lookupToOriginals[lookupCarrier]) lookupToOriginals[lookupCarrier] = [];
    lookupToOriginals[lookupCarrier].push(carrier);
  });

  if (!wantedPort) {
    originals.forEach(function(carrier) {
      out[carrier].free_days_reason = "未能把 " + text(rawPol) + " 解析成五字码";
    });
    return out;
  }

  var lookupCarriers = Object.keys(lookupToOriginals);
  if (!lookupCarriers.length) return out;

  const { rows } = await pool.query(
    `SELECT UPPER(TRIM(carrier_code)) AS carrier_code, container_type, free_days, port_code
       FROM public.carrier_free_days
      WHERE UPPER(TRIM(carrier_code)) = ANY($1)
        AND direction = $2
        AND (
          UPPER(TRIM(port_code)) = ANY($3)
          OR port_code LIKE '%除%外%'
          OR port_code LIKE '%限于%'
        )
      ORDER BY carrier_code, port_code, container_type`,
    [lookupCarriers, "出口", [wantedPort, "全中国"]]
  );

  var byCarrier = {};
  rows.forEach(function(row) {
    var carrier = normCarrier(row.carrier_code);
    if (!byCarrier[carrier]) byCarrier[carrier] = { exact: [], china: [], rules: [] };
    var rowPort = text(row.port_code);
    if (rowPort.toUpperCase() === wantedPort) byCarrier[carrier].exact.push(row);
    else if (rowPort === "全中国") byCarrier[carrier].china.push(row);
    else byCarrier[carrier].rules.push(row);
  });

  originals.forEach(function(carrier) {
    var lookupCarrier = freeDaysCarrier(carrier);
    var grouped = byCarrier[lookupCarrier] || { exact: [], china: [], rules: [] };
    if (grouped.exact.length) {
      out[carrier].free_days = fillFreeDays(grouped.exact);
      out[carrier].free_days_match = "五字码 " + wantedPort;
      return;
    }
    if (grouped.china.length) {
      out[carrier].free_days = fillFreeDays(grouped.china);
      out[carrier].free_days_match = "全中国";
      return;
    }
    if (grouped.rules.length) {
      var ruleSeen = {};
      var ruleText = grouped.rules.map(function(row) { return text(row.port_code); })
        .filter(Boolean)
        .filter(function(rule) {
          if (ruleSeen[rule]) return false;
          ruleSeen[rule] = true;
          return true;
        })
        .join("/");
      out[carrier].free_days_match = "区域规则(未判定)";
      out[carrier].free_days_reason = lookupCarrier + " 只有区域规则(" + ruleText + "),暂无法判定 " + text(rawPol) + " 属于哪一档,需人工确认";
      return;
    }
    out[carrier].free_days_reason = lookupCarrier + " 在 " + wantedPort + " 未命中免柜期";
  });

  return out;
}

export async function loadFreeDays(pool, carrier, portCode, rawPol) {
  var normalized = normCarrier(carrier);
  var batch = await loadFreeDaysBatch(pool, [normalized], portCode, rawPol);
  return batch[normalized] || emptyResult(normalized, freeDaysCarrier(normalized));
}
