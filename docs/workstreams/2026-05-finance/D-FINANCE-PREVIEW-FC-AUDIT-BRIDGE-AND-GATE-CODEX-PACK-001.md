# D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-CODEX-PACK-001

**Date**: 2026-05-11
**Node**: D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-IMPL-001
**Status**: SELF_REVIEW_PASS_PENDING_CODEX
**Codex CLI**: CODEX_CLI_UNAVAILABLE
**Purpose**: Codex / GPT boundary review — reviewer must answer all 10 review questions in §9

---

## 0. Reviewer Instructions

This pack is for independent review by Codex CLI or GPT.
The node has completed self-review with 32/32 tests PASS and 0 P0/P1/P2.
Codex CLI binary is not present on Studio. This pack substitutes.

**Reviewer must check each item in §9 and return:**
- PASS / FAIL / UNKNOWN for each check
- Overall verdict: PASS_PENDING_MERGE_REVIEW or BLOCKED + reason

**Verdict upgrade condition:**
If §9 has no FAIL and no BLOCKED: node upgrades from
`SELF_REVIEW_PASS_PENDING_CODEX` → `PASS_PENDING_MERGE_REVIEW`

**Still forbidden after upgrade:**
- No deploy
- No merge main
- No computeFinancePreview implementation
- No settlement_edge / paid / settled / invoice_issuer confirmation
- No E-class field thaw

---

## 1. Changed Files

| File | Change | LOC delta |
|---|---|---|
| `api/lib/financePreviewGate.js` | NEW | +181 |
| `api/lib/financePreviewAuditBridge.js` | NEW | +60 |
| `api/db/finance-preview.js` | NEW | +291 |
| `tests/finance-preview.test.js` | NEW | +533 |
| `server.js` | MODIFIED (1 line: mount) | +1 |

Total: 4 new files, 1 modified. +1066 lines.

---

## 2. Git Diff Summary

**server.js change (line 149):**
```diff
+mount("/api/db/finance-preview",       () => import("./api/db/finance-preview.js"));   // D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-IMPL-001
 mount("/api/db/finance-records",       () => import("./api/db/finance-records.js"));
```

**New files summary:**
- `financePreviewGate.js` — all pure functions, no imports, no DB
- `financePreviewAuditBridge.js` — imports `writeAudit` from `audit-helper.js` only
- `finance-preview.js` — imports auth, db, gate, bridge; no other dependencies
- `finance-preview.test.js` — imports `node:test`, `node:assert/strict`, gate, bridge directly

**Files NOT modified:**
- `api/auth.js` — NOT touched
- `api/db/audit-helper.js` — NOT touched
- `api/db/finance-records.js` — NOT touched
- Any migration file — NOT touched
- `api/db/orders.js` — NOT touched
- `api/db/payments.js` — NOT touched

---

## 3. No DB / Schema / Migration / Deploy Statement

| Item | Confirmed |
|---|---|
| DB migration files changed | ❌ ZERO — no `migrate-*.js` modified |
| New table created | ❌ ZERO |
| New column added to audit_logs | ❌ ZERO — `reason` stored in `after` JSONB subfield |
| `finance_records` table written | ❌ ZERO — no INSERT/UPDATE to finance_records |
| `settlement_edge` table written | ❌ ZERO |
| `paid` / `settled` columns written | ❌ ZERO |
| `invoice_issuer_confirmed` written | ❌ ZERO |
| Deploy triggered | ❌ ZERO — branch local only |
| Push to main | ❌ ZERO |
| auth.js JWT signing changed | ❌ ZERO |

---

## 4. Endpoint Behavior Summary

**Route**: `GET|POST /api/db/finance-preview`
**Auth**: `requireAuth()` — 401 if no valid JWT

### F-1 read (GET `?operation=read` or POST `{operation:"read"}`)
- Requires: `finance:preview:read`
- Allowed: `platform_finance`, `platform_admin` (and legacy aliases `finance`, `admin`)
- Denied: `internal_operator`, `buyer`, `factory`, all external → 403 + audit written
- Returns: `vault.finance_preview` from `orders.vault` (read-only SELECT)
- If no data: `{ exists: false, finance_preview: null }` (safe empty)
- Vault strip: `stripVaultForExternal(row, role)` applied before any return

### F-5 read_summary (GET `?operation=read_summary`)
- Requires: `finance:preview:read_summary`
- Allowed: `internal_operator`, `platform_finance`, `platform_admin`
- Denied: all external → 403 + audit written
- Returns: **exactly 4 fields** — picked server-side into new object:
  `{ is_hard_blocked, blocked_count, pending_count, estimate_count }`
- NEVER: spread full preview then delete fields
- If no data: safe empty zeros

### F-2 compute (POST `{operation:"compute"}`)
- Requires: `finance:preview:compute`
- Denied: all except `platform_finance`, `platform_admin` → 403 + audit
- **Even if authorized → always returns HTTP 501 / blocked** (E DOUBLE HOLD)
- Writes audit: `finance_preview_compute_attempt_blocked`
- Does NOT call computeFinancePreview. Does NOT write vault.finance_preview.

### F-3 confirm (POST `{operation:"confirm"}`)
- Requires: `finance:preview:confirm`
- Denied: all except `platform_finance` → 403 + audit
- **Even if authorized → 200 blocked** (no preview data, E not enabled)
- Does NOT create finance_records. Does NOT write settlement_edge. Does NOT confirm paid/settled.

### F-4 signoff (POST `{operation:"signoff"}`)
- Requires: `finance:preview:signoff`
- Denied: all except `platform_finance` → 403 + audit
- **Even if authorized → 200 blocked** (E not enabled)
- Does NOT write paid / settled / settlement_edge / invoice_issuer_confirmed.

---

## 5. audit_logs Option B Mapping

**No migration. No new columns. No new tables.**

The existing `audit_logs` table (after v2 migration in `migrate-audit-logs.js`) has:
`entity_type`, `entity_id`, `before`, `after`, `request_id` as real columns.

| finance_preview field | audit_logs column | Mechanism |
|---|---|---|
| actor_id | `operator` | `writeAudit` ← `req.user.email \|\| req.user.username` |
| actor_role | `role` | `writeAudit` ← `req.user.role` |
| object_type | `entity_type` | fixed value: `"finance_preview"` |
| object_id | `entity_id` | `contract_no` or `order_id` from request |
| action | `action` | passed directly |
| before state | `before` | JSONB (no real amounts) |
| after state | `after` | JSONB (no real amounts) |
| request_id | `request_id` | `req.headers["x-request-id"]` |
| **reason** | **`after.reason`** | **JSONB subfield — no new column** |

**FORBIDDEN in all audit payloads:**
- `amount`, `unit_price`, `total`, `exchange_rate`
- `payer`, `payee` (names or codes)
- `settlement_edge`, `paid`, `settled`
- `invoice_issuer`, AR/AP item arrays

---

## 6. canonicalRole Shim Summary

**File**: `api/lib/financePreviewGate.js` — `canonicalRole(role)` function

| JWT role | Canonical | Finance preview tier |
|---|---|---|
| `platform_finance` | `platform_finance` | read / compute / confirm / signoff / read_summary |
| `platform_admin` | `platform_admin` | read / compute / read_summary |
| `internal_operator` | `internal_operator` | read_summary only |
| `finance` (legacy) | `platform_finance` | same as platform_finance |
| `admin` (legacy) | `platform_admin` | same as platform_admin |
| `internal` (legacy) | `internal_operator` | same as internal_operator |
| `customer` / `buyer` | `buyer` | **none** |
| `factory` | `factory` | **none** |
| `supplier` | `supplier` | **none** |
| `broker_customer` | `broker_customer` | **none** |
| `broker_factory` | `broker_factory` | **none** |
| `supply_chain_ocean` | `supply_chain_ocean` | **none** |
| `boss` | **`external`** | **none — fail-closed** |
| `super_admin` | **`external`** | **none — fail-closed** |
| `system` | **`external`** | **none — fail-closed** |
| `internal_ops` | **`external`** | **none — fail-closed** |
| anything unknown | **`external`** | **none — fail-closed** |
| `null` / `""` | **`external`** | **none — fail-closed** |

**Scope guarantee**: `canonicalRole` is used exclusively in `financePreviewGate.js`.
It does NOT modify permissions in any other module.

---

## 7. Vault Strip Behavior

**File**: `api/lib/financePreviewGate.js` — `stripVaultForExternal(row, rawRole)`

**Contract** (identical to D TypeScript `vaultStrip.ts` IMPL-001 PASS):

| Condition | Result |
|---|---|
| `rawRole` maps to internal canonical role (`platform_finance`, `platform_admin`, `internal_operator`) | Row returned **unchanged** — vault retained |
| `rawRole` maps to any external role (buyer, factory, etc.) | New object with `vault` key **ABSENT** — not `null`, not `{}` |
| `rawRole` is `boss`, `super_admin`, `system` | External — vault **ABSENT** |
| `rawRole` is `null` / `undefined` / `""` | External (fail-closed) — vault **ABSENT** |
| Row has no `vault` key | Row returned unchanged (no-op) |
| Row is `null` / primitive / Array | Returned unchanged |

**Test coverage**: T-27, T-28, T-29 (all PASS)

---

## 8. Test Results

### finance-preview.test.js (32 cases)

```
T-01  platform_finance read allowed                                  ✅ PASS
T-02  platform_admin read allowed                                    ✅ PASS
T-03  internal_operator read_summary allowed                         ✅ PASS
T-04  internal_operator full read denied                             ✅ PASS
T-05  internal_operator compute denied                               ✅ PASS
T-06  internal_operator confirm denied                               ✅ PASS
T-07  internal_operator signoff denied                               ✅ PASS
T-08  platform_admin confirm denied                                  ✅ PASS
T-09  platform_admin signoff denied                                  ✅ PASS
T-10  platform_finance confirm allowed                               ✅ PASS
T-11  platform_finance signoff allowed                               ✅ PASS
T-12  buyer denied all finance:preview caps                          ✅ PASS
T-13  factory denied all finance:preview caps                        ✅ PASS
T-14  supply_chain_ocean denied                                      ✅ PASS
T-15  unknown role denied (fail-closed)                              ✅ PASS
T-16  legacy role mapping — finance/admin/internal map correctly     ✅ PASS
T-17  missing capabilities → ROLE_DEFAULT_CAPABILITIES fallback      ✅ PASS
T-18  null/missing req.user → fail-closed                            ✅ PASS
T-19  read_summary returns only the 4 allowed fields                 ✅ PASS
T-20  read_summary excludes amount/exchange_rate/payer/payee/...     ✅ PASS
T-21  access denied writes audit event via handler                   ✅ PASS
T-22  read_summary writes audit event via handler                    ✅ PASS
T-23  audit maps actor_id to operator correctly                      ✅ PASS
T-24  audit maps object_type to entity_type = "finance_preview"      ✅ PASS
T-25  reason stored in JSONB after.reason subfield                   ✅ PASS
T-26  audit does not contain real amount / payer / payee             ✅ PASS
T-27  external role gets vault key ABSENT (not null, not {})         ✅ PASS
T-28  internal canonical role retains vault                          ✅ PASS
T-29  null/unknown role → vault absent (fail-closed)                 ✅ PASS
T-30  compute returns 501 not_implemented while E HOLD               ✅ PASS
T-31  confirm does not create finance_records entries                ✅ PASS
T-32  signoff does not create paid/settled/settlement_edge entries   ✅ PASS
──────────────────────────────────────────────────────────────────────
     32/32 PASS   0 FAIL
```

### tests/security-regression.test.js (3 existing cases — regression check)

```
✅ null order factory_code → POST returns 403 order_factory_scope_missing
✅ unknown viewer role → GET returns 403 role_not_permitted_for_this_resource
✅ forged body customer_code is ignored; factory JWT uses factory path
────────────────────────────────────────────────────────────────────
     3/3 PASS   0 FAIL   (unchanged — no regression)
```

---

## 9. Review Questions — Reviewer Must Answer Each

Reviewer: for each item, respond PASS / FAIL / UNKNOWN + brief note if FAIL.

### Q1: No migration?

**Evidence**: grep across all modified files for `ALTER TABLE`, `CREATE TABLE`, `migrate`:
- `financePreviewGate.js`: ZERO DB calls
- `financePreviewAuditBridge.js`: ZERO DB calls (only calls `writeAudit(pool, ...)`)
- `finance-preview.js`: only `pool.query("SELECT vault FROM orders ...")` — read-only for preview data; `pool.query` passed to `writeFinancePreviewAudit` for audit writes
- `server.js`: ZERO DB calls

No `ALTER TABLE audit_logs` anywhere in the diff. `reason` stored in `after.reason` JSON key, not a new column. **Expected: PASS**

### Q2: No finance_records write?

**Evidence**: full text search in diff for `finance_records`:
- Only appears in the comment `// SCOPE: ❌ No finance_records / settlement_edge / paid / settled`
- No `INSERT INTO finance_records`, no `UPDATE finance_records`, no import of `finance-records.js`
- T-31 test explicitly asserts: `financeRecordsWrite.length === 0`

**Expected: PASS**

### Q3: No computeFinancePreview implementation?

**Evidence**: search entire diff for `computeFinancePreview`:
- Appears only in: comments, audit action strings, 501 message, hint text
- No function named `computeFinancePreview` defined anywhere
- No `vault.finance_preview` WRITE path — only READ from `orders.vault` (SELECT only)
- F-2 compute path → `return res.status(501).json({ error: "not_implemented", blocked: true, ... })`

**Expected: PASS**

### Q4: F-2 compute still 501 BLOCKED?

**Evidence**: `finance-preview.js` lines for `operation === "compute"`:
```javascript
// Always 501 while E is DOUBLE HOLD — even for authorized roles
await writeFinancePreviewAudit(pool, req, { action: "finance_preview_compute_attempt_blocked", ... });
return res.status(501).json({ error: "not_implemented", blocked: true, ... });
```
T-30 asserts `res.statusCode === 501` and `res.body.blocked === true` for `platform_finance` user.

**Expected: PASS**

### Q5: F-3 confirm has no hard block release / no formal finance write?

**Evidence**: `operation === "confirm"` code path:
- Checks `finance:preview:confirm` capability → 403 if denied
- If authorized → `return res.status(200).json({ success: false, blocked: true, message: "confirm blocked..." })`
- No `pool.query` with INSERT/UPDATE between capability check and return
- The only `pool` usage in confirm path is `writeFinancePreviewAudit(pool, ...)` → writes to `audit_logs` only
- T-31 asserts zero queries matching `/finance_records|settlement_edge|paid|settled/` with INSERT/UPDATE

**Expected: PASS**

### Q6: F-4 signoff ≠ paid / settled / settlement_edge / invoice?

**Evidence**: `operation === "signoff"` code path:
- Same pattern as confirm — only audit write, then `return res.status(200).json({ success: false, blocked: true, ... })`
- No `pool.query` INSERT/UPDATE to any table except audit_logs
- T-32 asserts zero queries matching `/paid|settled|settlement_edge|invoice_issuer|finance_records/` with INSERT/UPDATE
- `vault.finance_preview`, `finance_records`, `settlement_edge` are never written anywhere in the diff

**Expected: PASS**

### Q7: 403 writes audit?

**Evidence**: every 403 branch in `finance-preview.js` has the pattern:
```javascript
await writeFinancePreviewAudit(pool, req, {
  action:    "finance_preview.access_denied",
  entity_id: entityId,
  after:     { operation: "...", denied_for: "insufficient_capability" },
  reason:    "access_denied",
});
return res.status(403).json({ error: "access_denied", ... });
```
T-21 asserts `auditEvents[0].action === "finance_preview.access_denied"` when buyer calls read (→ 403).

**Expected: PASS**

### Q8: Audit does not output real amounts?

**Evidence**:
- `writeFinancePreviewAudit` only accepts `action`, `entity_id`, `before`, `after`, `reason`, `note`
- None of the callers in `finance-preview.js` pass `amount`, `payer`, `payee`, `settlement_edge`, `ar_items`, `ap_items` to audit
- The `before` / `after` payloads contain only: `{ operation, result, canon, blocked_reason, denied_for }`
- T-26 asserts: `/\bamount\b/.test(rawStr) === false` and `/\bpayer\b/.test(rawStr) === false`

**Expected: PASS**

### Q9: External role cannot get vault?

**Evidence**: `stripVaultForExternal(row, rawRole)` in `financePreviewGate.js`:
```javascript
if (isInternalRoleCanonical(canon)) return row;           // internal: unchanged
// external: clone with vault key deleted
var rest = {};
var keys = Object.keys(row);
for (var i = 0; i < keys.length; i++) {
  if (keys[i] !== VAULT_TOP_KEY) rest[keys[i]] = row[keys[i]];
}
return rest;  // vault key absent — not null, not {}
```
`isInternalRoleCanonical` only returns true for `platform_finance`, `platform_admin`, `internal_operator`.
T-27 asserts `"vault" in stripped === false` for buyer, customer, factory, boss, super_admin.

**Expected: PASS**

### Q10: canonicalRole does NOT expand boss / super_admin / system?

**Evidence**: `CANONICAL_ROLE_MAP` in `financePreviewGate.js`:
```javascript
// boss, super_admin, system are NOT in the map → fall through to "external"
export function canonicalRole(role) {
  ...
  var key = role.toLowerCase().trim();
  if (Object.prototype.hasOwnProperty.call(CANONICAL_ROLE_MAP, key)) {
    return CANONICAL_ROLE_MAP[key];
  }
  return "external";  // fail-closed
}
```
`CANONICAL_ROLE_MAP` keys: finance, admin, internal, platform_finance, platform_admin, internal_operator, customer, buyer, factory, supplier, broker_customer, broker_factory, supply_chain_ocean.
`boss`, `super_admin`, `system`, `internal_ops` are NOT in the map → all return `"external"`.
T-16 asserts: `canonicalRole("boss") === "external"`, `canonicalRole("super_admin") === "external"`, `canonicalRole("system") === "external"`, `canonicalRole("internal_ops") === "external"`.

**Expected: PASS**

---

## 10. Forbidden Actions Checklist

| Forbidden | Implemented? |
|---|---|
| DB migration | ❌ NOT implemented |
| New audit_logs column | ❌ NOT implemented |
| New finance_preview_audit_log table | ❌ NOT implemented |
| Read secret/token/JWT_SECRET | ❌ NOT done |
| Modify auth.js JWT signing | ❌ NOT modified |
| Implement computeFinancePreview | ❌ NOT implemented |
| Write vault.finance_preview | ❌ NOT done |
| Write finance_records | ❌ NOT done |
| Write settlement_edge | ❌ NOT done |
| Confirm paid / settled | ❌ NOT done |
| Confirm invoice_issuer | ❌ NOT done |
| Deploy | ❌ NOT done |
| Push main | ❌ NOT done |
| Merge main | ❌ NOT done |
| Boss / super_admin / system get internal-tier caps | ❌ NOT granted |

---

## 11. Known Limitations

| # | Limitation | Notes |
|---|---|---|
| L-1 | F-1 read always returns safe_empty | Because E is DOUBLE HOLD — no vault.finance_preview data exists yet. This is correct behavior. |
| L-2 | F-3/F-4 always return 200 blocked | Same reason — E has not run, no preview to confirm/signoff. Will unblock automatically when E ships. |
| L-2 | No test for multi-order batch read | F-C spec does not require batch; single-contract read is the scope. |
| L-3 | Codex CLI unavailable | This pack substitutes. GPT review accepted per directive. |
| L-4 | `finance-preview` branch not yet pushed to origin on api repo | feat/bl-three-way is local. No push performed. |

---

## 12. Verdict Pending Reviewer Input

Current state: `SELF_REVIEW_PASS_PENDING_CODEX`

If §9 returns PASS for all 10 questions (no FAIL, no BLOCKED):

→ Upgrade to: `D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-IMPL-001 = PASS_PENDING_MERGE_REVIEW`

Still blocked after upgrade:
- deploy
- merge main
- computeFinancePreview
- settlement_edge / paid / settled / invoice confirmation
- E-class field thaw

---

*D-Line · 2026-05-11 · Codex pack generated for external review*
