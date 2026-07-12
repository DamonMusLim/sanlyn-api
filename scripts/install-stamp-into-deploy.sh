#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# install-stamp-into-deploy.sh — 把"部署前自动盖版本戳"根治进部署唯一入口
#
# 背景: 单据模版页脚 v<N>·<部署时间戳> 靠 scripts/stamp-doc-versions.sh 手动盖,
#       曾因部署时忘跑盖戳 → 时间戳漂移(旧戳看着像新的)。此脚本把盖戳调用幂等地
#       插进 ~/bin/deploy-sanlyn-api 顶部,以后每次部署自动先盖戳,不再靠人记。
#
# 安全: ①先备份 deploy 脚本 ②幂等(插过就跳过) ③插入后 bash -n 语法校验,过了才落地
#       ④盖戳失败不阻断部署(|| 提示) ⑤本脚本只改 deploy 脚本本身,不触发任何部署
# 用法: bash ~/canonical/sanlyn-api/scripts/install-stamp-into-deploy.sh
#       可选参数1 = deploy 脚本路径(默认 ~/bin/deploy-sanlyn-api)
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

DEPLOY="${1:-$HOME/bin/deploy-sanlyn-api}"
STAMP="$HOME/canonical/sanlyn-api/scripts/stamp-doc-versions.sh"
MARK="# >>> predeploy auto-stamp (stamp-doc-versions) >>>"
ENDMARK="# <<< predeploy auto-stamp <<<"

[ -f "$DEPLOY" ] || { echo "❌ 找不到部署脚本: $DEPLOY — 请把路径作为参数1传入"; exit 1; }
[ -f "$STAMP" ]  || { echo "❌ 找不到盖戳脚本: $STAMP"; exit 1; }

if grep -qF "$MARK" "$DEPLOY"; then
  echo "✓ 盖戳步骤已存在, 幂等跳过 ($DEPLOY)"
  exit 0
fi

BAK="$DEPLOY.bak-predeploy-stamp-$(date +%Y%m%d-%H%M%S)"
cp "$DEPLOY" "$BAK"
echo "🗄  已备份: $BAK"

BLOCK="$MARK
bash \"$STAMP\" || echo \"[predeploy] 盖戳失败(不阻断部署)\" >&2
$ENDMARK"

TMP="$(mktemp)"
first_line="$(head -n1 "$DEPLOY")"
if printf '%s' "$first_line" | grep -q '^#!'; then
  # 有 shebang: 插在 shebang 之后
  { head -n1 "$DEPLOY"; printf '%s\n' "$BLOCK"; tail -n +2 "$DEPLOY"; } > "$TMP"
else
  # 无 shebang: 补 shebang + 盖戳块 再接原内容
  { printf '#!/bin/bash\n%s\n' "$BLOCK"; cat "$DEPLOY"; } > "$TMP"
fi

if bash -n "$TMP"; then
  chmod +x "$TMP"
  mv "$TMP" "$DEPLOY"
  chmod +x "$DEPLOY"
  echo "✅ 已插入盖戳步骤到 $DEPLOY:"
  grep -n -A2 -F "$MARK" "$DEPLOY" || true
  echo "↩  如需回滚: cp \"$BAK\" \"$DEPLOY\""
else
  echo "❌ 插入后语法校验失败, 已放弃(原脚本未改动, 备份在 $BAK)"
  rm -f "$TMP"
  exit 1
fi
