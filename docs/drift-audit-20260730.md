# Drift Audit 2026-07-30

## Scope And Snapshot

- Scope: repository-local read-only audit of deploy scripts/configs/docs for stale pins, destructive sync, version checks, true-source conventions, other `/opt` service clues, and false-green deploy traps.
- Local branch during audit: `fix/auto-derive-shipping-on-confirm` at `23f37d5`.
- Worktree note: repository already had many unrelated uncommitted changes before this audit; this file is the only audit output.
- No online host, database, deployment, SQL, restart, or push was executed.

## Executive Summary

The latest `deploy/deploy-sanlyn-api` has fixed the specific `snapshot/prod-20260628` stale-pin failure mode by dynamically selecting `snapshot/prod-*`, refusing `main`, refusing dirty trees, avoiding `--delete`, backing up `/opt`, and running `scripts/verify-opt-mirror.mjs`.

The remaining drift risks are not in that single fixed path; they are alternate deploy paths and incomplete enforcement:

- `deploy.sh` is still a legacy scp deploy path that can restart PM2 and print success without mirror/version validation.
- `DEPLOYED_VERSION` exists but is not a pre-deploy gate; it is excluded/protected during rsync and only written after the main deploy finishes.
- `scripts/verify-opt-mirror.mjs` checks only eight hard-coded key files, not all deployed tracked files, so large classes of stale files can survive undetected.
- Docs still contain hand-copy `/opt` deployment instructions that bypass canonical deploy guardrails.
- `/opt` is not yet a git working tree; the runbook says this remains an artificial mirror, so manual edits or alternate deploys can still create drift.
- This repo has only thin clues for `admin-v1`, `cockpit-web`, and `finance-api`; their deploy scripts are not auditable here and need machine-side checks.

## Risk List

### R1. Legacy `deploy.sh` can still produce false-green partial deploys

- Location: `deploy.sh:14-18`, `deploy.sh:30-33`, `deploy.sh:79-85`, `deploy.sh:88-90`.
- Risk point: legacy deploy path directly `scp`s selected files, restarts PM2, greps `pm2 list`, then prints `Deploy complete`.
- Why this causes rollback/drift: it never mirrors the full tree, never runs `verify-opt-mirror`, never checks remote `DEPLOYED_VERSION`, does not back up `/opt`, and suppresses restart output with `> /dev/null 2>&1`. A partial old file set can be deployed and reported green even when `/opt` is mixed-version.
- Severity: High.
- Block: make `deploy.sh` a hard-failing wrapper that execs `~/bin/deploy-sanlyn-api` or exits with instructions. If kept for emergencies, add clean-tree guard, remote mirror verify, remote version compare, backup, and unsuppressed PM2 health check.

### R2. `DEPLOYED_VERSION` is a marker, not an enforcement gate

- Location: `DEPLOYED_VERSION:1-4`, `.deployignore:28`, `deploy/deploy-sanlyn-api:24-27`, `deploy/deploy-sanlyn-api:99-107`.
- Risk point: local `DEPLOYED_VERSION` still records `branch=snapshot/prod-20260709`, while the main deploy protects/excludes `DEPLOYED_VERSION` from rsync and only writes it after mirror verify.
- Why this causes rollback/drift: a stale `DEPLOYED_VERSION` does not stop any deploy. The previous rollback happened because the deploy source was stale; a version file that is not compared before copy cannot detect source selection mistakes.
- Severity: High.
- Block: before file transfer, read remote `DEPLOYED_VERSION`, parse `repo/branch/commit`, and reject deploy if the selected source commit is behind the recorded deployed commit for the same true-source lineage. After transfer and restart, read it back and require exact `branch` and `commit` match.

### R3. Mirror verifier only checks eight hard-coded files

- Location: `scripts/verify-opt-mirror.mjs:7-16`, `scripts/verify-opt-mirror.mjs:89-107`.
- Risk point: `KEY_PATHS` covers `server.js`, `routes-core.js`, a few invoice/template files, deployment metadata, and `.deployignore`.
- Why this causes rollback/drift: stale or missing files outside `KEY_PATHS` are invisible. A deploy can pass while API modules, public pages, migrations, or scripts still differ from canonical.
- Severity: High.
- Block: change verification to compare the deploy manifest generated from `git ls-files` minus `.deployignore` and runtime excludes. Keep `KEY_PATHS` only as a fast preflight, then run full manifest checksum after deploy.

### R4. Main deploy still operates by rsync mirror, not true git checkout on `/opt`

- Location: `deploy/deploy-sanlyn-api:73-100`, `docs/opt-git-worktree-runbook.md:7-11`, `docs/opt-git-worktree-runbook.md:90-168`.
- Risk point: the current fixed deploy is still rsync from mini canonical into `/opt`, while the runbook says `/opt` git worktree migration is the final state and still manual.
- Why this causes rollback/drift: rsync has no native deployed commit ancestry. Manual edits, omitted files, protected files, or alternate copy paths can make `/opt` diverge from canonical without a git status surface on the host.
- Severity: High.
- Block: prioritize the `/opt` git worktree migration in the runbook. Until then, schedule full manifest `verify-opt-mirror` and alert on any drift, not just deploy-time checks.

### R5. True-source branch convention is still split between dynamic latest and named current

- Location: `deploy/deploy-sanlyn-api:30-53`, `deploy/README.md:14-15`, `docs/opt-git-worktree-runbook.md:15`, `docs/opt-git-worktree-runbook.md:41-48`.
- Risk point: the script dynamically selects latest local `snapshot/prod-*` when not already on one, while docs mention `PROD_BRANCH` and `snapshot/prod-api-current`.
- Why this causes rollback/drift: if `~/deploy-config/sanlyn-api.env` is missing or inconsistent across machines, "latest local prod branch" can differ by clone freshness. The current audit observed multiple local prod branches, including `snapshot/prod-20260628`, `snapshot/prod-20260709`, `snapshot/prod-live-20260718`, and `snapshot/prod-api-current`.
- Severity: Medium-High.
- Block: make `PROD_BRANCH` required, not optional, and fail closed if the env file is absent. Alternatively maintain a single moving branch such as `snapshot/prod-api-current` and forbid date snapshots as deployable branch names.

### R6. Main deploy may run migrations before post-restart version write

- Location: `deploy/deploy-sanlyn-api:99-107`, `scripts/apply-migrations.js:20-48`.
- Risk point: deploy runs mirror verify, then applies migrations, then runs `node --check`, restarts PM2, and writes `DEPLOYED_VERSION`.
- Why this causes rollback/drift: if migrations succeed but restart/version write fails, DB state may advance while `DEPLOYED_VERSION` remains stale. This is not code rollback by itself, but it creates an ambiguous half-green state.
- Severity: Medium.
- Block: write a `DEPLOYING_VERSION` or deploy transaction log before migrations, then finalize `DEPLOYED_VERSION` only after restart and health checks. On failure, leave an explicit incomplete marker and alert.

### R7. Hand-copy `/opt` deploy doc bypasses canonical guardrails

- Location: `docs/M2b-business-write-resolver-deploy.md:10-31`, `docs/M2b-business-write-resolver-deploy.md:35-56`.
- Risk point: this doc instructs manual backup, direct `install` into `/opt/sanlyn-api-test`, and direct SQL execution.
- Why this causes rollback/drift: direct `/opt` copy creates live code that may not exist in canonical true source and will later be overwritten by canonical deploy. It also bypasses `.deployignore`, branch guards, mirror verify, version marker, and migration runner checksum flow.
- Severity: Medium-High.
- Block: rewrite as "merge to true-source branch, commit, deploy via `deploy/deploy-sanlyn-api`; SQL files are produced for human execution only unless promoted to idempotent `M*.sql`." Mark direct `/opt install` as emergency-only with mandatory post-copy canonical commit and mirror audit.

### R8. Manual `/opt` git-worktree runbook includes placeholders that need operator proof

- Location: `docs/opt-git-worktree-runbook.md:105-112`, `docs/opt-git-worktree-runbook.md:132-149`, `docs/opt-git-worktree-runbook.md:160-168`.
- Risk point: the runbook uses `<REPO_URL>` and `<LATEST_SNAPSHOT_PROD_BRANCH>` placeholders and instructs a manual directory swap.
- Why this causes rollback/drift: the plan is sound, but a wrong branch or unpushed commit during the one-time migration can entrench old code as the new git worktree.
- Severity: Medium.
- Block: before executing, require printed proof of `git remote -v`, `git rev-parse HEAD`, `git branch --show-current`, `git status --short`, and `node scripts/verify-opt-mirror.mjs` from the new worktree. Record these in a handoff note.

### R9. Other `/opt` services are not auditable from this repo

- Location: `docs/API-INVENTORY-2026-05.md:174`, `public/index.html:7-8`, brief snapshot references to `/opt/sanlyn-admin-v1`, `/opt/sanlyn-cockpit-web/dist`, and `/opt/finance-api`.
- Risk point: this repo only mentions that finance API endpoints live elsewhere and that `public/index.html` loads `/admin-v1` assets. It does not include deploy scripts for admin-v1, cockpit-web, or finance-api.
- Why this causes rollback/drift: stale pins, `rsync --delete`, false-green deploys, or missing version checks can exist in those service repos or host scripts without being visible here.
- Severity: Unknown, potentially High.
- Block: manually audit each service on its canonical repo and host install path. Minimum checks: deploy script source branch/commit, `--delete` usage, runtime excludes, post-deploy content hash, PM2/process health, and `DEPLOYED_VERSION` equivalent.

### R10. No GitHub workflow deploy path found here, but absence is not proof

- Location: `.github` search returned no workflow files in this repository; `docs/opt-git-worktree-runbook.md:168` warns about any CI/GitHub Actions full-tree sync.
- Risk point: repo-local audit found no `.github/workflows` deploy script to inspect.
- Why this causes rollback/drift: if deployment is performed by external CI, user-level cron, or host-local `~/bin` scripts not committed here, they can still overwrite `/opt`.
- Severity: Medium.
- Block: inventory host crons, PM2 deploy hooks, GitHub repository Actions settings, and `~/bin/*deploy*` on mini/tencent. Commit the canonical deploy entry or document exact installed checksums.

### R11. Runtime/code excludes are duplicated in script and `.deployignore`

- Location: `.deployignore:18-29`, `deploy/deploy-sanlyn-api:20-27`.
- Risk point: excludes/protect rules live in both `.deployignore` and shell arrays.
- Why this causes rollback/drift: future edits can update one list but not the other. A path can become deleted/overwritten in rsync or invisible to verification depending on which list a tool reads.
- Severity: Medium.
- Block: make `.deployignore` the single source for all mirror excludes, and derive rsync protect/filter rules or verification manifest from it. Add a static check that duplicated runtime paths stay aligned.

### R12. Deploy "success" health check is shallow

- Location: `deploy/deploy-sanlyn-api:105-107`, `deploy.sh:79-85`.
- Risk point: main deploy checks `node --check server.js`, restarts PM2, and greps recent logs; legacy deploy suppresses restart output and greps PM2 list.
- Why this causes rollback/drift: syntax and process listing do not prove the intended code is serving traffic or that routes/templates match the deployed commit.
- Severity: Medium.
- Block: add a local `/health/version` or `/api/version` endpoint returning branch/commit/build time from `DEPLOYED_VERSION`, then curl it after restart and compare with the source commit.

## Why `DEPLOYED_VERSION` Did Not Stop The Rollback

`DEPLOYED_VERSION` did not stop old code from covering `/opt` because it is not used as a gate before copying files.

In the fixed main deploy path, `DEPLOYED_VERSION` is explicitly protected and excluded from rsync (`.deployignore:28`, `deploy/deploy-sanlyn-api:24-27`), mirror verification runs before the script writes the new version (`deploy/deploy-sanlyn-api:99-107`), and the file is only updated after restart (`deploy/deploy-sanlyn-api:107-112`). In the legacy deploy path, no remote version read/write check exists; it only appends a local ledger entry (`deploy.sh:88-90`).

That means a stale source branch can still be copied if the source-selection guard is wrong. The version file can later say "old branch/old commit" or remain stale, but nothing in the old deploy flow says "remote is currently newer than the source I am about to copy; stop."

Minimum change to make versioning real:

1. Generate intended version from `git rev-parse --abbrev-ref HEAD` and `git rev-parse HEAD` before deploy.
2. Read remote `$RDIR/DEPLOYED_VERSION` before any transfer.
3. Reject if intended branch is not the configured true-source branch.
4. Reject if intended commit is behind the deployed commit on the same branch.
5. After deploy/restart, read remote `DEPLOYED_VERSION` and require exact branch/commit match.
6. Add a runtime `/health/version` response and curl it after restart to prove the running process serves the expected commit.

## Priority

1. P0: disable or wrap legacy `deploy.sh`; it is still the clearest false-green and partial-deploy trap.
2. P0: make `DEPLOYED_VERSION` a pre/post deploy gate, not a passive marker.
3. P0: expand `verify-opt-mirror` from hard-coded key files to a full `git ls-files` deploy manifest.
4. P1: make `PROD_BRANCH` required and normalize the true-source convention to one deployable branch.
5. P1: execute the `/opt` git-worktree migration with operator proof, or schedule full manifest drift checks until it is done.
6. P1: replace hand-copy deployment docs with canonical deploy flow and emergency-only exceptions.
7. P2: audit admin-v1, cockpit-web, and finance-api in their own repos/hosts; this repo does not contain enough evidence.

## Suggested Minimal Patch Set For A Later Implementation

- `deploy.sh`: replace body with a failing wrapper or `exec "$HOME/bin/deploy-sanlyn-api" "$@"`.
- `deploy/deploy-sanlyn-api`: require `ENV_FILE`, require `PROD_BRANCH`, pre-read remote `DEPLOYED_VERSION`, compare ancestry, write `DEPLOYING_VERSION`, finalize `DEPLOYED_VERSION`, then curl runtime version.
- `scripts/verify-opt-mirror.mjs`: build file list from `git ls-files`, apply `.deployignore` and runtime excludes, compare every deployable file, and optionally emit JSON for cron alerts.
- `server.js` or a small route module: expose read-only version health from `DEPLOYED_VERSION` plus process start time.
- `deploy/README.md` and old handoff docs: mark direct `/opt` writes as emergency-only and require immediate canonical commit plus mirror check.

## Manual Checks Needed Outside This Repo

- On mini: inspect installed `~/bin/deploy-sanlyn-api` checksum/content and confirm it matches `deploy/deploy-sanlyn-api`.
- On mini: inspect `~/deploy-config/sanlyn-api.env` and confirm `PROD_BRANCH` is present, current, and not stale.
- On mini/tencent: inspect crontab, PM2 ecosystem files, and `~/bin/*deploy*` for external deploy paths.
- On tencent: inspect `/opt/sanlyn-api-test/DEPLOYED_VERSION` and compare with the currently running code via a content hash or future version endpoint.
- On admin-v1/cockpit-web/finance-api hosts: audit deploy scripts for stale branch/commit pins, `rsync --delete`, missing runtime excludes, and lack of post-deploy content verification.

## Evidence Files Read

- `deploy.sh`
- `deploy/deploy-sanlyn-api`
- `scripts/verify-opt-mirror.mjs`
- `deploy/README.md`
- `.deployignore`
- `DEPLOYED_VERSION`
- `docs/opt-git-worktree-runbook.md`
- `docs/M2b-business-write-resolver-deploy.md`
- `scripts/apply-migrations.js`
- repo-wide `rg` searches for deploy, rsync, PM2, true-source branches, `/opt` paths, and version markers
