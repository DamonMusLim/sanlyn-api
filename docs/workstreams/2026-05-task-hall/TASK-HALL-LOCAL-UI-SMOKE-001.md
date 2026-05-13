# TASK-HALL-LOCAL-UI-SMOKE-001
## Sanlyn OS · 任务大厅 UI Smoke 分析 & 最小改造方案

**日期**: 2026-05-11  
**方式**: 代码审阅（不部署，不改 prod）  
**严禁事项确认**: 不 deploy，不 push main，不改 DB schema

---

## 1. 当前 UI 状态评估

### 1.1 功能评估

根据 API 层审阅（tasks.js + tasks-create.js + factory-portal-tasks.js），当前任务大厅具备：

| 功能 | 状态 | 说明 |
|------|------|------|
| 任务列表展示 | ✅ 有 | API 可读，前端有任务大厅入口 |
| 任务详情抽屉 | ✅ 有 | GET /api/tasks?id= 实现 |
| Action 执行 | ✅ 有 | confirm_ready_date/fill_driver_info 等均已实现 |
| 风险标签展示 | ✅ 可展示 | risk_level 字段已有 high/mid/low |
| 批量操作 | ❌ 无 | 无批量关闭/归档接口 |
| 分组展示 | ❌ 无 | 当前全量平铺 |
| 优先级排序 | ❌ 无 | 按 created_at 排序 |
| payment_term_confirm action | ❌ 无 | 该 task_type 无对应 action 实现 |
| 每日摘要/提醒 | ❌ 无 | 无定时任务，无 push 通知 |

### 1.2 关键 UX 问题

**问题1：98条平铺**
- Damon 打开任务大厅看到 98 条，完全无法判断今天做什么
- 高风险任务 `t-mobecqy0-ah24` 淹没在 95 条 payment_term_confirm 中

**问题2：payment_term_confirm 无法关闭**
- 这 95 条任务在 UI 上显示为 open，但执行任何 action 都不会关闭它们
- 用户体验：点进去什么都不能做

**问题3：无噪音折叠**
- 批量噪音和真实任务视觉上没有区别
- 没有任何提示哪些是"建议处置"哪些是"批量等待"

---

## 2. 最小改造方案（本地预览，不 deploy）

### 2.1 改造目标

不大改，只做4件事：
1. **顶部摘要横幅** — 显示真实任务数 vs 噪音候选数
2. **payment_term_confirm 默认折叠** — 一行显示"95条历史批量任务（折叠）"
3. **高风险任务置顶** — risk_level=high 强制排第一
4. **批量噪音候选标签** — 给 t-pt- 前缀任务加 `NOISE_CANDIDATE` 标签

### 2.2 前端改造清单（极简）

#### A. 新增 API 接口（本地 branch）

**GET /api/tasks/summary**（新增）
```javascript
// 返回格式：
{
  real_operation: {
    count: 3,
    high: 1,
    mid: 2,
    tasks: [...]  // 完整 task 对象
  },
  noise_candidate: {
    count: 95,
    batch_a: 89,
    batch_b: 6
  },
  done: { count: 5 },
  awaiting_decision: {
    count: 1,
    description: "批量 payment_term_confirm 归档需 Damon 确认"
  }
}
```

**识别规则（纯 JS，不改 DB）**：
```javascript
function classifyTask(task) {
  // 批次B（测试任务）
  if (task.id.startsWith('t-pt-') && 
      /ORD-\d{8}-\d{4}/.test(task.related_order_no)) {
    return 'NOISE_TEST';
  }
  // 批次A（历史 seed）
  if (task.id.startsWith('t-pt-') && 
      task.task_type === 'payment_term_confirm') {
    return 'NOISE_CANDIDATE';
  }
  // 真实运营
  return 'REAL_OPERATION';
}
```

#### B. 前端任务列表改造

**排序规则（前端排序，不改 DB）**：
```javascript
const PRIORITY = {
  REAL_OPERATION: { high: 0, mid: 1, low: 2 },
  NOISE_CANDIDATE: 10,
  NOISE_TEST: 11
};

tasks.sort((a, b) => {
  const aClass = classifyTask(a);
  const bClass = classifyTask(b);
  if (aClass === 'REAL_OPERATION' && bClass !== 'REAL_OPERATION') return -1;
  if (bClass === 'REAL_OPERATION' && aClass !== 'REAL_OPERATION') return 1;
  if (aClass === 'REAL_OPERATION' && bClass === 'REAL_OPERATION') {
    return PRIORITY[aClass][a.risk_level] - PRIORITY[bClass][b.risk_level];
  }
  return 0;
});
```

#### C. UI 组件改动（极小）

**1. TaskHall 顶部摘要横幅（新增，约30行）**：
```jsx
<SummaryBanner>
  <SummaryItem icon="⚡" label="今日必须处理" count={realOps.length} 
               highlight={realOps.length > 0} />
  <SummaryItem icon="📦" label="历史噪音候选" count={noiseCount} 
               muted={true} />
  <SummaryItem icon="✅" label="已完成" count={doneCount} />
</SummaryBanner>
```

**2. payment_term_confirm 折叠 Group（改约15行）**：
```jsx
{noiseTasks.length > 0 && (
  <CollapsedGroup 
    label={`📦 历史批量噪音候选 (${noiseTasks.length}条)`}
    defaultCollapsed={true}
    description="2026-04-28 批量创建 · 等待 Damon 批准归档"
    badge="NOISE_CANDIDATE"
  />
)}
```

**3. 高风险任务置顶标签（改约5行）**：
```jsx
{task.risk_level === 'high' && (
  <Badge color="red">🔴 HIGH</Badge>
)}
{isNoise && (
  <Badge color="gray" muted>NOISE_CANDIDATE</Badge>
)}
```

**4. 批量关闭按钮（disabled，等待 Damon 授权）**：
```jsx
<Button 
  disabled={!damonApproved} 
  onClick={handleBulkArchive}
  tooltip="需要 Damon 在聊天中明确批准后才可执行"
>
  批量归档 ({noiseCount}条)
</Button>
```

---

## 3. 改造优先级

| 改造项 | 工作量 | 优先级 | 说明 |
|--------|--------|--------|------|
| GET /api/tasks/summary 接口 | 30分钟 | P1 | 数据层基础，其他都依赖它 |
| 顶部摘要横幅 | 20分钟 | P1 | 打开任务大厅第一眼看到的 |
| payment_term_confirm 折叠 | 15分钟 | P1 | 消除视觉噪音 |
| 高风险置顶 + 标签 | 15分钟 | P1 | 确保真实任务不被淹没 |
| 批量归档按钮（disabled） | 20分钟 | P2 | 流程完整性 |
| 每日提醒 API | 40分钟 | P2 | 自动化提醒 |
| payment_term_confirm action 实现 | 60分钟 | P2 | 让未来的 pt 任务可正常关闭 |

**合计 P1 改造：约80分钟（1.5小时内可完成本地预览）**

---

## 4. 本地 Smoke 验证步骤

```bash
# Step 1: 启动本地 dev server
cd ~/Desktop/sanlyn-api-dev
npm run dev

# Step 2: 验证 /api/tasks 可读取
curl -H "Authorization: Bearer {token}" https://localhost:3001/api/tasks?status=open | jq '.count'
# 期望：98

# Step 3: 验证分类逻辑
# 手动在浏览器打开任务大厅，确认：
# - 顶部显示"今日必须处理 3"
# - payment_term_confirm 默认折叠
# - 38-XM-251 置顶且标红

# Step 4: 验证 action 可执行（不真实执行，只验证接口可达）
curl -X POST -H "Authorization: Bearer {token}" \
  "https://localhost:3001/api/tasks?id=t-mobecqy0-ah24" \
  -d '{"action":"confirm_ready_date","payload":{"ready_date":"2026-06-01"}}' \
  --dry-run
```

---

## 5. 当前 Smoke 结论

| 测试项 | 结果 | 说明 |
|--------|------|------|
| 任务数据可读取 | ✅ PASS | DB 直连确认98条 |
| 真实任务可识别 | ✅ PASS | 3条手工任务特征明显 |
| 噪音批次可识别 | ✅ PASS | t-pt- 前缀+时间戳聚类 |
| Action 接口可用 | ✅ PASS | tasks.js 已实现4种 action |
| payment_term_confirm 可关闭 | ❌ FAIL | 无对应 action |
| 批量操作接口 | ❌ FAIL | 不存在 |
| 分组/排序 UI | ❌ FAIL | 当前全量平铺 |
| 每日提醒 | ❌ FAIL | 无定时任务 |

**总结**：数据层 PASS，UI/流程层 FAIL，但 FAIL 均有明确可执行的最小修复路径。

---

*本文为本地 smoke 分析，未做任何 deploy 或 prod 变更。*
