# B2-2A 工厂端后端加固执行报告

任务编号：B2-2A-FACTORY-BACKEND-HARDENING-001
执行人：Claude Opus 4.7
审核：Codex
执行日期：2026-04-24
后端仓：`~/Desktop/sanlyn-api-dev/`
后端 HEAD（改前）：`f67736a`（B2-1 改动仍为 untracked）

---

## 1. 本轮目标

B2-2A：在进入 B2-2 前端接入前，先把 B2-1 遗留的后端最小基础能力补齐：
1. 给 `factory_notifications` 建正式 PG migration
2. 将 GET/PATCH 通知接口从 JSON 切到 PG 源（或明确阻塞原因）
3. 给新端点套 rate-limit
4. 给 `tasks.status` 9 态补 DB CHECK 约束（或明确阻塞原因）

**不做**：B2-2 前端轮询 / B2-3 权限 UI / B2-4 响应式 / 任何前端改动。

---

## 2. 改动文件清单

| 文件 | 类型 | 行数 |
|---|---|---:|
| `api/db/migrate-factory-notifications.js` | 新增 | 114 |
| `api/factory-portal-notifications.js` | 重构（JSON 单源 → PG 优先 + JSON 回退） | 319（↑ 214） |
| `server.js` | 修改（+14 行：rate-limit + migration 路由） | 243（↑ 229） |
| `api/factory-portal-upload-history.js` | 无改动 | 185 |
| `api/constants/factory-enums.js` | 无改动 | 77 |
| `data/factory-notifications.json` | 无业务改动（回滚 smoke 的副作用） | — |
| `docs/B2-2A-FACTORY-BACKEND-HARDENING-result.md` | 新增（本文件） | — |

### 未改（确认）
- 前端任何源码 ❌
- DeliveryCenter.jsx / ProductCenter.jsx / 客户端口 / 总控台 / 财务 / 产品 / 我的页面 ❌
- B2-3 权限 UI / B2-4 响应式 ❌

全部新增/修改文件均 **≤ 319 行**，远低于 600 软上限、1000 硬上限。

---

## 3. 1) factory_notifications PG migration

新增 `api/db/migrate-factory-notifications.js`，端点：`POST /api/db/migrate-factory-notifications`（admin-only）。

### 建表语句（幂等）
```sql
CREATE TABLE IF NOT EXISTS factory_notifications (
  id              VARCHAR(64) PRIMARY KEY,
  factory_id      VARCHAR(64) NOT NULL,
  supplier_id     VARCHAR(64),
  task_id         VARCHAR(64),
  delivery_id     VARCHAR(64),
  title           TEXT NOT NULL,
  body            TEXT,
  status          VARCHAR(16) NOT NULL DEFAULT 'unread',
  severity        VARCHAR(16) DEFAULT 'info',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ,
  audit           JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_fn_factory   ON factory_notifications(factory_id);
CREATE INDEX IF NOT EXISTS idx_fn_status    ON factory_notifications(status);
CREATE INDEX IF NOT EXISTS idx_fn_task      ON factory_notifications(task_id);
CREATE INDEX IF NOT EXISTS idx_fn_delivery  ON factory_notifications(delivery_id);
CREATE INDEX IF NOT EXISTS idx_fn_created   ON factory_notifications(created_at DESC);

-- status 4 态 CHECK（DROP 后 ADD，幂等）
ALTER TABLE factory_notifications DROP CONSTRAINT IF EXISTS chk_fn_status;
ALTER TABLE factory_notifications ADD CONSTRAINT chk_fn_status
  CHECK (status IN ('unread','read','handled','archived'));

-- severity CHECK（允许 NULL）
ALTER TABLE factory_notifications DROP CONSTRAINT IF EXISTS chk_fn_severity;
ALTER TABLE factory_notifications ADD CONSTRAINT chk_fn_severity
  CHECK (severity IS NULL OR severity IN ('info','warning','critical'));

-- seed 3 条演示数据，ON CONFLICT (id) DO NOTHING
```

### 权限
- 只允许 `req.user.role === 'admin' || 'system'` 触发
- 走 `requireAuth` JWT 中间件（与其他 migration 端点一致）

---

## 4. 2) 通知接口 JSON → PG 切换

### 设计
- 新增 **Store 抽象层**：`jsonStore` 与 `pgStore` 同接口（`list / findById / update`）
- `chooseStore()` 首次调用时探测 `SELECT 1 FROM factory_notifications LIMIT 1`：
  - 成功 → 缓存 `pgStore`
  - 失败（表不存在 / DB 不可达）→ 缓存 `jsonStore`，显式回退
- 探测结果在响应体回显 `_dataSource: "pg" | "json"`，便于运维排查
- 探测只做一次，后续请求零开销

### 权限 / audit 保留（未动）
- audit 身份 **只** 来自 `req.user.sub / req.user.account / req.user.role`
- `body.actorId` / `body.actorRole` 被完全忽略（B2-1 P0 Codex 修复保留）
- PATCH `status=unread` 仍返回 400
- 跨 factoryId 写仍返回 403
- 非 admin 且无 `companyCodes` → 空数据 fallback，不返回全库

### 无法端到端切换的原因（明确声明）
- 本机无可用 PostgreSQL 实例，本轮 **未验证真实 PG 路径**
- 代码路径（`pgStore.list / findById / update`）通过 `node --check` 语法校验
- 运行期走 `jsonStore`（fail-closed 到 JSON），响应 `_dataSource: "json"`
- 生产环境跑一次 `POST /api/db/migrate-factory-notifications`（admin token）后，探测自动切到 PG，无需再改代码

---

## 5. 3) Rate-limit

新增 `factoryPortalLimiter`：
- 窗口 5 分钟 / IP
- 上限 240 次
- 覆盖 `/api/factory-portal/notifications`（含 PATCH）与 `/api/factory-portal/upload-history`

### 为什么 240 / 5min
- B2-2 前端轮询锁定 30s 一次（GPT 裁决 2.5）→ 单标签 10 req / 5min
- 预留 3–4 个并发标签 + 人工操作余量：10 × 4 + 管理操作 ≈ 50 req / 5min
- 240 给到 ~5× 余量，足以吸收突发（批量标记已读等），又能拦掉异常客户端

### 命中证据（curl）
```
RateLimit-Policy: 240;w=300
RateLimit-Limit: 240
RateLimit-Remaining: 234
RateLimit-Reset: 300
```

---

## 6. 4) tasks.status 9 态 DB CHECK 约束

### 做法
在 `migrate-factory-notifications.js` 末尾追加，与通知表 migration 合并成一次 admin 操作：
```sql
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS chk_tasks_status_v2;
ALTER TABLE tasks ADD CONSTRAINT chk_tasks_status_v2
  CHECK (status IS NULL OR status IN (
    -- 9 态（B2 口径）
    'pending','in_progress','waiting_upload','uploaded',
    'under_review','accepted','rejected','completed','blocked',
    -- legacy（历史数据兼容）
    'open','doing','done','cancelled'
  ));
```

### 为什么 union 而不是严格 9 态
- `factory-portal-tasks.js` 默认过滤 `status IN ('open','doing')`，现网数据仍是 legacy 值
- 如果直接约束成 9 态，CHECK 会立即拒绝现有行，migration 失败
- 保留 legacy 4 态 + 9 态，既做到"不能写进 9/legacy 之外的垃圾值"，又不破坏现有数据
- 后续 B2 收口时再单独起一条 **数据迁移**（legacy → 9 态）：`open → pending`、`doing → in_progress`、`done → completed`、`cancelled → blocked`。不在本轮做。

### 无法端到端执行的原因
同 §4：本机无可用 PG，未在真实 DB 执行 `chk_tasks_status_v2` 添加。代码路径通过 `node --check`。

---

## 7. 保留项（未动）

| # | 要求 | 状态 |
|---|---|---|
| 5 | 不新增 `POST /api/factory-portal/assert-permission` | ✅ 未新增 |
| 6 | accepted 与 completed 不合并 | ✅ 枚举保持独立 |
| 7 | PATCH status=unread 禁止 | ✅ 400（curl 验证） |
| 8 | 跨 factoryId 修改 403 | ✅ curl 验证 |
| 9 | audit 身份只来自 req.user，body 不可覆盖 | ✅ `actorId = req.user.sub || account`；curl 用伪造 actorId/actorRole 的 body 测试，audit 仍落 token 值 |

---

## 8. 验证结果

### `node --check`
```
api/factory-portal-notifications.js       OK
api/factory-portal-upload-history.js      OK
api/constants/factory-enums.js            OK
api/db/migrate-factory-notifications.js   OK
server.js                                 OK
```

### `npm run build`
后端仓 `sanlyn-api-dev` **无 build 步骤**（`scripts: { dev, start }`），不适用。

### 启动
`JWT_SECRET=devlocal-b22a PORT=3792 node server.js` → `[sanlyn-api] listening on :3792` ✅

### curl 用例

| # | 用例 | 预期 | 实际 |
|---|---|---|---|
| 1 | `GET /api/factory-portal/notifications?factoryId=FAC-JJ`（FAC-JJ token） | 200 + 数据 | ✅ 200，返回自己的通知 |
| 2 | `PATCH notifications/ntf-0001 {status:"read", actorId:"HACKER", actorRole:"admin"}` | 200 + audit 不被伪造 | ✅ 200，`audit.lastActionBy=u-jj`（token sub），`lastActionRole=factory` |
| 3 | `PATCH notifications/ntf-0001 {status:"unread"}` | 400 | ✅ 400 |
| 4 | `PATCH notifications/ntf-0003`（FAC-JJ 改 FAC-DB） | 403 | ✅ 403 |
| 5 | `GET /api/factory-portal/upload-history?factoryId=FAC-JJ` | 200 + 空数据（fail-closed） | ✅ 200，`data: []` |
| 6 | Rate-limit 头 | 存在 | ✅ `RateLimit-Limit: 240, Remaining: 234, Reset: 300` |

### 未验证路径（明确声明）
- **未验证真实 PG 路径**：本机无可用 Postgres 实例；通知接口运行时走 JSON 回退（`_dataSource: "json"`）
- **未验证 `migrate-factory-notifications` 端到端执行**：代码通过 `node --check`，但未跑真实 `CREATE TABLE`
- **未验证 `chk_tasks_status_v2` CHECK 添加**：同上

以上 3 项需要生产/预发 PG 环境执行一次 `POST /api/db/migrate-factory-notifications`（admin JWT）才能闭环。

---

## 9. 已知遗留

### P0
1. 🔴 无

### P1
1. 🟡 **真实 PG 路径未现场验证**（§8）—— 需生产/预发环境执行一次 migration
2. 🟡 **legacy status → 9 态数据迁移未做** —— CHECK 约束采用 union 方式兼容，避免阻塞；legacy 映射（`open→pending / doing→in_progress / done→completed / cancelled→blocked`）留 B2 后续批次处理
3. 🟡 **audit 仍是对象内联字段，无独立 `audit_events` 表** —— 留 B2-3 权限主线引入

### P2
1. 🔵 `_dataSource` 字段仅用于排查，生产可按需过滤
2. 🔵 JSON 回退路径的 write 是同步 I/O；回退本就是兜底，PG 上线后此问题消失

---

## 10. 文件行数检查

| 检查项 | 结果 |
|---|---|
| 新增文件是否超 600 行 | ❌ `migrate-factory-notifications.js` 114 行 |
| 修改文件是否超 600 行 | ❌ `factory-portal-notifications.js` 319 / `server.js` 243，均 < 600 |
| 是否触碰超 1000 行文件 | ❌ 未触碰 `DeliveryCenter.jsx`（1487）/ `ProductCenter.jsx`（1101） |
| 如触碰，原因与改动范围 | 不适用 |

---

## 11. 附：git diff 摘要

```
~/Desktop/sanlyn-api-dev/
 M server.js                                    (+14)
 ?? api/constants/                               (B2-1 untracked)
 ?? api/factory-portal-notifications.js          (B2-1 untracked；B2-2A 扩展到 319 行)
 ?? api/factory-portal-upload-history.js         (B2-1 untracked)
 ?? api/db/migrate-factory-notifications.js      (B2-2A 新增)
 ?? data/factory-notifications.json              (B2-1 untracked)
 ?? docs/B2-2A-FACTORY-BACKEND-HARDENING-result.md (本文件)
```
