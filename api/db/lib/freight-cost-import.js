import { buildRateComparison, computeHistoryGuard } from "./freight-price-guard.js";
import { parseLocalChargeFees } from "./freight-fee-lines.js";

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

function inferCarrierFromBl(blNo, carrierMap) {
  var s = key(blNo);
  for (var len = 4; len >= 2; len--) {
    var p = s.slice(0, len);
    if (carrierMap.has(p)) return carrierMap.get(p);
  }
  return null;
}

function normCarrier(v, carrierMap, blNo) {
  var raw = clean(v);
  if (raw) {
    var k = key(raw);
    return { raw: raw, norm: carrierMap.get(k) || k, inferred: false };
  }
  var inferred = inferCarrierFromBl(blNo, carrierMap);
  return { raw: null, norm: inferred, inferred: Boolean(inferred) };
}

function qtyValue(v) {
  var n = num(v);
  return n && n > 0 ? n : null;
}

function sameAmount(rows, getter) {
  var vals = [...new Set(rows.map(getter).filter((v) => v !== null).map((v) => String(v)))];
  return vals.length === 1 ? num(vals[0]) : null;
}

function sourceList(rows, amountGetter) {
  return rows.slice(0, 12).map((r) => ({
    source_id: r.id || null,
    charge_code: r.charge_code || null,
    carrier: r.carrier || null,
    pol: r.pol || null,
    pod: r.pod || null,
    container_type: r.container_type || null,
    currency: r.currency || "CNY",
    unit_cost: amountGetter(r),
  }));
}

function total(unitCost, qty, warnings) {
  if (!qty) {
    warnings.push("缺柜数·不能汇总");
    return null;
  }
  return unitCost === null ? null : unitCost * qty;
}

function adoptedPort(row, ctx, level, confidence, warnings, loose) {
  var unitCost = num(row.cost_total);
  var subItems = parseLocalChargeFees(row.fees);
  if (ctx.carrier.inferred) warnings.push("carrier_inferred");
  if (!ctx.containerType) warnings.push("柜型缺失·待确认");
  if (loose) warnings.push("loose_same_amount");
  return {
    fee_item: "port_charge",
    status: "matched",
    unit_cost: unitCost,
    currency: "CNY",
    quantity: ctx.qty,
    total_cost: total(unitCost, ctx.qty, warnings),
    match_level: level,
    source_table: "local_charges",
    source_id: row.id || null,
    charge_code: row.charge_code || null,
    sub_items: subItems,
    confidence: confidence,
    warnings: warnings,
  };
}

function adoptedOcean(row, ctx, level, confidence, warnings, loose) {
  var unitCost = ctx.containerType === "20GP" ? num(row.gp20) : ctx.containerType === "40HQ" ? num(row.hq40) : null;
  if (ctx.carrier.inferred) warnings.push("carrier_inferred");
  if (loose) warnings.push("loose_same_amount");
  return {
    fee_item: "ocean",
    status: "matched",
    unit_cost: unitCost,
    currency: row.currency || null,
    quantity: ctx.qty,
    total_cost: total(unitCost, ctx.qty, warnings),
    match_level: level,
    source_table: "freight_rates",
    source_id: row.id || null,
    charge_code: null,
    confidence: confidence,
    warnings: warnings,
  };
}

function missing(feeItem, dimension, message, candidates) {
  return {
    fee_item: feeItem,
    status: "missing",
    unit_cost: null,
    currency: null,
    quantity: null,
    total_cost: null,
    match_level: null,
    source_table: null,
    source_id: null,
    charge_code: null,
    confidence: "none",
    warnings: [message],
    gap_dimension: dimension,
    candidates: candidates || [],
  };
}

function decidePort(rows, ctx) {
  var steps = [
    ["exact", (r) => r.pol_norm === ctx.pol.norm && r.pod_norm === ctx.pod.norm && r.carrier_norm === ctx.carrier.norm && r.ctype_norm === ctx.containerType],
    ["pod_family", (r) => ctx.pod.family && r.pol_norm === ctx.pol.norm && r.pod_family === ctx.pod.family && r.carrier_norm === ctx.carrier.norm && r.ctype_norm === ctx.containerType],
    ["no_carrier", (r) => r.pol_norm === ctx.pol.norm && r.pod_norm === ctx.pod.norm && r.ctype_norm === ctx.containerType],
    ["no_carrier_pod_family", (r) => ctx.pod.family && r.pol_norm === ctx.pol.norm && r.pod_family === ctx.pod.family && r.ctype_norm === ctx.containerType],
    ["no_container", (r) => r.pol_norm === ctx.pol.norm && r.pod_norm === ctx.pod.norm],
    ["no_container_pod_family", (r) => ctx.pod.family && r.pol_norm === ctx.pol.norm && r.pod_family === ctx.pod.family],
  ];
  for (var i = 0; i < steps.length; i++) {
    var level = steps[i][0];
    var matches = rows.filter(steps[i][1]).filter((r) => num(r.cost_total) !== null);
    if (!matches.length) continue;
    if (matches.length === 1) return adoptedPort(matches[0], ctx, level, i < 2 ? "high" : "medium", [], false);
    var same = sameAmount(matches, (r) => num(r.cost_total));
    if (same !== null) return adoptedPort(matches[0], ctx, level, "medium", [], true);
    return missing("port_charge", "local_charge_rate", "港杂费率多候选·待确认", sourceList(matches, (r) => num(r.cost_total)));
  }
  return missing("port_charge", "local_charge_rate", "缺该航线港杂费率·待录");
}

function rateAmount(row, ctype) {
  return ctype === "20GP" ? num(row.gp20) : ctype === "40HQ" ? num(row.hq40) : null;
}

function decideOcean(rows, ctx) {
  if (!ctx.containerType) return missing("ocean", "ocean_rate", "缺柜型·不能按柜型取海运价");
  var steps = [
    ["exact", (r) => r.pol_norm === ctx.pol.norm && r.pod_norm === ctx.pod.norm && r.carrier_norm === ctx.carrier.norm],
    ["pod_family", (r) => ctx.pod.family && r.pol_norm === ctx.pol.norm && r.pod_family === ctx.pod.family && r.carrier_norm === ctx.carrier.norm],
    ["no_carrier", (r) => r.pol_norm === ctx.pol.norm && r.pod_norm === ctx.pod.norm],
    ["no_carrier_pod_family", (r) => ctx.pod.family && r.pol_norm === ctx.pol.norm && r.pod_family === ctx.pod.family],
  ];
  for (var i = 0; i < steps.length; i++) {
    var level = steps[i][0];
    var matches = rows.filter(steps[i][1]).filter((r) => rateAmount(r, ctx.containerType) !== null);
    if (!matches.length) continue;
    matches.sort((a, b) => String(b.valid_from || "").localeCompare(String(a.valid_from || "")));
    if (matches.length === 1) return adoptedOcean(matches[0], ctx, level, i === 0 ? "high" : "medium", [], false);
    var same = sameAmount(matches, (r) => rateAmount(r, ctx.containerType));
    if (same !== null) return adoptedOcean(matches[0], ctx, level, "medium", [], true);
    return missing("ocean", "ocean_rate", "多运价候选·待选", sourceList(matches, (r) => rateAmount(r, ctx.containerType)));
  }
  return missing("ocean", "ocean_rate", "缺该航线费率·待录");
}

function rawJson(row) {
  if (!row || !row.raw) return {};
  if (typeof row.raw === "object") return row.raw;
  try { return JSON.parse(row.raw); } catch { return {}; }
}

function pick() {
  for (var i = 0; i < arguments.length; i++) {
    if (arguments[i] !== null && arguments[i] !== undefined && arguments[i] !== "") return arguments[i];
  }
  return null;
}

async function loadCarrierMap(pool) {
  var r = await pool.query(`
    SELECT upper(btrim(code)) AS raw, code FROM carriers
    UNION ALL
    SELECT upper(btrim(raw_upper)) AS raw, canonical_code AS code FROM carrier_aliases`);
  return new Map((r.rows || []).filter((x) => x.raw && x.code).map((x) => [x.raw, x.code]));
}

function normalizeChargeRows(rows, carrierMap) {
  return rows.map((r) => {
    var pod = normPort(r.pod);
    return { ...r, pol_norm: normPort(r.pol).norm, pod_norm: pod.norm, pod_family: pod.family,
      carrier_norm: normCarrier(r.carrier, carrierMap).norm, ctype_norm: normContainer(r.container_type) };
  });
}

function normalizeRateRows(rows, carrierMap) {
  return rows.map((r) => {
    var pod = normPort(r.pod);
    return { ...r, pol_norm: normPort(r.pol).norm, pod_norm: pod.norm, pod_family: pod.family,
      carrier_norm: normCarrier(r.carrier, carrierMap).norm };
  });
}

export async function importCostPreview(pool, input) {
  var plan = null;
  if (input.shipping_plan_id) {
    var pr = await pool.query(
      `SELECT * FROM shipping_plans
        WHERE id::text=$1 OR _id::text=$1
        ORDER BY created_at DESC NULLS LAST LIMIT 1`,
      [String(input.shipping_plan_id).trim()]
    );
    plan = pr.rows[0] || null;
  } else if (input.bl_no) {
    var br = await pool.query(
      `SELECT * FROM shipping_plans
        WHERE bl_no=$1 ORDER BY created_at DESC NULLS LAST LIMIT 1`,
      [String(input.bl_no).trim()]
    );
    plan = br.rows[0] || null;
  }
  if (!plan) return { status: "missing_context", items: [], warnings: ["未找到 shipment 上下文"], unmatched: [] };

  var raw = rawJson(plan);
  var carrierMap = await loadCarrierMap(pool);
  var ctx = {
    bl_no: pick(plan.bl_no, input.bl_no),
    shipping_plan_id: pick(plan.id, plan._id, input.shipping_plan_id),
    pol: normPort(pick(plan.pol, raw.pol)),
    pod: normPort(pick(plan.pod, raw.pod)),
    carrier: normCarrier(pick(plan.carrier_code, plan.shipping_line, raw.carrier, raw.shippingLine), carrierMap, pick(plan.bl_no, input.bl_no)),
    containerType: normContainer(pick(plan.container_type, raw.containerType, raw.ctnr_type)),
    qty: qtyValue(pick(plan.container_qty, raw.containerQty)),
    customer_company_code: pick(plan.customer_company_code, plan.company_code, plan.customer_code, raw.customerCompanyCode),
  };
  var warnings = [];
  if (!ctx.pol.norm) warnings.push("缺POL·不能匹配");
  if (!ctx.pod.norm) warnings.push("缺POD·不能匹配");
  if (!ctx.carrier.norm) warnings.push("缺船司·将仅尝试退carrier匹配");
  if (warnings.length) return { status: "missing_context", context: ctx, items: [], warnings: warnings, unmatched: [] };

  var [lc, fr] = await Promise.all([
    pool.query(`SELECT id, carrier, pol, pod, company_name, container_type, cost_total, charge_code, fees
                  FROM local_charges
                 WHERE (valid_until IS NULL OR valid_until >= CURRENT_DATE)
                   AND cost_total IS NOT NULL`),
    pool.query(`SELECT id, pol, pod, carrier, gp20, hq40, currency, valid_from, valid_to
                  FROM freight_rates
                 WHERE COALESCE(status,'') NOT IN ('withdrawn','expired')
                   AND (valid_to IS NULL OR valid_to >= CURRENT_DATE)`)
  ]);

  var items = [
    decidePort(normalizeChargeRows(lc.rows || [], carrierMap), ctx),
    decideOcean(normalizeRateRows(fr.rows || [], carrierMap), ctx),
  ];
  items = await Promise.all(items.map(async (item) => {
    if (item.status !== "matched" || num(item.unit_cost) === null) return item;
    try {
      var guard = await computeHistoryGuard(pool, {
        pol: ctx.pol.raw,
        pod: ctx.pod.raw,
        carrier: ctx.carrier.norm,
        fee_item: item.fee_item,
        container_type: ctx.containerType,
        unit_cost: item.unit_cost,
        currency: item.currency,
        sub_items: item.sub_items,
      });
      return { ...item, guard: guard };
    } catch (e) {
      return { ...item, guard: { verdict: "insufficient", count: 0, message: "历史守卫查询失败·仅供参考", error: e.message, historySamples: [] } };
    }
  }));
  items = await attachSaleSuggestions(pool, items, ctx);
  var rateComparison = await buildRateComparison(pool, {
    pol: ctx.pol.raw,
    pod: ctx.pod.raw,
    carrier: ctx.carrier.norm,
    container_type: ctx.containerType,
  });
  return {
    status: items.some((x) => x.status === "matched") ? "ok" : "missing",
    context: ctx,
    items: items,
    rate_comparison: rateComparison,
    warnings: items.flatMap((x) => x.warnings || []),
    unmatched: items.filter((x) => x.status === "missing"),
  };
}

async function attachSaleSuggestions(pool, items, ctx) {
  var feeItems = [...new Set((items || []).map((x) => x.fee_item).filter(Boolean))];
  if (!feeItems.length) return items;
  var customer = clean(ctx.customer_company_code);
  if (!customer || !ctx.pol.norm || !ctx.pod.norm || !ctx.containerType) {
    return items.map((item) => ({ ...item, sale: null, sale_label: "待你定" }));
  }
  var [fixedRows, dnaRows] = await Promise.all([
    pool.query(
      `SELECT bl_no, customer_company_code, pol, pod, container_type, fee_item,
              sale_amount, sale_currency, updated_at
         FROM ocean_sale_prices
        WHERE customer_company_code = $1
          AND container_type = $2
          AND fee_item = ANY($3)
          AND sale_amount IS NOT NULL
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 100`,
      [customer, ctx.containerType, feeItems]
    ).catch(() => ({ rows: [] })),
    pool.query(
      `SELECT customer_company_code, pol, pod, container_type, fee_item,
              suggested_sale, suggested_currency, sample_count, updated_at
         FROM ocean_sale_price_dna
        WHERE customer_company_code = $1
          AND container_type = $2
          AND fee_item = ANY($3)
        ORDER BY updated_at DESC NULLS LAST
        LIMIT 100`,
      [customer, ctx.containerType, feeItems]
    ).catch(() => ({ rows: [] })),
  ]);
  return items.map((item) => ({ ...item, ...saleForItem(item, ctx, fixedRows.rows, dnaRows.rows) }));
}

function saleForItem(item, ctx, fixedRows, dnaRows) {
  var fixed = (fixedRows || []).find((r) => routeMatches(r, ctx) && r.fee_item === item.fee_item);
  if (fixed && num(fixed.sale_amount) !== null) {
    return { sale: {
      amount: num(fixed.sale_amount),
      currency: fixed.sale_currency || item.currency || "CNY",
      source: "fixed",
      label: "固定价·" + clean(ctx.customer_company_code),
      bl_no: fixed.bl_no || null,
    }};
  }
  var dna = (dnaRows || []).find((r) => routeMatches(r, ctx) && r.fee_item === item.fee_item);
  if (dna && Number(dna.sample_count || 0) >= 3 && num(dna.suggested_sale) !== null) {
    return { sale: {
      amount: num(dna.suggested_sale),
      currency: dna.suggested_currency || item.currency || "CNY",
      source: "dna",
      label: "DNA建议·" + Number(dna.sample_count || 0) + "次",
    }};
  }
  if (dna) {
    return {
      sale: null,
      sale_hint: {
        source: "dna",
        label: "DNA样本不足·" + Number(dna.sample_count || 0) + "次",
        sample_count: Number(dna.sample_count || 0),
      },
      sale_label: "待你定",
    };
  }
  if (item.fee_item === "port_charge" && num(item.unit_cost) !== null) {
    return { sale: {
      amount: num(item.unit_cost),
      currency: item.currency || "CNY",
      source: "passthrough·代收代付",
      label: "passthrough·代收代付",
    }};
  }
  return { sale: null, sale_label: "待你定" };
}

function routeMatches(row, ctx) {
  var pol = normPort(row.pol);
  var pod = normPort(row.pod);
  return pol.norm === ctx.pol.norm && (pod.norm === ctx.pod.norm || (ctx.pod.family && pod.family === ctx.pod.family));
}
