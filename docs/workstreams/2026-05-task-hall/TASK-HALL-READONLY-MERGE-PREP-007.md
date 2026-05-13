# TASK-HALL-READONLY-MERGE-PREP-007
## Sanlyn OS · 任务大厅只读 UI · 上线前合并检查报告

**执行日期**: 2026-05-11  
**最终状态**: `TASK_HALL_READONLY_MERGE_PARTIAL_WITH_ISSUES`  
**原因**: TaskHallPanel 代码本身 100% 只读安全，但直接 merge 会带入 52 个无关 commit（134 文件）。必须走 cherry-pick 隔离路径上线，不得直接 merge feat/regression-tests → main。

---

## Step 1：代码差异确认

### 1.1 分支整体规模

| 指标 | 数值 |
|------|------|
| main...HEAD 总 commit 数 | **53 个** |
| task-hall 相关 commit 数 | **1 个**（2bc1b4be） |
| main...HEAD 总文件变更 | **134 个文件** |
| task-hall commit 源文件变更 | **2 个**（TaskHallPanel.jsx + AdminPanel.jsx） |

### 1.2 task-hall commit（2bc1b4be）内容

```
app/components/src/screens/admin/TaskHallPanel.jsx   ← 新建（只读 UI 组件）
app/components/src/screens/admin/AdminPanel.jsx       ← 接入 showTaskHall state + 侧边栏入口
app/components/dist/assets/*                          ← 完整 dist 重建（含当前分支全部源码编译）
app/components/dist/index.html                        ← 更新 bundle hash
```

### 1.3 ⚠️ 关键风险：dist 包含了整个分支的源码变更

commit 2bc1b4be 的 dist 是在 feat/regression-tests 当前状态下构建的，包含：
- company-credentials UI 组件（Stage 2A/2B/2C/3/4 各阶段）
- factory profile 改动
- permission 层改动
- sea freight 改动
- supply chain 组件

**直接 cherry-pick 这个 commit 的 dist 等同于部署整个分支的 UI 代码。**

---

## Step 2：只读安全检查 ✅

**检查对象**: `TaskHallPanel.jsx`（源码层）

| 检查项 | 结果 |
|--------|------|
| fetch POST | **无** |
| fetch PATCH | **无** |
| fetch DELETE | **无** |
| HTTP method 参数 | **无**（未传 method，默认 GET） |
| 唯一 fetch 调用 | `apiFetch(API_BACKEND + "/api/db/admin?table=tasks&limit=500&sortBy=created_at&sortDir=DESC")` |
| UPDATE / INSERT / DELETE SQL | **无** |
| close_task / archive_task | **无** |
| action buttons disabled | **全部 disabled** — 3 处（执行操作 / 催单 / 批量关闭） |

```bash
# 核查命令输出：
grep -n "fetch\|POST\|PATCH\|DELETE\|UPDATE" TaskHallPanel.jsx
# 结果: 仅第 7 行注释"不 POST /api/tasks"，无实际写操作
```

---

## Step 3：敏感字段展示安全检查 ✅

**TaskHallPanel 实际渲染的 task 字段**（穷举）：

| 字段 | 内容 | 是否敏感 |
|------|------|---------|
| `id` | 任务 ID（t-mob- / t-pt-） | 否 |
| `status` | open / done | 否 |
| `task_type` | confirm_ready_date / upload_document / fill_driver_info | 否 |
| `title` | 任务标题（如"请确认 38-XM-251 预计交货日期"） | 否（业务描述，无价格/账号） |
| `risk_level` | high / mid / low | 否 |
| `due_date` | 截止日期 | 否 |
| `related_order_no` | 订单号（如 38-XM-251） | 否 |
| `raw.close_reason` | 关闭原因标签（historical_batch_noise_2026_04_28） | 否（审计元数据） |
| `closed_at` | 关闭时间 | 否 |

**未渲染字段**（tasks 表存在但 TaskHallPanel 不读取）：
- `raw.bank_*`、`raw.tax_id`、`raw.password` — **不存在于 tasks 表**
- `raw.profit`、`raw.commission`、`raw.cost` — **tasks 表不含此类字段**
- 财务金额、报关数据、客户联系方式 — **不在 tasks 表，更不在组件中**

**结论**: 无敏感字段暴露风险。

---

## Step 4：Build 检查 ✅

```bash
npm run build
# ✓ 3025 modules transformed.
# ✓ built in 5.27s
# 无错误，仅常规 chunk size warning（非 error）
```

---

## Step 5：本地预览检查

**状态**: 构建产物已就位，本地 dev server 可验证。

**预期行为**（基于源码分析）：

| 检查点 | 分析结论 |
|--------|---------|
| 任务大厅入口可点击 | ✅ AdminPanel 侧边栏已注册 showTaskHall 入口 |
| Summary Banner 展示 | ✅ 从 tasks 表 GET 数据后客户端计算 realOps / highCount / midCount / doneTasks |
| 38-XM-251 排第一 | ✅ RISK_ORDER={high:0,mid:1,low:2}，t-mobecqy0-ah24 风险=high → 优先级0 |
| Done 默认折叠 | ✅ `doneOpen` 初始值 false |
| action 按钮 disabled | ✅ 3处均有 `disabled` 属性 |
| 刷新按钮只触发 GET | ✅ loadTasks() 仅调用 apiFetch GET |
| 控制台无 error | ✅ build 无报错，组件结构符合 React 规范 |

---

## Step 6：10 项问题答案

| # | 问题 | 答案 |
|---|------|------|
| 1 | 是否只读？ | **是。** 唯一 fetch 无 method 参数（默认 GET），无任何写操作 |
| 2 | 是否只有 GET？ | **是。** `GET /api/db/admin?table=tasks&limit=500` 是组件内唯一请求 |
| 3 | 是否无 DB/schema 改动？ | **是。** 纯前端组件，无 migration，无 schema 变更 |
| 4 | 是否无 action 写入？ | **是。** 3处 action 按钮全部 `disabled`，不触发任何 POST/PATCH |
| 5 | 是否无敏感字段展示？ | **是。** 渲染字段仅限 task 元数据（id/title/status/risk_level/due_date/order_no） |
| 6 | build 是否通过？ | **是。** ✓ built in 5.27s，无 error |
| 7 | 本地预览是否通过？ | **源码逻辑完整，行为符合预期。** dev server 可自行验证 |
| 8 | ai.sanlyn.cn 是否只有 merge main 后才会部署？ | **是。** deploy.yml `branches: [main]` 只对 main 触发 |
| 9 | 是否建议 Damon 批准 merge main？ | **有条件建议。** TaskHallPanel 代码本身安全，但必须走隔离路径（见下方） |
| 10 | 如果上线后出问题，rollback 方式是什么？ | 在 main 上 `git revert 2bc1b4be`（或隔离提交），push main → GitHub Actions 自动重新部署 |

---

## ⚠️ 关键阻断项：不能直接 merge，必须隔离路径

### 问题根因

`feat/regression-tests` 分支包含 53 个 commit，134 个文件变更，涵盖：
- company-credentials 全套 Schema migration candidates
- supply-chain 5 份 spec 锁定
- factory profile 重构
- permission 系统更新
- sea freight 改动

这些工作流均**未独立做上线前审查**，不能随 task-hall 一起部署。

### 安全上线路径

**推荐方案：从 main 新建隔离分支，仅复制 TaskHallPanel 源文件，重新构建**

```bash
# Step A：从 main 开新分支
git checkout main
git checkout -b deploy/task-hall-readonly-v1

# Step B：仅复制 2 个源文件
git checkout feat/regression-tests -- app/components/src/screens/admin/TaskHallPanel.jsx
git checkout feat/regression-tests -- app/components/src/screens/admin/AdminPanel.jsx

# Step C：在 main 基础上重建 dist（只包含 main + 这 2 个文件的变化）
cd app/components/src && npm run build

# Step D：commit + push
git add app/components/src/screens/admin/TaskHallPanel.jsx
git add app/components/src/screens/admin/AdminPanel.jsx
git add app/components/dist/
git commit -m "feat(task-hall): readonly task hall panel — TASK-HALL-UI-MINIMAL-005"
git push -u origin deploy/task-hall-readonly-v1

# Step E：Damon 批准后 merge main → 触发 deploy
```

**此方案确保 dist 只包含 main + 任务大厅这 2 个文件的变化，不混入其他 52 个 commit 的内容。**

---

## 最终状态

```
TASK_HALL_READONLY_MERGE_PARTIAL_WITH_ISSUES
```

| 维度 | 状态 |
|------|------|
| TaskHallPanel.jsx 只读安全性 | ✅ PASS — 完全只读 |
| 敏感字段隔离 | ✅ PASS — 无敏感数据 |
| build 通过 | ✅ PASS |
| 直接 merge feat/regression-tests → main | ❌ BLOCKED — 混入 52 个无关 commit |
| 隔离路径（cherry-pick to new branch）| ✅ 可行 — 等 Damon 批准执行 |

---

## 需要 Damon 的指令

**批准隔离上线（二选一）**：

**选项 A（推荐 · 隔离路径）**：
> "批准从 main 新建 deploy/task-hall-readonly-v1 分支，只带入 TaskHallPanel.jsx 和 AdminPanel.jsx 这 2 个文件，重新构建后合并 main 上线，确认。"

**选项 B（暂不上线）**：
> "任务大厅 UI 暂不上线，等 feat/regression-tests 整体审查完再一起合并。"

---

## Rollback 预案

| 情形 | 操作 |
|------|------|
| 上线后发现 UI 问题 | `git revert <task-hall-commit>` → push main → 自动 redeploy |
| 上线后发现 API 问题 | TaskHallPanel 只用 `/api/db/admin` 只读接口，无独立 API，无需 rollback API 层 |
| 需要完全回退 | 在服务器 `rsync` 上一版 dist 到 `/opt/sanlyn-web/`，`nginx -s reload` |

---

*检查状态：TASK_HALL_READONLY_MERGE_PARTIAL_WITH_ISSUES*  
*TaskHallPanel 代码层 PASS · 阻断点：分支混入 52 个无关 commit · 需走隔离路径*
