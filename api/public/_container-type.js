function text(v) {
  return String(v == null ? "" : v).trim();
}

export function normalizeContainerType(v) {
  var s = text(v || "40HQ").toUpperCase().replace(/\s+/g, "");
  s = s.replace("40HC", "40HQ").replace("HC", "HQ");
  if (s === "20") return "20GP";
  if (s === "40") return "40HQ";
  return s;
}

export function containerType(v, activeTypes) {
  var s = normalizeContainerType(v);
  return activeTypes && activeTypes.has(s) ? s : "";
}

export function rateColumn(ct) {
  if (ct === "20GP") return "gp20";
  if (ct === "40HQ") return "hq40";
  if (ct === "20RF") return "rf20";
  if (ct === "40RH") return "rh40";
  return null;
}
