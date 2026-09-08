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

export function countWeekQuotedCarriers(carriers){
  return (carriers || []).filter(function(carrier){
    return (carrier.weeks || []).some(function(week){
      return week && (week.quoted || Object.keys(week.prices || {}).length > 0);
    });
  }).length;
}
