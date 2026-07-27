#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:9000}"
API_DIR="${API_DIR:-/opt/sanlyn-api-test}"
PATCH="${PATCH:-/opt/taskcenter-engines/patches/patch_active_count.py}"

live_total="$(
  curl -fsS "$API_BASE/api/console/domain-counts" |
    node -e "let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const j=JSON.parse(s); console.log((j.data||[]).filter(r=>r.task_prefix!=='__OCEAN__').reduce((n,r)=>n+Number(r.total_count||0),0));})"
)"

truth_total="$(
  cd "$API_DIR"
  node - <<'NODE'
require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.query("SELECT COUNT(*)::int AS n FROM task_center_v WHERE status IN ('open','doing')")
  .then(r => { console.log(r.rows[0].n); })
  .finally(() => pool.end());
NODE
)"

if [ "$live_total" != "$truth_total" ]; then
  echo "domain-counts drift: live_total=$live_total truth_open_doing=$truth_total; reapplying active-count patch"
  python3 "$PATCH" "$API_DIR/api/db/console-views.cjs"
  cd "$API_DIR"
  pm2 restart sanlyn-api >/dev/null
else
  echo "domain-counts active-count ok: $live_total"
fi
