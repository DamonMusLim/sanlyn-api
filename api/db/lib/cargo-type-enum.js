export const CARGO_TYPE_ENUM = Object.freeze({
  DRY: "干货",
  REEFER: "冷藏/冷冻",
  OOG: "超限/特种柜",
  DANGEROUS: "危险品",
  BREAK_BULK: "件杂/散杂",
});

const ALIASES = [
  ["DANGEROUS", ["danger", "dangerous", "dg", "haz", "hazard", "危险", "危品", "冷藏危险"]],
  ["REEFER", ["reefer", "rf", "refrigerated", "冷藏", "冷冻", "冻品", "冷链"]],
  ["OOG", ["oog", "out of gauge", "超限", "框架", "开顶", "特种柜"]],
  ["BREAK_BULK", ["break bulk", "breakbulk", "bb", "bulk", "件杂", "散杂", "散货"]],
  ["DRY", ["dry", "general", "normal", "普通", "普货", "干货", "非危险"]],
];

export function normalizeCargoType(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { code: null, label: null, raw: null, state: "not_connected" };
  const upper = raw.toUpperCase().replace(/[-\s]+/g, "_");
  if (Object.prototype.hasOwnProperty.call(CARGO_TYPE_ENUM, upper)) {
    return { code: upper, label: CARGO_TYPE_ENUM[upper], raw, state: "ready" };
  }
  const text = raw.toLowerCase();
  const hit = ALIASES.find(([, aliases]) => aliases.some((x) => text.includes(x.toLowerCase())));
  if (!hit) return { code: null, label: null, raw, state: "unmapped" };
  return { code: hit[0], label: CARGO_TYPE_ENUM[hit[0]], raw, state: "ready" };
}
