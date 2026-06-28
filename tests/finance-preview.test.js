// tests/finance-preview.test.js
// D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-IMPL-001
//
// Node-runnable tests (node:test + node:assert/strict).
// No vitest / jest dependency.
//
// Coverage:
//   Gate  T-01..T-18 — checkCapability / canonicalRole / vault strip (pure functions)
//   Summary  T-19..T-20 — read_summary field constraints
//   Audit T-21..T-26 — audit bridge + handler audit events
//   Vault T-27..T-29 — stripVaultForExternal / applyVaultLens (pure functions)
//   Endpoint T-30..T-32 — blocked operations + no forbidden DB writes

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDLER_PATH = join(__dirname, "../api/db/finance-preview.js");

// ─── Direct imports (pure functions — no mock needed) ──────────────────────
import {
  canonicalRole,
  checkCapability,
  isInternalRoleCanonical,
  stripVaultForExternal,
  applyVaultLens,
  ROLE_DEFAULT_CAPABILITIES,
} from "../api/lib/financePreviewGate.js";

import { writeFinancePreviewAudit } from "../api/lib/financePreviewAuditBridge.js";

// ─── Test helpers ──────────────────────────────────────────────────────────
function mkReq(role, extra) {
  return Object.assign(
    { headers: {}, query: {}, body: {}, method: "GET",
      user: role ? { role, email: "test@sanlyn.cn" } : null },
    extra || {}
  );
}
function mkRes() {
  var r = {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    end() { return this; },
  };
  return r;
}
// Mock pool that captures all pool.query calls
function capturePool(rows) {
  var captured = [];
  return {
    captured,
    async query(sql, params) {
      captured.push({ sql, params: params || [] });
      // Return empty for SELECT unless rows provided
      if (/SELECT/.test(sql) && rows) return { rows, rowCount: rows.length };
      return { rows: [], rowCount: 0 };
    },
  };
}

// Load handler with injected mocks
async function loadHandler(opts) {
  var key = "__fpMock_" + randomUUID().replaceAll("-", "_");
  globalThis[key] = {
    auth: {
      requireAuth: opts.requireAuth || function(req, res) {
        if (!req.user) { res.status(401).json({ error: "Unauthorized" }); return false; }
        return true;
      },
    },
    db:   { getPool: function() { return opts.pool || capturePool().pool; } },
    gate: opts.gate || {
      checkCapability,
      stripVaultForExternal,
      applyVaultLens,
      canonicalRole,
    },
    audit: opts.audit || {
      writeFinancePreviewAudit: async function() { return { ok: true }; },
    },
  };
  var source = await readFile(HANDLER_PATH, "utf8");
  var injected = source
    .replace('import { requireAuth } from "../auth.js";', `const { requireAuth } = globalThis.${key}.auth;`)
    .replace('import { getPool } from "../db.js";', `const { getPool } = globalThis.${key}.db;`)
    .replace('import { checkCapability, stripVaultForExternal, applyVaultLens, canonicalRole } from "../lib/financePreviewGate.js";', `const { checkCapability, stripVaultForExternal, applyVaultLens, canonicalRole } = globalThis.${key}.gate;`)
    .replace('import { writeFinancePreviewAudit } from "../lib/financePreviewAuditBridge.js";', `const { writeFinancePreviewAudit } = globalThis.${key}.audit;`);
  try {
    return (await import(`data:text/javascript;base64,${Buffer.from(injected).toString("base64")}#${key}`)).default;
  } finally {
    delete globalThis[key];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Gate / capability (pure function tests T-01..T-18)
// ═══════════════════════════════════════════════════════════════════════════

test("T-01: platform_finance read allowed", () => {
  var r = checkCapability(mkReq("platform_finance"), "finance:preview:read");
  assert.equal(r.allowed, true);
  assert.equal(r.canon, "platform_finance");
});

test("T-02: platform_admin read allowed", () => {
  var r = checkCapability(mkReq("platform_admin"), "finance:preview:read");
  assert.equal(r.allowed, true);
  assert.equal(r.canon, "platform_admin");
});

test("T-03: internal_operator read_summary allowed", () => {
  var r = checkCapability(mkReq("internal_operator"), "finance:preview:read_summary");
  assert.equal(r.allowed, true);
  assert.equal(r.canon, "internal_operator");
});

test("T-04: internal_operator full read denied", () => {
  var r = checkCapability(mkReq("internal_operator"), "finance:preview:read");
  assert.equal(r.allowed, false);
});

test("T-05: internal_operator compute denied", () => {
  var r = checkCapability(mkReq("internal_operator"), "finance:preview:compute");
  assert.equal(r.allowed, false);
});

test("T-06: internal_operator confirm denied", () => {
  var r = checkCapability(mkReq("internal_operator"), "finance:preview:confirm");
  assert.equal(r.allowed, false);
});

test("T-07: internal_operator signoff denied", () => {
  var r = checkCapability(mkReq("internal_operator"), "finance:preview:signoff");
  assert.equal(r.allowed, false);
});

test("T-08: platform_admin confirm denied", () => {
  var r = checkCapability(mkReq("platform_admin"), "finance:preview:confirm");
  assert.equal(r.allowed, false);
});

test("T-09: platform_admin signoff denied", () => {
  var r = checkCapability(mkReq("platform_admin"), "finance:preview:signoff");
  assert.equal(r.allowed, false);
});

test("T-10: platform_finance confirm allowed", () => {
  var r = checkCapability(mkReq("platform_finance"), "finance:preview:confirm");
  assert.equal(r.allowed, true);
});

test("T-11: platform_finance signoff allowed", () => {
  var r = checkCapability(mkReq("platform_finance"), "finance:preview:signoff");
  assert.equal(r.allowed, true);
});

test("T-12: buyer denied all finance:preview caps", () => {
  assert.equal(checkCapability(mkReq("buyer"), "finance:preview:read").allowed, false);
  assert.equal(checkCapability(mkReq("buyer"), "finance:preview:read_summary").allowed, false);
  assert.equal(checkCapability(mkReq("buyer"), "finance:preview:confirm").allowed, false);
});

test("T-13: factory denied all finance:preview caps", () => {
  assert.equal(checkCapability(mkReq("factory"), "finance:preview:read").allowed, false);
  assert.equal(checkCapability(mkReq("factory"), "finance:preview:read_summary").allowed, false);
});

test("T-14: supply_chain_ocean denied", () => {
  var r = checkCapability(mkReq("supply_chain_ocean"), "finance:preview:read");
  assert.equal(r.allowed, false);
});

test("T-15: unknown role denied (fail-closed)", () => {
  var r = checkCapability(mkReq("totally_unknown_role"), "finance:preview:read");
  assert.equal(r.allowed, false);
  assert.equal(r.canon, "external");
});

test("T-16: legacy role mapping — finance/admin/internal map correctly", () => {
  assert.equal(canonicalRole("finance"),   "platform_finance");
  assert.equal(canonicalRole("admin"),     "platform_admin");
  assert.equal(canonicalRole("internal"),  "internal_operator");
  // canonical pass-through
  assert.equal(canonicalRole("platform_finance"),  "platform_finance");
  assert.equal(canonicalRole("platform_admin"),    "platform_admin");
  assert.equal(canonicalRole("internal_operator"), "internal_operator");
  // explicitly not canonical → external
  assert.equal(canonicalRole("boss"),        "external");
  assert.equal(canonicalRole("super_admin"), "external");
  assert.equal(canonicalRole("system"),      "external");
  assert.equal(canonicalRole("internal_ops"),"external");
});

test("T-17: missing capabilities on req.user fall back to ROLE_DEFAULT_CAPABILITIES (fail-closed for empty)", () => {
  // req.user.capabilities not set → falls back to ROLE_DEFAULT_CAPABILITIES[canonicalRole]
  var req = mkReq("platform_finance");
  delete req.user.capabilities; // ensure absent
  var r = checkCapability(req, "finance:preview:read");
  assert.equal(r.allowed, true); // platform_finance default caps include read

  var reqExt = mkReq("buyer");
  delete reqExt.user.capabilities;
  var rExt = checkCapability(reqExt, "finance:preview:read");
  assert.equal(rExt.allowed, false); // buyer default caps = []
});

test("T-18: null/missing req.user → fail-closed", () => {
  assert.equal(checkCapability(null,  "finance:preview:read").allowed, false);
  assert.equal(checkCapability({},    "finance:preview:read").allowed, false);
  assert.equal(checkCapability({ user: null }, "finance:preview:read").allowed, false);
  assert.equal(checkCapability({ user: {} },   "finance:preview:read").allowed, false);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Summary field constraints (T-19..T-20)
// ═══════════════════════════════════════════════════════════════════════════

test("T-19: read_summary returns only the 4 allowed fields", async () => {
  var pool = capturePool([{
    vault: {
      finance_preview: {
        is_hard_blocked: true,
        blocked_count:   3,
        pending_count:   2,
        estimate_count:  5,
        // forbidden fields that must NOT appear in summary
        amount:        12345,
        exchange_rate: 7.1,
        payer:         "CUST-A",
        payee:         "FACTORY-B",
        ar_items:      [{ id: 1, amount: 999 }],
        ap_items:      [{ id: 2, amount: 888 }],
        margin:        1000,
      },
    },
  }]);
  var auditCalled = [];
  var handler = await loadHandler({
    pool,
    audit: {
      writeFinancePreviewAudit: async function(p, r, params) {
        auditCalled.push(params);
        return { ok: true };
      },
    },
  });
  var req = mkReq("internal_operator", {
    method: "GET",
    query: { operation: "read_summary", contract_no: "SO-TEST-001" },
  });
  var res = mkRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  var data = res.body.data;
  // Only 4 fields present
  assert.deepEqual(Object.keys(data).sort(), ["blocked_count", "estimate_count", "is_hard_blocked", "pending_count"]);
  assert.equal(data.is_hard_blocked, true);
  assert.equal(data.blocked_count, 3);
  assert.equal(data.pending_count, 2);
  assert.equal(data.estimate_count, 5);
});

test("T-20: read_summary excludes amount / exchange_rate / payer / payee / ar_items / ap_items / margin", async () => {
  var pool = capturePool([{
    vault: {
      finance_preview: {
        is_hard_blocked: false,
        blocked_count:   0,
        pending_count:   1,
        estimate_count:  1,
        amount:        99999,
        payer:         "LEAKER",
        payee:         "LEAKER2",
        ar_items:      ["sensitive"],
        ap_items:      ["sensitive"],
        margin:        5000,
        exchange_rate: 6.9,
      },
    },
  }]);
  var handler = await loadHandler({ pool });
  var req = mkReq("platform_finance", {
    method: "GET",
    query: { operation: "read_summary", contract_no: "SO-TEST-002" },
  });
  var res = mkRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  var data = res.body.data;
  assert.equal("amount"        in data, false, "amount must not appear");
  assert.equal("exchange_rate" in data, false, "exchange_rate must not appear");
  assert.equal("payer"         in data, false, "payer must not appear");
  assert.equal("payee"         in data, false, "payee must not appear");
  assert.equal("ar_items"      in data, false, "ar_items must not appear");
  assert.equal("ap_items"      in data, false, "ap_items must not appear");
  assert.equal("margin"        in data, false, "margin must not appear");
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Audit bridge (T-21..T-26)
// ═══════════════════════════════════════════════════════════════════════════

test("T-21: access denied writes audit event via handler", async () => {
  var auditEvents = [];
  var pool = capturePool([]);
  var handler = await loadHandler({
    pool,
    audit: {
      writeFinancePreviewAudit: async function(p, r, params) {
        auditEvents.push(params);
        return { ok: true };
      },
    },
  });
  var req = mkReq("buyer", { method: "GET", query: { operation: "read" } });
  var res = mkRes();
  await handler(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(auditEvents.length >= 1, true, "audit must be written on access denied");
  assert.equal(auditEvents[0].action, "finance_preview.access_denied");
});

test("T-22: read_summary writes audit event via handler", async () => {
  var auditEvents = [];
  var pool = capturePool([]);
  var handler = await loadHandler({
    pool,
    audit: {
      writeFinancePreviewAudit: async function(p, r, params) {
        auditEvents.push(params);
        return { ok: true };
      },
    },
  });
  var req = mkReq("internal_operator", {
    method: "GET",
    query: { operation: "read_summary", contract_no: "SO-AUDIT-001" },
  });
  var res = mkRes();
  await handler(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(auditEvents.some(function(e) { return e.action === "finance_preview.read_summary"; }), true);
});

test("T-23: audit bridge maps actor_id to operator via writeAudit", async () => {
  var pool = capturePool([]);
  var req = { user: { email: "test-actor@sanlyn.cn", role: "platform_finance" },
               headers: {}, ip: null };
  await writeFinancePreviewAudit(pool, req, {
    action:    "finance_preview.read",
    entity_id: "SO-AUDIT-TEST-001",
    after:     { operation: "read" },
    reason:    null,
  });
  var insertCall = pool.captured.find(function(c) { return /INSERT INTO audit_logs/.test(c.sql); });
  assert.ok(insertCall, "INSERT INTO audit_logs must be called");
  // params[1] = operator (actor_id)
  assert.equal(insertCall.params[1], "test-actor@sanlyn.cn");
});

test("T-24: audit bridge maps object_type to entity_type = 'finance_preview'", async () => {
  var pool = capturePool([]);
  var req = { user: { email: "u@sanlyn.cn", role: "platform_finance" },
               headers: {}, ip: null };
  await writeFinancePreviewAudit(pool, req, {
    action:    "finance_preview.read_summary",
    entity_id: "SO-999",
    after:     {},
    reason:    null,
  });
  var insertCall = pool.captured.find(function(c) { return /INSERT INTO audit_logs/.test(c.sql); });
  assert.ok(insertCall, "audit INSERT must occur");
  // params[4] = entity_type
  assert.equal(insertCall.params[4], "finance_preview");
  // params[5] = entity_id
  assert.equal(insertCall.params[5], "SO-999");
});

test("T-25: reason stored in JSONB after.reason subfield (no new column)", async () => {
  var pool = capturePool([]);
  var req = { user: { email: "u@sanlyn.cn", role: "platform_admin" },
               headers: {}, ip: null };
  await writeFinancePreviewAudit(pool, req, {
    action:    "finance_preview.access_denied",
    entity_id: "SO-REASON-TEST",
    after:     { operation: "read" },
    reason:    "access_denied_reason_text",
  });
  var insertCall = pool.captured.find(function(c) { return /INSERT INTO audit_logs/.test(c.sql); });
  assert.ok(insertCall, "audit INSERT must occur");
  // params[7] = after JSONB string
  var afterObj = JSON.parse(insertCall.params[7]);
  assert.equal(afterObj.reason, "access_denied_reason_text");
});

test("T-26: audit events do not contain real amount / payer / payee", async () => {
  var pool = capturePool([]);
  var req = { user: { email: "u@sanlyn.cn", role: "platform_finance" },
               headers: {}, ip: null };
  await writeFinancePreviewAudit(pool, req, {
    action:    "finance_preview.read",
    entity_id: "SO-CLEAN",
    before:    { status: "pending" },
    after:     { operation: "read", result: "found" },
    reason:    null,
  });
  var insertCall = pool.captured.find(function(c) { return /INSERT INTO audit_logs/.test(c.sql); });
  assert.ok(insertCall, "audit INSERT must occur");
  var rawStr = JSON.stringify(insertCall.params);
  assert.equal(/\bamount\b/.test(rawStr), false, "amount must not appear in audit params");
  assert.equal(/\bpayer\b/.test(rawStr), false, "payer must not appear in audit params");
  assert.equal(/\bpayee\b/.test(rawStr), false, "payee must not appear in audit params");
  assert.equal(/settlement_edge/.test(rawStr), false, "settlement_edge must not appear");
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Vault strip (pure function tests T-27..T-29)
// ═══════════════════════════════════════════════════════════════════════════

test("T-27: external role gets vault key ABSENT (not null, not {})", () => {
  var row = { id: "o1", contract_no: "SO-1", vault: { finance_preview: { x: 1 } } };
  var stripped = stripVaultForExternal(row, "buyer");
  assert.equal("vault" in stripped, false, "vault key must be absent");
  assert.notEqual(stripped.vault, null, "must not be null — key must not exist at all");
  assert.equal(stripped.id, "o1");
  assert.equal(stripped.contract_no, "SO-1");
  // Also verify with canonical legacy roles
  assert.equal("vault" in stripVaultForExternal(row, "customer"), false);
  assert.equal("vault" in stripVaultForExternal(row, "factory"),  false);
  assert.equal("vault" in stripVaultForExternal(row, "boss"),     false); // not canonical internal
  assert.equal("vault" in stripVaultForExternal(row, "super_admin"), false); // not canonical
});

test("T-28: internal canonical role retains vault", () => {
  var row = { id: "o1", vault: { finance_preview: { sensitive: "data" } } };
  var pf = stripVaultForExternal(row, "platform_finance");
  assert.equal("vault" in pf, true, "platform_finance must retain vault");
  var pa = stripVaultForExternal(row, "platform_admin");
  assert.equal("vault" in pa, true, "platform_admin must retain vault");
  var io = stripVaultForExternal(row, "internal_operator");
  assert.equal("vault" in io, true, "internal_operator must retain vault (D contract)");
  // Legacy canonical aliases
  var fin = stripVaultForExternal(row, "finance");   // maps → platform_finance
  assert.equal("vault" in fin, true, "finance (legacy) must retain vault");
  var adm = stripVaultForExternal(row, "admin");     // maps → platform_admin
  assert.equal("vault" in adm, true, "admin (legacy) must retain vault");
});

test("T-29: null / unknown role → vault key absent (fail-closed)", () => {
  var row = { id: "o1", vault: { finance_preview: { x: 1 } } };
  assert.equal("vault" in stripVaultForExternal(row, null),      false);
  assert.equal("vault" in stripVaultForExternal(row, undefined),  false);
  assert.equal("vault" in stripVaultForExternal(row, ""),         false);
  assert.equal("vault" in stripVaultForExternal(row, "xyz_role"), false);
  // applyVaultLens batch
  var rows = [row, row];
  var stripped = applyVaultLens(rows, null);
  assert.equal("vault" in stripped[0], false);
  assert.equal("vault" in stripped[1], false);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Endpoint behavior (T-30..T-32)
// ═══════════════════════════════════════════════════════════════════════════

test("T-30: compute returns 501 not_implemented while E is DOUBLE HOLD", async () => {
  var pool = capturePool([]);
  var handler = await loadHandler({ pool });
  // platform_finance has compute cap — should still get 501
  var req = mkReq("platform_finance", {
    method: "POST",
    body:   { operation: "compute", contract_no: "SO-COMPUTE-TEST" },
    query:  {},
  });
  var res = mkRes();
  await handler(req, res);
  assert.equal(res.statusCode, 501);
  assert.equal(res.body.blocked, true);
  assert.ok(res.body.error === "not_implemented" || res.body.error === "blocked");
  // No DB writes beyond audit_logs
  var forbiddenWrites = pool.captured.filter(function(c) {
    return /INSERT|UPDATE/.test(c.sql) && !/audit_logs/.test(c.sql);
  });
  assert.equal(forbiddenWrites.length, 0, "compute must not write to any table except audit_logs");
});

test("T-31: confirm does not create finance_records entries", async () => {
  var pool = capturePool([]);
  var handler = await loadHandler({ pool });
  var req = mkReq("platform_finance", {
    method: "POST",
    body:   { operation: "confirm", contract_no: "SO-CONFIRM-TEST" },
    query:  {},
  });
  var res = mkRes();
  await handler(req, res);
  // Should be blocked (200 blocked) or 403 — either way, no finance_records write
  var financeRecordsWrite = pool.captured.filter(function(c) {
    return /finance_records|settlement_edge|paid|settled/.test(c.sql) &&
           /INSERT|UPDATE/.test(c.sql);
  });
  assert.equal(financeRecordsWrite.length, 0,
    "confirm must not INSERT/UPDATE finance_records, settlement_edge, paid, or settled");
});

test("T-32: signoff does not create paid / settled / settlement_edge entries", async () => {
  var pool = capturePool([]);
  var handler = await loadHandler({ pool });
  var req = mkReq("platform_finance", {
    method: "POST",
    body:   { operation: "signoff", contract_no: "SO-SIGNOFF-TEST" },
    query:  {},
  });
  var res = mkRes();
  await handler(req, res);
  var forbiddenWrites = pool.captured.filter(function(c) {
    return /paid|settled|settlement_edge|invoice_issuer|finance_records/.test(c.sql) &&
           /INSERT|UPDATE/.test(c.sql);
  });
  assert.equal(forbiddenWrites.length, 0,
    "signoff must not write to paid, settled, settlement_edge, invoice_issuer, or finance_records");
});

// ─── Results summary ────────────────────────────────────────────────────────
// Collected via test runner — run with: node --test tests/finance-preview.test.js
