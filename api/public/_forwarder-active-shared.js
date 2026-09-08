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
