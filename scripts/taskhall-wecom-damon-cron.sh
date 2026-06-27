#!/usr/bin/env bash
# taskhall-wecom-damon-cron.sh
# Sanlyn OS · TASK-HALL-DAILY-DIGEST-WECOM-018
#
# Cron wrapper: sends daily task hall digest to Damon's WeCom.
# Runs at 08:05 CST (00:05 UTC) — 5 minutes after the digest cron.
# ONLY sends to Damon. fail-closed: errors write to log only, no retry bombing.
#
# Cron entry (08:05 CST = 00:05 UTC):
#   5 0 * * * /opt/sanlyn-api-test/scripts/taskhall-wecom-damon-cron.sh >> /opt/sanlyn-reports/taskhall-digest/wecom-push.log 2>&1
#
# Manual test (preview, no send):
#   bash /opt/sanlyn-api-test/scripts/taskhall-wecom-damon-cron.sh
#
# Manual test (actually send):
#   WECOM_SEND=1 bash /opt/sanlyn-api-test/scripts/taskhall-wecom-damon-cron.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="/opt/sanlyn-api-test/.env"
PUSH_SCRIPT="${SCRIPT_DIR}/taskhall-wecom-push-damon.mjs"
INPUT_DIR="/opt/sanlyn-reports/taskhall-digest"
LOG_FILE="${INPUT_DIR}/wecom-push.log"

echo "════════════════════════════════════════"
echo "Sanlyn TaskHall WeCom Push (Damon only)"
echo "Run: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "════════════════════════════════════════"

# ── Pre-flight checks ──────────────────────────────────────────
if [ ! -f "${ENV_FILE}" ]; then
  echo "❌ ENV_FILE not found: ${ENV_FILE}" >&2
  exit 1
fi

if [ ! -f "${PUSH_SCRIPT}" ]; then
  echo "❌ PUSH_SCRIPT not found: ${PUSH_SCRIPT}" >&2
  exit 1
fi

if [ ! -f "${INPUT_DIR}/latest.json" ]; then
  echo "❌ latest.json not found: ${INPUT_DIR}/latest.json" >&2
  echo "   Run taskhall-digest-cron.sh first." >&2
  exit 1
fi

# ── Load env vars (webhook never printed) ─────────────────────
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

# Verify webhook is present without printing URL
WEBHOOK_URL="${WECOM_DAMON_WEBHOOK_URL:-${WECOM_WEBHOOK_URL:-}}"
if [ -z "${WEBHOOK_URL}" ]; then
  echo "❌ No WeCom webhook configured (WECOM_DAMON_WEBHOOK_URL or WECOM_WEBHOOK_URL)" >&2
  exit 1
fi
echo "✅ Webhook: PRESENT (${#WEBHOOK_URL} chars)"

# ── Determine send mode ────────────────────────────────────────
# By default: preview only (safe for testing)
# Set WECOM_SEND=1 to actually post
SEND_FLAG=""
if [ "${WECOM_SEND:-0}" = "1" ]; then
  SEND_FLAG="--send"
  echo "📤 WECOM_SEND=1: will actually POST to WeCom"
else
  echo "📋 WECOM_SEND not set: preview only (add WECOM_SEND=1 to actually send)"
fi

# ── Run push script ────────────────────────────────────────────
echo "🚀 Running push at $(date -u +%H:%M:%S)Z ..."
node "${PUSH_SCRIPT}" \
  --dry-run \
  --input-dir="${INPUT_DIR}" \
  ${SEND_FLAG}

EXIT_CODE=$?

if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "✅ Push complete."
  echo "Log: ${LOG_FILE}"
else
  echo "❌ Push script exited with code ${EXIT_CODE}" >&2
  # fail-closed — no external push, just log
fi

echo "════════════════════════════════════════"
exit $EXIT_CODE
