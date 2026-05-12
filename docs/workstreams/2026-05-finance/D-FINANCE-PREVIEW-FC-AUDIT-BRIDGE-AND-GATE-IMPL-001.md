# D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-IMPL-001

**Date**: 2026-05-11
**Repo**: sanlyn-api-dev
**Branch**: feat/bl-three-way
**Commit**: f6b113c
**Verdict**: ✅ SELF_REVIEW_PASS_PENDING_CODEX
**Tests**: 32/32 PASS
**Codex CLI**: CODEX_CLI_UNAVAILABLE (binary not present; review pack at `/Users/mac/Desktop/codex-review-permission-v1-stage2/`)

---

## 1. audit_logs Schema Decision

**Option B adopted: field mapping onto existing audit_logs — no migration.**

### Real audit_logs columns confirmed (via migrate-audit-logs.js + audit-helper.js):

| Column | Type | Present |
|---|---|---|
| `operator` | VARCHAR(100) | ✅ |
| `role` | VARCHAR(50) | ✅ |
| `entity_type` | VARCHAR(32) | ✅ (v2 migration) |
| `entity_id` | VARCHAR(64) | ✅ (v2 migration) |
| `before` | JSONB | ✅ (v2 migration) |
| `after` | JSONB | ✅ (v2 migration) |
| `request_id` | VARCHAR(64) | ✅ (v2 migration) |
| `reason` | (none) | ✅ stored as `after.reason` JSONB subfield |

**Option B mapping:**

| finance_preview field | audit_logs column | Method |
|---|---|---|
| actor_id | operator | writeAudit ← req.user.email |
| actor_role | role | writeAudit ← req.user.role |
| object_type | entity_type | fixed: `"finance_preview"` |
| object_id | entity_id | contract_no / order_id |
| action | action | direct |
| before | before | JSONB |
| after | after | JSONB |
| request_id | request_id | req.headers["x-request-id"] |
| reason | after.reason | JSONB subfield — **no new column** |

**No migration required. No new tables. No new columns.**

---

## 2. Files Changed

| File | Change | LOC |
|---|---|---|
| `api/lib/financePreviewGate.js` | **NEW** — canonicalRole shim, ROLE_DEFAULT_CAPABILITIES, checkCapability, vault strip port | +181 |
| `api/lib/financePreviewAuditBridge.js` | **NEW** — writeFinancePreviewAudit (Option B wrapper) | +60 |
| `api/db/finance-preview.js` | **NEW** — F-1/F-2/F-3/F-4/F-5 endpoint shell | +291 |
| `tests/finance-preview.test.js` | **NEW** — 32 test cases (T-01..T-32) | +533 |
| `server.js` | **MODIFIED** — mount `/api/db/finance-preview` at line 149 | +1 |

Net: 4 new files, 1 modified. Total: +1066 lines.

---

## 3. Endpoint Behavior

### GET /api/db/finance-preview

| `?operation=` | Capability required | Behavior |
|---|---|---|
| `read` (default) | `finance:preview:read` | Returns vault.finance_preview or safe_empty. Vault stripped for external. |
| `read_summary` | `finance:preview:read_summary` | Returns only 4 fields (server-side pick, never spread-then-delete). |

### POST /api/db/finance-preview `{ operation }`

| `operation` | Capability required | Behavior |
|---|---|---|
| `compute` | `finance:preview:compute` | **501 BLOCKED** — E DOUBLE HOLD. Writes audit `finance_preview_compute_attempt_blocked`. |
| `confirm` | `finance:preview:confirm` | **200 blocked** — no finance_preview data. Writes audit. Does NOT create finance_records / settlement_edge / paid / settled. |
| `signoff` | `finance:preview:signoff` | **200 blocked** — E not enabled. Writes audit. Does NOT write paid / settled / invoice_issuer. |

All 403 access denials write audit event `finance_preview.access_denied`.

### canonicalRole shim

| JWT role | Canonical | Capability tier |
|---|---|---|
| `finance` | `platform_finance` | read / compute / confirm / signoff / read_summary |
| `admin` | `platform_admin` | read / compute / read_summary |
| `internal` | `internal_operator` | read_summary only |
| `platform_finance` | `platform_finance` | (pass-through) |
| `platform_admin` | `platform_admin` | (pass-through) |
| `internal_operator` | `internal_operator` | (pass-through) |
| `boss`, `super_admin`, `system` | `external` | none (fail-closed) |
| anything else | `external` | none |

---

## 4. Tests (32/32 PASS)

```
T-01  platform_finance read allowed                                  ✅
T-02  platform_admin read allowed                                    ✅
T-03  internal_operator read_summary allowed                         ✅
T-04  internal_operator full read denied                             ✅
T-05  internal_operator compute denied                               ✅
T-06  internal_operator confirm denied                               ✅
T-07  internal_operator signoff denied                               ✅
T-08  platform_admin confirm denied                                  ✅
T-09  platform_admin signoff denied                                  ✅
T-10  platform_finance confirm allowed                               ✅
T-11  platform_finance signoff allowed                               ✅
T-12  buyer denied all finance:preview caps                          ✅
T-13  factory denied all finance:preview caps                        ✅
T-14  supply_chain_ocean denied                                      ✅
T-15  unknown role denied (fail-closed)                              ✅
T-16  legacy role mapping — finance/admin/internal map correctly     ✅
T-17  missing capabilities → ROLE_DEFAULT_CAPABILITIES fallback      ✅
T-18  null/missing req.user → fail-closed                            ✅
T-19  read_summary returns only the 4 allowed fields                 ✅
T-20  read_summary excludes amount/exchange_rate/payer/payee/...     ✅
T-21  access denied writes audit event via handler                   ✅
T-22  read_summary writes audit event via handler                    ✅
T-23  audit maps actor_id to operator correctly                      ✅
T-24  audit maps object_type to entity_type = "finance_preview"      ✅
T-25  reason stored in JSONB after.reason subfield                   ✅
T-26  audit does not contain real amount/payer/payee                 ✅
T-27  external role gets vault key ABSENT (not null, not {})         ✅
T-28  internal canonical role retains vault                          ✅
T-29  null/unknown role → vault absent (fail-closed)                 ✅
T-30  compute returns 501 not_implemented while E HOLD               ✅
T-31  confirm does not create finance_records entries                ✅
T-32  signoff does not create paid/settled/settlement_edge entries   ✅
─────────────────────────────────────────────────────────────────────
TOTAL  32/32 PASS
```

Security regression (existing): 3/3 PASS (unchanged).

---

## 5. No DB / Schema / API / Deploy Statement

| Item | Status |
|---|---|
| DB migration | ❌ NONE |
| Schema change | ❌ NONE |
| New table | ❌ NONE |
| New column in audit_logs | ❌ NONE (reason → after.reason JSONB subfield) |
| API endpoint added | ✅ ONE — `/api/db/finance-preview` (capability-gated read-only shell) |
| Deploy | ❌ NOT DEPLOYED — branch local, no push to production |
| auth.js JWT modification | ❌ NONE |
| finance_records write | ❌ NONE |
| settlement_edge write | ❌ NONE |
| paid / settled write | ❌ NONE |
| invoice_issuer_confirmed write | ❌ NONE |

---

## 6. E computeFinancePreview Status

**STILL DOUBLE HOLD.**

- `computeFinancePreview` not implemented, not referenced, not touched
- No `vault.finance_preview` write path created
- F-2 compute endpoint always returns 501 while E is DOUBLE HOLD
- Gate keyword required: `APPROVE_COMPUTE_FINANCE_PREVIEW_V2_IMPL_001`

---

## 7. Codex CLI Status

`CODEX_CLI_UNAVAILABLE` — Codex binary not present on Studio.

Self-review checklist:
- [x] No DB / schema / migration
- [x] No finance_records / settlement_edge
- [x] No paid / settled / invoice issuer
- [x] No E compute implementation
- [x] 403 gate on all unauthorized roles
- [x] audit mapping correct (entity_type = "finance_preview")
- [x] No real amount in audit payloads
- [x] External roles get vault key ABSENT

Verdict: **SELF_REVIEW_PASS_PENDING_CODEX**

Codex review pack at: `/Users/mac/Desktop/codex-review-permission-v1-stage2/` (for human + Codex GUI review if desired).

---

## 8. P0 / P1 / P2

| Severity | Count | Notes |
|---|---|---|
| P0 | 0 | None introduced |
| P1 | 0 | None introduced |
| P2 | 0 | None introduced |

Carried (out of scope, unchanged):
- P1-NEW-3 (UI migration) — tracking exists, unaffected
- FIELDVISIBILITY-MULTI-LINK-001 — tracking exists, unaffected
- E computeFinancePreview — DOUBLE HOLD, unaffected

---

## 9. Is F-C Complete?

**F-C minimum backend entry point = COMPLETE for the D-layer gate contract.**

| F-C precondition | Status |
|---|---|
| Capability gate wired | ✅ `checkCapability()` in financePreviewGate.js |
| canonicalRole shim | ✅ maps legacy JWT roles to canonical 3-role |
| audit bridge (Option B) | ✅ `writeFinancePreviewAudit()` — no migration |
| Vault strip at endpoint | ✅ `stripVaultForExternal()` applied before any row return |
| read endpoint shell | ✅ F-1 — returns safe_empty (no compute yet) |
| read_summary endpoint | ✅ F-5 — 4-field server-side pick |
| compute gated + blocked | ✅ F-2 — 501 while E DOUBLE HOLD |
| confirm + signoff gated + blocked | ✅ F-3/F-4 — soft-blocked |
| server.js mount | ✅ line 149 |

**What F-C does NOT yet do** (gated on E IMPL):
- Return real vault.finance_preview compute data (no compute has run)
- Write vault.finance_preview (E-layer job)
- Unblock confirm/signoff (requires real preview to exist)

---

## 10. Next Steps (D does NOT initiate)

1. If Damon wants Codex GUI review: route diff to Codex.app — pack at `/Users/mac/Desktop/codex-review-permission-v1-stage2/`
2. When `APPROVE_COMPUTE_FINANCE_PREVIEW_V2_IMPL_001` is issued → E line starts, writes vault.finance_preview, F-C endpoints unblock automatically
3. If F-line wants to compose vault strip in existing endpoint adapters: `import { stripVaultForExternal } from '../lib/financePreviewGate.js'`
4. PR for this node: can stack on top of feat/bl-three-way or a clean branch; no DB dependency

D is idle after this node. Waiting for E authorization or PR review comment.

---

*D-Line · 2026-05-11 · D-FINANCE-PREVIEW-FC-AUDIT-BRIDGE-AND-GATE-IMPL-001 = SELF_REVIEW_PASS_PENDING_CODEX*
