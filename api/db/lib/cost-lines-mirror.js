// costLines=计价唯一源,镜像字段=派生缓存(运费中心蓝图 v1.4 决议①,2026-08-03)。
// 保存票据时从 raw.cost_lines 重算 freight_cost / freight_sale_usd;
// 没有可算的海运行(name 含"海运"且 USD 且 cost 非空)则什么都不动 —— 绝不清空既有值。
function money(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function num(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isOceanUsdLine(line) {
  const name = String(line?.name || "");
  const currency = String(line?.currency || "USD").trim().toUpperCase();
  return name.includes("海运") && (!currency || currency === "USD") && num(line?.cost) != null;
}

export function applyCostLinesMirror(rowPatch) {
  const lines = rowPatch?.raw?.cost_lines;
  if (!Array.isArray(lines)) return rowPatch;

  const oceanLines = lines.filter(isOceanUsdLine);
  if (!oceanLines.length) return rowPatch;

  rowPatch.freight_cost = money(oceanLines.reduce((sum, line) => sum + num(line.cost), 0));

  let hasSale = false;
  const sale = oceanLines.reduce((sum, line) => {
    const n = num(line.sale);
    if (n == null) return sum;
    hasSale = true;
    return sum + n;
  }, 0);
  if (hasSale) rowPatch.freight_sale_usd = money(sale);

  return rowPatch;
}
