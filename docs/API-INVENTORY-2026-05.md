# SANLYN-API · API Inventory (2026-05)

**Date**: 2026-05-05
**Repo**: `DamonMusLim/sanlyn-api` @ `11e4e57`
**Method**: read-only grep on `server.js mount()` calls + `api/` directory tree.
**Outcome**: **155 mounted endpoints** (real count vs. `api_contract.md` memory's 134 — memory is **stale by ~21**).

---

## 1. Top-line numbers

```
total .js files in api/ recursively ............ 178
mount() calls in server.js ..................... 155
endpoints under /api/db/* ....................... 108  (70%)
endpoints under /api/jdy*  ......................  13  (8.4%)
endpoints under /api/factory* ..................  14  (9%)
endpoints under /api/portal/* ..................   4  (2.6%)
endpoints under /api/vessel* ...................   5  (3.2%)
other (one-off) ................................   ~11
```

---

## 2. Mount mechanism

`server.js` uses a Vercel-style file-based dispatch:

```js
function mount(route, handlerModule) {
  app.all(route, async (req, res) => {
    const mod = await handlerModule();
    const handler = mod.default || mod;
    await handler(req, res);
  });
}
```

- 全部 endpoints 是 `app.all(...)` — 单 route 接受 GET/POST/PUT/DELETE/PATCH。Method 由 handler 内部判断。
- 全局 `authMiddleware` 守 (line 82); `/api/portal/*` 额外 `portalGate` (line 84).
- Rate-limit middleware on 5 routes:
  `/api/db/auth-login` (10/15min), `/api/factory-fill` + `/api/pending-confirm` (30/5min),
  `/api/factory-portal/notifications` + `/upload-history` (factoryPortalLimiter).

---

## 3. By Business Module

### 3.1 `/api/db/*` (108) — main operational surface

| 子领域关键词 | endpoint 数 | 代表 path |
|---|---|---|
| `factory*` | 14 | `factory-submit` `factory-prefill` `factory-token-create` `factory-recent` `factory-reviews` `factory-fill-tasks` ... |
| `customs*` | 3 | `customs` `customs-summary` `customs-draft` |
| `doc*` | 8 | `documents` `doc-uploads` `doc-reminders` `doc-share` `doc-auth` `doc-ai-reviews` `customs-doc-pdf` ... |
| `vessel*` (合并) | 5 in /api/+/api/db | `vessel-track` `vessel-sync` `vessel-subscribe` `vessel-map` `vessel-callback` |
| `finance*` | 3 | `finance-records` `finance-receivables` `setup-finance` |
| `customer*` | 2 | `customers` `customer-orders` `customer-stamps` |
| `order*` | 3 | `orders` `orders-status` `order-create-v2` |
| `credit*` | 2 | `credit-approvals` `credit-notes` `recompute-credit-used` |
| `audit*` | 1 | `audit-log` (+ `audit-helper.js` infra) |
| `auth*` | 1 | `auth-login` (rate-limited) |
| `accounts*` | 2 | `accounts` `accounts-team` |
| `analytics` | 1 | `analytics` |
| `bl-control` | 1 | bill-of-lading control |
| `container-bookings*` | 2 | `container-bookings` + `container-bookings-parse` |
| `commission-report` | 1 | |
| `company*` | 4 | `company` `company-capabilities` `company-certs` `company-departments` |
| `contracts` | 1 | |
| `qc-checks` | 1 | |
| `products*` | 4 | `products` `products-v3` `products-stats` `product-image-update` |
| `payments*` | 2 | `payments` `payment-terms` |
| `stamp*` | 3 | `stamp-permissions` (+ /api/stamp/smart-position + /api/stamp/apply) |
| `seed-*` | 4 | `seed-zc-group` `seed-payment-defaults` `seed-payment-term-tasks` `seed-oss-local-charges` `seed-huihe-charges` |
| `migrate-*` | 2 | `migrate-v2-network` `migrate-tasks-factory-code` |
| 其他 (vendor-quotes / vault-read / upsert / tenants / shipping / modules / relationships / freight-rates / invoice-* / forward-doc / pending-token-create / check-username / export-refund-lookup / raw-patch / sync-products-oss / thread-events) | ~30 | scattered |

### 3.2 `/api/jdy*` (13) — JDY (简道云) 双向同步 — **legacy per project memory**

```
/api/jdy-company-sync        /api/jdy-customer-sync
/api/jdy-driver-update       /api/jdy-freight-sync
/api/jdy-plans-sync          /api/jdy-sync
/api/jdy-write               /api/jdy-company
+ /api/jdy/customer-addresses
+ /api/jdy/customer-full-sync
+ /api/jdy/docs-sync
+ /api/jdy/order-create
+ /api/jdy/pi-sync
```

**Note**: `project_jdy_abandoned.md` memory says JDY no longer in use. These endpoints likely **dead code candidates** — verify with access logs before pruning. **DO NOT delete in this PR.**

### 3.3 `/api/factory-portal/*` (4) — factory-side portal

```
/api/factory-portal/notifications     (rate-limited)
/api/factory-portal/upload-history    (rate-limited)
/api/factory-portal/...               (2 more under factory-portal-tasks.js)
```

### 3.4 `/api/portal/*` (4) — customer-side portal (under `portalGate`)

```
/api/portal/login
/api/portal/shipping
/api/portal/documents
/api/portal/missing
```

### 3.5 `/api/m3/*` (2) — module-3 specific

```
/api/m3/run-merge      /api/m3/scan-missing      + /api/db/m3-missing
```

### 3.6 `/api/tasks/*` (2) + workflow-related

```
/api/tasks                  /api/tasks/create
+ workflow-engine.js / workflow-rules.js / workflow-runner.js (handlers)
```

### 3.7 `/api/vessel*` (5) — sea freight tracking

```
/api/vessel-callback (webhook)  /api/vessel-map
/api/vessel-subscribe           /api/vessel-sync
/api/vessel-track
+ /api/db/vessel-related (under db prefix)
```

### 3.8 一次性 single-purpose endpoints (~11)

```
/api/send-email           /api/oss-upload          /api/proxy-file
/api/ocr-license          /api/ocr-review          /api/ocr-booking (?)
/api/ddp-quotes           /api/ddp-ocr-extract
/api/freight-quotes       /api/minimax-booking     /api/setup-finance
/api/driver-evidence      /api/factory-fill (rate-limited)
/api/pending-confirm (rate-limited)
/api/doc-convert          /api/doc-review
/api/ideas-capture        /api/audit
/api/collab               /api/oss-direct
/api/migrate-shipping     /api/health (server-defined)
```

---

## 4. Hard-Gate Risk Classification

| 类别 | 数量（估） | 风险层 |
|---|---|---|
| **Read-only GET** (analytics / lookup / list) | ~50 | LOW · 可批量接入 dashboard |
| **Write POST/PUT** (create / update truth) | ~70 | MEDIUM · 需 capability gate |
| **DELETE / migrate / seed** | ~10 | HIGH · Owner-only |
| **JDY (legacy)** | 13 | DEPRECATED · 不接 |
| **OCR / OSS / external API** | ~10 | EXTERNAL · 涉及第三方 |
| **Webhook (vessel-callback)** | 1 | HIGH · 不可重放 |

**估算精度**：±15% — 真实方法读取需逐文件分析 handler method check（`req.method === 'POST'`），本 inventory 仅做粗分。Wave 1 启动前需精读。

---

## 5. Already-Connected Surfaces (best-effort observation)

`api_contract.md` memory 提：
- 134 endpoint contract 在 `Sanlyn-OS/docs/API-CONTRACT.md`（实际 155，差额 21 是新增）
- 约定：ESM only / kebab-case / `getPool()` / `{success, data, error, count}` 响应 shape
- `customers.id 无 PK` 是雷

Dashboard / admin 实际消费量：
- `sanlyn-os-dashboard` `services/readOnlyAggregator.js` (PR-7) 已对接少量 GET
- `sanlyn-admin` `services/finance-api/` 子目录有独立 endpoint（不在本仓内）
- `sanlyn-os-dashboard` `src/utils/jdyApi.js` 直调 JDY (legacy)
- 本 inventory 不数 consumer 端，只数 producer

---

## 6. Already-Stale / Dead-Code Candidates (观察，未验证)

| Surface | 风险 | 建议 |
|---|---|---|
| `/api/jdy*` (13) | DEPRECATED | 用 access log 确认 0 traffic 后可考虑批量下线 |
| `/api/m3/*` | 模块 3 专用 | 确认模块 3 是否仍活跃 |
| `seed-*` (4) | 一次性数据初始化 | 完成历史 seed 后可硬删 |
| `migrate-*` (2) | 一次性迁移 | 同上 |
| `setup-finance` | 一次性 | 同上 |

**全部仅为观察，本 inventory 不删除任何 endpoint。**

---

## 7. Recommended Wave Assignment Hints

| Wave | candidate endpoints | 数量 |
|---|---|---|
| **Wave 1 · GET-only readonly** | `/api/db/analytics` `/api/db/audit-log` (read) `/api/db/customers` (list) `/api/db/orders` (list) `/api/db/products` (list) `/api/db/freight-rates` (read) `/api/db/companies` (list) — 各模块的 list/get | ~30-50 |
| **Wave 2 · 单写入口（按模块）** | `customer-orders/create` `qc-checks/create` `doc-uploads/create` `factory-submit` 等 | ~15-25 |
| **Wave 3 · 删除/迁移类** | `migrate-*` / `seed-*` / batch DELETE | ~10 |
| **Wave 4 · Bridge Agent 触发** | webhook 类（`/api/vessel-callback` 接收方） | ~5 |
| **Wave 0 · 不接（DEPRECATED）** | `/api/jdy*` 全集 | 13 |

总计可能对接：~60-90 个 endpoint（占总 155 的 40-60%）。其余为内部工具 / 一次性 / 已废弃。

---

## 8. Data Sufficiency for Wave Master Plan

本 inventory **足够** 让 Phase 2 master plan 做：
- ✅ 总 endpoint 数（155，去重后真实数）
- ✅ 按业务模块分桶
- ✅ 按风险层分类
- ✅ 已知 deprecated 标识
- ⚠️ 真实 Wave 1 启动前仍需逐文件 method 解析（粗略 GET-only ≈ 30-50）

---

## 9. Boundary Compliance

| 项 | 状态 |
|---|---|
| 修改 src / api / server.js | ❌ 0 改动 |
| 调任何 endpoint | ❌ 0 调用 |
| 读 .env / secret | ❌ 未读 |
| 触碰其他 repo | ❌ 仅 sanlyn-api 本仓 |
| docs-only PR | ✅ |

---

## 10. References

- `api_contract.md` (memory，已 stale 21 endpoint)
- `Sanlyn-OS/docs/API-CONTRACT.md`（cross-repo，未读）
- `server.js` line 89-273 — mount() 调用块为本 inventory 唯一权威源
