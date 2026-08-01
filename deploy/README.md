# 部署铁律 (Production Governance)

**生产状态 = git canonical commit + migrations applied。tencent 只是部署目标,永远不是真源。**

- 改代码只在 mini `~/canonical/sanlyn-api`,改完 commit + push。
- 部署只走 `~/bin/deploy-sanlyn-api`(= deploy/deploy-sanlyn-api 这份)。
- 绝不直接编辑 tencent `/opt/sanlyn-api-test`(会被下次部署覆盖,且漂移)。
- 结构改 → `migrations/MXXX-*.sql`(幂等),部署时 `scripts/apply-migrations.js` 自动跑。
- 一次性数据修正 → `migrations/data/D*.sql`(留痕,不被 runner 跑)。
- 已跑的 migration 不可改(runner checksum 会拦),改要新建 MXXX。

## 2026-07-30 回退根治补强

- 推荐组合: A 为纪律真源、B 为最终形态、C 为部署/定时校验。当前仓库已落地 C 和 B 的安全前置；真正把 `/opt/sanlyn-api-test` 转成 git 工作树按 `docs/opt-git-worktree-runbook.md` 人工执行。
- `deploy/deploy-sanlyn-api` 从 `~/deploy-config/sanlyn-api.env` 读取 `PROD_BRANCH`，默认 `snapshot/prod-api-current`；拒绝 main、拒绝非真源、拒绝脏树。
- 同步显式排除并保护 `uploads/`、`api/files/`、`backups/`、`DEPLOYED_VERSION`，不使用 `--delete`。
- 部署后运行 `node scripts/verify-opt-mirror.mjs --remote tencent --remote-dir /opt/sanlyn-api-test`，校验远端已部署代码与当前 canonical tracked files 一致。
- 根目录 `deploy.sh` 是旧 scp 路，只能应急；常规上线只走 `deploy/deploy-sanlyn-api` 或安装后的 `~/bin/deploy-sanlyn-api`。
