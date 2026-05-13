# TASK-HALL-PROD-CLEANUP-APPROVAL-DRAFT-004
## Sanlyn OS · 任务大厅生产清理审批稿

**起草日期**: 2026-05-11  
**状态**: DRAFT — 等待 Damon 二次授权后执行  
**依据**: TASK-HALL-LOCAL-DEV-DB-SETUP-003 本地验证通过  
**执行方式**: SSH 到服务器 → psql 本地连接 127.0.0.1 → 事务内执行

---

## ⚠️ 执行前必读

本 SQL **直接操作生产数据库**。与本地 dev 验证不同，此操作不可轻易撤销（无自动备份恢复，需手动 UPDATE 回 'open'）。

**执行前必须确认**：
- [ ] 生产 tasks 表 Open count = 98（与预期一致）
- [ ] 3条真实运营任务未被人工提前关闭
- [ ] 当前无其他 session 正在写入 tasks 表
- [ ] Damon 已在此文档下方签字确认

---

## 1. 生产关闭前置条件

| 条件 | 检查 SQL | 期望值 |
|------|---------|--------|
| Open 总数 | `SELECT COUNT(*) FROM tasks WHERE status='open'` | 98 |
| 噪音待关闭 | `SELECT COUNT(*) FROM tasks WHERE status='open' AND task_type='payment_term_confirm' AND id LIKE 't-pt-%'` | 95 |
| 真实运营 open | `SELECT COUNT(*) FROM tasks WHERE status='open' AND task_type!='payment_term_confirm'` | 3 |

---

## 2. 执行入口

```bash
# SSH 到生产服务器
ssh -i ~/.ssh/github_actions_sanlyn root@111.229.242.13

# 连接本地 postgres
psql -U sanlyn_admin -h 127.0.0.1 -d sanlyn_db
# 输入密码（不在本文档记录）
```

---

## 3. 执行前 Count 验证 SQL

```sql
-- Step P-1: 执行前快照
SELECT 
  '执行前_open总数'     AS metric, COUNT(*)::text AS val FROM tasks WHERE status='open'
UNION ALL
SELECT '执行前_done总数',            COUNT(*)::text FROM tasks WHERE status='done'
UNION ALL
SELECT '执行前_噪音待关闭',          COUNT(*)::text FROM tasks WHERE status='open' AND task_type='payment_term_confirm' AND id LIKE 't-pt-%'
UNION ALL
SELECT '执行前_真实运营open',        COUNT(*)::text FROM tasks WHERE status='open' AND task_type!='payment_term_confirm';
```

**期望输出**：
```
metric              | val
--------------------|----
执行前_open总数      | 98
执行前_done总数      | 5
执行前_噪音待关闭    | 95
执行前_真实运营open  | 3
```

**⚠️ 如果任何值与期望不符，立即 STOP，不执行下一步。**

---

## 4. 生产 UPDATE SQL（事务内）

```sql
-- Step P-2: 开始事务
BEGIN;

-- 关闭95条噪音任务
UPDATE tasks
SET 
  status = 'done',
  closed_at = NOW(),
  updated_at = NOW(),
  raw = raw || jsonb_build_object(
    'close_reason', 
    CASE 
      WHEN (created_at AT TIME ZONE 'Asia/Shanghai')::date <= '2026-04-30' 
        THEN 'historical_batch_noise_2026_04_28'
      ELSE 'test_task_cleanup_2026_05_07'
    END,
    'closed_by', 'prod_cleanup_damon_authorized',
    'authorized_by', 'damon_sl',
    'cleanup_batch', 'TASK-HALL-PROD-CLEANUP-004',
    'cleanup_date', '2026-05-11',
    'local_dev_verified', true
  )
WHERE status = 'open'
  AND task_type = 'payment_term_confirm'
  AND id LIKE 't-pt-%';

-- ⚠️ 检查影响行数，必须为95
-- 如果输出不是 "UPDATE 95"，立即 ROLLBACK；

-- Step P-3: 执行后立即验证（COMMIT 前）
SELECT 
  '执行后_open总数'     AS metric, COUNT(*)::text AS val FROM tasks WHERE status='open'
UNION ALL
SELECT '执行后_done总数',            COUNT(*)::text FROM tasks WHERE status='done'
UNION ALL
SELECT '执行后_真实运营still_open',  COUNT(*)::text FROM tasks WHERE status='open' AND task_type!='payment_term_confirm'
UNION ALL
SELECT '执行后_噪音已关闭',          COUNT(*)::text FROM tasks WHERE status='done' AND id LIKE 't-pt-%';

-- 只有当以上输出完全正确时才 COMMIT
-- 期望：open=3 / done=100 / still_open=3 / 噪音已关闭=95

-- Step P-4: 如果正确，COMMIT
COMMIT;

-- Step P-5: COMMIT 后最终确认
SELECT status, COUNT(*) FROM tasks GROUP BY status ORDER BY status;
-- 期望：done=100 / open=3
```

---

## 5. ROLLBACK SQL（如需撤销）

```sql
-- 如果发现误操作，在 COMMIT 前用此回滚：
ROLLBACK;

-- 如果已经 COMMIT，用以下 UPDATE 恢复（需要 Damon 再次授权）：
-- 注意：此操作会把已关闭的噪音任务重新打开，仅用于紧急恢复
BEGIN;
UPDATE tasks
SET 
  status = 'open',
  closed_at = NULL,
  updated_at = NOW(),
  raw = raw - 'close_reason' - 'closed_by' - 'authorized_by' - 'cleanup_batch'
WHERE status = 'done'
  AND task_type = 'payment_term_confirm'
  AND id LIKE 't-pt-%'
  AND raw->>'cleanup_batch' = 'TASK-HALL-PROD-CLEANUP-004';
-- 期望: UPDATE 95
COMMIT;
```

---

## 6. 执行后 Count（期望）

| 指标 | 执行前 | 执行后 |
|------|--------|--------|
| open | 98 | **3** |
| done | 5 | **100** |
| real_ops open | 3 | 3（不变） |
| payment_term_confirm closed | 0 | 95 |

---

## 7. 风险等级

| 风险项 | 等级 | 缓解措施 |
|--------|------|---------|
| 误关闭真实任务 | 🔴 HIGH | WHERE 条件排除非 t-pt- 和非 payment_term_confirm |
| 更新影响行数不对 | 🔴 HIGH | COMMIT 前强制 count 校验，不对则 ROLLBACK |
| 事务中途连接断开 | 🟡 MID | 未提交事务自动 ROLLBACK，无影响 |
| 已提交后发现误操作 | 🟡 MID | ROLLBACK SQL 准备好（见第5节） |
| 影响其他业务模块 | 🟢 LOW | tasks 表独立，status='done' 只影响任务大厅展示 |

---

## 8. Damon 二次授权

**请在以下选项中选择一个，在聊天中明确回复：**

**选项A（直接生产执行）**：
> "生产清理审批通过，按 TASK-HALL-PROD-CLEANUP-APPROVAL-DRAFT-004 执行，确认。"

**选项B（延期生产，先改 UI）**：
> "先做 UI 最小改造，生产清理暂缓，等 UI 上线后再执行。"

**选项C（放弃生产清理）**：
> "不需要生产清理，任务大厅改 UI 折叠噪音任务即可。"

---

## 9. 执行时间建议

- **非业务高峰期执行**（建议：凌晨 0:00-6:00 或工作日上午前）
- 整个操作预计耗时 < 2 分钟
- 无需停机，无需维护模式

---

*本审批稿基于 TASK-HALL-LOCAL-DEV-DB-SETUP-003 本地验证结果起草。*  
*本地验证状态：TASK_HALL_LOCAL_DEV_DB_SETUP_PASS*  
*Production DB 写入：ZERO（截至本文档生成时）*
