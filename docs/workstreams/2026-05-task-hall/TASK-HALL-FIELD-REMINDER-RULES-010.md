# TASK-HALL-FIELD-REMINDER-RULES-010
## Sanlyn OS · 任务大厅字段提醒规则中心 · 设计方案 v1

**设计日期**: 2026-05-11  
**状态**: `TASK_HALL_FIELD_REMINDER_RULES_SPEC_READY`  
**阶段**: 设计 + 最小实现方案（不改 schema，不改生产 DB，不接真实推送）  
**前序任务**: TASK-HALL-READONLY-PROD-DEPLOY-009（只读 UI 已上线）

---

## 一句话核心思路

> 不靠人 / Claude 手写任务，系统扫描字段状态 → 按规则自动生成提醒任务 → 按优先级推送到配置的目标 → 任务大厅统一展示，Damon 可在配置文件中调整规则。

---

## 1. 字段提醒规则模型

一条 `ReminderRule` 代表"当某张表的某个字段满足某个条件时，做什么"。

### 1.1 完整字段定义

```typescript
interface ReminderRule {
  // ─── 身份 ───────────────────────────────────────────────
  rule_code:          string;   // 全局唯一，kebab-case。例: "ready_date_missing"
  rule_name:          string;   // 人类可读名称（中文）。例: "交货日期缺失提醒"
  enabled:            boolean;  // false = 规则静默，不扫描、不生成

  // ─── 数据源 ──────────────────────────────────────────────
  target_table:       string;   // 扫描哪张表。例: "orders", "shipping_plans", "tasks"
  target_field:       string;   // 关注哪个字段（支持 JSONB 点路径）。例: "raw.ready_date"
  join_context?:      string;   // 可选：联表说明。例: "JOIN orders ON shipping_plans.order_id = orders.id"

  // ─── 触发条件 ────────────────────────────────────────────
  condition:          RuleCondition;
  /*
    RuleCondition 枚举：
      FIELD_NULL              — 字段为 NULL 或 JSONB key 不存在
      FIELD_EMPTY_STRING      — 字段为空字符串
      FIELD_MISSING           — FIELD_NULL || FIELD_EMPTY_STRING
      FIELD_OVERDUE           — 字段是日期类型且值 < TODAY
      FIELD_UNCONFIRMED       — 字段存在但 confirmed_at = NULL
      FIELD_CONFLICT          — 字段值与另一张表的同义字段不一致
      TASK_ESCALATION         — tasks 表中此任务已超过 escalation_after_days 未关闭
      CUSTOM_SQL              — 使用 condition_sql 自定义
  */
  condition_sql?:     string;   // condition=CUSTOM_SQL 时有效，必须 SELECT-only，返回需提醒的行

  // ─── 严重程度 ────────────────────────────────────────────
  severity:           "high" | "mid" | "low";
  escalation_after_days: number; // 生成任务后 N 天未关闭 → 自动升级 risk_level 为 high
  cooldown_hours:     number;   // 同一条规则 + 同一记录在此时间内不重复生成任务（去重窗口）

  // ─── 任务生成 ────────────────────────────────────────────
  create_task:        boolean;  // 是否写入 tasks 表（false = 只推送，不创建任务卡）
  task_type:          string;   // 写入 tasks.task_type 的值。例: "missing_field"
  task_title_template: string;  // 支持 {order_no} {field} {value} 占位符
  dedupe_key:         string;   // 唯一约束键。例: "{rule_code}:{order_id}"
                                // 同 dedupe_key 存在 open 任务时跳过创建

  // ─── 推送目标 ────────────────────────────────────────────
  target_role:        TargetRole[];  // 见第 2 节
  push_channel:       PushChannel[]; // 见第 2 节
  push_target:        PushTarget[];  // 见第 2 节
}
```

### 1.2 字段说明要点

| 字段 | 说明 |
|------|------|
| `target_field` | 支持 JSONB 点路径，如 `raw.ready_date`，避免为每个字段加表列 |
| `condition` | 枚举化，引擎层统一处理，规则本身不写 SQL |
| `dedupe_key` | 防止同一订单/任务重复创建提醒卡，是去重的核心 |
| `cooldown_hours` | 已有 open 任务时静默，不再推送；任务关闭后冷却重置 |
| `escalation_after_days` | 超期自动提级，驱动 high 排序到第一位 |
| `enabled` | 生产热开关，配置文件改为 false 立即静默，无需改代码 |
| `create_task` | 部分规则只推送不建卡（如低优先级通知） |

---

## 2. 推送目标模型

### 2.1 三层结构

```
push_channel  →  push_target  →  target_role
（渠道）           （具体目标）       （角色标签，决定谁收）
```

### 2.2 PushChannel 枚举

```typescript
type PushChannel =
  | "system_only"      // 仅写入 tasks 表，任务大厅可见，不外发
  | "wecom_webhook"    // 企业微信 webhook（v1 不接真实 webhook，system_only 模拟）
  | "email"            // 邮件（v1 不接真实 SMTP，system_only 模拟）
  | "manual_followup"; // 标记为"需人工跟进"，UI 显示特殊徽章
```

### 2.3 PushTarget 枚举

```typescript
type PushTarget =
  | "damon"             // Damon 本人（企微/邮件）
  | "ops_group"         // 运营群（企微群组 webhook）
  | "factory_contact"   // 工厂联系人（从 orders.factory_id → partners 取联系方式）
  | "trucking_contact"  // 拖车联系人（shipping_plans.trucker_contact）
  | "customs_contact"   // 报关行联系人（需隐私隔离，v1 不启用）
  | "sales_owner";      // 订单归属销售（orders.sales_owner）
```

### 2.4 TargetRole 枚举（任务大厅 UI 过滤用）

```typescript
type TargetRole =
  | "admin"     // Damon / Sanlyn 后台
  | "ops"       // 运营
  | "factory"   // 工厂端（Phase 2 工厂门户可见）
  | "trucking"  // 拖车方（Phase 2 可见）
  | "system";   // 纯系统自动，不分配给人
```

### 2.5 Damon 如何配置推送目标

v1 阶段：**使用配置文件** `reminder-rules.config.json`，Damon 直接编辑 JSON 字段。

```jsonc
// 配置示例（v1 全部 system_only，不接真实 webhook）
{
  "global": {
    "dry_run": true,           // true = 只记录，不实际推送/创建任务
    "push_channel_override": "system_only"   // 强制覆盖所有规则的渠道
  },
  "rules": {
    "ready_date_missing": {
      "enabled": true,
      "severity": "high",
      "push_target": ["damon", "ops_group"],
      "cooldown_hours": 24,
      "escalation_after_days": 2
    },
    "loading_photo_missing": {
      "enabled": true,
      "severity": "mid",
      "push_target": ["ops_group", "factory_contact"],
      "cooldown_hours": 48,
      "escalation_after_days": 3
    }
    // ...
  }
}
```

**Phase 2 升级路径**：`push_channel_override` 改为 `"wecom_webhook"`，补填 `wecom_webhook_url`，即可开通真实推送，无需改规则逻辑。

---

## 3. 任务生成规则

### 3.1 引擎扫描流程（伪代码）

```
每次触发（定时 / 手动 / 事件驱动）：

FOR each enabled ReminderRule:

  1. 查询 target_table，筛出满足 condition 的记录集 → candidate_rows

  2. FOR each row in candidate_rows:

     a. 计算 dedupe_key = rule_code + ":" + row[primary_key]

     b. 查询 tasks 表：
        SELECT id, status, risk_level, created_at
        FROM tasks
        WHERE raw->>'dedupe_key' = dedupe_key
        ORDER BY created_at DESC
        LIMIT 1
        → existing_task

     c. 去重判断：
        IF existing_task EXISTS AND existing_task.status = 'open':
          → 跳过创建
          → 检查升级：IF TODAY - existing_task.created_at > escalation_after_days:
              UPDATE tasks SET risk_level = 'high'
                             , raw = raw || '{"escalated_at":"NOW()"}'
              → 不重复推送（仅升级 risk_level）
          CONTINUE

        IF existing_task EXISTS AND existing_task.status = 'done':
          last_closed = existing_task.updated_at
          IF NOW() - last_closed < cooldown_hours:
            CONTINUE  ← 冷却期内不重新生成

     d. 通过去重 → 生成任务：
        INSERT INTO tasks (
          id          = gen_ulid('t-auto-'),
          status      = 'open',
          task_type   = rule.task_type,
          title       = render(rule.task_title_template, row),
          risk_level  = rule.severity,
          related_order_no = row.order_no,
          raw = {
            "rule_code":     rule.rule_code,
            "dedupe_key":    dedupe_key,
            "source_table":  rule.target_table,
            "source_field":  rule.target_field,
            "generated_by":  "reminder_engine",
            "last_reminded_at": NOW()
          }
        )

     e. 推送（v1 dry_run=true → 仅 console.log / NOTIFICATIONS.md 记录）

  3. last_reminded_at 更新：
     UPDATE tasks SET raw = raw || '{"last_reminded_at":"NOW()"}'
     WHERE raw->>'dedupe_key' = dedupe_key AND status = 'open'
```

### 3.2 六个核心问题解答

| 问题 | 解决方案 |
|------|---------|
| **如何避免重复任务** | `dedupe_key = rule_code:primary_key`，INSERT 前先 SELECT，open 任务存在则跳过 |
| **如何判断已有 open 任务** | `WHERE raw->>'dedupe_key' = ? AND status = 'open'` |
| **如何更新 last_reminded_at** | 已有 open 任务时 `UPDATE tasks SET raw = raw || '{"last_reminded_at":"NOW()"}'` |
| **如何升级 high risk** | open 任务存续超过 `escalation_after_days` → `UPDATE risk_level = 'high'` |
| **如何关闭后不重新生成** | `status = 'done'` + 检查 `cooldown_hours` 窗口，窗口内跳过 |
| **如何处理 done/archived 历史** | done 任务保留，`status = 'done'` 不影响 UI 排序；超过 30 天可归档到 `raw.archived = true`，任务大厅折叠显示 |

### 3.3 id 命名规范

```
t-auto-{rule_short}-{order_short}

示例：
t-auto-rdm-38xm251   ← ready_date_missing, 38-XM-251
t-auto-lpm-38xm246   ← loading_photo_missing, 38-XM-246
t-auto-dim-37xm243   ← driver_info_missing, 37-XM-243
```

区别于现有 `t-mobecq*`（手动生成）和 `t-pt-*`（payment_term 噪音），引擎生成任务可独立过滤。

---

## 4. 第一版 5 条规则定义

### Rule 1 — `ready_date_missing`

```json
{
  "rule_code": "ready_date_missing",
  "rule_name": "工厂交货日期缺失",
  "enabled": true,
  "target_table": "orders",
  "target_field": "raw.ready_date",
  "condition": "FIELD_MISSING",
  "severity": "high",
  "escalation_after_days": 2,
  "cooldown_hours": 24,
  "create_task": true,
  "task_type": "missing_field",
  "task_title_template": "请确认 {order_no} 预计交货日期",
  "dedupe_key": "ready_date_missing:{order_id}",
  "target_role": ["admin", "ops"],
  "push_channel": ["system_only"],
  "push_target": ["damon", "ops_group"],
  "filter_sql": "WHERE status NOT IN ('cancelled', 'closed') AND actDelivery IS NULL"
}
```

**触发范围**：未取消、未关闭、工厂尚未确认出货日期的订单，且 `raw.ready_date` 为空。  
**当前匹配**：38-XM-251（high，已有手动任务，引擎生成时将识别并跳过）

---

### Rule 2 — `loading_photo_missing`

```json
{
  "rule_code": "loading_photo_missing",
  "rule_name": "备货照片未上传",
  "enabled": true,
  "target_table": "orders",
  "target_field": "raw.loading_photos",
  "condition": "FIELD_MISSING",
  "severity": "mid",
  "escalation_after_days": 3,
  "cooldown_hours": 48,
  "create_task": true,
  "task_type": "upload_document",
  "task_title_template": "请上传 {order_no} 生产备货照片",
  "dedupe_key": "loading_photo_missing:{order_id}",
  "target_role": ["admin", "ops", "factory"],
  "push_channel": ["system_only"],
  "push_target": ["ops_group", "factory_contact"],
  "filter_sql": "WHERE status IN ('confirmed', 'production', 'ready_to_ship')"
}
```

**触发范围**：订单进入生产/确认阶段，`raw.loading_photos` 为空。  
**当前匹配**：38-XM-246（mid）

---

### Rule 3 — `driver_info_missing`

```json
{
  "rule_code": "driver_info_missing",
  "rule_name": "提货司机信息缺失",
  "enabled": true,
  "target_table": "shipping_plans",
  "target_field": "raw.driver_name",
  "condition": "FIELD_MISSING",
  "severity": "mid",
  "escalation_after_days": 1,
  "cooldown_hours": 12,
  "create_task": true,
  "task_type": "fill_driver_info",
  "task_title_template": "请提供 {related_order_no} 提货司机信息",
  "dedupe_key": "driver_info_missing:{shipping_plan_id}",
  "target_role": ["admin", "ops", "trucking"],
  "push_channel": ["system_only"],
  "push_target": ["ops_group", "trucking_contact"],
  "filter_sql": "WHERE pickup_date > NOW() - INTERVAL '7 days' AND pickup_date IS NOT NULL"
}
```

**触发范围**：有提货日期的运单，提货日 7 天内司机信息未填。  
**当前匹配**：37-XM-243（mid）  
**注意**：`driver_name` 字段属于物流信息，非财务/报关数据，符合 P1 安全边界。

---

### Rule 4 — `document_missing`

```json
{
  "rule_code": "document_missing",
  "rule_name": "关键单证未上传",
  "enabled": true,
  "target_table": "orders",
  "target_field": "raw.bl_number",
  "condition": "FIELD_MISSING",
  "severity": "mid",
  "escalation_after_days": 5,
  "cooldown_hours": 48,
  "create_task": true,
  "task_type": "upload_document",
  "task_title_template": "请上传 {order_no} 提单号（BL）",
  "dedupe_key": "document_missing_bl:{order_id}",
  "target_role": ["admin", "ops"],
  "push_channel": ["system_only"],
  "push_target": ["damon", "ops_group"],
  "filter_sql": "WHERE status = 'shipped' AND raw->>'bl_number' IS NULL",
  "note": "仅检测 BL 号缺失，不读取 BL 原件内容，不涉及财务/报关数据"
}
```

**触发范围**：订单状态为 shipped 但缺少提单号。  
**扩展方向**：v2 可扩展为检测 PI/SC/IV/PL 各类单证，每类对应独立 rule_code。

---

### Rule 5 — `overdue_task_escalation`

```json
{
  "rule_code": "overdue_task_escalation",
  "rule_name": "逾期任务自动升级",
  "enabled": true,
  "target_table": "tasks",
  "target_field": "created_at",
  "condition": "TASK_ESCALATION",
  "severity": "high",
  "escalation_after_days": 3,
  "cooldown_hours": 24,
  "create_task": false,
  "task_type": null,
  "task_title_template": null,
  "dedupe_key": "overdue_escalation:{task_id}",
  "target_role": ["admin"],
  "push_channel": ["system_only"],
  "push_target": ["damon"],
  "filter_sql": "WHERE status = 'open' AND risk_level != 'high' AND created_at < NOW() - INTERVAL '3 days'",
  "action": "UPDATE tasks SET risk_level = 'high', raw = raw || jsonb_build_object('escalated_at', NOW()::text, 'escalated_by', 'reminder_engine') WHERE id = {task_id}"
}
```

**特殊规则**：这条规则不创建新任务（`create_task: false`），只升级已有任务的 `risk_level`。  
**触发逻辑**：tasks 中超过 3 天未关闭且不是 high 的任务 → 自动变 high → TaskHallPanel 排序时自动浮顶。  
**当前匹配**：如果 38-XM-246/37-XM-243 超过 3 天未关闭，自动从 mid 升为 high。

---

## 5. 任务大厅 UI 显示规范

### 5.1 分区结构（更新版）

```
┌─────────────────────────────────────────────────┐
│ 📋 任务大厅                       [刷新] [设置⚙]  │
├─────────────────────────────────────────────────┤
│ Summary Banner                                   │
│  今日必须处理: 3  HIGH: 1  MID: 2  已完成: 100    │
│  [字段提醒: 3]  [逾期升级: 0]  [噪音已过滤: 97]   │
├─────────────────────────────────────────────────┤
│ 🔴 今日必须处理  (REAL_OP + HIGH)                 │
│  [t-mobecqy0] 38-XM-251 — 交货日期缺失  HIGH      │
│               rule: ready_date_missing           │
│               已开 2 天 · 升级: 剩 0 天 ⚠        │
│  ────────────────────────────────────────────── │
│ 🟡 字段提醒  (REAL_OP + MID，自动生成)            │
│  [t-mobecqyg] 38-XM-246 — 备货照片缺失  MID       │
│               rule: loading_photo_missing        │
│               已开 1 天 · 升级: 剩 2 天           │
│  [t-mobecqyv] 37-XM-243 — 司机信息缺失  MID       │
│               rule: driver_info_missing          │
│               已开 1 天 · 升级: 剩 0 天 ⚠        │
│  ────────────────────────────────────────────── │
│ ⚠️ 异常问题  (FIELD_CONFLICT / FIELD_UNCONFIRMED) │
│  (当前无)                                         │
│  ────────────────────────────────────────────── │
│ ✅ 已结束  (status=done)  [展开 ▶]  100 条        │
│  ────────────────────────────────────────────── │
│ 🔇 批量噪音  (NOISE_PT)  [展开 ▶]  97 条          │
└─────────────────────────────────────────────────┘
```

### 5.2 任务卡片字段（引擎生成任务额外显示）

```
┌──────────────────────────────────────────────┐
│ 🔴 HIGH   38-XM-251 — 请确认预计交货日期       │
│                                              │
│ 订单: 38-XM-251    类型: missing_field       │
│ 来源: ready_date_missing 规则自动生成          │
│ 缺失字段: orders.raw.ready_date              │
│ 下一步: 联系工厂确认交货日期                    │
│                                              │
│ 已开 2 天  /  升级预警: 今日将变 HIGH          │
│                                              │
│ [跟进中…]  [标记完成]  [忽略此次]             │
│           (Phase 1 全部 disabled)            │
└──────────────────────────────────────────────┘
```

### 5.3 五个显示区映射表

| 显示区 | 数据来源 | 过滤条件 | 说明 |
|--------|---------|---------|------|
| 今日必须处理 | tasks | `status=open AND risk_level=high` | REAL_OP high 优先 |
| 字段提醒 | tasks | `status=open AND risk_level IN (mid,low) AND raw->>'generated_by'='reminder_engine'` | 引擎生成的字段缺失提醒 |
| 异常问题 | tasks | `status=open AND task_type IN ('field_conflict','unconfirmed')` | 数据异常类 |
| 已结束 | tasks | `status=done` | 默认折叠（doneOpen=false） |
| 批量噪音 | tasks | `id LIKE 't-pt-%' AND task_type='payment_term_confirm'` | 批量 PT 噪音，默认折叠 |

### 5.4 批量噪音保护规则（不变）

```javascript
function classifyTask(task) {
  // PT 噪音：payment_term_confirm 前缀任务
  if (task.id?.startsWith("t-pt-") && task.task_type === "payment_term_confirm")
    return "NOISE_PT";
  // 引擎生成的字段提醒
  if (task.raw?.generated_by === "reminder_engine" && task.status === "open")
    return task.risk_level === "high" ? "REAL_OP" : "FIELD_REMINDER";
  // 普通真实任务
  return task.status === "open" ? "REAL_OP" : "DONE";
}
```

### 5.5 Summary Banner 更新

```
当前（Phase 1）：
  今日待处理: 3  |  已完成: 100  |  HIGH: 1  |  MID: 2

Phase 2 增加：
  今日待处理: N  |  已完成: M   |  HIGH: H  |  MID: M
  字段提醒: F   |  逾期升级: E  |  噪音过滤: 97
```

---

## 6. 不允许事项（硬边界）

| 类别 | 约束 |
|------|------|
| 数据写入 | v1 引擎 `dry_run=true`，不写生产 DB，仅 console.log 模拟 |
| Schema 改动 | 不新增表/列，规则存配置文件，任务写现有 tasks 表的 `raw` JSONB |
| 真实推送 | 企业微信 webhook / SMTP 全部模拟，`push_channel_override: "system_only"` |
| 假任务 | 引擎生成任务必须对应真实字段缺失，不允许凭空创建 |
| 财务/报关数据 | `rule.target_field` 白名单校验，禁止访问 finance/customs/tax 相关字段 |
| 生产 DB 改 | 当前规则只改 tasks 表 raw JSONB，且仅 Phase 2 实装后才真写 |
| Phase 2 action | 任务大厅 action 按钮维持全 disabled，需独立 Damon 批准 |

---

## 7. 实现路线图

### v1.0 — 配置文件 + dry_run（当前方案，不改 schema）

```
reminder-rules.config.json      ← Damon 可自己编辑的规则配置
scripts/reminder-engine.mjs     ← Node.js 扫描脚本，dry_run=true
  - 读取配置文件
  - 查询 DB（只读，MCP sanlyn-pg）
  - 模拟任务生成（console.log）
  - 输出 NOTIFICATIONS.md 报告
TaskHallPanel.jsx               ← UI 不改（已上线），等真实任务写入后自动展示
```

**触发方式**：手动 `node scripts/reminder-engine.mjs` 或 Damon 指令触发，不自动定时。

### v1.5 — 真实写入 tasks 表（需 Damon 批准）

```
干掉 dry_run，开放写入
任务 id 前缀 t-auto-，可过滤
dedupe_key 写入 tasks.raw
cooldown 和 escalation 逻辑实装
```

**schema 变更**：0 个。tasks 表 raw JSONB 已经存在，新增字段只是往 JSONB 加 key，不改表结构。

### v2.0 — 定时扫描 + 真实推送（Phase 2，需独立 Damon 批准）

```
企业微信 webhook 接入
pm2 cron 每小时扫描
邮件 SMTP 接入
工厂/拖车联系人推送
```

---

## 8. 最终回答

### Q1：字段提醒规则中心是否必要？

**必要，且优先级高。**

当前任务完全靠人工/Claude 手写，漏提醒风险极高：
- 生产任务只有 3 条是因为前几百条 PT 噪音已清理，不代表后续不会再积压
- 每次靠 Claude 扫描字段是临时方案，不可持续
- 字段提醒规则中心让任务生成有章可循，Damon 可配置，Claude 不再是中间人

### Q2：第一版该不该改 schema？

**不该改，也不必要。**

- `tasks` 表的 `raw` JSONB 已经足够存储 `rule_code / dedupe_key / generated_by / last_reminded_at`
- 规则存配置文件，不需要 `reminder_rules` 表（Phase 2 再考虑）
- 零 schema 改动 = 零 migration 风险 = Damon 随时可回退

### Q3：是否可以先用配置文件实现？

**可以，且这是推荐的 v1 路径。**

```
reminder-rules.config.json
  + scripts/reminder-engine.mjs（dry_run）
  + 现有 tasks 表 raw JSONB
= 完整的规则中心 v1
```

Damon 只需编辑 JSON，不需要碰代码。Phase 2 升级只需改 `dry_run: false`。

### Q4：是否可以先 system_only，不接真实推送？

**可以，且 v1 必须这样。**

`global.push_channel_override: "system_only"` 强制所有规则走系统内部，无外部依赖，无 webhook，无 SMTP。UI 在任务大厅看，Push 看 NOTIFICATIONS.md。

### Q5：下一步最小实现是什么？

```
Step 1（今天可做）：
  写 reminder-rules.config.json（5 条规则，dry_run=true）
  写 scripts/reminder-engine.mjs（只读扫描，console.log 输出）
  在本地跑一次，验证 3 条真实任务被正确识别

Step 2（Damon 批准后）：
  dry_run → false
  写入 tasks 表（raw.generated_by = "reminder_engine"）
  TaskHallPanel 自动展示（不改 UI）

Step 3（独立批准）：
  接企业微信 webhook
  pm2 定时任务
```

**Step 1 工时预估**：45 分钟。不改任何生产代码，不需要 Damon 额外批准。

---

## 附录：三条当前任务的规则映射

| 任务 | rule_code | target_table | target_field | 当前状态 |
|------|-----------|-------------|-------------|---------|
| 38-XM-251 交货日期缺失 | `ready_date_missing` | orders | raw.ready_date | 手动任务，引擎接管后 dedupe 跳过 |
| 38-XM-246 备货照片缺失 | `loading_photo_missing` | orders | raw.loading_photos | 手动任务，引擎接管后 dedupe 跳过 |
| 37-XM-243 司机信息缺失 | `driver_info_missing` | shipping_plans | raw.driver_name | 手动任务，引擎接管后 dedupe 跳过 |

---

## 文件输出清单

| 文件 | 状态 |
|------|------|
| `docs/workstreams/2026-05-task-hall/TASK-HALL-FIELD-REMINDER-RULES-010.md` | ✅ 本文件 |
| `reminder-rules.config.json` | 🔲 待 Damon 批准 Step 1 后创建 |
| `scripts/reminder-engine.mjs` | 🔲 待 Damon 批准 Step 1 后创建 |

---

## 最终状态

```
TASK_HALL_FIELD_REMINDER_RULES_SPEC_READY
```

| 维度 | 状态 |
|------|------|
| 规则模型设计 | ✅ 完整（13 个字段，枚举化条件） |
| 推送目标模型 | ✅ 三层结构（channel / target / role） |
| 任务生成规则 | ✅ 去重 / 冷却 / 升级 / 归档全覆盖 |
| 5 条初版规则 | ✅ 覆盖当前 3 个真实任务 + document + escalation |
| UI 显示规范 | ✅ 5 区 + 噪音保护 + Summary Banner |
| Schema 改动 | ✅ 零改动 |
| 真实推送 | ✅ 未接（system_only） |
| 生产 DB 写入 | ✅ 未写（dry_run=true） |
| 下一步最小实现 | ✅ config.json + engine.mjs，45min，零生产风险 |

---

*设计状态：TASK_HALL_FIELD_REMINDER_RULES_SPEC_READY*  
*零 schema 改动 · 零生产 DB 写入 · 零真实推送 · Damon 配置文件可控*  
*下一步：批准 Step 1 → 写 config.json + reminder-engine.mjs → dry_run 验证*
