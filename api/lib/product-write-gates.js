// api/lib/product-write-gates.js
// ─────────────────────────────────────────────────────────────────────────────
// Write-side permission gates and body whitelists for the Product Master V1
// write endpoints. Co-located with api/lib/product-scope.js (read-side); split
// out 2026-05-20 to keep product-scope.js under Damon's 500-line cap.
//
// SECURITY-CRITICAL. Codex review required for every change.
//   • Front-end-supplied company_code values are NEVER auth evidence — they
//     are write targets that must be validated against req.user's own codes.
//   • Helpers always return { ok, role?, targetFactoryCompanyCode?, reason }.
//     Callers translate ok=false to HTTP 403/400 with the supplied reason.

// Tiny role normalizer kept local so callers don't need both modules.
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

// ── canWriteFactoryProfile ───────────────────────────────────────────────────
// Gate for PATCH /api/db/products/:sku/factory-profile.
//
//   - admin / super_admin / superadmin / platform_admin   → may write any factory
//   - finance / platform_finance                          → may write any factory
//   - logistics                                            → may write any factory
//   - factory                                              → only own company_code(s)
//   - everyone else                                        → 403
//
// Returns { ok, role, targetFactoryCompanyCode, reason }.
//   - role is the LOWERCASED req.user.role — handlers MUST switch on this
//     (not on req.user.role) to avoid casing bypasses.
//   - For factory role: if caller has multiple companyCodes, the body MUST
//     supply target_factory_company_code (an ambiguous default would risk
//     writing to the wrong code).
//   - For admin/finance/logistics: target_factory_company_code is REQUIRED;
//     proxy writes without an explicit target are rejected so the audit
//     trail is always explicit.
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

  // Admin / finance / logistics: must supply target_factory_company_code.
  if (FACTORY_PROFILE_ANY_FACTORY_ROLES.has(role)) {
    const code = typeof requestedTargetCode === "string" ? requestedTargetCode.trim() : "";
    if (!code) {
      return { ok: false, reason: "target_factory_company_code required for proxy write" };
    }
    return { ok: true, role, targetFactoryCompanyCode: code };
  }

  // Factory: locked to caller's own company_code(s). Multi-code users may
  // target any of their own codes; body's value honored only if it appears
  // in caller.companyCodes.
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
      return { ok: true, role, targetFactoryCompanyCode: reqTrim };
    }
    if (codes.length === 1) {
      return { ok: true, role, targetFactoryCompanyCode: codes[0] };
    }
    return { ok: false, reason: "factory has multiple company_codes — target_factory_company_code required" };
  }

  return { ok: false, reason: `role ${role} cannot write factory profile` };
}

// ── Body whitelist ──────────────────────────────────────────────────────────
// Keys accepted by PATCH /api/db/products/:sku/factory-profile. Any other
// key is rejected. Frozen to prevent runtime mutation.
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

// Keys explicitly rejected if present (clearer error than silent ignore).
export const FACTORY_PROFILE_REJECTED_KEYS = Object.freeze([
  "factory_price", "sanlyn_price", "sales_price", "customs_declared_price",
  "invoice_price", "tax_rebate_rate", "tax_rate", "rebate_rate",
  "profit", "margin", "pricing",
  "customer_sku", "customer_alias",
  "aliases", "factory_profile",
  "raw", "id", "sku", "active", "deleted_at",
]);

export default {
  canWriteFactoryProfile,
  FACTORY_PROFILE_WRITABLE_KEYS,
  FACTORY_PROFILE_REJECTED_KEYS,
};
