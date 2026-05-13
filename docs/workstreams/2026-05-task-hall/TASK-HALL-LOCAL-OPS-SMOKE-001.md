# TASK-HALL-LOCAL-OPS-SMOKE-001
## Sanlyn OS · 任务大厅本地可运营性 Smoke 测试 · 最终报告

**测试日期**: 2026-05-11  
**测试执行**: Claude (TASK-HALL-LOCAL-OPS-SMOKE-001 指令)  
**数据来源**: 直连生产 DB read-only + API 源码审阅  
**严禁事项确认**: 全程未执行任何 DB 写入、schema 变更、delete、deploy、push main、merge

---

## 最终状态

```
LOCAL_TASK_HALL_SMOKE_PARTIAL_PASS_WITH_ISSUES
```

**原因**：数据层完全可用，但 UI/流程层存在4个明确问题，均有可执行修复路径。

---

## 10 个核心问题的答案

### Q1. 任务大厅现在能不能作为每日入口？

**现在：不能。但改造后可以。**

- 当前问题：98条平铺，高风险淹没在噪音里，没有每日摘要，无 push 通知
- 改造后（约1.5小时工作量）：可以作为每日入口使用
- 不改造直接用：Damon 每天打开看到98条，工作量反而更大

---

### Q2. 98条 Open 任务里，哪些是真任务，哪些是噪音候选？

| 分类 | 数量 | 性质 |
|------|------|------|
| 真实运营任务 | **3条** | 真任务，需要今日处理 |
| 批次A噪音（真实订单） | **89条** | 历史 seed，建议批量归档（需 Damon 批准） |
| 批次B噪音（测试订单） | **6条** | 测试任务，可直接归档 |

识别标志：
- 真实任务：`t-mob` 前缀，手工建，source=manual
- 噪音任务：`t-pt-` 前缀，批量建，source=NULL

---

### Q3. 95条 payment_term_confirm 是否建议批量关闭？

**建议：是，分两步执行。**

- 批次B 6条（测试任务）：**可立即归档**，明确测试噪音
- 批次A 89条（真实订单关联 seed）：**建议归档，需 Damon 先批准**

**不建议直接删除，建议改为 status='done' 并在 raw 中记录关闭原因，保留审计轨迹。**

---

### Q4. 批量关闭前需要 Damon 确认哪一句话？

**批次B（立即可执行）**：
> "批次B的6条测试任务（SC-TEST/SMOKE-TEST/FORBIDDEN-TEST）可以关闭，确认。"

**批次A（需慎重，需此句话才执行）**：
> "2026-04-28 批量创建的89条 payment_term_confirm 任务是历史 seed 数据，不代表真实未处理业务，可以批量关闭，确认。"

---

### Q5. 3条真实运营任务今天应该怎么处理？

| 任务 | 行动 | 截止 |
|------|------|------|
| 38-XM-251 预计交货日期 | ⚡ 联系工厂 td 确认交货日期 → `confirm_ready_date` action | 今日 |
| 38-XM-246 生产备货照片 | 🟡 联系工厂确认备货状态 → 要求上传照片或解释 | 今日内 |
| 37-XM-243 提货司机信息 | 🟡 先查该订单是否已出货 → 若未出货填司机信息，若已出货手工关闭 | 今日内 |

---

### Q6. 当前功能是否只是数据层可用，还是 UI/流程也可用？

| 层 | 状态 | 说明 |
|----|------|------|
| 数据层 (DB) | ✅ 完全可用 | 98条任务真实存在，字段完整，可读取 |
| API 层 | ✅ 大部分可用 | GET/POST tasks 均实现，4种 action 可执行 |
| action 执行 | ✅ 可用（3条真实任务） | confirm_ready_date/fill_driver_info/upload_document 均实现 |
| payment_term_confirm action | ❌ 不可用 | 无对应 action，这批任务永远无法正常关闭 |
| UI 分组/排序 | ❌ 不可用 | 当前全量平铺无分组 |
| 批量操作 | ❌ 不可用 | 无批量 API |
| 每日提醒 | ❌ 不可用 | 无定时任务，无 push |

---

### Q7. 是否需要新增"每日任务提醒"？

**是，强烈建议。**

- 最小方案（当前可用）：每天 Damon 说"Claude 查一下任务大厅"→ Claude 执行 query → 微信推送
- 半自动方案：scheduled-tasks 配置每日9点 fire → Claude 执行 → wechat-push
- 完整方案：`GET /api/tasks/summary` 接口 + cron job + 企业微信 webhook

---

### Q8. 是否需要 Claude/Hermes 每天主动整理任务？

**建议：是（Phase 2），但不是现在。**

- 现阶段：先让 Damon 能快速看清楚任务（UI 改造 P1 完成后）
- Phase 2：Claude 每日自动运行：query → 分类 → 生成摘要 → push → 等 Damon 批准 → 执行归档

---

### Q9. 本轮有没有触碰 DB/schema/deploy/production？

**完全没有。**

- ✅ 未执行任何 INSERT/UPDATE/DELETE
- ✅ 未修改 DB schema（无 ALTER TABLE/CREATE TABLE）
- ✅ 未 deploy 任何代码
- ✅ 未 push main 或 merge
- ✅ 未触碰财务/报关/客户核心真相源
- ✅ 未制造"已处理"假状态
- ✅ 全程只读：DB query（read-only MCP）+ 源码 Read

---

### Q10. 下一步最小可执行动作是什么？

**今日必须（不需要 Damon 批准）**：
1. 联系工厂 td，跟进 38-XM-251 / 38-XM-246 / 37-XM-243

**今日需要 Damon 说一句话**：
- 批次B：6条测试任务可归档
- 批次A：89条历史 seed 可批量关闭

**本周内（1.5小时工作量）**：
- 实现 `GET /api/tasks/summary`
- 任务大厅顶部摘要横幅
- payment_term_confirm 折叠 Group
- 高风险任务置顶

**下周（1小时工作量）**：
- 实现 payment_term_confirm action（让未来的此类任务可正常关闭）
- 配置每日9点自动摘要 + 微信推送

---

## 交付文件清单

| 文件 | 说明 |
|------|------|
| `TASK-HALL-DATA-SOURCE-AUDIT-001.md` | Step 1：任务数据来源完整审计 |
| `task-hall-open-task-classification-dryrun-v1.csv` | Step 2：98条 Open 任务干跑分类结果（全量） |
| `TASK-HALL-OPEN-TASK-TRIAGE-PLAN-001.md` | Step 3：处置建议 + 批量关闭 DRY-RUN SQL |
| `TASK-HALL-DAILY-ENTRY-RULES-001.md` | Step 4：每日入口规则 + SOP + 提醒文案 |
| `TASK-HALL-LOCAL-UI-SMOKE-001.md` | Step 5：UI 现状评估 + 最小改造方案 |
| `TASK-HALL-LOCAL-OPS-SMOKE-001.md` | Step 6：本文，最终报告 |

---

## 给 Damon 的摘要（一页纸版本）

```
📋 任务大厅 Smoke 测试结果 · 2026-05-11

✅ 数据层：正常，98条任务真实存在，可读取，可分类
✅ API层：正常，action 执行接口均有效

❌ 发现的问题：
  1. 95条 payment_term_confirm 无法正常关闭（缺 action 实现）
  2. 任务大厅全量平铺，真实任务淹没在噪音里
  3. 无每日摘要/提醒机制
  4. 3条真实运营任务挂了18天无人处理

📦 分类结果：
  真实任务   3条（今日处理）
  批次A噪音  89条（等你批准后批量归档）
  批次B噪音   6条（测试任务，可立即归档）

🔴 今日第一优先：
  联系工厂 td → 38-XM-251 交期确认

📢 需要你说的话：
  "批次B的6条测试任务可以关闭，确认。"
  "批次A的89条 payment_term_confirm seed 数据可以批量关闭，确认。"

⚡ 下一步：
  1. 今天：处理3条真实任务 + 批准噪音归档
  2. 本周：UI 改造（1.5小时，让任务大厅可每日使用）
  3. 下周：自动每日摘要 + 微信推送
```

---

*测试状态：LOCAL_TASK_HALL_SMOKE_PARTIAL_PASS_WITH_ISSUES*  
*全程零 DB 写入，零 deploy，零 schema 变更。*
