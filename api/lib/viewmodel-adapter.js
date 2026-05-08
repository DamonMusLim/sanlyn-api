// api/lib/viewmodel-adapter.js
//
// Common ViewModel Adapter for all collab sheet endpoints.
// Contracts:
//   - applyLens(row, role)         : strip internal_note for non-internal roles
//   - adaptCollabSheet(row, ctx)   : full strip (internal_note + forbidden fields + non-allowed notes)
//   - filterByRole(rows, ctx)      : map adaptCollabSheet over rows
//   - assertNoForbiddenInBody(body): defensive write-side guard
//   - isInternalRole / roleFromAuth: shared role helpers
//
// Notes:
//   - Forbidden fields are isolated at the schema layer (NOT in any sheet table).
//     This adapter is a defense-in-depth check; it strips them if they ever leak in.
//   - applyLens is the cheap fast path used inside D's loading-sheets.js. New
//     endpoints should prefer adaptCollabSheet, which is the strict variant.

import crypto from "node:crypto";

// ── Roles considered "internal" (full visibility, may write internal_note) ──
const INTERNAL_ROLES = new Set([
  "admin", "internal", "boss", "finance", "platform_admin", "system",
]);

export function isInternalRole(role) {
  return INTERNAL_ROLES.has(String(role || "").toLowerCase());
}

// ── Role detection from request (best-effort; auth middleware should already
//    have run, so prefer req.user, with explicit ?role= as a debug fallback) ──
export function roleFromAuth(req) {
  if (req && req.user && req.user.role) return String(req.user.role).toLowerCase();
  if (req && req.query && req.query.role) return String(req.query.role).toLowerCase();
  // last resort: try JWT bearer payload
  try {
    const auth = (req && req.headers && req.headers.authorization) || "";
    const token = auth.replace(/^Bearer\s+/i, "");
    if (!token) return "anonymous";
    const parts = token.split(".");
    if (parts.length !== 3) return "factory";
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return String(payload.role || "factory").toLowerCase();
  } catch (e) {
    return "factory";
  }
}

// ── Note channel visibility (which note fields each role may read) ──
export const NOTE_VISIBILITY = {
  customer:        ["customer_visible_note",  "participant_note"],
  factory:         ["factory_visible_note",   "participant_note"],
  forwarder:       ["forwarder_visible_note", "participant_note"],
  trucking:        ["forwarder_visible_note", "participant_note"],
  customs_broker:  ["customs_visible_note",   "participant_note"],
  driver:          ["driver_visible_note"],
  internal:        ["*"],
  admin:           ["*"],
  platform_admin:  ["*"],
  boss:            ["*"],
  finance:         ["*"],
  system:          ["*"],
};

const ALL_NOTE_FIELDS = [
  "participant_note",
  "customer_visible_note",
  "factory_visible_note",
  "forwarder_visible_note",
  "customs_visible_note",
  "driver_visible_note",
  "internal_note",
  "audit_note",
];

// ── Forbidden fields that MUST NEVER appear in any sheet response/body ──
//   These do not live in collab sheet tables (schema-level isolation),
//   but this is the defense-in-depth check.
export const FORBIDDEN_FIELDS = [
  "trucking_cost",
  "trucking_company",
  "truck_plate",
  "driver_phone",
  "pickup_depot",
  "return_depot",
  "factory_cost",
  "supplier_bill",
  "trader_margin",
  "profit",
  "customer_final_price",
  "customer_price",
];

// ── applyLens: minimal strip (D's loading-sheets.js historical contract) ──
//   Removes internal_note when role is non-internal. Used by older code paths.
export function applyLens(row, role) {
  if (!row) return row;
  if (isInternalRole(role)) return row;
  const clone = Object.assign({}, row);
  delete clone.internal_note;
  return clone;
}

// ── adaptCollabSheet: strict adapter for all NEW endpoints ──
//   ctx = { role, companyCode?, sheetType? }
export function adaptCollabSheet(row, ctx) {
  if (!row) return row;
  const role = (ctx && ctx.role) || "anonymous";
  const out = Object.assign({}, row);

  // 1. Strip forbidden fields (defense in depth — should never be present)
  for (const f of FORBIDDEN_FIELDS) {
    if (f in out) delete out[f];
  }

  // 2. Strip note channels not allowed for this role
  const allowed = NOTE_VISIBILITY[role] || [];
  if (!allowed.includes("*")) {
    const allowedSet = new Set(allowed);
    for (const noteField of ALL_NOTE_FIELDS) {
      if (!allowedSet.has(noteField) && noteField in out) {
        delete out[noteField];
      }
    }
  }

  // 3. Strip internal_note explicitly for non-internal roles (belt + suspenders)
  if (!isInternalRole(role) && "internal_note" in out) {
    delete out.internal_note;
  }

  return out;
}

export function filterByRole(rows, ctx) {
  if (!Array.isArray(rows)) return rows;
  return rows.map(r => adaptCollabSheet(r, ctx));
}

// ── Defensive write-side guard: never let a write body include forbidden keys ──
export function assertNoForbiddenInBody(body) {
  if (!body || typeof body !== "object") return;
  for (const f of FORBIDDEN_FIELDS) {
    if (f in body) {
      const err = new Error("forbidden_field_in_body:" + f);
      err.statusCode = 400;
      throw err;
    }
  }
}

// ── Token utilities for Magic Link issuance ──
export function generateRawToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw)).digest("hex");
}

// ── Standardized error response ──
export function sendError(res, status, code, detail) {
  return res.status(status).json({ error: code, detail: detail || undefined });
}
