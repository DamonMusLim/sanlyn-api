# 部署铁律 (Production Governance)

**生产状态 = git canonical commit + migrations applied。tencent 只是部署目标,永远不是真源。**

- 改代码只在 mini `~/canonical/sanlyn-api`,改完 commit + push。
- 部署只走 `~/bin/deploy-sanlyn-api`(= deploy/deploy-sanlyn-api 这份)。
- 绝不直接编辑 tencent `/opt/sanlyn-api-test`(会被下次部署覆盖,且漂移)。
- 结构改 → `migrations/MXXX-*.sql`(幂等),部署时 `scripts/apply-migrations.js` 自动跑。
- 一次性数据修正 → `migrations/data/D*.sql`(留痕,不被 runner 跑)。
- 已跑的 migration 不可改(runner checksum 会拦),改要新建 MXXX。
