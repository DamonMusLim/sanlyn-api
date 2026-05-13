# TASK-HALL-DATA-SOURCE-AUDIT-001
## Sanlyn OS · 任务大厅数据来源审计

**审计日期**: 2026-05-11  
**审计方式**: 直连生产 DB read-only query（mcp__sanlyn-pg__query）+ API 源码审阅  
**审计人**: Claude (TASK-HALL-LOCAL-OPS-SMOKE-001)  
**严禁事项确认**: 本次审计未写入 DB、未改 schema、未 deploy、未删除任何数据

---

## 1. 数据来源

### 1.1 主数据表：`tasks`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | VARCHAR | 主键，两种格式（见下方 ID 模式分析） |
| `title` | VARCHAR | 任务标题 |
| `task_type` | VARCHAR | 任务类型（见下方枚举） |
| `level` | VARCHAR | `order` / `factory` / `doc` / `logi` / `approve` |
| `status` | VARCHAR | `open` / `done` |
| `risk_level` | VARCHAR | `low` / `mid` / `high` / `urgent` |
| `owner_object_type` | VARCHAR | `order` / `factory` / `document` / `logistics` |
| `owner_object_id` | VARCHAR | 关联对象 ID |
| `owner_object_label` | VARCHAR | 显示标签 |
| `related_order_no` | VARCHAR | 关联订单号 |
| `related_po_no` | VARCHAR | 客户 PO 号（当前全 NULL） |
| `company_code` | VARCHAR | 归属客户公司（tenant scope） |
| `factory_company_code` | VARCHAR | 归属工厂公司 |
| `mode` | VARCHAR | `owned` / `agent` |
| `due_at` | TIMESTAMPTZ | 截止时间 |
| `reason` | TEXT | 触发原因说明 |
| `raw` | JSONB | 扩展字段：source / created_by_admin / collaborators / primary_action / steps / uploads |
| `assignee_user_id` | UUID | 指派人（当前全 NULL） |
| `company_id` | INT | 公司 ID（当前全 NULL） |
| `order_service_id` | UUID | 关联服务 ID（当前全 NULL） |
| `created_at` | TIMESTAMPTZ | 创建时间 |
| `updated_at` | TIMESTAMPTZ | 更新时间 |
| `closed_at` | TIMESTAMPTZ | 关闭时间 |

**无 batch_id 字段** — 批量任务无显式批次标识，但可通过 ID 前缀 + 时间戳 + due_at 推断。

### 1.2 关联表

| 表 | 关联方式 | 用途 |
|----|---------|------|
| `collaboration_threads` | `task_id` | 每个任务可有一个协作线程 |
| `collaboration_messages` | `thread_id` | 线程内消息/事件流水 |
| `orders` | `related_order_no` | 执行 action 时回写 orders 字段 |
| `shipping_plans` | `related_order_no` | 执行 action 时回写 shipping_plans 字段 |

### 1.3 API 路由

| 路由 | 方法 | 功能 |
|------|------|------|
| `GET /api/tasks?id={task_id}` | GET | 获取单个任务详情（抽屉用） |
| `POST /api/tasks?id={task_id}` | POST body `{action, payload}` | 执行任务 action |
| `POST /api/tasks/create` | POST (admin only) | 手工创建任务 |

**注意**：当前 **无 PATCH 状态变更接口**，无批量关闭接口，无 archive 接口。  
任务关闭只能通过执行 action 触发（如 confirm_ready_date → 自动 status='done'）。

### 1.4 当前支持的 Action

| action | payload | 触发关闭？ |
|--------|---------|-----------|
| `confirm_ready_date` | `{ ready_date }` | ✅ 是 |
| `confirm_actual_date` | `{ actual_date }` | ✅ 是 |
| `fill_driver_info` | `{ driver_name, driver_phone, plate_no, arrive_at }` | ✅ 是 |
| `fill_container_info` | `{ container_no, seal_no, size }` | ✅ 是 |
| `upload_document` | `{ kind, url, filename }` | 视情况 |

**payment_term_confirm 对应的 action 尚未实现** — 这也是这 95 条任务无法被关闭的根本原因。

---

## 2. 任务 ID 模式分析

### 模式 A：`t-mob{timestamp}-{random}` — 手工/功能创建
- 例：`t-moba9m4r-oyr3`, `t-mobecqy0-ah24`
- 来源：`tasks-create.js` 或验收测试
- 所有 Done=5 的任务均为此模式
- 所有 3 条真实运营任务均为此模式

### 模式 B：`t-pt-{random}` — 批量脚本创建
- 例：`t-pt-mqet7ddu`, `t-pt-xr4u34e4`
- 来源：独立批量生成脚本（非 `tasks-create.js`，因后者生成 `t-mob` 前缀）
- 所有 95 条 payment_term_confirm 均为此模式
- **`t-pt-` 前缀是批量任务的唯一可识别标志**

---

## 3. Done=5 来源分析

| task_id | 标题 | 来源 | 关闭时间 | 说明 |
|---------|------|------|---------|------|
| t-moba9m4r-oyr3 | 确认预计交期 | manual, created_by_admin=damon_sl | 2026-04-23 09:56 | 真实业务任务，Damon 手工建，已被工厂完成 |
| t-mobcs6cj-uyjg | [验收] 确认实际交货日期 | manual, [验收]前缀 | 2026-04-23 10:43 | 验收测试任务，42-Order-3 测试数据 |
| t-mobcsg1e-mqvt | [验收] 填写司机信息 | manual, [验收]前缀 | 2026-04-23 10:43 | 验收测试任务，42-Order-3 测试数据 |
| t-mobcsg1x-8s1s | [验收] 填写装柜信息 | manual, [验收]前缀 | 2026-04-23 10:43 | 验收测试任务，42-Order-3 测试数据 |
| t-mobsuv7t-k1ck | [验收] 两步流：盖章上传 → 确认交期 | manual, [验收]前缀 | 2026-04-23 18:13 | 验收测试任务，38-XM-251，有假 PDF upload |

**结论**：Done=5 中，1 条是真实业务任务（Damon 建），4 条是验收测试。**真实业务成功关闭率 = 1/98 (开放) = 极低。**

---

## 4. Open=98 来源分析

| 批次 | 数量 | 创建时间 | 到期时间 | ID前缀 | raw.source | 订单类型 | 性质 |
|------|------|---------|---------|--------|-----------|---------|------|
| 批次A | 89 | 2026-04-28 16:39:46 (约1.5秒内全部创建) | 2026-05-01 | t-pt- | NULL | 真实订单 (FS*, PBTYF-*, 40-XZ-*, 42-JJ-*) | 批量噪音候选 |
| 批次B | 6 | 2026-05-07 10:55~11:20 | 2026-05-10 | t-pt- | NULL | 测试订单 (SC-*-TEST, SMOKE-TEST, FESM-*, SC-FORBIDDEN-*) | 测试噪音，建议直接归档 |
| 真实运营 | 3 | 2026-04-23 11:27 | NULL | t-mob- | manual | 真实订单 (38-xm-251, 38-XM-246, 37-XM-243) | 真实待处理 |

### 批次A深度分析

89 条任务全部在 **2026-04-28 16:39:46.666Z 到 16:39:46.775Z**（约110毫秒内）批量插入。

特征：
- `raw->>'source'` = NULL（批量脚本未设置来源标记）
- `raw->>'created_by_admin'` = NULL
- `due_at` 全部为 `created_at + 3天`（固定偏移量）
- `related_order_no` 覆盖的订单均为 2025-12 至 2026-04 期间的历史订单
- 无任何后续跟进记录（collaboration_threads 未检查，但 closed_at=NULL 且 updated_at=created_at）

**推断**：批次A是某次功能开发/展示时跑的批量 seed 脚本，不是人工逐条创建。

### 批次B深度分析

6 条任务分散在 2026-05-07 10:55~11:20 创建，引用订单号均含 "TEST", "SMOKE", "FORBIDDEN" 等明显测试标记。关联 `related_order_no` 均为 `ORD-20260507-{随机}` 格式。

**推断**：批次B是 2026-05-07 当天 smoke testing 时产生的测试任务副产品。

---

## 5. 字段完整性

| 字段 | 填充率 | 说明 |
|------|--------|------|
| id | 100% | 全部有值 |
| title | 100% | 全部有值 |
| task_type | 100% | 全部有值 |
| status | 100% | 全部有值 |
| risk_level | 100% | 全部有值 |
| company_code | 100% | 全部有值 |
| related_order_no | ~100% | 极少数可能 NULL |
| due_at | payment_term_confirm=100%, 其他=0% | 手工任务均无截止时间 |
| assignee_user_id | 0% | 全 NULL，指派功能未启用 |
| company_id | 0% | 全 NULL，未来 tenant 隔离用 |
| order_service_id | 0% | 全 NULL |
| related_po_no | 0% | 全 NULL |
| raw.batch_id | 不存在 | ⚠️ 缺乏批次标识，建议后续在 raw 中增加 |

---

## 6. 关键问题总结

| 问题 | 严重度 | 说明 |
|------|--------|------|
| payment_term_confirm 无对应 action | 🔴 HIGH | 这些任务创建后永远无法通过正常流程关闭 |
| 无批量关闭/归档 API | 🔴 HIGH | 当前只能逐条执行 action，没有批量操作接口 |
| 无 batch_id 字段 | 🟡 MID | 批量噪音识别依赖 ID 前缀推断，不够严谨 |
| assignee 全 NULL | 🟡 MID | 任务没有分配给任何人，无法产生通知 |
| 批次B测试任务未清理 | 🟡 MID | 6 条 SC-TEST/SMOKE-TEST 任务应归档 |
| due_at 缺失（真实任务） | 🟡 MID | 3 条真实运营任务无截止时间，逾期无法自动标记 |
| 无每日提醒机制 | 🟡 MID | 没有定时任务/cron 生成每日任务摘要 |

---

*本文档为只读审计，不含任何 DB 写入或状态变更。*
