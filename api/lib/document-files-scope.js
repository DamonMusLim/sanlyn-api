// document-files-scope.js
// MIN_FIX_BATCH_20260526 A-3 (2026-05-25)
//
// Defensive scoping helper for any read endpoint hitting `document_files`.
//
// AUDIT FINDING (REMAINING_TABLE_FIELD_AUDIT_001 worker D, F-D-001):
//   `document_files.visibility_scope` is declared NOT NULL DEFAULT '{}'.
//   All 231 prod rows have empty visibility_scope.
//   Today there is NO live customer-facing GET endpoint on document_files,
//   so this is not an active leak — but the table is default-open by data
//   shape. Any future read endpoint MUST use this helper to fail-closed.
//
// Generator path (api/db/documents.js line ~390-428) uses a different table
// (`documents`) and is already fail-closed via JOIN orders.company_code.
// This helper is for the `document_files` table specifically.
//
// USAGE (mandatory pattern for any new read endpoint on document_files):
//
//   import { documentFilesScopeSql } from "../lib/document-files-scope.js";
//   const scope = documentFilesScopeSql(req); // returns { sql, params, isAdmin }
//   const q = `SELECT * FROM document_files WHERE ${scope.sql} ORDER BY ...`;
//   const rows = await pool.query(q, scope.params);
//
// RULES enforced:
//   1. Admin / internal roles: no restriction (returns "TRUE").
//   2. Non-admin: MUST match at least one of:
//        - JWT role in visibility_scope (array overlap)
//        - JWT companyCode in visibility_scope
//        - owner_company_id = JWT company_id
//   3. Empty visibility_scope ('{}') is fail-closed for non-admin
//      (NOT treated as "open to everyone").
//   4. tenant_id MUST match req.user.tenant_id when set.
//
// NOTE: this helper does NOT change DB schema (out of scope per Damon
// MIN_FIX_BATCH_20260526). It only provides the read-side guard.

const INTERNAL_ROLES = new Set([
  "admin", "super_admin", "root",
  "finance", "logistics", "trader", "sales", "internal",
]);

export function documentFilesScopeSql(req, opts) {
  opts = opts || {};
  const user = req && req.user;
  const isAdmin = !!(user && INTERNAL_ROLES.has(String(user.role || "").toLowerCase()));

  if (isAdmin) {
    // Admin: tenant guard still applies if set
    if (user && user.tenant_id != null) {
      return {
        sql: "(tenant_id IS NULL OR tenant_id = $1)",
        params: [user.tenant_id],
        isAdmin: true,
      };
    }
    return { sql: "TRUE", params: [], isAdmin: true };
  }

  // Non-admin: build scoped predicate
  const role = String(user && user.role || "").toLowerCase();
  const companyCodes = (user && user.companyCodes) ||
    (user && user.companyCode ? [user.companyCode] : []);
  const codes = companyCodes
    .map(c => String(c).trim().toUpperCase())
    .filter(c => c.length > 0 && c.length <= 64);

  if (!role && codes.length === 0) {
    // Fail-closed: no identity → return predicate that matches nothing
    return { sql: "FALSE", params: [], isAdmin: false };
  }

  const params = [];
  const orClauses = [];

  // Match by role in visibility_scope (array contains)
  if (role) {
    params.push(role);
    orClauses.push("visibility_scope @> ARRAY[$" + params.length + "]::text[]");
  }

  // Match by any of user's company codes in visibility_scope
  if (codes.length > 0) {
    params.push(codes);
    orClauses.push("visibility_scope && $" + params.length + "::text[]");
  }

  // Match by owner_company_id if user has company_id
  if (user && user.company_id != null) {
    params.push(user.company_id);
    orClauses.push("owner_company_id = $" + params.length);
  }

  // Match by bound_subject if caller scopes to a specific subject id
  if (opts.bound_subject_id) {
    params.push(opts.bound_subject_id);
    orClauses.push("bound_subject_id = $" + params.length);
  }

  // NOTE: empty visibility_scope ('{}') intentionally does NOT match.
  // Fail-closed: rows must explicitly grant visibility.

  let scopeSql;
  if (orClauses.length === 0) {
    scopeSql = "FALSE";
  } else {
    scopeSql = "(" + orClauses.join(" OR ") + ")";
  }

  // Layer tenant_id guard on top (non-admin: must match)
  if (user && user.tenant_id != null) {
    params.push(user.tenant_id);
    scopeSql = "(tenant_id = $" + params.length + " AND " + scopeSql + ")";
  }

  return { sql: scopeSql, params, isAdmin: false };
}

// Convenience: assert that a row is visible to req.user (post-fetch defense in depth).
export function assertDocumentFileVisible(row, req) {
  const user = req && req.user;
  if (!user) return false;
  const isAdmin = INTERNAL_ROLES.has(String(user.role || "").toLowerCase());
  if (isAdmin) {
    if (user.tenant_id != null && row.tenant_id != null && row.tenant_id !== user.tenant_id) return false;
    return true;
  }
  if (user.tenant_id != null && row.tenant_id !== user.tenant_id) return false;

  const scope = Array.isArray(row.visibility_scope) ? row.visibility_scope : [];
  if (scope.length === 0) return false; // fail-closed on default-empty

  const role = String(user.role || "").toLowerCase();
  if (role && scope.includes(role)) return true;

  const codes = (user.companyCodes || (user.companyCode ? [user.companyCode] : []))
    .map(c => String(c).trim().toUpperCase());
  for (const c of codes) {
    if (scope.includes(c)) return true;
  }

  if (user.company_id != null && row.owner_company_id === user.company_id) return true;

  return false;
}
