import { normalizeCarrier } from "../db/lib/portcharge-close-loop.js";
import { localNormalizePort } from "./_lane-weeks.js";

export function cleanText(v){
  return String(v == null ? "" : v).trim();
}

export function numOrNull(v){
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function dateTime(v){
  if (!v) return null;
  var d = new Date(v);
  return Number.isFinite(d.getTime()) ? d.getTime() : null;
}

function chargeKey(carrier, pol, pod, box){
  return [
    normalizeCarrier(carrier || "*"),
    localNormalizePort(pol),
    localNormalizePort(pod),
    cleanText(box).toUpperCase().replace(/\s+/g, "").replace("HC", "HQ"),
  ].join("\u0001");
}

export async function loadForwarderLocalCharges(pool, supplierName){
  const { rows } = await pool.query(
    `SELECT carrier, pol, pod, container_type, fees, base_total_cny, conditional_total_cny, updated_at
       FROM local_charges
      WHERE lower(btrim(company_name)) = lower(btrim($1))
        AND COALESCE(is_active, true) IS TRUE
        AND COALESCE(charge_type, '') = 'port_charge'
      ORDER BY updated_at DESC NULLS LAST, id DESC`,
    [supplierName]
  );
  return rows;
}

export function attachForwarderLocalCharges(lanes, chargeRows){
  var cards = {};
  (chargeRows || []).forEach(function(row){
    var key = chargeKey(row.carrier, row.pol, row.pod, row.container_type);
    if (!cards[key]) cards[key] = row;
  });
  (lanes || []).forEach(function(lane){
    (lane.carriers || []).forEach(function(carrier){
      carrier.local_charge_cards = (carrier.boxes || []).map(function(box){
        var row = cards[chargeKey(carrier.name, lane.pol, lane.pod, box)];
        if (!row) return { container_type:box, status:"missing", display:"请填写港杂" };
        return {
          container_type:box,
          status:"filled",
          display:numOrNull(row.base_total_cny),
          base_total_cny:numOrNull(row.base_total_cny),
          conditional_total_cny:numOrNull(row.conditional_total_cny),
          fees:Array.isArray(row.fees) ? row.fees : [],
          updated_at:row.updated_at || null,
        };
      });
    });
  });
}

function stripSpec(label){
  return cleanText(label)
    .replace(/[（(][^（）()]*[）)]/g, " ")
    .replace(/\bHS\s*(?:码\s*)?[\d.\s]{4,}/gi, " ")
    .replace(/\s\d+(\.\d+)?\s*(KG|G|ML|L)\b/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function dropChineseDuplicate(label){
  var s = cleanText(label);
  if (!/[A-Za-z]{3,}/.test(s) || !/[\u4e00-\u9fff]{2,}/.test(s)) return s;
  return s
    .replace(/\s*[\u4e00-\u9fff]{2,}\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function publicCargoName(v){
  var s = cleanText(v);
  if (!s) return null;
  var parts = s.split(/\s\/\s/).map(function(part){
    return dropChineseDuplicate(stripSpec(part));
  }).filter(Boolean);
  var seen = {}, base = [];
  parts.forEach(function(p){
    var k = p.toUpperCase();
    if (!seen[k]) { seen[k] = 1; base.push(p); }
  });
  if (!base.length) return null;
  var head = base.slice(0, 2).join(" / ");
  if (head.length > 40) head = head.slice(0, 39) + "…";
  return head + (base.length > 2 ? " 等" + base.length + "项" : "");
}

export function countWeekQuotedCarriers(carriers){
  return (carriers || []).filter(function(carrier){
    return carrierHasWeekQuote(carrier);
  }).length;
}

export function carrierHasWeekQuote(carrier){
  return (carrier && carrier.weeks || []).some(function(week){
    return week && (week.quoted || Object.keys(week.prices || {}).length > 0);
  });
}

export function refreshLaneQuoteStats(lane){
  (lane.carriers || []).forEach(function(carrier){
    carrier.quoted = carrierHasWeekQuote(carrier);
  });
  lane.quoted_carriers = countWeekQuotedCarriers(lane.carriers);
  lane.week_quoted_carriers = lane.quoted_carriers;
  lane.week_pending_carriers = (lane.carriers || []).length - lane.quoted_carriers;
  lane.has_any_week_quote = lane.quoted_carriers > 0;
}
