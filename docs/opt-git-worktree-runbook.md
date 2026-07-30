# /opt 部署回退根治手册

## 结论

推荐组合是 A + B + C：

- A 分支治本：所有上线改动必须先进入真源分支 `snapshot/prod-*`，feature 分支手工部署只允许临时救火，不能视为上线完成。
- B /opt 变 git 工作树：这是最终形态。`/opt/sanlyn-api-test` 直接 checkout 真源分支，部署从“全树覆盖”改为“真源 commit 前进”，运行时目录用 `.gitignore`/exclude 保护。
- C 漂移校验：部署后和定时校验 `/opt` 与真源 commit 的 tracked files 是否一致，发现回退立即报警。

不推荐只做 A 或只做 C。A 靠人，挡不住另一条全量部署；C 能发现但不能阻止；B 能追溯和回滚，但必须先处理好 `uploads/` 等运行时目录。本次仓库已落地 C 和 B 的前置保护，B 的线上切换由人工执行。

## 已落地

- `deploy/deploy-sanlyn-api` 不再写死 2026-06-28 旧快照；当前分支若是 `snapshot/prod-*` 就使用当前分支，否则提示切到本地最新 `snapshot/prod-*`。
- 部署拒绝 main、拒绝非真源分支、拒绝脏树、拒绝本地落后 origin。
- rsync 排除并保护 `uploads/`、`api/files/`、`backups/`、`DEPLOYED_VERSION`，不使用 `--delete`。
- 部署后运行 `scripts/verify-opt-mirror.mjs` 比对 canonical 和 `/opt` 的关键文件 md5。
- `.deployignore` 记录部署镜像排除项，供 CI/人工审查对齐。

## 方案代价和风险

A 的代价是流程纪律：每个 feature 都要合入真源后才能上线。风险是并发分支冲突，需要人工 review。

B 的代价是一次性迁移 `/opt`。风险集中在首次切换：必须先备份，必须保住 `uploads/` 和 `api/files/`，不得使用会删除运行时目录的命令。

C 的代价是校验耗时。风险是 tracked files 范围过宽时会暴露历史未部署文件，需要把真正不该部署的内容加入 `.deployignore` 和部署脚本排除项。

## feature 发票改动合入真源

以下只做 git 合并，不碰线上数据。

1. 在 mini canonical 仓确认当前现场：

```bash
cd ~/canonical/sanlyn-api
git status --short --branch
git branch --list 'snapshot/prod-*' --sort=-committerdate | head
```

2. 确认最新真源分支：

```bash
PROD_BRANCH=$(git for-each-ref --sort=-committerdate --format='%(refname:short)' 'refs/heads/snapshot/prod-*' | head -1)
test -n "$PROD_BRANCH" && echo "$PROD_BRANCH"
```

若取不到 `PROD_BRANCH`，先停止，不要猜一个旧快照。

3. 备份 feature 和真源指针：

```bash
git branch backup/feature-auto-derive-before-prod-merge fix/auto-derive-shipping-on-confirm
git branch backup/prod-before-invoice-merge "$PROD_BRANCH"
```

4. 切到真源并更新：

```bash
git checkout "$PROD_BRANCH"
git fetch origin "$PROD_BRANCH"
git merge --ff-only "origin/$PROD_BRANCH"
```

5. 只合入发票相关提交或文件。优先 cherry-pick 已确认提交；若要按文件拿变更，先看 diff：

```bash
git diff --stat "$PROD_BRANCH"..fix/auto-derive-shipping-on-confirm -- \
  'public/*invoice*' 'api/**/*invoice*' 'routes-core.js' 'server.js'
```

若 diff 范围干净，再 cherry-pick 对应 commit；不要把其它 workstream 的未审改动一起带入真源。

6. 本地静态检查：

```bash
node --check server.js
node --check routes-core.js
node scripts/verify-opt-mirror.mjs --help
```

7. 提交并推真源：

```bash
git status --short
git commit -m "deploy: merge invoice confirm fixes into prod source"
git push origin "$PROD_BRANCH"
```

## /opt 转 git 工作树

首次迁移由 Claude 人工执行。所有命令先在会话里逐条确认输出，禁止 `rsync --delete`。

1. 远端备份运行目录和运行时产物：

```bash
ssh tencent
cd /opt
mkdir -p /opt/sanlyn-api-backups
TS=$(date +%Y%m%d-%H%M%S)
tar czf /opt/sanlyn-api-backups/pre-git-worktree-$TS.tar.gz sanlyn-api-test
tar czf /opt/sanlyn-api-backups/uploads-$TS.tar.gz sanlyn-api-test/uploads sanlyn-api-test/api/files 2>/dev/null || true
```

2. 在远端旁路 clone 真源，不覆盖 live 目录：

```bash
cd /opt
git clone <REPO_URL> sanlyn-api-test.gitworktree
cd sanlyn-api-test.gitworktree
git checkout <LATEST_SNAPSHOT_PROD_BRANCH>
```

3. 复制 live 的环境文件和运行时目录到新工作树。这里不用 `--delete`：

```bash
cp -a /opt/sanlyn-api-test/.env* /opt/sanlyn-api-test.gitworktree/ 2>/dev/null || true
mkdir -p /opt/sanlyn-api-test.gitworktree/uploads /opt/sanlyn-api-test.gitworktree/api/files
rsync -a /opt/sanlyn-api-test/uploads/ /opt/sanlyn-api-test.gitworktree/uploads/ 2>/dev/null || true
rsync -a /opt/sanlyn-api-test/api/files/ /opt/sanlyn-api-test.gitworktree/api/files/ 2>/dev/null || true
```

4. 安装依赖并做本地检查：

```bash
cd /opt/sanlyn-api-test.gitworktree
npm ci --omit=dev
node --check server.js
node scripts/apply-migrations.js --help 2>/dev/null || true
```

5. 停短窗口切换目录，保留旧目录可回滚：

```bash
cd /opt
mv sanlyn-api-test sanlyn-api-test.pre-git-$TS
mv sanlyn-api-test.gitworktree sanlyn-api-test
pm2 restart sanlyn-api
```

6. 切换后验证：

```bash
cd /opt/sanlyn-api-test
git status --short --branch
node --check server.js
pm2 logs sanlyn-api --lines 20 --nostream
test -d uploads && test -d api/files
```

7. 回滚方式：

```bash
cd /opt
mv sanlyn-api-test sanlyn-api-test.failed-$TS
mv sanlyn-api-test.pre-git-$TS sanlyn-api-test
pm2 restart sanlyn-api
```

## 上线自检清单

- `git branch --show-current` 是 `snapshot/prod-*`，且是准备上线的最新真源分支。
- `git status --short` 为空。
- `git rev-parse HEAD` 等于或领先 `origin/$(git branch --show-current)`，不得落后。
- `deploy/deploy-sanlyn-api` dry-run 输出不包含 `uploads/`、`api/files/`。
- 部署后 `node scripts/verify-opt-mirror.mjs --remote tencent --remote-dir /opt/sanlyn-api-test` 通过。
- 远端 `DEPLOYED_VERSION` 记录本次真源分支和 commit。
- 若任何 CI/GitHub Actions 使用全树同步，必须去掉 `--delete`，并加入 `.deployignore` 同等排除项；否则停用该部署入口。
