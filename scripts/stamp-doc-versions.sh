#!/usr/bin/env bash
# 部署时给单据模版盖版本号: v<N> · <部署时间戳(北京)>。N 存 scripts/doc-version.txt(手动升),时间戳每次部署自动更新。
# 用法: bash scripts/stamp-doc-versions.sh   (在 canonical/sanlyn-api 根目录)
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VER="v$(cat "$ROOT/scripts/doc-version.txt" 2>/dev/null || echo 1)"
TS="$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M')"
STAMP="$VER · $TS"
python3 - "$ROOT" "$STAMP" <<'PY'
import sys,re
root,stamp=sys.argv[1],sys.argv[2]
jobs=[
 ('public/templates/transfer-template.js', r'var TPL_VERSION = "[^"]*";', 'var TPL_VERSION = "%s";'%stamp, 1),
 ('public/templates/export-docs-template.html', r'Sanlyn OS Supply Chain Engine(?: · 模版 [^<]*)?', 'Sanlyn OS Supply Chain Engine · 模版 %s'%stamp, 0),
 ('api/db/customs-declaration-form.js', r'报关单模版 [^<]*', '报关单模版 %s'%stamp, 1),
 ('public/customs-collab-factory.html', r'对账页 v[^<]*', '对账页 %s'%stamp, 1),
]
for f,pat,rep,cnt in jobs:
    p=root+'/'+f; s=open(p,encoding='utf-8').read()
    s2=re.sub(pat,rep,s,count=cnt)
    open(p,'w',encoding='utf-8').write(s2); print('  stamped',f)
PY
echo "文档模版版本 = $STAMP"
