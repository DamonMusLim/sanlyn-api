# TASK-HALL-OPEN-TASK-TRIAGE-PLAN-001
## Sanlyn OS · 任务大厅 Open 任务处置建议

**日期**: 2026-05-11  
**状态**: DRY-RUN ONLY — 本文件为处置建议，不含任何真实写入  
**审计基础**: TASK-HALL-DATA-SOURCE-AUDIT-001.md + task-hall-open-task-classification-dryrun-v1.csv  
**严禁事项确认**: 本文不执行任何 DB 写入、状态变更、删除或 deploy

---

## 1. 总体分类结果

| 分类 | 数量 | 占比 | 处置建议 |
|------|------|------|---------|
| REAL_OPERATION_HIGH | 1 | 1% | ESCALATE_TODAY |
| REAL_OPERATION_MEDIUM | 2 | 2% | FOLLOW_UP_TODAY |
| NOISE_CANDIDATE (批次A · 真实订单) | 89 | 91% | BULK_ARCHIVE_PENDING_DAMON |
| NOISE_CANDIDATE (批次B · 测试订单) | 6 | 6% | ARCHIVE_IMMEDIATELY |
| **合计 Open** | **98** | 100% | |

---

## 2. 真实运营任务处置

### Task 1 — 🔴 高风险 · ESCALATE_TODAY

```
task_id:   t-mobecqy0-ah24
title:     请确认 38-XM-251 预计交货日期
order_no:  38-xm-251
company:   CN-00038
factory:   td（工厂代码，需确认对应工厂名称）
创建:      2026-04-23（已逾期18天）
due_at:    NULL（无截止时间）
action:    confirm_ready_date
risk:      HIGH
```

**问题描述**：
订单 38-XM-251 尚未获得工厂确认的预计交货日期。18天前创建任务至今无任何跟进，意味着系统和客户端都不知道这单什么时候出货。如果订单已有船期安排，此信息缺失将直接影响 ETD 展示和客户沟通。

**建议行动（今日）**：
1. ⚡ **立即联系工厂（company_code=td 对应工厂）** 确认预计交货日期
2. 通过 `POST /api/tasks?id=t-mobecqy0-ah24` body `{action:"confirm_ready_date", payload:{ready_date:"YYYY-MM-DD"}}` 关闭任务
3. 若工厂无法给出日期：升级为 URGENT，在 collaboration thread 留记录

**每日任务大厅入口：置顶显示，红色标记**

---

### Task 2 — 🟡 中风险 · FOLLOW_UP_WITH_EVIDENCE

```
task_id:   t-mobecqyg-01qq
title:     请上传 38-XM-246 生产备货照片
order_no:  38-XM-246
company:   CN-00038
factory:   td
创建:      2026-04-23（已逾期18天）
due_at:    NULL
action:    upload_document
risk:      MID
```

**问题描述**：
订单 38-XM-246 需要工厂上传生产/备货现场照片，以核实生产进度。此任务18天无跟进，可能的情况：
- 工厂实际已备货但没上传
- 工厂不知道如何上传
- 订单状态已变化（出货？取消？）

**建议行动（今日）**：
1. **联系工厂确认** 38-XM-246 当前生产状态
2. 若货已备好：要求工厂通过工厂门户上传照片，然后执行 upload_document action
3. 若状态已变：在 collab thread 留记录，手工关闭任务

**每日任务大厅入口：次优先，黄色标记**

---

### Task 3 — 🟡 中风险 · FOLLOW_UP_TODAY

```
task_id:   t-mobecqyv-o59k
title:     请提供 37-XM-243 提货司机信息
order_no:  37-XM-243
company:   CN-00037
factory:   td
创建:      2026-04-23（已逾期18天）
due_at:    NULL
action:    fill_driver_info
risk:      MID
```

**问题描述**：
订单 37-XM-243 需要提货司机的姓名、车牌号、预计到厂时间。18天无跟进，如果订单已装柜出货则此任务是历史噪音，如果仍在等提货则影响物流安排。

**建议行动（今日）**：
1. **先查 37-XM-243 订单状态** — 是否已有 BL、是否已出货
2. 若已出货：手工关闭任务（留记录："货已出，司机信息历史未录入"）
3. 若仍待提货：要求车队/工厂提供司机信息，通过 fill_driver_info action 关闭

**每日任务大厅入口：黄色标记**

---

## 3. 批量噪音处置建议

### 3A. 批次A（89条）— BULK_ARCHIVE_PENDING_DAMON

**特征**：
- 全部创建于 2026-04-28 16:39:46（110毫秒内批量插入）
- ID 前缀：`t-pt-`（非 tasks-create.js 生成）
- due_at 全部为 2026-05-01（固定 +3天偏移）
- source=NULL，created_by_admin=NULL
- 关联真实订单（FS20260105001 至 FS20260418075）
- payment_term_confirm action 尚未实现，永远无法通过正常流程关闭
- 已逾期10天，无任何跟进记录

**定性**：
- **功能开发/展示阶段的批量 seed 数据**，不是人工逐条建立的真实业务任务
- 这些订单的付款条款状态应以 `finance_payments` / `orders.raw` 为真相源，不应由此批 tasks 决定

**建议处置方式**（需 Damon 明确批准后执行）：
- 批量将 89 条任务 status 改为 `done`，closed_at=NOW()
- 或新增 `status='archived'`（需 schema 变更，本轮禁止）
- 推荐：不改 schema，直接批量 close，reason 写入 raw：`{"close_reason":"bulk_noise_batch_a_2026_04_28","closed_by":"damon_sl","closed_at":"2026-05-11"}`

**前提：需要 Damon 明确说的一句话**（见第5节）

---

### 3B. 批次B（6条）— ARCHIVE_IMMEDIATELY

**特征**：
- 创建于 2026-05-07（上周测试日）
- SC编号明确含 TEST/SMOKE/FORBIDDEN 等测试标记
- related_order_no 全为 `ORD-20260507-{随机}` 格式（非真实订单格式）
- safe_to_auto_close = TRUE

**建议处置方式**：
- **可直接归档，无需 Damon 额外确认**（测试性质明确）
- 建议 Damon 统一批准批次A时一起说："批次B测试任务也一并关闭"

---

## 4. 处置时序建议

```
今日（2026-05-11）
├── 1. 立即：联系工厂 td，确认 38-XM-251 交货日期 [ESCALATE]
├── 2. 今日内：跟进 38-XM-246 / 37-XM-243 状态 [FOLLOW_UP]
└── 3. 获取 Damon 口头批准（见第5节）→ 批量关闭批次B 6条

本周内（获批后）
└── 4. 批量关闭批次A 89条 + 批次B 6条

下周
└── 5. 实现 payment_term_confirm action，防止下一批无法关闭
```

---

## 5. 需要 Damon 批准的明确句子

### 关于批次B（测试任务，可立即执行）：
> **"批次B的6条测试任务（SC-TEST/SMOKE-TEST/FORBIDDEN-TEST）可以关闭，确认。"**

### 关于批次A（真实订单关联的批量 seed，需慎重）：
> **"2026-04-28 批量创建的89条 payment_term_confirm 任务是历史 seed 数据，不代表真实未处理业务，可以批量关闭，确认。"**

**两句话都批准后，Claude/系统管理员执行批量关闭 SQL：**
```sql
-- DRY-RUN：以下 SQL 未执行，仅供 Damon 审阅
-- 批次A + 批次B 批量关闭
UPDATE tasks
SET 
  status = 'done',
  closed_at = NOW(),
  updated_at = NOW(),
  raw = raw || '{"close_reason":"bulk_noise_close_approved_by_damon","closed_by":"damon_sl","close_date":"2026-05-11"}'::jsonb
WHERE 
  task_type = 'payment_term_confirm'
  AND status = 'open'
  AND id LIKE 't-pt-%';
-- 影响行数预期：95条
```

**⚠️ 本 SQL 不得在未获 Damon 明确批准前执行。**

---

*本文为处置计划，所有 SQL 为 DRY-RUN 展示，未执行。*
