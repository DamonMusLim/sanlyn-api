// api/lib/product-scope.js
// ─────────────────────────────────────────────────────────────────────────────
// Product Master V1 — P0-0 user scope (row-level) + role+scope field whitelist
// + party-alias + pricing visibility resolver for products endpoints.
//
// This module is defense-in-depth on top of brand-scoping.js (Layer 1). It is
// the single source of truth for "what products + which fields can req.user
// see" in the Product Master V1 surface.
//
// Doctrine (per blueprints/product-master-v1.md):
//   1. user scope row-level cut         ← applyProductRowScope
//   2. role + scope field-level cut     ← applyProductFieldWhitelist
//   3. party alias single-party view    ← resolvePartyAlias
//   4. pricing/margin single-party view ← resolvePricingVisibility
//   5. fail-closed defaults             ← null scope → []
//
// SECURITY-CRITICAL.
//   • Front-end-supplied company_code / customer_code / factory_code MUST be
//     treated as filter hints only. Permission decisions read from req.user.
//   • req.user is populated by api/auth.js authMiddleware (JWT verified).
//   • Callers MUST verify req.user exists before reaching this module.
//     getProductScope() returns null for missing/unknown role; callers must
//     translate that to HTTP 403 or empty array (200).
//   • This module never trusts row contents to decide who else can see them.
//
// Codex review required for every change. ─────────────────────────────────────

// ── Role classification ──────────────────────────────────────────────────────
// FULL: see everything. Sensitive ops still audit_log.
// Includes the canonical 3-role layer documented in api/lib/financePreviewGate.js
// (finance → platform_finance, admin → platform_admin, internal → internal_operator)
// — CODEX-REVIEW P2 (2026-05-19) noted the canonical aliases were missing,
// which would 403 legitimate finance/operator users.
const FULL_ROLES = new Set([
  "admin", "super_admin", "superadmin", "ceo", "system",
  "boss", "internal", "platform_admin", "finance",
  "platform_finance", "internal_operator",
]);

// INTERNAL_RESTRICTED: internal staff that, per V1 doctrine, should NOT see
// the whole catalog. V1 keeps behavior close to "full" to avoid breakage but
// flags this surface for tightening in a follow-up PR. Field-level masking
// still applies (e.g. trader hides factory_price).
const INTERNAL_RESTRICTED_ROLES = new Set([
  "logistics", "customs", "sales", "operator", "trader",
]);

const FACTORY_ROLES  = new Set(["factory"]);
// "buyer" is the role assigned by factory-invite-complete.js for invite type
// "customer" — treat it as a customer-scoped role so the existing buyer-account
// flow keeps working (regression flagged by CODEX-REVIEW P1, 2026-05-19).
const CUSTOMER_ROLES = new Set(["customer", "buyer", "portal", "external"]);

// ── Field hide lists (kept in sync with products.js historic strip set) ─────
// Trader/customer/factory: explicit hides override defaults.
// Adding a new sensitive field? Add to the strictest list AND a comment.

// Trader = reseller: sees selling price, never Sanlyn buy-side / margin.
const TRADER_HIDE_FIELDS = [
  "factory_price", "profit",
  "vat_rate", "rebate_rate", "tax_rate",
  "bg_bx", "issuing_company", "jdy_id",
];

// Factory: sees own cost (factory_price) only; never customer-facing pricing /
// rebate / profit. NOTE: factory_price is NOT in this list — factory MAY see
// its own. resolvePricingVisibility further restricts to caller's company_code.
const FACTORY_HIDE_FIELDS = [
  "sanlyn_price", "price", "price_usd", "sale_price_cny",
  "profit", "tax_rate", "rebate_rate", "vat_rate",
  "bg_bx", "issuing_company", "jdy_id", "declaration_amount",
];

// Customer: no pricing / margin / internal identifiers / other-factory info.
// Includes camelCase variants for fields that historically lived inside the
// raw JSONB blob (factoryCode / factoryName / factoryCity / factoryCompanyCode)
// — flagged by CODEX-REVIEW P1 (2026-05-19): the strip only matched snake_case
// keys, leaving camelCase factory identity visible to customer responses.
// "factory_profile" was added 2026-05-20 alongside the Factory Write-in V1
// endpoint — the new sub-object holds factory_product_code/name/spec/moq/etc.
// and must NEVER reach customer responses.
const CUSTOMER_HIDE_FIELDS = [
  "factory_price", "sanlyn_price", "price", "price_usd",
  "profit", "sale_price_cny", "vat_rate", "rebate_rate", "tax_rate",
  "bg_bx", "factory_name", "factory_city", "factory_code",
  "factoryCode", "factoryName", "factoryCity", "factoryCompanyCode",
  "issuing_company", "issuingCompany", "jdy_id", "jdyId", "declaration_amount",
  "factory_profile",
];

// Internal-restricted (logistics/sales/operator): no extra hide today.
// Marked for P0-future tightening (e.g. logistics shouldn't see full margin).
const INTERNAL_RESTRICTED_HIDE_FIELDS = [];

// Customs: needs HS / declaration_name / declaration_amount, but must NOT see
// commercial pricing or margin. Previously the customs role was NOT in
// INTERNAL_ROLES (see prior products.js INTERNAL_ROLES list), so it fell
// through to brand-scoping with the customer strip. Promoting it to
// internal_restricted without a hide list re-exposed factory_price /
// sanlyn_price / profit / rebate_rate — CODEX-REVIEW P1 (2026-05-19).
// Use the trader hide list as the baseline (same intent: internal but no
// cost/margin) plus sanlyn_price (customs does not need commercial sell price).
const CUSTOMS_HIDE_FIELDS = [
  "factory_price", "sanlyn_price", "price", "price_usd", "sale_price_cny",
  "profit", "vat_rate", "rebate_rate", "tax_rate",
  "bg_bx", "issuing_company", "jdy_id",
];

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalizeRole(role) {
  return String(role || "").toLowerCase();
}

function normalizeCodes(reqUser) {
  if (!reqUser) return [];
  if (Array.isArray(reqUser.companyCodes) && reqUser.companyCodes.length) {
    return reqUser.companyCodes.filter(Boolean).map(String);
  }
  const c = reqUser.companyCode || reqUser.company_code;
  return c ? [String(c)] : [];
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * getProductScope(reqUser) → scope descriptor or null.
 *
 * Returned shape (when not null):
 *   { mode: 'full' | 'internal_restricted' | 'factory' | 'customer',
 *     role: string,
 *     codes: string[] }
 *
 * null → fail-closed. Callers MUST translate to 403 or [].
 *
 * Rules:
 *   - missing req.user / unknown role / no codes (for factory/customer) → null
 *   - admin/finance/super_admin/etc → 'full'
 *   - logistics/customs/sales/operator/trader → 'internal_restricted'
 *   - factory (must have at least one company_code) → 'factory'
 *   - customer / portal / external (must have at least one company_code) → 'customer'
 */
export function getProductScope(reqUser) {
  if (!reqUser || !reqUser.role) return null;
  const role = normalizeRole(reqUser.role);
  const codes = normalizeCodes(reqUser);

  if (FULL_ROLES.has(role))                return { mode: "full",                role, codes };
  if (INTERNAL_RESTRICTED_ROLES.has(role)) return { mode: "internal_restricted", role, codes };
  if (FACTORY_ROLES.has(role)) {
    if (codes.length === 0) return null;
    return { mode: "factory", role, codes };
  }
  if (CUSTOMER_ROLES.has(role)) {
    if (codes.length === 0) return null;
    return { mode: "customer", role, codes };
  }
  return null; // unknown role → fail-closed
}

/**
 * applyProductRowScope(rows, reqUser) → filtered rows.
 *
 * Defense-in-depth row filter. Callers should ALSO push the same predicate
 * down to the SQL layer when possible (so the DB doesn't return rows that
 * would be dropped here). For factory, the SQL pre-filter on factory_code
 * is the primary cut; this is the post-query safety net.
 *
 *   - null scope            → []
 *   - 'full'                → unchanged
 *   - 'internal_restricted' → unchanged (V1; flagged for tightening)
 *   - 'factory'             → keep rows where factory_code (column or raw)
 *                              ∈ caller.codes; rows missing factory_code drop
 *   - 'customer'            → unchanged (brand-scoping SQL WHERE is the cut)
 */
export function applyProductRowScope(rows, reqUser) {
  if (!Array.isArray(rows)) return [];
  const scope = getProductScope(reqUser);
  if (!scope) return [];
  switch (scope.mode) {
    case "full":
    case "internal_restricted":
    case "customer":
      return rows;
    case "factory": {
      // Match either the top-level column or raw.factoryCode (mirrors the
      // SQL prefilter OR clause). CODEX-REVIEW P2 (2026-05-19): the previous
      // `||` short-circuit dropped legacy rows where factory_code held an
      // old backfill value but raw.factoryCode held the real company code.
      const codeSet = new Set(scope.codes);
      return rows.filter(r => {
        if (!r) return false;
        if (r.factory_code != null && codeSet.has(String(r.factory_code))) return true;
        if (r.raw && r.raw.factoryCode != null && codeSet.has(String(r.raw.factoryCode))) return true;
        return false;
      });
    }
    default:
      return [];
  }
}

/**
 * applyProductFieldWhitelist(rows, reqUser) → rows (mutated in place).
 *
 * V1: implements the existing strip-based hide model, routed via scope mode.
 * Reserves the full whitelist surface for P0-future (positive whitelist per
 * role + scope rather than negative hide list).
 *
 *   - null scope            → []                     (fail-closed)
 *   - 'full'                → no strip
 *   - 'internal_restricted' → trader-specific strip if role=trader, else none
 *   - 'factory'             → strip FACTORY_HIDE_FIELDS
 *   - 'customer'            → strip CUSTOMER_HIDE_FIELDS
 *
 * Mutates each row + row.raw.
 */
export function applyProductFieldWhitelist(rows, reqUser) {
  if (!Array.isArray(rows)) return [];
  const scope = getProductScope(reqUser);
  if (!scope) return [];
  let hideList;
  switch (scope.mode) {
    case "full":
      hideList = [];
      break;
    case "internal_restricted":
      if      (scope.role === "trader")  hideList = TRADER_HIDE_FIELDS;
      else if (scope.role === "customs") hideList = CUSTOMS_HIDE_FIELDS;
      else                                hideList = INTERNAL_RESTRICTED_HIDE_FIELDS;
      break;
    case "factory":
      hideList = FACTORY_HIDE_FIELDS;
      break;
    case "customer":
      hideList = CUSTOMER_HIDE_FIELDS;
      break;
    default:
      hideList = CUSTOMER_HIDE_FIELDS; // strictest as fail-closed default
  }
  if (!hideList.length) return rows;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    for (const f of hideList) delete row[f];
    if (row.raw && typeof row.raw === "object") {
      for (const f of hideList) delete row.raw[f];
    }
  }
  return rows;
}

/**
 * resolvePartyAlias(row, reqUser) → row (mutated).
 *
 * raw.aliases shape (V1 transition; future product_party_aliases table):
 *   {
 *     customer: { "<company_code>": { sku, name, is_orderable, ... }, ... },
 *     factory:  { "<company_code>": { code, name, ... }, ... }
 *   }
 *
 * Behavior:
 *   - 'full'                → keep full raw.aliases (admin/finance edit it)
 *   - 'internal_restricted' → keep full map (V1; future: scope per party)
 *   - 'factory'             → set row.alias = aliases.factory[caller_code]
 *                             delete raw.aliases
 *   - 'customer'            → set row.alias = aliases.customer[caller_code]
 *                             delete raw.aliases
 *   - null scope            → delete raw.aliases
 *
 * Never returns another party's alias to the caller.
 */
export function resolvePartyAlias(row, reqUser) {
  if (!row || !row.raw || !row.raw.aliases) return row;
  const scope = getProductScope(reqUser);
  if (!scope) { delete row.raw.aliases; return row; }
  if (scope.mode === "full" || scope.mode === "internal_restricted") return row;

  const aliases = row.raw.aliases;
  let mine = null;
  if (scope.mode === "factory" && aliases.factory && typeof aliases.factory === "object") {
    for (const code of scope.codes) {
      if (Object.prototype.hasOwnProperty.call(aliases.factory, code)) {
        mine = aliases.factory[code];
        break;
      }
    }
  } else if (scope.mode === "customer" && aliases.customer && typeof aliases.customer === "object") {
    for (const code of scope.codes) {
      if (Object.prototype.hasOwnProperty.call(aliases.customer, code)) {
        mine = aliases.customer[code];
        break;
      }
    }
  }
  if (mine) row.alias = mine;
  delete row.raw.aliases;
  return row;
}

/**
 * resolvePricingVisibility(row, reqUser) → row (mutated).
 *
 * raw.pricing shape (V1 transition; future product_pricing table):
 *   {
 *     factory_price: { value, currency, unit, source, scope_company_code?, ... },
 *     sales_price:   { ... },
 *     customs_declared_price: { ... },
 *     invoice_price: { ... },
 *     tax_rebate_rate: { ... },
 *     ...
 *   }
 *
 * Behavior:
 *   - 'full'                → keep full raw.pricing (admin/finance)
 *   - 'internal_restricted' → expose customs_declared_price + tax_rebate_rate
 *                             only; expose *_status flags for the rest. Trader
 *                             role: no pricing in product center (handled
 *                             upstream by field whitelist).
 *   - 'factory'             → expose only factory_price scoped to caller's
 *                             company_code (or unscoped legacy value)
 *   - 'customer'            → no pricing (price flows via quote/PI/SC/order)
 *   - null scope            → no pricing
 */
export function resolvePricingVisibility(row, reqUser) {
  if (!row || !row.raw || !row.raw.pricing) return row;
  const scope = getProductScope(reqUser);
  if (!scope) { delete row.raw.pricing; return row; }
  const pricing = row.raw.pricing;

  if (scope.mode === "full") return row;

  if (scope.mode === "internal_restricted") {
    // Trader is a reseller — TRADER_HIDE_FIELDS already strips rebate/tax from
    // top-level columns, so the nested pricing branch must NOT re-leak them.
    // Codex audit (CODEX-REVIEW P1, 2026-05-19): trader fell through here and
    // received tax_rebate_rate + status flags. Strip pricing entirely for trader.
    if (scope.role === "trader") {
      delete row.raw.pricing;
      return row;
    }
    // Customs: keep customs_declared_price + tax_rebate_rate (it's the only
    // role besides admin that legitimately needs them for declarations), but
    // strip sales/factory/invoice pricing — including status flags.
    if (scope.role === "customs") {
      const customsMasked = {};
      if (pricing.customs_declared_price) customsMasked.customs_declared_price = pricing.customs_declared_price;
      if (pricing.tax_rebate_rate)        customsMasked.tax_rebate_rate        = pricing.tax_rebate_rate;
      row.pricing = customsMasked;
      delete row.raw.pricing;
      return row;
    }
    const masked = {};
    if (pricing.customs_declared_price) masked.customs_declared_price = pricing.customs_declared_price;
    if (pricing.tax_rebate_rate)        masked.tax_rebate_rate        = pricing.tax_rebate_rate;
    if (pricing.sales_price)            masked.sales_price_status     = pricing.sales_price.value != null ? "configured" : "missing";
    if (pricing.factory_price)          masked.factory_price_status   = pricing.factory_price.value != null ? "configured" : "missing";
    if (pricing.invoice_price)          masked.invoice_price_status   = pricing.invoice_price.value != null ? "configured" : "missing";
    row.pricing = masked;
    delete row.raw.pricing;
    return row;
  }

  if (scope.mode === "factory") {
    const fp = pricing.factory_price;
    let visible = null;
    if (fp && typeof fp === "object") {
      // If pricing entry tags a scope_company_code, require match. Otherwise
      // (legacy / unscoped) expose it — V1 transition data may be unscoped.
      if (fp.scope_company_code) {
        if (scope.codes.includes(String(fp.scope_company_code))) visible = fp;
      } else {
        visible = fp;
      }
    }
    if (visible) row.pricing = { factory_price: visible };
    delete row.raw.pricing;
    return row;
  }

  // customer or anything else: strip entirely
  delete row.raw.pricing;
  return row;
}

// ── Convenience: apply all post-query transforms in one pass ────────────────
// Call AFTER row scope filter has been applied.
export function applyAllVisibility(rows, reqUser) {
  applyProductFieldWhitelist(rows, reqUser);
  for (const row of rows) {
    resolvePartyAlias(row, reqUser);
    resolvePricingVisibility(row, reqUser);
  }
  return rows;
}

// ── Factory write-in V1 (2026-05-20) ───────────────────────────────────────
// Write gate for the new PATCH /api/db/products/:sku/factory-profile endpoint.
// Distinct from the PUT/PATCH master-data gates because the write surface is
// narrow (raw.factory_profile + raw.aliases.factory[code]) and factories must
// be allowed to maintain their own profile.
//
//   - admin / super_admin / superadmin / platform_admin   → may write any factory
//   - finance / platform_finance                          → may write any factory
//   - logistics                                            → may write any factory
//   - factory                                              → only own company_code
//   - everyone else                                        → 403
//
// canWriteFactoryProfile returns { ok, targetFactoryCompanyCode, reason }.
//   - ok=false → caller forbidden; reason explains why
//   - ok=true  → targetFactoryCompanyCode is the validated company code to
//                write into; callers MUST use this, NOT the body's value.
//
// For factory role: targetFactoryCompanyCode is locked to req.user's own code.
// For admin/finance/logistics: targetFactoryCompanyCode comes from the body
// (target_factory_company_code is REQUIRED and must be a non-empty string).
const FACTORY_PROFILE_ANY_FACTORY_ROLES = new Set([
  "admin", "super_admin", "superadmin", "platform_admin",
  "finance", "platform_finance",
  "logistics",
]);

export function canWriteFactoryProfile(reqUser, requestedTargetCode) {
  if (!reqUser || !reqUser.role) {
    return { ok: false, reason: "no req.user" };
  }
  const role = normalizeRole(reqUser.role);

  // Admin / finance / logistics: may write any factory's profile, but MUST
  // supply target_factory_company_code in the body so the audit trail is
  // explicit and the write is not "to whoever the actor happens to belong to".
  if (FACTORY_PROFILE_ANY_FACTORY_ROLES.has(role)) {
    const code = typeof requestedTargetCode === "string" ? requestedTargetCode.trim() : "";
    if (!code) {
      return { ok: false, reason: "target_factory_company_code required for proxy write" };
    }
    return { ok: true, targetFactoryCompanyCode: code };
  }

  // Factory: locked to caller's own company_code(s). Multi-code factory
  // users may target any of their own codes; the body's value is honored
  // only if it appears in caller.companyCodes. Default behaviour:
  //   - single code → use it (target may be omitted)
  //   - multiple codes → target MUST be supplied to avoid ambiguity
  // CODEX-REVIEW P2 (2026-05-20): the previous code locked to codes[0],
  // breaking multi-code factory users who could GET products under their
  // 2nd code but not write the profile.
  if (role === "factory") {
    const codes = normalizeCodes(reqUser);
    if (codes.length === 0) {
      return { ok: false, reason: "factory has no company_code" };
    }
    const reqTrim = requestedTargetCode != null ? String(requestedTargetCode).trim() : "";
    if (reqTrim) {
      if (!codes.includes(reqTrim)) {
        return { ok: false, reason: "factory may only write own company_code(s)" };
      }
      return { ok: true, targetFactoryCompanyCode: reqTrim };
    }
    // No target supplied — only safe to default when caller has a single code
    if (codes.length === 1) {
      return { ok: true, targetFactoryCompanyCode: codes[0] };
    }
    return { ok: false, reason: "factory has multiple company_codes — target_factory_company_code required" };
  }

  return { ok: false, reason: `role ${role} cannot write factory profile` };
}

// Whitelist of body keys accepted by PATCH /api/db/products/:sku/factory-profile.
// Any other key is rejected (defense-in-depth — never trust body shape).
export const FACTORY_PROFILE_WRITABLE_KEYS = Object.freeze([
  "factory_product_code",
  "factory_product_name",
  "factory_spec",
  "moq",
  "lead_time_days",
  "production_status",
  "package_requirement",
  "material_requirement",
  "qc_requirement",
  "factory_notes",
]);

// Keys explicitly rejected if present in the body (extra clear-error rather
// than silent ignore — surfaces misuse during development).
export const FACTORY_PROFILE_REJECTED_KEYS = Object.freeze([
  "factory_price", "sanlyn_price", "sales_price", "customs_declared_price",
  "invoice_price", "tax_rebate_rate", "tax_rate", "rebate_rate",
  "profit", "margin", "pricing",
  "customer_sku", "customer_alias",
  "aliases", "factory_profile",      // direct overwrite of these sub-objects
  "raw", "id", "sku", "active", "deleted_at",
]);

export default {
  getProductScope,
  applyProductRowScope,
  applyProductFieldWhitelist,
  resolvePartyAlias,
  resolvePricingVisibility,
  applyAllVisibility,
  canWriteFactoryProfile,
  FACTORY_PROFILE_WRITABLE_KEYS,
  FACTORY_PROFILE_REJECTED_KEYS,
};
