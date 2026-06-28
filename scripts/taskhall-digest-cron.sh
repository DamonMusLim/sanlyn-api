#!/usr/bin/env bash
# taskhall-digest-cron.sh
# Sanlyn OS · TASK-HALL-DAILY-DIGEST-017
#
# Cron wrapper for the MiniMax daily digest.
# Safety rules:
#   - Never prints MINIMAX_API_KEY
#   - Never writes to DB
#   - Never pushes to WeCom / Email / SMS
#   - Always runs with --dry-run
#   - Fails closed: any error writes to log only, no external notification
#
# Cron entry (08:00 CST = 00:00 UTC):
#   0 0 * * * /opt/sanlyn-api-test/scripts/taskhall-digest-cron.sh >> /opt/sanlyn-reports/taskhall-digest/digest-run.log 2>&1
#
# Manual run (dry-run test):
#   bash /opt/sanlyn-api-test/scripts/taskhall-digest-cron.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="/opt/sanlyn-api-test/.env"
OUTPUT_DIR="/opt/sanlyn-reports/taskhall-digest"
CANDIDATES_FILE="${REPO_ROOT}/docs/workstreams/2026-05-task-hall/reminder-candidates-dryrun-v1.json"
LOG_FILE="${OUTPUT_DIR}/digest-run.log"
DIGEST_SCRIPT="${SCRIPT_DIR}/taskhall-daily-digest.mjs"

echo "════════════════════════════════════════"
echo "Sanlyn TaskHall Daily Digest"
echo "Run: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "════════════════════════════════════════"

# ── Pre-flight checks ──────────────────────────────────────────
if [ ! -f "${ENV_FILE}" ]; then
  echo "❌ ENV_FILE not found: ${ENV_FILE}" >&2
  exit 1
fi

if [ ! -f "${DIGEST_SCRIPT}" ]; then
  echo "❌ DIGEST_SCRIPT not found: ${DIGEST_SCRIPT}" >&2
  exit 1
fi

if [ ! -f "${CANDIDATES_FILE}" ]; then
  echo "⚠️  CANDIDATES_FILE not found: ${CANDIDATES_FILE}"
  echo "   Proceeding without candidates file (script will use static snapshot)"
fi

# ── Create output dir if missing ───────────────────────────────
mkdir -p "${OUTPUT_DIR}"

# ── Load env vars (key never printed) ──────────────────────────
set -a
# shellcheck source=/dev/null
source "${ENV_FILE}"
set +a

# Verify key is present without printing it
if [ -z "${MINIMAX_API_KEY:-}" ]; then
  echo "❌ MINIMAX_API_KEY not set after sourcing ${ENV_FILE}" >&2
  exit 1
fi
echo "✅ MINIMAX_API_KEY: PRESENT (len=${#MINIMAX_API_KEY})"

# ── Run digest script ──────────────────────────────────────────
echo "🚀 Starting digest at $(date -u +%H:%M:%S)Z ..."
node "${DIGEST_SCRIPT}" \
  --dry-run \
  --env=readonly-prod \
  --output-dir="${OUTPUT_DIR}" \
  --candidates-file="${CANDIDATES_FILE}"

EXIT_CODE=$?

# ── Post-run check ─────────────────────────────────────────────
if [ $EXIT_CODE -eq 0 ]; then
  echo ""
  echo "✅ Digest complete. Output:"
  ls -lh "${OUTPUT_DIR}/latest.json" "${OUTPUT_DIR}/latest.md" 2>/dev/null || true
  echo "no_write: true | no_external_push: true"
else
  echo "❌ Digest script exited with code ${EXIT_CODE}" >&2
  # Fail closed — no external push, just log
fi

echo "════════════════════════════════════════"
exit $EXIT_CODE
