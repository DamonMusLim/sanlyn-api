// api/lib/financePreviewAuditBridge.js
// D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-IMPL-001
//
// Thin wrapper around audit-helper.js writeAudit for finance_preview events.
// Implements Option B: field mapping onto existing audit_logs columns.
// No DB migration. No new columns. No new tables.
//
// Option B mapping:
//   actor_id     → audit_logs.operator   (via writeAudit ← req.user.email/username)
//   actor_role   → audit_logs.role       (via writeAudit ← req.user.role)
//   object_type  → audit_logs.entity_type = "finance_preview"  (fixed)
//   object_id    → audit_logs.entity_id  = orderId / contract_no
//   action       → audit_logs.action
//   before       → audit_logs.before     (JSONB — no real amounts)
//   after        → audit_logs.after      (JSONB — no real amounts)
//   request_id   → audit_logs.request_id (from req.headers["x-request-id"])
//   reason       → audit_logs.after.reason (JSONB subfield — no new column)
//
// FORBIDDEN in any audit payload written here:
//   amount / unit_price / total / exchange_rate
//   payer / payee names or codes
//   settlement_edge / paid / settled / invoice_issuer
//   AR/AP full item arrays

import { writeAudit } from "../db/audit-helper.js";

/**
 * Write a finance_preview audit event using Option B field mapping.
 *
 * @param {object}  pool
 * @param {object}  req                  — Express req (actor extracted by writeAudit)
 * @param {object}  params
 * @param {string}  params.action        — e.g. "finance_preview.access_denied"
 * @param {string}  [params.entity_id]   — contract_no / order_id (no real amounts)
 * @param {object}  [params.before]      — before state (no real amounts)
 * @param {object}  [params.after]       — after state (no real amounts)
 * @param {string}  [params.reason]      — stored in after.reason JSONB subfield (no new column)
 * @param {string}  [params.note]        — human-readable note for detail.note
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function writeFinancePreviewAudit(pool, req, params) {
  if (!pool || !params || !params.action) {
    return { ok: false, error: "missing pool/action" };
  }

  // Merge reason into after.reason (JSONB subfield — no new audit_logs column)
  var afterPayload = Object.assign({}, params.after || {});
  if (params.reason != null) {
    afterPayload.reason = String(params.reason).slice(0, 200);
  }

  return writeAudit(pool, req, {
    action:      params.action,
    entity_type: "finance_preview",
    entity_id:   params.entity_id ? String(params.entity_id) : null,
    before:      params.before || {},
    after:       afterPayload,
    note:        params.note || null,
  });
}
