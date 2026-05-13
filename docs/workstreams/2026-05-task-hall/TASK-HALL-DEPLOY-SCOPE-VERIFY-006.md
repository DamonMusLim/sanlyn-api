# TASK-HALL-DEPLOY-SCOPE-VERIFY-006
## Sanlyn OS · 部署范围核查报告

**执行日期**: 2026-05-11  
**最终状态**: `TASK_HALL_DEPLOY_SCOPE_VERIFIED_SAFE`  
**触发原因**: TASK-HALL-UI-MINIMAL-005 报告中口径矛盾，需核查 feat/regression-tests push 是否触发生产部署

---

## ✅ 核查结论（一行版）

**feat/regression-tests push 未触发任何 deploy。ai.sanlyn.cn 当前运行的仍是旧 bundle，commit 2bc1b4be 未上线。无需 rollback。**

---

## Step 1：GitHub Actions Workflow 核查

**文件路径**：`.github/workflows/deploy.yml`

```yaml
name: Deploy to ai.sanlyn.cn

on:
  push:
    branches: [main]       # ← 仅 main 分支触发

jobs:
  deploy:
    steps:
      - name: Deploy dist via rsync
        run: |
          rsync -az \
            -e "ssh -i ~/.ssh/deploy_key ..." \
            app/components/dist/ \
            root@111.229.242.13:/opt/sanlyn-web/
      - name: Reload nginx
        run: |
          ssh ... root@111.229.242.13 "nginx -s reload"
```

**`.github/workflows/tests.yml`**：
```yaml
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
```

**结论**：

| 问题 | 答案 |
|------|------|
| feat/regression-tests 是否在 deploy 触发范围内 | **否。只有 main 触发** |
| deploy.yml 是否有通配符 branch 规则 | **无。仅 `branches: [main]`** |
| rsync 目标路径 | `/opt/sanlyn-web/`（nginx root，ai.sanlyn.cn 服务目录） |
| push feat/regression-tests 是否会 deploy | **不会** |

---

## Step 2：线上 vs 本地 Bundle 对比

| 指标 | 线上 (ai.sanlyn.cn) | 本地 dist (commit 2bc1b4be) |
|------|---------------------|------------------------------|
| index.js hash | `index-CUVcG6xs.js` | `index-DKiM7k5b.js` |
| 是否相同 | **否（完全不同）** | — |
| TaskHall 关键词命中数 | **0** | **3** |

```bash
# 线上 bundle 核查命令（只读 GET）：
curl -s https://ai.sanlyn.cn/ | grep 'assets/index-'
# 输出: assets/index-CUVcG6xs.js  ← 未更新

# 本地 dist bundle：
cat app/components/dist/index.html | grep 'assets/index-'
# 输出: assets/index-DKiM7k5b.js  ← 包含 TaskHallPanel

# 关键词验证：
curl -s https://ai.sanlyn.cn/assets/index-CUVcG6xs.js | grep -c "TaskHall"
# 输出: 0  ← 线上无 TaskHallPanel
```

---

## Step 3：ai.sanlyn.cn 定性

根据 MEMORY.md（部署架构节）：

> `ai.sanlyn.cn` — 腾讯云轻量服务器 111.229.242.13 — **生产**，客户/工厂访问这个

**ai.sanlyn.cn = 生产入口**（非 staging，非 preview）。

Vercel (`sanlyn-os.vercel.app`) 是备用预览，但 deploy.yml 部署的是生产服务器。

---

## Step 4：9项问题答案

| # | 问题 | 答案 |
|---|------|------|
| 1 | feat/regression-tests push 是否触发 GitHub Actions？ | **否。deploy.yml 只对 main 触发。** |
| 2 | 是否 deploy 到 ai.sanlyn.cn？ | **否。线上 bundle hash 与本地 dist 不同，TaskHall 关键词命中 0。** |
| 3 | ai.sanlyn.cn 是什么入口？ | **生产入口**（不是 staging，不是 demo）。客户/工厂访问此地址。 |
| 4 | commit 2bc1b4be 是否已经上线？ | **否。仅在 feat/regression-tests 分支，未 merge main，未 deploy。** |
| 5 | TASK-HALL-UI-MINIMAL-005 报告"未生产部署"是否需要更正？ | **该结论正确，无需更正。但交付摘要末尾的"GitHub Actions 将自动 deploy 到 ai.sanlyn.cn"表述有误，应删除或改为"合并 main 后才会 deploy"。** |
| 6 | 如果已经上线，风险等级？ | **N/A — 未上线。** |
| 7 | 是否需要 rollback？ | **否。代码未上线，无需任何回滚操作。** |
| 8 | 如果没上线，下一步如何预览？ | 本地预览：`npm run dev` → localhost；或 merge 到 main → GitHub Actions 自动部署到 ai.sanlyn.cn（需 Damon 批准 merge）。 |
| 9 | 是否可以继续 Phase 2 action？ | **技术上可继续开发，但 action 写入属于 P0 操作，必须等 Damon 明确批准开放哪条 action 再动手。** |

---

## TASK-HALL-UI-MINIMAL-005 报告口径勘误

**错误表述**（交付摘要末行）：
> "GitHub Actions 将自动 deploy 到 ai.sanlyn.cn"

**应更正为**：
> "代码在 feat/regression-tests 分支，未合并 main，GitHub Actions 不会触发。需 Damon 批准 merge main 后才会自动 deploy 到 ai.sanlyn.cn。"

---

## 安全确认

| 项目 | 状态 |
|------|------|
| 生产 DB 是否被写入 | **NO** |
| 生产前端是否被更新 | **NO**（bundle hash 不同，线上未变） |
| 是否需要 rollback | **NO** |
| 是否需要 merge main | **待 Damon 决策** |

---

*核查状态：TASK_HALL_DEPLOY_SCOPE_VERIFIED_SAFE*  
*线上未变 · 分支隔离正常 · 无需任何回滚*
