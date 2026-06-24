#!/usr/bin/env bash
# 安装推送护栏钩子。幂等，任何仓通用。
# 用法（在仓库根目录）：  bash scripts/install-hooks.sh
set -e

REPO_ROOT="$(git rev-parse --show-toplevel)"
mkdir -p "$REPO_ROOT/.git/hooks"

for HOOK in pre-push; do
  SRC="$REPO_ROOT/scripts/git-hooks/$HOOK"
  DST="$REPO_ROOT/.git/hooks/$HOOK"
  [ -f "$SRC" ] || { echo "❌ 缺钩子源文件: $SRC"; exit 1; }
  chmod +x "$SRC"
  ln -sf "$SRC" "$DST"
  chmod +x "$DST"
  echo "✔ $HOOK 已装 → $DST"
done

echo ""
echo "✅ 推送护栏已生效：从此改动走分支 + PR，别直接推 main（紧急绕过 git push --no-verify）"
