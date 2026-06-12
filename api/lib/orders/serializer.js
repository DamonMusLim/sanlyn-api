// W0-1: Role-scoped allowlist serializer for orders SELECT o.* output.
//
// Wraps existing stripSensitive() in api/db/orders.js with an explicit per-role
// column allowlist (positive list). Default = customer_facing = most restrictive.
//
// Rationale: SELECT o.* returns the full orders row (incl. profit, factory_amount,
// middleman_markup_*, exchange_rate, total_amount_factory, raw blob, etc.).
// Worker A risk table flags these as P0 leak vectors. stripSensitive() is a
// negative-list deny pattern (good as defence in depth) — this serializer is
// the positive-list whitelist that runs on top.
//
// Memory rules enforced:
//  - feedback_customer_code_anti_counterfeit.md → company_code NEVER on customer payload
//  - sanlyn_collab_privacy_isolation.md → factory hides freight/customer prices
//  - sanlyn_platform_blueprint.md (Supplement B) → middleman_* internal only
//  - saas_role_equality.md → admin/internal sees everything; super_admin gets raw
//
// Default behaviour: if role is unknown / missing, treat as customer_facing
// (fail-closed: smallest visible surface).

// Customer-facing columns: everything a buyer legitimately needs to track their
// own order. Excludes: company_code (防伪 ID), all profit/markup, factory pricing,
// raw blob (may contain unredacted snapshots), exchange_rate (reveals markup).
const CUSTOMER_FACING = new Set([
  "id",
  "order_no",
  "customer_po",
  "contract_no",
  "status",
  "production_status",
  "currency",
  "total_amount",        // customer-facing total (sale price)
  "total_qty",
  "container_qty",
  "container_type",
  "trade_terms",
  "payment_terms",
  "etd", "eta", "atd", "ata",
  "delivery_date",
  "required_arrival",
  "confirmed_delivery",
  "vessel", "voyage",
  "pol", "destination_port",
  "bl_no",
  "company_name_en",     // customer's own company display name (NOT company_code)
  "brand",
  "remarks",
  "notes",
  "created_at", "updated_at",
  "products",            // already stripped by stripSensitive() for factoryPrice/cost
  // Live shipping joins from orders.js GET LEFT LATERAL JOINs:
  "sp_bl_no", "sp_etd", "sp_eta", "sp_pol", "sp_pod",
  "sp_status_cn", "sp_tracking_updated_at",
  "driver_name", "driver_phone", "truck_plate", "planned_load_at",
  // W0-1 review fix #2: _events / _tasks intentionally OMITTED from external
  // allowlists — they carry raw actor_role / actor_company_id / meta which
  // leak internal workflow. Re-add only after building a visibility-scoped
  // event serializer (uses event_groups.visibility_scope).
  "_sensitive_stripped", "_stripped_reason",
]);

// Factory-facing: factory cost fields PLUS production info — but NOT customer pricing.
// W0-1 review fix #1: factory_code is an internal anti-counterfeit ID and is
// NOT included here. Factory identifies orders by order_no (already prefixed with
// factory's po_prefix per order_numbering_convention).
// W0-1 review fix #2: _events / _tasks omitted from external allowlists — they
// carry raw actor_role / actor_company_id / meta which leak internal workflow.
const FACTORY_FACING = new Set([
  "id",
  "order_no",
  "contract_no",
  "status", "production_status",
  "factory_amount", "factory_price_total",  // factory's own cost
  "currency",
  "total_qty",
  "container_qty", "container_type",
  "trade_terms",
  "delivery_date", "required_arrival", "confirmed_delivery",
  "etd", "eta",
  "pol",
  "remarks", "notes",
  "brand",
  "created_at", "updated_at",
  "products",
  "_sensitive_stripped", "_stripped_reason",
  // factory does NOT see: customer name/po (防跳单), total_amount (customer sale),
  // bl_no, vessel/voyage, destination_port (shipping is forwarder/Sanlyn turf),
  // profit/margin/markup, raw blob, exchange_rate, company_code, company_name_en,
  // factory_code (anti-counterfeit), _events / _tasks (internal workflow meta).
]);

// Internal admin (Sanlyn ops staff): sees most fields except the very-most-secret.
const INTERNAL_ADMIN_HIDE = new Set([
  "raw",                       // raw JSONB may contain unredacted pricing_snapshot/vault
  "pricing_snapshot",
  "vault",
  "middleman_markup_total",    // platform margin — super_admin only
  "middleman_markup_pct",
  "tax_rebate_amount",
  "profit",
]);

function pickByAllowlist(row, allow) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const k of Object.keys(row)) {
    if (allow.has(k)) out[k] = row[k];
  }
  return out;
}

function dropByHideSet(row, hide) {
  if (!row || typeof row !== "object") return row;
  const out = {};
  for (const k of Object.keys(row)) {
    if (!hide.has(k)) out[k] = row[k];
  }
  return out;
}

// Map JWT role → audience tier
function roleToAudience(role) {
  if (!role) return "customer_facing";       // fail-closed default
  const r = String(role).toLowerCase();
  if (r === "super_admin" || r === "root") return "super_admin";
  if (r === "admin" || r === "logistics" || r === "finance" || r === "sales" || r === "internal")
    return "internal_admin";
  if (r === "factory" || r === "factory_user" || r === "supplier") return "factory_facing";
  // customer, customer_user, forwarder (forwarder gets nothing more than customer), unknown:
  return "customer_facing";
}

export function serializeOrderForRole(row, role) {
  const audience = roleToAudience(role);
  if (audience === "super_admin") return row;
  if (audience === "internal_admin") return dropByHideSet(row, INTERNAL_ADMIN_HIDE);
  if (audience === "factory_facing") {
    const out = pickByAllowlist(row, FACTORY_FACING);
    out._allowlist_applied = "factory_facing";
    return out;
  }
  // default = customer_facing (most restrictive)
  const out = pickByAllowlist(row, CUSTOMER_FACING);
  out._allowlist_applied = "customer_facing";
  return out;
}

export function serializeOrdersForRole(rows, role) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => serializeOrderForRole(r, role));
}

export const _internals = {
  CUSTOMER_FACING, FACTORY_FACING, INTERNAL_ADMIN_HIDE, roleToAudience,
};
