// Unified external-order classifier for shipping_plans.
// Pure logic only: pass Sanlyn entity names from the caller, no DB access here.

const FALLBACK_SANLYN_ENTITIES = [
  // Source: Damon 2026-06-03 production rule in P0a brief.
  "厦门巴匕进出口",
  "XIAMEN PET BABY",
  "建平中砂膨润土",
  "厦门宠爱我宠物用品",
  "富城山凌",
  "FORTUNESANLYN",
  "连云港中砂",
  "徐州大之圣",
];

function textValue(value) {
  return value == null ? "" : String(value).trim();
}

export function normalizeCompanyName(value) {
  return textValue(value)
    .normalize("NFKC")
    .toUpperCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function rawObject(plan) {
  const raw = plan && plan.raw;
  if (!raw) return {};
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return typeof raw === "object" ? raw : {};
}

export function buildSanlynEntitySet(names = []) {
  const source = names.length ? names : FALLBACK_SANLYN_ENTITIES;
  return new Set(source.map(normalizeCompanyName).filter(Boolean));
}

export function isSanlynEntityName(name, sanlynEntities) {
  const normalized = normalizeCompanyName(name);
  if (!normalized) return false;
  const entitySet = sanlynEntities instanceof Set
    ? sanlynEntities
    : buildSanlynEntitySet(sanlynEntities || []);
  return entitySet.has(normalized);
}

export function isFreightAgency(plan, options = {}) {
  if (!plan) return false;
  if (plan.source_system === "freight_agency") return true;

  const raw = rawObject(plan);
  if (raw.order_type === "external") return true;

  const shipper = textValue(plan.shipper || raw.shipper || raw.shipper_name);
  if (!shipper) return false;

  const entitySet = options.sanlynEntities instanceof Set
    ? options.sanlynEntities
    : buildSanlynEntitySet(options.sanlynEntities || []);

  return isSanlynEntityName(shipper, entitySet) ? false : "candidate";
}

export { FALLBACK_SANLYN_ENTITIES };

// Self-check examples:
// isFreightAgency({ shipper: "恒安" }, { sanlynEntities }) -> "candidate"
// isFreightAgency({ shipper: "玖立" }, { sanlynEntities }) -> "candidate"
// isFreightAgency({ shipper: "厦门巴匕进出口" }, { sanlynEntities }) -> false
// isFreightAgency({ source_system: "freight_agency" }, { sanlynEntities }) -> true
