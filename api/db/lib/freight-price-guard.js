import { normalizeFeeCategory, summarizeFeeLine, summarizePortFeeGuard } from "./freight-fee-lines.js";

const PORT_KLANG_FAMILY = "PORT_KLANG_FAMILY";

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

function normContainer(v) {
  var s = key(v).replace(/[\s-]/g, "");
  if (!s) return null;
  if (s === "20" || s === "20GP" || s === "GP20") return "20GP";
  if (s === "40HC" || s === "40HQ" || s === "HQ40" || s === "40H" || s === "45HQ") return "40HQ";
  return null;
}

function normPort(v) {
  var raw = clean(v);
  var k = key(raw);
  if (!k) return { raw: null, norm: null, family: null };
  if (["PORT KLANG", "PORTKLANG", "WESTPORT", "NORTHPORT", "PORT KLANG NORTH", "PORT KLANG WEST"].includes(k)) {
    return { raw: raw, norm: k, family: PORT_KLANG_FAMILY };
  }
  if (k.includes("PORT KLANG") || k.includes("WESTPORT") || k.includes("NORTHPORT")) {
    return { raw: raw, norm: k, family: PORT_KLANG_FAMILY };
  }
  return { raw: raw, norm: k, family: null };
}

function routeMatch(row, ctx) {
  var pol = normPort(row.pol);
  var pod = normPort(row.pod);
  return pol.norm === ctx.pol.norm && (pod.norm === ctx.pod.norm || (ctx.pod.family && pod.family === ctx.pod.family));
}

function normFee(v) {
  var s = key(v);
  if (!s) return "other";
  if (s.includes("OCEAN") || s.includes("海运") || s.includes("运费")) return "ocean";
  if (s.includes("港杂") || s.includes("THC") || s.includes("LOCAL") || s.includes("文件") || s.includes("DOC") ||
      s.includes("铅封") || s.includes("SEAL") || s.includes("VGM") || s.includes("舱单") || s.includes("设备")) {
    return "port_charge";
  }
  return "other";
}

function safeUnit(row) {
  var u = num(row.unit_price);
  if (u !== null && u > 0) return u;
  var amount = num(row.amount);
  var qty = num(row.qty);
  if (amount !== null && qty !== null && qty > 0) return amount / qty;
  return null;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  var pos = (sorted.length - 1) * p;
  var lo = Math.floor(pos);
  var hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function roundMoney(v) {
  return v === null ? null : Math.round(v * 100) / 100;
}

function currency(v) {
  return key(v || "CNY") || "CNY";
}

async function loadFx(pool) {
  var r = await pool.query(
    `SELECT DISTINCT ON (currency_pair) currency_pair, rate
       FROM exchange_rates
      WHERE fetched_at::date = CURRENT_DATE
      ORDER BY currency_pair, fetched_at DESC NULLS LAST`
  );
  var map = new Map();
  (r.rows || []).forEach((x) => {
    var rate = num(x.rate);
    if (x.currency_pair && rate && rate > 0) map.set(key(x.currency_pair), rate);
  });
  return map;
}

function toCny(amount, cur, fx) {
  cur = currency(cur);
  if (cur === "CNY" || cur === "RMB") return amount;
  var direct = fx.get(cur + "_CNY");
  if (direct) return amount * direct;
  var inverse = fx.get("CNY_" + cur);
  if (inverse) return amount / inverse;
  return null;
}

function moneyText(v, cur) {
  var prefix = currency(cur) === "CNY" ? "¥" : currency(cur) + " ";
  return prefix + Math.round(v).toLocaleString("zh-CN") + "/柜";
}

function buildMessage(verdict, stats, unitCost, cur, scarce) {
  if (verdict === "insufficient") return "历史不足 " + stats.count + " 条，仅供参考；请人工确认";
  var note = scarce ? "样本较少；" : "";
  if (verdict === "alert" && unitCost > stats.max) {
    return note + "高于历史最高价，历史最高 " + moneyText(stats.max, cur) + "，本次 " + moneyText(unitCost, cur) + "，疑似乱加价";
  }
  var pct = stats.median ? Math.round((unitCost / stats.median - 1) * 100) : 0;
  if (verdict === "alert") {
    return note + "高于历史中位数 " + pct + "%，历史中位 " + moneyText(stats.median, cur) + "，本次 " + moneyText(unitCost, cur) + "，疑似乱加价";
  }
  if (verdict === "warn") {
    return note + "高于历史中位数 " + pct + "%，历史中位 " + moneyText(stats.median, cur) + "，本次 " + moneyText(unitCost, cur);
  }
  if (verdict === "low") {
    return note + "低于历史中位数 " + Math.abs(pct) + "%，确认是否费用件缺项或供应商漏收";
  }
  return note + "历史价守卫通过，历史中位 " + moneyText(stats.median, cur);
}

function summarize(samples, unitCost, cur, feeItem) {
  var values = samples.map((x) => x.compare_unit_price).sort((a, b) => a - b);
  var stats = {
    count: values.length,
    median: roundMoney(percentile(values, 0.5)),
    avg: roundMoney(values.reduce((a, b) => a + b, 0) / values.length),
    min: roundMoney(values[0]),
    max: roundMoney(values[values.length - 1]),
    p75: roundMoney(percentile(values, 0.75)),
    latest_price: roundMoney(samples[0] ? samples[0].compare_unit_price : null),
  };
  var verdict = "ok";
  if (stats.count < 3) verdict = "insufficient";
  else {
    var scarce = stats.count < 5;
    var warnLine = feeItem === "port_charge" ? 1.05 : 1.1;
    var alertLine = feeItem === "port_charge" ? 1.1 : 1.2;
    if (unitCost > stats.max || unitCost > stats.median * alertLine) verdict = "alert";
    else if (unitCost > stats.median * warnLine) verdict = "warn";
    else if (unitCost < stats.median * 0.8) verdict = "low";
    stats.sample_warning = scarce ? "样本较少" : null;
  }
  return {
    verdict: verdict,
    median: stats.median,
    avg: stats.avg,
    min: stats.min,
    max: stats.max,
    p75: stats.p75,
    latest_price: stats.latest_price,
    count: stats.count,
    currency: cur,
    message: buildMessage(verdict, stats, unitCost, cur, stats.sample_warning),
    historySamples: samples.slice(0, 10).map((x) => ({
      date: x.date,
      unit_price: roundMoney(x.compare_unit_price),
      original_unit_price: roundMoney(x.unit_price),
      currency: x.currency,
      carrier: x.carrier,
      source: x.source,
      fx_converted: x.fx_converted,
    })),
  };
}

function collectBillSamples(rows, ctx, feeItem) {
  var grouped = new Map();
  (rows || []).forEach((r) => {
    if (!routeMatch(r, ctx)) return;
    if (key(r.carrier) !== ctx.carrier.norm) return;
    if (normContainer(r.container_type) !== ctx.containerType) return;
    if (normFee(r.cost_category) !== feeItem) return;
    var unit = safeUnit(r);
    if (unit === null || unit <= 0) return;
    var id = feeItem === "port_charge" ? [r.bl_no || r.id || Math.random(), currency(r.currency)].join(":") : (r.id || r.bl_no || Math.random());
    var g = grouped.get(id) || { unit_price: 0, row: r };
    g.unit_price += unit;
    grouped.set(id, g);
  });
  return [...grouped.values()].map((g) => ({
    date: g.row.sample_date,
    unit_price: g.unit_price,
    currency: currency(g.row.currency),
    carrier: g.row.carrier,
    source: g.row.source,
  }));
}

function collectRateHistorySamples(rows, ctx) {
  return (rows || []).filter((r) => routeMatch(r, ctx) && key(r.carrier) === ctx.carrier.norm).map((r) => {
    var unit = ctx.containerType === "20GP" ? num(r.prev_gp20) : num(r.prev_hq40);
    if (unit === null || unit <= 0) return null;
    return { date: r.changed_at, unit_price: unit, currency: currency(r.currency), carrier: r.carrier, source: "freight_rates_history" };
  }).filter(Boolean);
}

function collectFeeLineSamples(rows, feeCategory) {
  return (rows || []).map((r) => {
    if (normalizeFeeCategory(r.cost_category) !== feeCategory) return null;
    var unit = safeUnit(r);
    if (unit === null || unit <= 0) return null;
    return {
      date: r.sample_date,
      unit_price: unit,
      compare_unit_price: unit,
      currency: currency(r.currency),
      carrier: r.carrier,
      source: r.source,
    };
  }).filter(Boolean);
}

function comparableSamples(samples, unitCost, inputCurrency, fx) {
  var cur = currency(inputCurrency);
  var same = samples.filter((s) => currency(s.currency) === cur).map((s) => ({ ...s, compare_unit_price: s.unit_price, fx_converted: false }));
  if (same.length >= 3) return { samples: same, unitCost: unitCost, currency: cur };
  var inputCny = toCny(unitCost, cur, fx);
  if (inputCny === null) return { samples: same, unitCost: unitCost, currency: cur };
  var converted = [];
  samples.forEach((s) => {
    var cny = toCny(s.unit_price, s.currency, fx);
    if (cny !== null) converted.push({ ...s, compare_unit_price: cny, fx_converted: currency(s.currency) !== "CNY" });
  });
  return converted.length > same.length ? { samples: converted, unitCost: inputCny, currency: "CNY" } : { samples: same, unitCost: unitCost, currency: cur };
}

export async function computeHistoryGuard(pool, input) {
  var unitCost = num(input.unit_cost);
  var subItems = Array.isArray(input.sub_items) ? input.sub_items : [];
  var ctx = {
    pol: normPort(input.pol),
    pod: normPort(input.pod),
    carrier: { norm: key(input.carrier) },
    containerType: normContainer(input.container_type),
  };
  if (!unitCost || !ctx.pol.norm || !ctx.pod.norm || !ctx.carrier.norm) {
    return { verdict: "insufficient", count: 0, message: "历史守卫上下文不足·仅供参考", historySamples: [] };
  }
  if (input.fee_item === "port_charge" && !subItems.length) {
    return { verdict: "insufficient", count: 0, message: "港杂缺费目拆项·不做整柜混合历史比较", historySamples: [] };
  }
  var activeBillSql = `
    SELECT b.id::text, b.bl_no, b.cost_category, b.amount, b.qty, b.unit_price, b.currency,
           COALESCE(b.created_at, sp.created_at) AS sample_date,
           sp.pol, sp.pod, sp.container_type, COALESCE(sp.carrier_code, sp.shipping_line) AS carrier, $1 AS source
      FROM active_freight_supplier_bills b
      JOIN shipping_plans sp ON sp.bl_no = b.bl_no
     WHERE COALESCE(b.rebill_status,'') <> 'voided'
       AND COALESCE(b.created_at, sp.created_at, now()) >= now() - interval '24 months'
       AND b.unit_price IS NOT NULL
     ORDER BY COALESCE(b.created_at, sp.created_at) DESC NULLS LAST
     LIMIT 500`;
  var legacyBillSql = activeBillSql.replace("active_freight_supplier_bills", "freight_supplier_bills").replace("b.unit_price IS NOT NULL", "b.unit_price IS NULL");
  var [activeRows, legacyRows, rateRows, fx] = await Promise.all([
    pool.query(activeBillSql, ["active_freight_supplier_bills"]),
    pool.query(legacyBillSql, ["freight_supplier_bills"]),
    input.fee_item === "ocean" ? pool.query(
      `SELECT h.prev_gp20, h.prev_hq40, h.changed_at, f.pol, f.pod, f.carrier, f.currency
         FROM freight_rates_history h
         JOIN freight_rates f ON f.id = h.rate_id
        WHERE h.changed_at >= now() - interval '24 months'
        ORDER BY h.changed_at DESC LIMIT 300`
    ) : Promise.resolve({ rows: [] }),
    loadFx(pool).catch(() => new Map()),
  ]);
  if (input.fee_item === "port_charge" && subItems.length) {
    var perFee = subItems.map((line) => {
      var cur = currency(line.currency || input.currency);
      var category = line.cost_category || normalizeFeeCategory(line.feeName);
      var samples = collectFeeLineSamples(activeRows.rows, category).filter((s) => currency(s.currency) === cur);
      return summarizeFeeLine({ ...line, cost_category: category }, samples, cur);
    });
    return summarizePortFeeGuard(perFee);
  }
  var samples = collectBillSamples(activeRows.rows, ctx, input.fee_item)
    .concat(collectBillSamples(legacyRows.rows, ctx, input.fee_item))
    .concat(collectRateHistorySamples(rateRows.rows, ctx))
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
    .slice(0, 100);
  var cmp = comparableSamples(samples, unitCost, input.currency, fx);
  if (cmp.samples.length < 1) return { verdict: "insufficient", count: 0, message: "无同币种/可换算历史样本·仅供参考", historySamples: [] };
  return summarize(cmp.samples, cmp.unitCost, cmp.currency, input.fee_item);
}

function comparisonRow(row, feeItem, ctype, currentCarrier) {
  var unit = feeItem === "port_charge" ? num(row.cost_total) : ctype === "20GP" ? num(row.gp20) : num(row.hq40);
  if (unit === null) return null;
  return {
    carrier: row.carrier || null,
    container_type: ctype,
    unit_cost: unit,
    currency: row.currency || "CNY",
    source: feeItem === "port_charge" ? "local_charges" : "freight_rates",
    is_current: key(row.carrier) === key(currentCarrier),
  };
}

export async function buildRateComparison(pool, input) {
  var ctx = { pol: normPort(input.pol), pod: normPort(input.pod) };
  var ctype = normContainer(input.container_type);
  if (!ctx.pol.norm || !ctx.pod.norm || !ctype) return { port_charge: [], ocean: [] };
  var [lc, fr] = await Promise.all([
    pool.query(`SELECT carrier, pol, pod, container_type, cost_total, 'CNY' AS currency
                  FROM local_charges
                 WHERE (valid_until IS NULL OR valid_until >= CURRENT_DATE)
                   AND cost_total IS NOT NULL`),
    pool.query(`SELECT carrier, pol, pod, gp20, hq40, currency
                  FROM freight_rates
                 WHERE COALESCE(status,'') NOT IN ('withdrawn','expired')
                   AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`)
  ]);
  var port = (lc.rows || []).filter((r) => routeMatch(r, ctx) && normContainer(r.container_type) === ctype)
    .map((r) => comparisonRow(r, "port_charge", ctype, input.carrier)).filter(Boolean);
  var ocean = (fr.rows || []).filter((r) => routeMatch(r, ctx))
    .map((r) => comparisonRow(r, "ocean", ctype, input.carrier)).filter(Boolean);
  var byPrice = (a, b) => a.unit_cost - b.unit_cost;
  return { port_charge: port.sort(byPrice), ocean: ocean.sort(byPrice) };
}
