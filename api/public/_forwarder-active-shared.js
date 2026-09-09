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

export function perContainerCharge(row, fallbackTotal){
  var qty = numOrNull(row && row.container_qty);
  var total = numOrNull(row && row.port_surcharge_total);
  if (!(qty > 0)) return null;
  if (!(total > 0)) total = fallbackTotal;
  return total > 0 ? { amount:total / qty, qty:qty } : null;
}

export function portChargeBoxGroup(boxType){
  var s = cleanText(boxType).toUpperCase();
  if (/^20/.test(s)) return "20";
  if (/^(40|45)/.test(s)) return "40";
  return "";
}

export function isUsablePortCharge(amount){
  var n = numOrNull(amount);
  return n != null && n > 0 && n <= 20000;
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
