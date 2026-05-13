# TASK-HALL-LOCAL-DEV-DB-SETUP-003
## Sanlyn OS · 任务大厅本地 Dev DB 搭建与清理验证报告

**执行日期**: 2026-05-11  
**最终状态**: `TASK_HALL_LOCAL_DEV_DB_SETUP_PASS`  
**执行者**: Claude (TASK-HALL-LOCAL-DEV-DB-SETUP-003 指令)  
**Production DB 写入**: **ZERO** — 全程未执行任何生产写入

---

## 1. 为什么拒绝直接操作 Production

**原因**：
上轮 TASK-HALL-LOCAL-CLEANUP-002 在环境确认阶段（Step 1）发现：
- MCP `mcp__sanlyn-pg__query` 连接的是生产 DB（`sanlyn_db` @ 腾讯云服务器）
- MCP 用户 `sanlyn_readonly` 物理上无法执行 UPDATE
- `.env.local` 中的 `sanlyn_admin` 用户可连接同一生产 DB
- Damon 的授权范围明确是"local/dev 环境"

因此，必须先建立独立 local/dev DB，在隔离环境验证后，再生成生产清理审批稿。

**安全决策**：宁可多一步，不在生产直接验证逻辑。

---

## 2. 本地 Dev DB 信息

| 项目 | 值 |
|------|-----|
| 数据库名称 | `sanlyn_taskhall_dev_20260511` |
| 主机 | `127.0.0.1:5432` (本机 Homebrew PostgreSQL 18.3) |
| 创建用户 | `mac` (本机 superuser) |
| 生产 DB 主机 | `127.0.0.1:5432` @ 服务器 111.229.242.13（独立实例） |
| 数据来源 | SSH + pg_dump → SCP 到本机 → 清理后导入 |
| Git 提交 | 不含 dump 文件（dump 在 Desktop 非 repo 目录） |

---

## 3. 导出的表

| 表 | 导出方式 | 行数 | 说明 |
|----|---------|------|------|
| `tasks` | pg_dump --table=tasks --no-acl --no-owner | 103 | 唯一需要的表，清理测试只需此表 |

**其他表不导出原因**：
- `collaboration_threads/messages`：只读参考，不影响 task status 变更
- `orders/shipping_plans`：cleanup 不回写这些表，无需导出
- 最小化原则：减少敏感数据暴露面

---

## 4. 敏感字段审查

| 检查项 | 结果 |
|--------|------|
| 银行账号/路由号 | ✅ 无 |
| 税号/身份证 | ✅ 无 |
| 付款流水 | ✅ 无 |
| 密码/密钥 | ✅ 无 |
| 客户联系方式/地址 | ✅ 无（tasks 表只含业务 code，不含 PII） |
| dump 文件路径 | `/Users/mac/Desktop/临时OS--- S1/taskhall-dev-dump/` — 非 git repo |
| dump 文件提交 git | ✅ 否（Desktop 路径不在 repo 内） |
| 服务器临时文件 | ✅ 已删除（`rm /tmp/taskhall_dump_20260511.sql`） |

**特殊处理**：dump 原文件含 `\restrict`/`\unrestrict` 行（服务器安全标签），导入前已用 grep 过滤，导入本地无安全限制版本。

---

## 5. 导入前后 Count

| 指标 | 期望值 | 实际值 | 结果 |
|------|--------|--------|------|
| total_tasks | 103 | 103 | ✅ |
| open | 98 | 98 | ✅ |
| done | 5 | 5 | ✅ |
| payment_term_confirm (open) | 95 | 95 | ✅ |
| 真实运营任务 (open) | 3 | 3 | ✅ |
| 38-XM-251 交期确认 | open | open | ✅ |
| 38-XM-246 备货照片 | open | open | ✅ |
| 37-XM-243 司机信息 | open | open | ✅ |

---

## 6. 清理执行详情

### 6.1 SELECT dry-run
```sql
SELECT COUNT(*) FROM tasks
WHERE status='open' AND task_type='payment_term_confirm' AND id LIKE 't-pt-%';
-- 结果: 95 ✅
```

### 6.2 ROLLBACK 预演
```
BEGIN;
UPDATE 95 rows;  -- ✅
open_after_update = 3    -- ✅ (98-95=3)
done_after_update = 100  -- ✅ (5+95=100)
real_ops_still_open = 3  -- ✅ 3条真实任务未动
noise_pt_closed = 95     -- ✅
close_reason = historical_batch_noise_2026_04_28 / test_task_cleanup_2026_05_07
closed_by = local_cleanup_damon_authorized
ROLLBACK;
-- open 恢复 98 ✅
```

### 6.3 COMMIT（本地 dev DB）
```
BEGIN;
UPDATE 95 rows;  -- ✅
open_final = 3;  done_final = 100;  noise_closed = 95;
COMMIT;  -- ✅
```

### 6.4 COMMIT 后最终状态

```sql
SELECT status, COUNT(*) FROM tasks GROUP BY status;
-- done | 100
-- open |   3
```

---

## 7. 关闭的 95 条任务分类

| 批次 | 数量 | close_reason | 特征 |
|------|------|-------------|------|
| 批次A (历史 seed) | 86 | `historical_batch_noise_2026_04_28` | created_at CST ≤ 2026-04-30，id=t-pt- |
| 批次B (测试任务) | 9 | `test_task_cleanup_2026_05_07` | created_at CST = 2026-05-07，含TEST/SMOKE |
| **合计** | **95** | | |

> 注：批次A/B的实际数量因时区换算（UTC→CST）与初步分析略有出入（86+9 vs 89+6），总数95条一致。

---

## 8. 保留的 3 条真实运营任务

| task_id | 标题 | 风险 | 状态 | 建议行动 |
|---------|------|------|------|---------|
| t-mobecqy0-ah24 | 请确认 38-XM-251 预计交货日期 | 🔴 HIGH | open | 联系工厂 td，获取 ready_date |
| t-mobecqyg-01qq | 请上传 38-XM-246 生产备货照片 | 🟡 MID | open | 要求工厂上传备货照片 |
| t-mobecqyv-o59k | 请提供 37-XM-243 提货司机信息 | 🟡 MID | open | 确认订单是否已出货，补司机信息 |

---

## 9. 关键安全确认

| 项目 | 结果 |
|------|------|
| Production DB 是否被写入 | **NO** — 全程零生产写入 |
| 是否改 schema | **NO** |
| 是否删除任务记录 | **NO** — status 改为 'done'，记录保留 |
| 是否关闭3条真实运营任务 | **NO** — 三条全部保持 open |
| 是否触碰财务/报关/退税/付款 | **NO** |
| dump 文件是否提交 git | **NO** |
| 服务器临时文件是否清理 | **YES** — `/tmp/taskhall_dump_20260511.sql` 已删除 |

---

## 10. 下一步建议

### 立即（今日）：
1. **处理3条真实运营任务**（见上方表格）
2. **审阅生产清理审批稿**（TASK-HALL-PROD-CLEANUP-APPROVAL-DRAFT-004.md）
3. 确认是否批准生产执行

### 本周内：
4. 执行生产清理（需 Damon 二次确认，见审批稿）
5. UI 最小改造（约1.5小时）：顶部摘要横幅 + payment_term_confirm 折叠 + 高风险置顶

### 下周：
6. payment_term_confirm action 实现（防止下一批无法关闭）
7. 每日任务大厅摘要 + 微信推送

---

*本轮验证结论：清理逻辑正确，在隔离的本地 dev DB 中 Open 从 98 → 3 成功，生产 DB 零写入。可进入生产审批环节。*
