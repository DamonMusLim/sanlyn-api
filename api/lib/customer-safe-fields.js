// MODE_D_PREP_CUSTOMER_API_STRIPPER_001 (Wave 0 P0 — 2026-05-25)
//
// Central per-role allowlists for customer-facing API responses.
// Mirrors api/lib/orders/serializer.js — positive list, fail-closed default.
//
// Memory rules enforced:
//   - feedback_customer_code_anti_counterfeit.md → company_code NEVER on customer payload
//   - sanlyn_collab_privacy_isolation.md → customers must not see vendor identity
//   - sanlyn_platform_blueprint.md (Supplement B) → markup_* internal only
//   - feedback_customer_first_no_admin.md → customer is the design vertex
//
// Audience tiers:
//   - "super_admin"  → passthrough (no strip)
//   - "internal"     → passthrough (admin/finance/logistics/sales/system)
//   - "factory"      → not handled here (see api/lib/orders/serializer.js FACTORY_FACING)
//   - "customer"     → apply per-endpoint allowlist (default for unknown/forwarder)

export const SHIPPING_CUSTOMER_SAFE = new Set([
  "id", "_id", "shipment_no", "bl_no", "hbl_no", "mbl_no",
  "vessel", "voyage", "carrier_code",
  "pol", "pol_country", "pod", "pod_country",
  "etd", "eta", "atd", "ata",
  "cutoff_date", "doc_cutoff", "cargo_cutoff", "vgm_cutoff", "customs_cutoff",
  "container_no", "container_type", "container_qty", "seal_no",
  "total_cbm", "total_cartons", "gross_weight_kg",
  "cargo_description",
  "current_status", "current_status_cn", "status",
  "shipping_status", "flow_status", "release_type",
  "contract_no", "order_contract_nos", "sub_order_no",
  "booking_no", "forwarder_booking_no",  // GPT review fix: customer needs booking reference
  // D-001 (2026-05-25): ocean freight sell price — what the customer is charged.
  // freight_cost (Sanlyn's wholesale cost) is intentionally NOT included.
  // forwarder_cn, trucking_cn, customs_cn, profit fields remain internal-only.
  "freight_sale_usd",       // Ocean freight quoted to customer (USD)
  "freight_sale_cny",       // Ocean freight quoted to customer (CNY equivalent)
  "freight_sale_currency",  // Currency denomination for freight_sale
  "created_at", "updated_at", "status_updated_at", "tracking_updated_at",
  "first_issued_at", "cargo_ready_date",
  "factory_confirmed_at", "customer_confirmed_at",
]);

export const FREIGHT_RATES_CUSTOMER_SAFE = new Set([
  "id", "pol", "pod", "carrier", "routeCode",
  "customerGp20", "customerHq40",
  "transitDays", "validFrom", "validTo", "etaDate",
  "thisWeek", "nextWeek", "nextSailing", "freetime", "via",
  "status",
]);

export const CUSTOMERS_CUSTOMER_SAFE = new Set([
  "id", "name", "name_en", "name_cn",
  "brands", "addresses",
  "contact_name", "contact_phone", "contact_email",
  "country", "currency",
  "trade_terms", "payment_term",
  "destination_port", "address", "address_en",
  "logo_url", "card_template",
  "is_active", "created_at", "updated_at",
]);

export const ACCOUNTS_CUSTOMER_SAFE = new Set([
  "id", "username", "role",
  "is_active", "created_at", "updated_at",
]);

// Map JWT role → audience tier.
// fail-closed: missing/unknown role → "customer" (smallest visible surface).
export function audienceForRole(role) {
  if (!role) return "customer";
  const r = String(role).toLowerCase();
  if (r === "super_admin" || r === "root") return "super_admin";
  if (
    r === "admin" || r === "finance" || r === "logistics" ||
    r === "sales" || r === "internal" || r === "system"
  ) return "internal";
  if (r === "factory" || r === "supplier" || r === "factory_user") return "factory";
  return "customer";
}

// MODE_D_DEPLOY_CUSTOMER_API_STRIPPER_V2_001 (W0 P0 2026-05-25):
// Defense-in-depth nested-key scrubber. Today's customer responses do NOT
// include `raw` (it's dropped by the top-level allowlists above), so this
// helper is a no-op in production. It exists to guard against future
// regressions where `raw` might be re-introduced into a CUSTOMER_SAFE set
// (e.g. for a legitimate partial-display use case). When that happens,
// callers can wrap the response in scrubCustomerNested(rows, role) AFTER
// pickByAllowlist to guarantee the 12 V2-locked nested keys never exit.
//
// V2 leak reproduction (2026-05-25) found 0 occurrences of any of these
// keys in current customer payloads — confirmed via live prod scan.
export const FORBIDDEN_NESTED_KEYS = new Set([
  // Forwarder identity (P1 — cross-跳单 risk per sanlyn_collab_privacy_isolation.md)
  "forwarderEN",
  "merged_forwarder_cn",
  "oceanForwarder",
  "forwarderRef",
  "agentAtDestination",
  // Forwarder billing trail (P0 — vendor financial state)
  "forwarderInvoiceNo",
  "forwarderInvoiceDate",
  // USCC / tax id of partners (P0 — feedback_customer_code_anti_counterfeit.md)
  "customs_broker_uscc",
  "customs_uscc",
  "shipper_babi_uscc",
  // Cost-side fee placeholders (P0 — reveals cost structure)
  "truckingCostPending",
  "customsCostPending",
]);

// Recursive: deep-scrub any object/array; drops keys in `forbidden` at any depth.
// O(n) over total keys. Returns a NEW tree (does not mutate input).
// Handles: null/undefined, primitives, arrays, plain objects, nested
// arrays-of-objects (containers[].seal etc.). Does NOT walk class instances.
export function scrubNestedRaw(obj, forbidden = FORBIDDEN_NESTED_KEYS) {
  if (obj == null) return obj;
  if (Array.isArray(obj)) return obj.map((v) => scrubNestedRaw(v, forbidden));
  if (typeof obj !== "object") return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    if (forbidden.has(k)) continue;
    const v = obj[k];
    out[k] = (v && typeof v === "object") ? scrubNestedRaw(v, forbidden) : v;
  }
  return out;
}

// Convenience: applies scrubNestedRaw to row.raw for customer role.
// Today a no-op (top-level allowlists already drop `raw`); guard for future.
export function scrubCustomerNested(rows, role, forbidden = FORBIDDEN_NESTED_KEYS) {
  if (audienceForRole(role) !== "customer") return rows;
  if (rows == null) return rows;
  const apply = (r) => {
    if (!r || typeof r !== "object") return r;
    if (!("raw" in r) || r.raw == null) return r;
    return { ...r, raw: scrubNestedRaw(r.raw, forbidden) };
  };
  return Array.isArray(rows) ? rows.map(apply) : apply(rows);
}

export function pickByAllowlist(row, allow) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const k of Object.keys(row)) {
    if (allow.has(k)) out[k] = row[k];
  }
  return out;
}

// Convenience: if audience is "customer", apply allowlist; else passthrough.
// Accepts a single row or an array of rows.
export function scrubForCustomer(rows, role, allow) {
  if (audienceForRole(role) !== "customer") return rows;
  if (rows == null) return rows;
  if (Array.isArray(rows)) return rows.map((r) => pickByAllowlist(r, allow));
  return pickByAllowlist(rows, allow);
}

export const _internals = { audienceForRole, pickByAllowlist };
