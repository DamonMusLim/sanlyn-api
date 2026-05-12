#!/bin/bash
# 每日汇率同步 — 由服务器 cron 调用
# crontab: 0 9 * * * /opt/sanlyn-api-test/scripts/daily-rate-sync.sh >> /var/log/sanlyn-rate-sync.log 2>&1

ENV_FILE="${1:-/opt/sanlyn-api-test/.env}"

JWT="$(node -e "
const crypto = require('crypto');
const fs = require('fs');
const raw = fs.readFileSync('${ENV_FILE}', 'utf8');
const env = raw.split('\n').reduce((a, l) => {
  const eq = l.indexOf('=');
  if (eq > 0) { const k = l.slice(0, eq).trim(); a[k] = l.slice(eq + 1).trim(); }
  return a;
}, {});
const secret = env.JWT_SECRET || '';
const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const p = Buffer.from(JSON.stringify({ account: 'cron-sync', role: 'internal', iat: Math.floor(Date.now() / 1000) })).toString('base64url');
const sig = crypto.createHmac('sha256', secret).update(h + '.' + p).digest('base64url');
console.log(h + '.' + p + '.' + sig);
" 2>/dev/null)"

if [ -z "$JWT" ]; then
  echo "[$(date)] ERROR: Failed to generate JWT — check ENV_FILE path: ${ENV_FILE}"
  exit 1
fi

RESULT=$(curl -s -X POST https://api.sanlyn.cn/api/platform/exchange-rate \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json")

echo "[$(date)] rate sync result: $RESULT"
