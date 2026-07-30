#!/bin/bash
# ══════════════════════════════════════════════════════════
# deploy.sh — Sanlyn API one-click deploy to production
# Usage:  ./deploy.sh          → deploy all
#         ./deploy.sh auth     → deploy auth files only
#         ./deploy.sh docs     → deploy documents.js only
# ══════════════════════════════════════════════════════════

SERVER="root@111.229.242.13"
SSH_KEY="$HOME/.ssh/github_actions_sanlyn"
REMOTE="/opt/sanlyn-api-test"
LOCAL="$(cd "$(dirname "$0")" && pwd)"

# ── 防回退门 + 部署账本 (2026-07-20 加, forge4 canonical 归一体检) ──────────
# ⚠️ 本脚本是旧路(直接scp,没有clean-tree/code-guard/备份/preflight检查),
# 真源分支权威定义统一读 ~/deploy-config/sanlyn-api.env (跟 ~/bin/deploy-sanlyn-api
# 共用一份指针,别各说各话)。强烈建议改用 ~/bin/deploy-sanlyn-api(有完整护栏);
# 这里只是给旧路也补上最基本的两道线,不代表旧路本身变安全了。
_SAPI_ENV="$HOME/deploy-config/sanlyn-api.env"
if [ -f "$_SAPI_ENV" ]; then
  . "$_SAPI_ENV"
  _SAPI_BR="$(cd "$LOCAL" && git branch --show-current 2>/dev/null || echo '?')"
  if [ -n "${PROD_BRANCH:-}" ] && [ "$_SAPI_BR" != "$PROD_BRANCH" ]; then
    echo "🛑 拒绝部署: canonical 当前分支 '$_SAPI_BR' != 声明真源 '$PROD_BRANCH' (见 $_SAPI_ENV)"
    exit 1
  fi
fi

ssh_cmd() { ssh -i "$SSH_KEY" "$SERVER" "$@"; }
scp_file() {
  echo "  → $1"
  scp -i "$SSH_KEY" "$LOCAL/$1" "$SERVER:$REMOTE/$1"
}

echo ""
echo "🚀 Sanlyn API Deploy — $(date '+%Y-%m-%d %H:%M')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

TARGET="${1:-all}"

deploy_auth() {
  echo "📦 Auth"
  scp_file "server.js"
  scp_file "api/auth.js"
  scp_file "api/db/auth-login.js"
}

deploy_docs() {
  echo "📄 Documents"
  scp_file "api/db/documents.js"
}

deploy_core() {
  echo "⚙️  Core API"
  scp_file "api/db/orders.js"
  scp_file "api/db/products.js"
  scp_file "api/db/upsert.js"
  scp_file "api/db/admin.js"
  scp_file "api/minimax-booking.js"
}

case "$TARGET" in
  auth)  deploy_auth ;;
  docs)  deploy_docs ;;
  core)  deploy_core ;;
  all)
    deploy_auth
    deploy_docs
    deploy_core
    ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Usage: ./deploy.sh [all|auth|docs|core]"
    exit 1
    ;;
esac

echo ""
echo "🔄 Restarting sanlyn-api..."
ssh_cmd "pm2 restart sanlyn-api > /dev/null 2>&1"
sleep 2
ssh_cmd "pm2 list | grep sanlyn-api | head -2"

echo ""
echo "✅ Deploy complete — $(date '+%H:%M:%S')"
echo ""

mkdir -p ~/.openclaw
_SAPI_COMMIT="$(cd "$LOCAL" && git rev-parse --short HEAD 2>/dev/null || echo unknown)"
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)|$(hostname)|$(whoami)|sanlyn-api(legacy-deploy.sh:$TARGET)|sanlyn-api@${_SAPI_BR:-unknown}@${_SAPI_COMMIT}" >> ~/.openclaw/deploy-ledger.log
