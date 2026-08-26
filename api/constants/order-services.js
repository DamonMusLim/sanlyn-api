// Service item enum for ocean export orders.
// Store code values in DB; render Chinese labels only at display boundaries.

export const ORDER_SERVICE_ITEMS = Object.freeze([
  { code: "BOOKING", zh: "订舱" },
  { code: "TRUCKING", zh: "拖车" },
  { code: "STUFFING", zh: "内装" },
  { code: "CUSTOMS", zh: "报关" },
  { code: "CLEARANCE", zh: "清关" },
  { code: "OVERSEAS", zh: "海外段" },
  { code: "INSURANCE", zh: "保险" },
  { code: "CONTAINER_LEASE", zh: "租箱" },
  { code: "FUMIGATION", zh: "熏蒸" },
  { code: "BUY_DOC", zh: "买单" },
  { code: "CERTIFICATE", zh: "办证" },
  { code: "DOC_MAKING", zh: "制单" },
]);

export const ORDER_SERVICE_CODES = Object.freeze(ORDER_SERVICE_ITEMS.map((x) => x.code));

export const ORDER_SERVICE_LABEL_BY_CODE = Object.freeze(
  Object.fromEntries(ORDER_SERVICE_ITEMS.map((x) => [x.code, x.zh]))
);

export const ORDER_SERVICE_DERIVED_COLUMNS = Object.freeze({
  TRUCKING: Object.freeze({ column: "trucking_arrange", kind: "text" }),
  CUSTOMS: Object.freeze({ column: "customs_arrange", kind: "text" }),
  INSURANCE: Object.freeze({ column: "insurance_required", kind: "bool" }),
});

export function isOrderServiceCode(code) {
  return ORDER_SERVICE_CODES.includes(code);
}
