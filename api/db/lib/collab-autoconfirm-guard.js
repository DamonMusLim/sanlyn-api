// collab-autoconfirm-guard.js — "沉默=同意"护栏。
// 判每条费用 ETD 前能否默认确认。tier:
//   'auto'   绿 · 固定报价 · 开船前不点=默认确认
//   'confirm'橙 · 浮动/未报价/客户指定货代 · 必须主动确认,绝不自动
//   'never'  红 · 目的港/滞箱等到港后才产生 · 只提示不确认金额
// 铁律:保函/申报/VGM/单证类不是"费用",不走这里,永远主动确认(在各自块处理)。
const NEVER_RE = /目的港|destination|dest[_ ]?charge|滞港|滞箱|demurrage|detention|超期用箱|仓储|storage|堆存|港建|查验/i;
const FLOAT_RE = /附加|surcharge|\bbaf\b|\blss\b|低硫|\bebs\b|\bgri\b|\bpss\b|旺季|peak|拥堵|congestion|燃油|fuel|战争|war[_ ]?risk|苏伊士|巴拿马|运河/i;

export function classifyFeeLine(line, { externalLogistics = false, rateExpired = false } = {}) {
  const name = String((line && (line.name || line.cost_category)) || "").toLowerCase();
  const amt = Number(line && line.amount);
  const hasAmt = Number.isFinite(amt) && amt > 0;
  if (NEVER_RE.test(name)) return { tier: "never", reason: "到港后产生·金额未定" };
  if (!hasAmt) return { tier: "confirm", reason: "未报价·请补齐" };
  if (FLOAT_RE.test(name)) return { tier: "confirm", reason: "浮动附加费·需确认" };
  if (externalLogistics) return { tier: "confirm", reason: "客户指定货代·我方不代确认" };
  if (rateExpired) return { tier: "confirm", reason: "报价已过有效期·需重确认" };
  return { tier: "auto", reason: "固定报价·开船前不点默认确认" };
}

export function tagAutoConfirm(lines, ctx = {}) {
  if (!Array.isArray(lines)) return [];
  return lines.map(l => {
    const c = classifyFeeLine(l, ctx);
    return { ...l, ac_tier: c.tier, ac_reason: c.reason };
  });
}

// 整票能否走"沉默=同意":必须有打开回执(没打开不算看过),且有可自动确认的行。
export function canSheetAutoConfirm(lines, { openedAt } = {}) {
  if (!openedAt) return { ok: false, reason: "链接未被打开·不能默认确认" };
  const autoLines = (Array.isArray(lines) ? lines : []).filter(l => l && l.ac_tier === "auto");
  if (!autoLines.length) return { ok: false, reason: "无可默认确认项" };
  return { ok: true, autoCount: autoLines.length };
}
