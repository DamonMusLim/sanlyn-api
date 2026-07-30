function clean(v) {
  return String(v || "").trim().replace(/\s+/g, " ");
}

function key(v) {
  return clean(v).toUpperCase();
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(v) {
  return v === null ? null : Math.round(v * 100) / 100;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  var pos = (sorted.length - 1) * p;
  var lo = Math.floor(pos);
  var hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function moneyText(v, cur) {
  var prefix = key(cur || "CNY") === "CNY" ? "¥" : key(cur || "CNY") + " ";
  return prefix + Math.round(v).toLocaleString("zh-CN") + "/柜";
}

export function normalizeFeeCategory(v) {
  var s = key(v).replace(/[()\[\]（）【】\s-]/g, "");
  if (!s) return null;
  if (s.includes("THC")) return "THC";
  if (s.includes("文件") || s.includes("单证") || s.includes("DOC")) return "单证费";
  if (s.includes("封志") || s.includes("封签") || s.includes("铅封") || s.includes("SEAL")) return "封签费";
  if (s.includes("设备交接")) return "设备交接费";
  if (s.includes("VGM")) return "VGM";
  if (s.includes("订舱")) return "订舱费";
  if (s.includes("舱单")) return "舱单费";
  if (s.includes("操作")) return "操作费";
  if (s.includes("代理")) return "代理费";
  if (s.includes("提箱")) return "提箱费";
  if (s.includes("场站")) return "场站费";
  if (s.includes("港口包干") || s.includes("港杂") || s.includes("LOCAL")) return "港杂费";
  return null;
}

export function parseLocalChargeFees(rawFees) {
  var fees = rawFees || [];
  if (typeof fees === "string") {
    try { fees = JSON.parse(fees); } catch { fees = []; }
  }
  if (!Array.isArray(fees)) return [];
  return fees.map((f) => {
    var unit = num(f.unitPrice ?? f.unit_price);
    var amount = num(f.amount);
    var qty = num(f.qty);
    if ((unit === null || unit <= 0) && amount !== null && qty !== null && qty > 0) unit = amount / qty;
    if (unit === null || unit <= 0) return null;
    return {
      feeName: clean(f.feeName || f.name || f.cost_category),
      cost_category: normalizeFeeCategory(f.feeName || f.name || f.cost_category),
      unit_cost: roundMoney(unit),
      currency: clean(f.currency || "CNY") || "CNY",
      include_in_baseline: f.include_in_baseline !== false,
    };
  }).filter(Boolean);
}

function feeMessage(line, stats, cur) {
  if (line.verdict === "category_unmapped") return line.feeName + " 未映射历史费目·仅展示";
  if (line.verdict === "insufficient") return line.feeName + " 历史不足 " + stats.count + " 条·仅供参考";
  var base = line.feeName + " " + moneyText(line.unit_cost, cur);
  var hist = "历史最低" + moneyText(stats.robust_min, cur) + "/中位" + moneyText(stats.median, cur);
  if (line.verdict === "alert" && line.unit_cost > stats.max) {
    return base + " 高于历史最高 " + moneyText(stats.max, cur) + "（" + hist + "）";
  }
  var pct = stats.median ? Math.round((line.unit_cost / stats.median - 1) * 100) : 0;
  if (line.verdict === "alert") return base + " 高于历史中位 " + pct + "%（" + hist + "）";
  if (line.verdict === "warn") return base + " 高于历史中位 " + pct + "%（" + hist + "）";
  return base + " 历史价守卫通过（" + hist + "）";
}

export function summarizeFeeLine(line, samples, cur) {
  var unit = num(line.unit_cost);
  if (!line.cost_category) {
    return { ...line, verdict: "category_unmapped", history: null, message: feeMessage(line, {}, cur) };
  }
  var values = (samples || []).map((x) => x.compare_unit_price).filter((x) => x > 0).sort((a, b) => a - b);
  var stats = {
    count: values.length,
    min: roundMoney(values[0] ?? null),
    p10: roundMoney(percentile(values, 0.1)),
    p25: roundMoney(percentile(values, 0.25)),
    median: roundMoney(percentile(values, 0.5)),
    max: roundMoney(values[values.length - 1] ?? null),
  };
  stats.robust_min = stats.count >= 8 ? stats.p10 : stats.count >= 4 ? stats.p25 : stats.min;
  var verdict = "ok";
  if (!unit || stats.count < 3) verdict = "insufficient";
  else if (unit > stats.max || unit > stats.median * 1.2) verdict = "alert";
  else if (unit > stats.median * 1.1) verdict = "warn";
  return { ...line, verdict: verdict, history: stats, message: feeMessage({ ...line, verdict }, stats, cur) };
}

export function summarizePortFeeGuard(perFee) {
  var overpriced = perFee.filter((x) => x.verdict === "alert" || x.verdict === "warn").map((x) => x.feeName);
  var verdict = perFee.some((x) => x.verdict === "alert") ? "alert" : perFee.some((x) => x.verdict === "warn") ? "warn" : "ok";
  if (perFee.length && perFee.every((x) => x.verdict === "insufficient" || x.verdict === "category_unmapped")) verdict = "insufficient";
  var message = "港杂逐费目历史价守卫通过";
  if (verdict === "insufficient") message = "港杂逐费目历史不足·仅供参考";
  else if (overpriced.length) message = "港杂逐费目历史价守卫发现 " + overpriced.join("、");
  return {
    verdict: verdict,
    per_fee: perFee,
    overpriced: overpriced,
    count: perFee.reduce((sum, x) => sum + Number((x.history && x.history.count) || 0), 0),
    message: message,
    historySamples: [],
  };
}
