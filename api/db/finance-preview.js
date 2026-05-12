// api/db/finance-preview.js
// D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-IMPL-001
//
// Finance Preview F-C endpoint shell.
// Capability gate + audit bridge + vault strip.
// Does NOT implement computeFinancePreview (E-layer DOUBLE HOLD).
//
// Supported operations:
//   F-1  GET  ?operation=read           finance:preview:read
//              → safe empty if no vault.finance_preview data yet
//   F-5  GET  ?operation=read_summary   finance:preview:read_summary
//              → {is_hard_blocked, blocked_count, pending_count, estimate_count}
//              → server-side pick new object (never spread-then-delete)
//   F-2  POST { operation:"compute" }   → 501 BLOCKED (E DOUBLE HOLD)
//   F-3  POST { operation:"confirm" }   → 200 blocked (no preview data)
//   F-4  POST { operation:"signoff" }   → 200 blocked (no preview data)
//
//   All GET operations also accept POST with { operation }.
//   All 403 access denials write an audit event.
//   Vault key is ABSENT (not null, not {}) in all external-role responses.
//
// SCOPE:
//   ❌ No computeFinancePreview logic
//   ❌ No vault.finance_preview write
//   ❌ No finance_records / settlement_edge / paid / settled / invoice_issuer_confirmed
//   ❌ No DB schema change / migration
//   ❌ No auth.js JWT modification

import { requireAuth } from "../auth.js";
import { getPool } from "../db.js";
import { checkCapability, stripVaultForExternal, applyVaultLens, canonicalRole } from "../lib/financePreviewGate.js";
import { writeFinancePreviewAudit } from "../lib/financePreviewAuditBridge.js";

// ─── read_summary: server-side picked fields (never spread-then-delete) ───────
var SUMMARY_FIELDS = ["is_hard_blocked", "blocked_count", "pending_count", "estimate_count"];

var SAFE_EMPTY_SUMMARY = {
  is_hard_blocked: null,
  blocked_count:   0,
  pending_count:   0,
  estimate_count:  0,
};

var SAFE_EMPTY_PREVIEW = {
  exists:          false,
  finance_preview: null,
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;

  var pool = getPool();
  var body = req.body || {};

  var operation = (
    req.method === "GET"
      ? (req.query.operation || "read")
      : (body.operation || "read")
  ).toLowerCase().trim();

  var contractNo = (req.query.contract_no || body.contract_no || "").trim() || null;
  var orderId    = (req.query.order_id    || body.order_id    || "").trim() || null;
  var entityId   = contractNo || orderId;

  try {
    // ═══ F-2: compute — BLOCKED while E is DOUBLE HOLD ══════════════════════
    if (operation === "compute") {
      var computeCheck = checkCapability(req, "finance:preview:compute");
      if (!computeCheck.allowed) {
        await writeFinancePreviewAudit(pool, req, {
          action:    "finance_preview.access_denied",
          entity_id: entityId,
          after:     { operation: "compute", denied_for: "insufficient_capability" },
          reason:    "access_denied",
        });
        return res.status(403).json({
          error:   "access_denied",
          message: "Insufficient capability: finance:preview:compute",
        });
      }
      // Always 501 while E is DOUBLE HOLD — even for authorized roles
      await writeFinancePreviewAudit(pool, req, {
        action:    "finance_preview_compute_attempt_blocked",
        entity_id: entityId,
        after:     { operation: "compute", blocked_reason: "E_DOUBLE_HOLD", canon: computeCheck.canon },
        reason:    "E_computeFinancePreview_DOUBLE_HOLD",
      });
      return res.status(501).json({
        error:   "not_implemented",
        blocked: true,
        message: "computeFinancePreview is DOUBLE HOLD. E-layer not yet authorized.",
        hint:    "Requires explicit APPROVE_COMPUTE_FINANCE_PREVIEW_V2_IMPL_001.",
      });
    }

    // ═══ F-3: confirm — soft-blocked (no preview data; E not enabled) ════════
    if (operation === "confirm") {
      var confirmCheck = checkCapability(req, "finance:preview:confirm");
      if (!confirmCheck.allowed) {
        await writeFinancePreviewAudit(pool, req, {
          action:    "finance_preview.access_denied",
          entity_id: entityId,
          after:     { operation: "confirm", denied_for: "insufficient_capability" },
          reason:    "access_denied",
        });
        return res.status(403).json({
          error:   "access_denied",
          message: "Insufficient capability: finance:preview:confirm",
        });
      }
      // Soft block — does NOT create finance_records / settlement_edge / paid / settled
      await writeFinancePreviewAudit(pool, req, {
        action:    "finance_preview.confirm_blocked",
        entity_id: entityId,
        after:     { operation: "confirm", blocked_reason: "no_preview_E_not_enabled", canon: confirmCheck.canon },
        reason:    "no_finance_preview_data",
      });
      return res.status(200).json({
        success: false,
        blocked: true,
        message: "confirm blocked: finance_preview not available (E-layer DOUBLE HOLD)",
      });
    }

    // ═══ F-4: signoff — blocked (E not enabled) ══════════════════════════════
    if (operation === "signoff") {
      var signoffCheck = checkCapability(req, "finance:preview:signoff");
      if (!signoffCheck.allowed) {
        await writeFinancePreviewAudit(pool, req, {
          action:    "finance_preview.access_denied",
          entity_id: entityId,
          after:     { operation: "signoff", denied_for: "insufficient_capability" },
          reason:    "access_denied",
        });
        return res.status(403).json({
          error:   "access_denied",
          message: "Insufficient capability: finance:preview:signoff",
        });
      }
      // Blocked — does NOT write paid / settled / settlement_edge / invoice_issuer
      await writeFinancePreviewAudit(pool, req, {
        action:    "finance_preview.signoff_blocked",
        entity_id: entityId,
        after:     { operation: "signoff", blocked_reason: "no_preview_E_not_enabled", canon: signoffCheck.canon },
        reason:    "no_finance_preview_data",
      });
      return res.status(200).json({
        success: false,
        blocked: true,
        message: "signoff blocked: finance_preview not available (E-layer DOUBLE HOLD)",
      });
    }

    // ═══ F-5: read_summary — internal_operator may use ═══════════════════════
    if (operation === "read_summary") {
      var summaryCheck = checkCapability(req, "finance:preview:read_summary");
      if (!summaryCheck.allowed) {
        await writeFinancePreviewAudit(pool, req, {
          action:    "finance_preview.access_denied",
          entity_id: entityId,
          after:     { operation: "read_summary", denied_for: "insufficient_capability" },
          reason:    "access_denied",
        });
        return res.status(403).json({
          error:   "access_denied",
          message: "Insufficient capability: finance:preview:read_summary",
        });
      }

      // Server-side pick — NEVER return full payload then delete fields
      var summary = Object.assign({}, SAFE_EMPTY_SUMMARY);
      if (contractNo) {
        try {
          var sumResult = await pool.query(
            "SELECT vault FROM orders WHERE contract_no = $1 LIMIT 1",
            [contractNo]
          );
          if (sumResult.rows.length > 0) {
            var vault = sumResult.rows[0].vault || {};
            var fp = vault.finance_preview;
            if (fp && typeof fp === "object") {
              var picked = {};
              for (var i = 0; i < SUMMARY_FIELDS.length; i++) {
                var f = SUMMARY_FIELDS[i];
                picked[f] = Object.prototype.hasOwnProperty.call(fp, f) ? fp[f] : SAFE_EMPTY_SUMMARY[f];
              }
              summary = picked;
            }
          }
        } catch (e) {
          // DB read failure — return safe empty, do not fail request
        }
      }

      await writeFinancePreviewAudit(pool, req, {
        action:    "finance_preview.read_summary",
        entity_id: entityId,
        after:     { operation: "read_summary", result: "safe_summary_returned", canon: summaryCheck.canon },
        reason:    null,
      });

      return res.status(200).json({
        success:   true,
        operation: "read_summary",
        data:      summary,
      });
    }

    // ═══ F-1: read (default) — platform_finance / platform_admin ════════════
    if (operation === "read") {
      var readCheck = checkCapability(req, "finance:preview:read");
      if (!readCheck.allowed) {
        await writeFinancePreviewAudit(pool, req, {
          action:    "finance_preview.access_denied",
          entity_id: entityId,
          after:     { operation: "read", denied_for: "insufficient_capability" },
          reason:    "access_denied",
        });
        return res.status(403).json({
          error:   "access_denied",
          message: "Insufficient capability: finance:preview:read",
        });
      }

      var previewRow = null;
      if (contractNo) {
        try {
          var readResult = await pool.query(
            "SELECT id, contract_no, vault FROM orders WHERE contract_no = $1 LIMIT 1",
            [contractNo]
          );
          if (readResult.rows.length > 0) {
            previewRow = readResult.rows[0];
          }
        } catch (e) {
          // swallow — safe empty returned below
        }
      }

      if (!previewRow || !previewRow.vault || !previewRow.vault.finance_preview) {
        await writeFinancePreviewAudit(pool, req, {
          action:    "finance_preview.read",
          entity_id: entityId,
          after:     { operation: "read", result: "not_found", canon: readCheck.canon },
          reason:    null,
        });
        return res.status(200).json({
          success:   true,
          operation: "read",
          data:      SAFE_EMPTY_PREVIEW,
        });
      }

      // Apply vault strip before returning any row (D contract)
      var safeRow = stripVaultForExternal(previewRow, req.user.role);

      await writeFinancePreviewAudit(pool, req, {
        action:    "finance_preview.read",
        entity_id: entityId,
        after:     { operation: "read", result: "found", canon: readCheck.canon },
        reason:    null,
      });

      return res.status(200).json({
        success:   true,
        operation: "read",
        data: {
          exists:          true,
          finance_preview: safeRow.vault ? safeRow.vault.finance_preview : null,
        },
      });
    }

    // Unknown operation
    return res.status(400).json({
      error:   "unknown_operation",
      message: "Supported: read, read_summary, compute, confirm, signoff",
    });

  } catch (err) {
    console.error("[finance-preview] Error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }
}
