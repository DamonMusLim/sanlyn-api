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
