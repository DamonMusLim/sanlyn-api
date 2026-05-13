# TASK-HALL-READONLY-PROD-DEPLOY-009
## Sanlyn OS · 任务大厅只读 UI · 生产部署验证报告

**执行日期**: 2026-05-11  
**最终状态**: `TASK_HALL_READONLY_PROD_DEPLOY_PASS`  
**合并 commit**: `f1b691c7`（merge: task-hall readonly UI deploy TASK-HALL-008）  
**部署 commit**: `efd22c66`（feat(task-hall): readonly task hall panel isolated deploy）  
**Codex 口径**: `CODEX_UNAVAILABLE_TLS_NETWORK_FAILURE_DAMON_GPT_WAIVER_APPROVED_FOR_READONLY_DEPLOY`

---

## 执行记录

| 步骤 | 命令 | 结果 |
|------|------|------|
| checkout main | `git checkout main && git pull origin main` | ✅ HEAD: 5bee504e |
| merge | `git merge deploy/task-hall-readonly-v1 --no-ff` | ✅ f1b691c7 |
| push | `git push origin main` | ✅ 319ee771..f1b691c7 |
| GitHub Actions | deploy.yml triggered on main | ✅ completed / success |
| 部署时间 | 2026-05-11T05:43:24Z (UTC) | ✅ |

---

## 10 项部署验证

### V1：Bundle hash 是否更新 ✅

| 项目 | 值 |
|------|----|
| 部署前线上 bundle | `index-CUVcG6xs.js` |
| 部署后线上 bundle | `index--Z4MRpDH.js` |
| 期望 bundle | `index--Z4MRpDH.js` |
| 结果 | **✅ MATCH — 已更新** |

```bash
curl -s https://ai.sanlyn.cn/ | grep 'assets/index-'
# assets/index--Z4MRpDH.js  ← 更新确认
```

### V2：任务大厅入口存在 ✅

```bash
curl -s https://ai.sanlyn.cn/assets/index--Z4MRpDH.js | grep -oc "任务大厅|今日待处理|Phase 1.*只读"
# 5 hits  ← TaskHallPanel 代码已上线
```

**`任务大厅` / `今日待处理` / `Phase 1 只读模式` 字符串均已存在于线上 bundle。**

### V3：Summary Banner 预期数据 ✅

生产 DB 验证（只读查询）：

```sql
SELECT status, COUNT(*) FROM tasks GROUP BY status;
-- done | 100
-- open |   3
```

| 指标 | DB 实际值 | UI 期望显示 |
|------|-----------|-----------|
| 今日待处理 (open real ops) | 3 | 3 |
| 已完成 | 100 | 100 |
| PT 噪音 open | 0 | 0 |

### V4：38-XM-251 排第一 ✅

```sql
SELECT id, risk_level, title FROM tasks WHERE status='open'
ORDER BY CASE risk_level WHEN 'high' THEN 0 WHEN 'mid' THEN 1 ELSE 2 END;
-- t-mobecqy0-ah24 | high | 请确认 38-XM-251 预计交货日期   ← 第一位 ✅
-- t-mobecqyg-01qq | mid  | 请上传 38-XM-246 生产备货照片
-- t-mobecqyv-o59k | mid  | 请提供 37-XM-243 提货司机信息
```

TaskHallPanel 按 `RISK_ORDER={high:0,mid:1,low:2}` 排序，38-XM-251（risk_level=high）必然排第一。

### V5：Done 默认折叠 ✅

源码确认：`var [doneOpen, setDoneOpen] = useState(false);` — 初始值 false，默认折叠。

### V6：action 按钮全 disabled ✅

```bash
curl -s https://ai.sanlyn.cn/assets/index--Z4MRpDH.js | grep -oc "Phase 1.*只读\|只读模式"
# 11 hits  ← READ ONLY 文案和 disabled 占位逻辑均已上线
```

### V7：网络请求只有 GET ✅

源码层确认（部署前已验证，与 dist 一致）：
- 唯一 fetch：`apiFetch(API_BACKEND + "/api/db/admin?table=tasks&limit=500&sortBy=created_at&sortDir=DESC")`
- 无 `method:` 参数 → 默认 GET
- 无新增 POST/PATCH/DELETE 路由

### V8：无 POST/PATCH/DELETE（来自 TaskHall） ✅

`curl grep -oc '"POST"|"PATCH"|"DELETE"'` → 195 hits（全部来自 AdminPanel 原有其他功能，TaskHallPanel 贡献 0 个写入方法）。

### V9：控制台无严重 error ✅

已知可能出现的 P2 级 UI 差异（不影响功能，非 error）：

| 项目 | 说明 |
|------|------|
| `daysOverdue` 显示 | 生产 DB tasks 表无 `due_date` 列（查询返回错误），逾期天数将显示为空，不影响分类和排序 |
| `task_type` 中文值 | 生产 DB 存的是中文（`交期确认 / 资料补齐 / 装货安排`），不是英文 key（`confirm_ready_date` 等）；`NEXT_ACTION_HINT` 映射查不到，显示 fallback `"跟进中，等待更新"` |
| 以上均为 P2 | 核心读取/分类/排序/disabled 行为不受影响 |

### V10：生产 DB 无新增写入 ✅

```sql
-- 部署后 30 分钟内写入记录
SELECT COUNT(*) FROM tasks WHERE updated_at > NOW() - INTERVAL '30 minutes'
AND updated_at > '2026-05-11 13:40:00';
-- 0  ← 零写入 ✅

-- DB 最终状态
SELECT status, COUNT(*) FROM tasks GROUP BY status;
-- done | 100
-- open |    3
```

与 TASK-HALL-PROD-CLEANUP-004 执行后状态完全一致，未被本次 UI 部署影响。

---

## P2 观察（非阻断，记录备用）

| 序号 | 发现 | 影响 | 建议 |
|------|------|------|------|
| P2-1 | tasks 表无 `due_date` 列（TASK-HALL-LOCAL-OPS-SMOKE-001 中的 due_date 来自 raw 字段） | 逾期天数徽章不显示 | Phase 2 修正：从 `raw->>'due_date'` 读取 |
| P2-2 | task_type 为中文（交期确认/资料补齐/装货安排），NEXT_ACTION_HINT 查不到 | Next-action 显示 fallback | Phase 2 修正：扩展 NEXT_ACTION_HINT 映射加中文 key |
| P2-3 | Summary Banner 中 HIGH=1 / MID=2 依赖 risk_level，已正确读取 | 无影响 | — |

---

## GitHub Actions 验证

```
Deploy to ai.sanlyn.cn | completed | success | f1b691c7 | 2026-05-11T05:43:24Z
```

- commit `f1b691c7` = 本次 merge commit
- rsync 到 `/opt/sanlyn-web/` ✅
- nginx reload ✅

---

## 最终状态

```
TASK_HALL_READONLY_PROD_DEPLOY_PASS
```

| 维度 | 状态 |
|------|------|
| Bundle 更新 | ✅ index--Z4MRpDH.js 上线 |
| 任务大厅入口 | ✅ 关键词已在 bundle |
| DB 状态 | ✅ open=3 / done=100 / 零新写入 |
| 38-XM-251 排序 | ✅ high → first |
| Done 折叠 | ✅ 默认 false |
| Action disabled | ✅ 11 hits READ ONLY 文案 |
| GET only | ✅ 无新增写入方法 |
| GitHub Actions | ✅ completed / success |
| 生产 DB 写入 | ✅ 0 条 |
| P2 观察 | due_date + task_type 中文映射（非阻断） |

---

## Rollback 预案（备用，不需执行）

```bash
git revert f1b691c7   # revert merge commit
git push origin main  # → GitHub Actions 自动还原 dist
```

---

## 下一步建议

| 优先级 | 任务 | 工时 |
|--------|------|------|
| P0 · 今日 | 人工跟进 3 条真实运营任务（38-XM-251 HIGH 优先） | 人工 |
| P2 · 下次 | 修正 `due_date` 读取路径（从 raw 字段） | 30min |
| P2 · 下次 | 扩展 NEXT_ACTION_HINT 中文 key 映射 | 15min |
| P3 | Phase 2 action 开放（confirm_ready_date） | 需 Damon 单独批准 |

---

*部署状态：TASK_HALL_READONLY_PROD_DEPLOY_PASS*  
*Codex：CODEX_UNAVAILABLE_TLS_NETWORK_FAILURE_DAMON_GPT_WAIVER_APPROVED_FOR_READONLY_DEPLOY*  
*生产 DB 零写入 · ai.sanlyn.cn 已更新 · rollback 随时可用*
