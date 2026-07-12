#!/bin/bash
# ══════════════════════════════════════════════════════════
# deploy.sh — Sanlyn API one-click deploy to production
# Usage:  ./deploy.sh          → deploy all
#         ./deploy.sh auth     → deploy auth files only
#         ./deploy.sh docs     → deploy documents + 单据渲染器
#         ./deploy.sh core     → deploy core API
# ══════════════════════════════════════════════════════════

SERVER="root@111.229.242.13"
SSH_KEY="$HOME/.ssh/github_actions_sanlyn"
REMOTE="/opt/sanlyn-api-test"
LOCAL="$(cd "$(dirname "$0")" && pwd)"

ssh_cmd() { ssh -i "$SSH_KEY" "$SERVER" "$@"; }
scp_file() {
  echo "  → $1"
  scp -i "$SSH_KEY" "$LOCAL/$1" "$SERVER:$REMOTE/$1"
}

# ══════════════════════════════════════════════════════════
# 🛡 部署护栏 (2026-07-08 加) — 防从旧 main / 落后分支部署把线上打回旧版
# 病史: main 落后线上真源约一个月(517/228分叉), 真源 = 最新 snapshot/prod-* 分支。
# 谁 checkout 旧分支再跑本脚本就会回退线上——港口/FS 就这么被刷没过。
# ══════════════════════════════════════════════════════════
cd "$LOCAL" || exit 1
GUARD_BR=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$GUARD_BR" = "main" ]; then
  echo "🚫 拒绝部署: 当前在 main 分支。main 落后线上真源约一个月, 从 main 部署 = 把线上打回旧版。"
  echo "   sanlyn-api 真源 = 最新的 snapshot/prod-* 分支。先 git checkout 正确真源分支再部署。"
  exit 1
fi
git fetch origin "$GUARD_BR" --quiet 2>/dev/null
GUARD_BEHIND=$(git rev-list --count "HEAD..origin/$GUARD_BR" 2>/dev/null || echo 0)
if [ "${GUARD_BEHIND:-0}" -gt 0 ]; then
  echo "🚫 拒绝部署: 当前分支落后 origin/$GUARD_BR ${GUARD_BEHIND} 个提交, 部署会用旧代码覆盖新代码。先 git pull 再来。"
  exit 1
fi
echo "🛡 护栏通过 — 分支=$GUARD_BR  commit=$(git log -1 --format='%h %s' 2>/dev/null | cut -c1-56)"

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
  echo "📄 Documents / 单据渲染器"
  scp_file "api/db/documents.js"
  scp_file "api/db/shipping-plan-pdf.js"
  scp_file "api/db/customs-declaration-form.js"
  scp_file "api/db/customs-declaration-form-lib.js"
  scp_file "api/db/inbound-notice.js"
  scp_file "api/db/inspection-request-form.js"
  scp_file "api/db/inspection-ocr.js"
  scp_file "api/db/customs-bundle-pdf.js"
  scp_file "api/db/customs-doc-quality-gate.js"
  scp_file "api/db/_html-to-pdf.js"
  scp_file "public/templates/export-docs-template.js"
  scp_file "public/templates/export-docs-template.html"
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
