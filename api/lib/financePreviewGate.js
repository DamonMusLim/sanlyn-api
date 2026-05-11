// api/lib/financePreviewGate.js
// D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-IMPL-001
//
// Canonical role shim + capability gate + vault strip for finance_preview F-C.
// Pure functions — no DB, no HTTP, no auth.js modification.
//
// SCOPE:
//   ✅ canonicalRole(role)            — maps legacy JWT roles → canonical
//   ✅ ROLE_DEFAULT_CAPABILITIES      — default caps per canonical role
//   ✅ checkCapability(req, cap)       → { allowed, canon }
//   ✅ isInternalRoleCanonical(role)   — strict 3-role check for vault strip
//   ✅ stripVaultForExternal(row, role)— JS port of D TypeScript contract (IMPL-001 PASS)
//   ✅ applyVaultLens(rows, role)      — batch helper
//   ❌ NO DB / HTTP / auth.js JWT modification
//   ❌ NO computeFinancePreview
//   ❌ NO finance_records / settlement_edge / paid / settled
//
// canonicalRole is used ONLY for finance_preview gate.
// Does not change permissions in any other module.

// ─── Canonical role mapping ────────────────────────────────────────────────
// Maps legacy JWT role strings → canonical D-layer finance_preview roles.
// Unknown / null / empty → "external" (fail-closed).
var CANONICAL_ROLE_MAP = {
  // legacy → canonical
  "finance":           "platform_finance",
  "admin":             "platform_admin",
  "internal":          "internal_operator",
  // canonical pass-through
  "platform_finance":  "platform_finance",
  "platform_admin":    "platform_admin",
  "internal_operator": "internal_operator",
  // external roles (kept as-is for clarity)
  "customer":          "buyer",
  "buyer":             "buyer",
  "factory":           "factory",
  "supplier":          "supplier",
  "broker_customer":   "broker_customer",
  "broker_factory":    "broker_factory",
  "supply_chain_ocean":"supply_chain_ocean",
  // explicitly not canonical — fail-closed
  // internal_ops, boss, super_admin, system, finance (legacy) → mapped above or external
};

/**
 * Map any JWT role to a canonical finance_preview role.
 * Fail-closed: unknown / null / empty → "external".
 *
 * Aliases explicitly NOT canonical (fail-closed to external):
 *   - super_admin, boss, system — not in canonical 3-role set
 *   - internal_ops              — legacy alias, treated as external for vault
 *
 * @param {string|null|undefined} role
 * @returns {string}
 */
export function canonicalRole(role) {
  if (!role || typeof role !== "string") return "external";
  var key = role.toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(CANONICAL_ROLE_MAP, key)) {
    return CANONICAL_ROLE_MAP[key];
  }
  return "external";
}

// ─── Default capabilities per canonical role ─────────────────────────────────
// Used when JWT has no capabilities field (current production state).
// Empty array for unknown / external roles → fail-closed.
export var ROLE_DEFAULT_CAPABILITIES = {
  "platform_finance":  [
    "finance:preview:read",
    "finance:preview:compute",
    "finance:preview:confirm",
    "finance:preview:signoff",
    "finance:preview:read_summary",
  ],
  "platform_admin":    [
    "finance:preview:read",
    "finance:preview:compute",
    "finance:preview:read_summary",
  ],
  "internal_operator": [
    "finance:preview:read_summary",
  ],
  // All other canonical roles → no finance_preview capabilities
  "buyer":             [],
  "factory":           [],
  "supplier":          [],
  "broker_customer":   [],
  "broker_factory":    [],
  "supply_chain_ocean":[],
  "external":          [],
};

/**
 * Check whether the authenticated request has a required finance_preview capability.
 *
 * Falls back to role-derived default capabilities if req.user.capabilities is absent.
 * Fail-closed: no user / no role / unknown role / missing capability → { allowed: false }.
 *
 * @param {object} req           — Express req with req.user set by authMiddleware
 * @param {string} capability    — e.g. "finance:preview:read"
 * @returns {{ allowed: boolean, canon: string }}
 */
export function checkCapability(req, capability) {
  if (!req || !req.user || !req.user.role) return { allowed: false, canon: "external" };
  var canon = canonicalRole(req.user.role);
  var caps = req.user.capabilities
    || ROLE_DEFAULT_CAPABILITIES[canon]
    || [];
  return {
    allowed: Array.isArray(caps) && caps.includes(capability),
    canon: canon,
  };
}

// ─── Vault strip — JS port of D TypeScript contract ─────────────────────────
// Source: app/components/src/permission/vaultStrip.ts (D-IMPL-001 PASS)
// Contract is identical; ported to plain JS for API use.
// No cross-repo import — self-contained.

export var VAULT_TOP_KEY = "vault";

/**
 * Canonical 3-role internal check: {platform_finance, platform_admin, internal_operator}.
 * Input must already be a canonical role string (from canonicalRole()).
 * Everything else → external → vault MUST be stripped.
 *
 * @param {string|null|undefined} canon — already-canonicalized role
 * @returns {boolean}
 */
export function isInternalRoleCanonical(canon) {
  return canon === "platform_finance"
      || canon === "platform_admin"
      || canon === "internal_operator";
}

/**
 * Strip the entire `vault` key from a row for external roles.
 *
 * Contract (identical to D TypeScript vaultStrip.ts):
 *   - Internal canonical role → returns input row unchanged (no allocation)
 *   - External role → new object with `vault` key ABSENT (never null, never {})
 *   - null / primitive / Array input → returned unchanged
 *   - Row with no vault key → returned unchanged (no-op)
 *   - Fail-closed: unknown/null rawRole → canonicalized to "external"
 *
 * @param {object}              row
 * @param {string|null|undefined} rawRole — JWT role (canonicalized internally)
 * @returns {object}
 */
export function stripVaultForExternal(row, rawRole) {
  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
  var canon = canonicalRole(rawRole);
  if (isInternalRoleCanonical(canon)) return row;
  if (!Object.prototype.hasOwnProperty.call(row, VAULT_TOP_KEY)) return row;
  // External role + vault present → clone with vault key absent
  var rest = {};
  var keys = Object.keys(row);
  for (var i = 0; i < keys.length; i++) {
    if (keys[i] !== VAULT_TOP_KEY) rest[keys[i]] = row[keys[i]];
  }
  return rest;
}

/**
 * Apply stripVaultForExternal across an array of rows.
 *
 * Internal canonical role → returns input array unchanged (no clone).
 * External role → new array; each row stripped if it had vault.
 * Non-array input → returned unchanged.
 *
 * @param {readonly object[]} rows
 * @param {string|null|undefined} rawRole
 * @returns {readonly object[]}
 */
export function applyVaultLens(rows, rawRole) {
  if (!Array.isArray(rows)) return rows;
  var canon = canonicalRole(rawRole);
  if (isInternalRoleCanonical(canon)) return rows;
  return rows.map(function(r) { return stripVaultForExternal(r, rawRole); });
}
