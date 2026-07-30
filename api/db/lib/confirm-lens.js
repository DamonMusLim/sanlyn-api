import { resolveCompany } from "./company-code-resolve.js";

const ROLE_POLICIES = {
  customer_booking: { role: "customer", side: "receivable", segment: "customer" },
  shipper_booking: { role: "shipper", side: "receivable", segment: "port_charge" },
  factory_booking: { role: "supplier", side: "payable", segment: "factory" },
  trucking_booking: { role: "supplier", side: "payable", segment: "truck" },
  broker_booking: { role: "supplier", side: "payable", segment: "customs" },
  supplier_portal: { role: "supplier", side: "payable", segment: "supplier" },
};

export function clean(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

export function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

export function parseJson(v, fallback) {
  if (!v) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

export function matchFactory(label, factory) {
  const a = clean(label).toLowerCase();
  const b = clean(factory).toLowerCase();
  return !!a && !!b && (a.includes(b) || b.includes(a));
}

export function classifyFobScope(canonicalCategory, costCategory) {
  const canonical = clean(canonicalCategory, 80).toLowerCase();
  const label = clean(costCategory, 120).toLowerCase();
  const has = (pattern) => pattern.test(label);

  if (["ocean_freight", "rail_freight", "barge_freight", "fuel_surcharge"].includes(canonical)) return "freight";
  if (!canonical && has(/海运|运费|铁路|驳船|燃油|baf|ocean|freight/i)) return "freight";
  if (canonical === "customs_declaration") return "declaration";
  if (!canonical && has(/报关|申报|清关|customs/i)) return "declaration";
  if (!canonical && has(/目的港|destination|dthc|进口港/i)) return "destination";
  if (["storage", "detention", "pending"].includes(canonical)) return "review";
  if (!canonical && has(/仓储|滞港|滞箱|堆存/i)) return "review";
  if ([
    "doc", "thc", "booking", "seal", "vgm", "eir", "telex_fee", "manifest",
    "edi", "isps_security", "chc", "agency", "port_charge", "ptf",
  ].includes(canonical)) return "origin";
  if (!canonical && has(/单证|文件|码头|订舱|订仓|封签|铅封|设备交接|电放|放单|舱单|安全|港杂|代理|操作|thc|vgm|eir|edi|isps|chc|doc|seal|booking|telex|manifest/i)) return "origin";
  return "review";
}

function isPassThroughRemark(...values) {
  return values.some(v => /代收代付|客户承担|客户付|客付|rebill|pass.?through/i.test(clean(v, 300)));
}

function isExporterAbsorbedReceivable(name, scope) {
  if (scope === "declaration" || scope === "destination") return true;
  return /拖车|报关|清关|truck|customs/i.test(clean(name, 120));
}

function receivableAmount(row, scope) {
  const name = row.cost_category || row.name || "";
  if (isExporterAbsorbedReceivable(name, scope)) return { amount: 0, review: false };
  const sale = money(row.sale_amount ?? row.sale);
  const cost = money(row.amount ?? row.cost);
  if (sale > 0) return { amount: sale, review: scope === "review" };
  const status = clean(row.rebill_status, 40).toLowerCase();
  const raw = parseJson(row.raw, {});
  const passThrough = ["rebilled_to_customer", "rebill", "direct"].includes(status) ||
    isPassThroughRemark(row.remarks, row.remark, raw?.note, raw?.remark);
  if (passThrough && cost > 0) return { amount: cost, review: scope === "review" };
  return { amount: 0, review: false };
}

function hasNumeric(v) {
  return v !== null && v !== undefined && String(v).trim() !== "" && Number.isFinite(Number(v));
}

function billBasisLabel(v) {
  const raw = clean(v, 40);
  const basis = raw.toLowerCase();
  if (basis === "per_container" || /每柜|per.?container|container/.test(basis)) return "每柜";
  if (basis === "per_bl" || basis === "per_shipment" || /整票|每票|per.?bl|shipment|票/.test(basis)) return "整票";
  return raw || "整票";
}

export function partyLens(ctx, sp) {
  if (ctx.internal) {
    const p = clean(ctx.party, 20);
    const internalPayable = {
      ocean: { code: sp.forwarder_code, name: sp.forwarder_name },
      truck: { code: sp.trucking_code, name: sp.trucking_name },
      customs: { code: sp.broker_code, name: sp.broker_name },
      factory: { code: sp.party_company?.code, name: sp.party_company?.name_cn || sp.party_company?.factory_name },
    };
    if (Object.prototype.hasOwnProperty.call(internalPayable, p)) {
      return { role: "internal", side: "payable", code: clean(internalPayable[p].code, 40), name: clean(internalPayable[p].name, 120), segment: p };
    }
    return { role: "internal", side: "all", code: null, segment: "all" };
  }
  const policy = ROLE_POLICIES[ctx.role] || ROLE_POLICIES.supplier_portal;
  const segment = ctx.role === "supplier_portal" ? ((ctx.meta?.segments || [])[0] || policy.segment) : policy.segment;
  const code = {
    customer_booking: sp.customer_code,
    shipper_booking: sp.party_company?.code,
    trucking_booking: sp.trucking_code,
    broker_booking: sp.broker_code,
    factory_booking: sp.party_company?.code,
    supplier_portal: sp.party_company?.code,
  }[ctx.role];
  return { ...policy, code: clean(code, 40), segment };
}

async function canonicalCode(pool, value, cache) {
  const key = clean(value, 120);
  if (!key) return "";
  const upper = key.toUpperCase();
  if (cache.has(upper)) return cache.get(upper);
  const company = await resolveCompany(pool, key);
  const code = clean(company?.code || key, 40).toUpperCase();
  cache.set(upper, code);
  return code;
}

async function sameCompanyCode(pool, left, right, cache) {
  const a = await canonicalCode(pool, left, cache);
  const b = await canonicalCode(pool, right, cache);
  return !!a && !!b && a === b;
}

async function lineVisibleForLens(pool, row, lens, cache) {
  if (lens.role === "internal") return true;
  if (!lens.code) return false;
  const direction = clean(row.direction, 16).toLowerCase();
  const ownership = clean(row.ownership_scope, 16).toLowerCase();
  if (lens.side === "receivable") {
    if (!["receivable", "both"].includes(direction)) return false;
    const counterparty = row.counterparty_company_code || row.payer_company_code;
    return sameCompanyCode(pool, counterparty, lens.code, cache);
  }
  if (lens.side === "payable") {
    if (direction === "receivable") return false;
    if (["supplier", "ocean"].includes(lens.segment) && direction !== "payable") return false;
    if (["supplier", "ocean"].includes(lens.segment) && ownership && !["logistics", "shared"].includes(ownership)) return false;
    return sameCompanyCode(pool, row.supplier_company_code, lens.code, cache);
  }
  return false;
}

export async function defaultLines(pool, sp, ctx) {
  const blNo = clean(sp.bl_no || sp.hbl_no || sp.shipment_no || "", 80);
  const lens = partyLens(ctx, sp);
  const exwTransfer = clean(sp.freight_term, 20).toUpperCase() === "EXW";
  if (!blNo || (lens.role !== "internal" && !lens.code)) return { lines: [], exwTransfer, lens };
  if (ctx.internal && lens.side === "payable" && lens.segment === "factory" && !lens.code) return { lines: [], exwTransfer, lens };

  const params = [blNo];
  const where = ["bl_no=$1"];
  if (lens.side === "payable") {
    const supConds = [];
    if (lens.code && lens.role === "internal") {
      params.push(lens.code);
      supConds.push(`supplier_company_code=$${params.length}`);
    }
    if (lens.name) {
      params.push(lens.name);
      supConds.push(`supplier=$${params.length}`);
    }
    if (supConds.length) where.push(`(${supConds.join(" OR ")})`);
    where.push("COALESCE(amount,0)>0");
  } else if (lens.side === "receivable") {
    where.push("COALESCE(sale_amount, amount,0)>0");
    if (lens.segment === "port_charge") {
      where.push("TRUE");
    } else {
      params.push(lens.code);
      where.push(`(payer_company_code=$${params.length} OR counterparty_company_code=$${params.length} OR COALESCE(rebill_status,'') IN ('rebilled_to_customer','rebill','direct'))`);
    }
  } else {
    where.push("(COALESCE(amount,0)>0 OR COALESCE(sale_amount,0)>0)");
  }
  const r = await pool.query(
    `SELECT bl_no, cost_category, canonical_category, fob_scope,
            amount, sale_amount, currency, unit_price, qty, charge_basis,
            supplier, supplier_company_code, payer_company_code,
            direction, counterparty_company_code, ownership_scope, rebill_status, remarks, raw
       FROM active_freight_supplier_bills
      WHERE ${where.join(" AND ")}
      ORDER BY id`,
    params
  );

  const customsArrange = clean(sp.customs_arrange, 20).toLowerCase();
  const codeCache = new Map();
  const lines = [];
  for (const row of r.rows) {
    if (!(await lineVisibleForLens(pool, row, lens, codeCache))) continue;
    const scope = clean(row.fob_scope, 16) || classifyFobScope(row.canonical_category, row.cost_category);
    if (ctx.internal && !internalSegmentMatch(lens.segment, row.cost_category, scope)) continue;
    const receivable = lens.side === "receivable" ? receivableAmount(row, scope) : null;
    if (lens.side === "receivable" && receivable.amount <= 0) continue;
    if (lens.role === "customer" && scope !== "freight") continue;
    if (lens.role === "supplier" && Number(row.amount || 0) <= 0) continue;
    if (lens.side === "receivable" && !["freight", "origin", "review"].includes(scope)) continue;
    if (ctx.role === "factory_booking" && !ctx.internal) {
      if (scope === "freight" || scope === "destination") continue;
      if (scope === "declaration" && customsArrange === "factory") continue;
    }
    const visibleAmount = lens.side === "receivable" ? receivable.amount : row.amount;
    const basis = billBasisLabel(row.charge_basis);
    const line = baseLine(row.bl_no || blNo, row.cost_category || "港杂费", basis, visibleAmount, row.currency, scope, lens);
    line.unit_price = hasNumeric(row.unit_price) ? money(row.unit_price) : null;
    line.qty = basis === "每柜" ? (hasNumeric(row.qty) ? money(row.qty) : null) : 1;
    if (receivable?.review) line.review = true;
    if (lens.role === "internal") addInternalAmounts(line, row.amount, row.sale_amount);
    lines.push(line);
  }
  if (!lines.length && Array.isArray(sp.cost_lines) && sp.cost_lines.length && (ctx.internal || ["factory_booking", "trucking_booking", "broker_booking"].includes(ctx.role))) {
    addRawCostLines(lines, sp.cost_lines, blNo, lens, ctx, customsArrange);
  }
  return { lines, exwTransfer, lens };
}

function internalSegmentMatch(segment, name, scope) {
  if (!["ocean", "truck", "customs", "factory"].includes(segment)) return true;
  const label = clean(name, 120);
  if (segment === "ocean") return scope === "freight" || scope === "origin" || /海运|运费|港杂|码头|THC|订舱|单证|封签|VGM|EIR|telex|manifest|ocean|freight|port|local/i.test(label);
  if (segment === "truck") return /拖车|车队|提柜|还柜|truck|trucking|haul/i.test(label);
  if (segment === "customs") return scope === "declaration" || /报关|申报|清关|customs|declaration/i.test(label);
  return true;
}

function baseLine(blNo, name, basis, amount, currency, scope, lens) {
  return {
    bl_no: clean(blNo, 80),
    name: clean(name, 80),
    basis: clean(basis, 24),
    unit_price: null,
    qty: null,
    amount: money(amount),
    currency: clean(currency || "CNY", 8).toUpperCase(),
    fob_scope: scope,
    review: scope === "review",
    segment: lens.segment,
    line_side: lens.side,
  };
}

function addInternalAmounts(line, cost, sale) {
  line.cost_amount = money(cost);
  line.sale_amount = money(sale);
  line.gross_profit = money(Number(sale || 0) - Number(cost || 0));
}

function addRawCostLines(lines, costLines, blNo, lens, ctx, customsArrange) {
  for (const cl of costLines) {
    const name = clean(cl.name, 80); if (!name) continue;
    const cost = money(cl.cost), sale = money(cl.sale);
    const scope = classifyFobScope("", name);
    if (ctx.internal && !internalSegmentMatch(lens.segment, name, scope)) continue;
    const receivable = lens.side === "receivable" ? receivableAmount({ ...cl, amount: cost, sale_amount: sale, cost_category: name }, scope) : null;
    if (!ctx.internal) {
      if (lens.side === "receivable" && receivable.amount <= 0) continue;
      if (lens.role === "supplier" && cost <= 0) continue;
      if (lens.side === "receivable" && !["freight", "origin", "review"].includes(scope)) continue;
      if (ctx.role === "factory_booking") {
        if (scope === "freight" || scope === "destination") continue;
        if (scope === "declaration" && customsArrange === "factory") continue;
      }
    }
    const visibleAmount = lens.side === "receivable" ? receivable.amount : lens.side === "payable" ? cost : (sale || cost);
    const line = baseLine(blNo, name, "整票", visibleAmount, cl.currency, scope, lens);
    line.from_raw = true;
    if (receivable?.review) line.review = true;
    if (lens.role === "internal") addInternalAmounts(line, cost, sale);
    lines.push(line);
  }
}

export async function loadLaneBenchmarks(pool, sp, lens) {
  const carrier = clean(sp.carrier_code || sp.shipping_line || sp.forwarder_name, 80);
  const pol = clean(sp.pol, 100), pod = clean(sp.pod, 100), ct = clean(sp.container_type || "40HC", 20);
  const out = { localCharge: null, freightRate: null };
  if (!carrier || !pol || !pod) return out;
  const lc = await pool.query(
    `SELECT id, carrier, pol, pod, container_type, fees, cost_total, sell_total
       FROM local_charges
      WHERE lower(btrim(carrier))=lower(btrim($1)) AND lower(btrim(pol))=lower(btrim($2))
        AND lower(btrim(pod))=lower(btrim($3)) AND lower(btrim(container_type))=lower(btrim($4))
      ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`,
    [carrier, pol, pod, ct]
  );
  if (lc.rows[0]) out.localCharge = {
    id: lc.rows[0].id, carrier: lc.rows[0].carrier, pol: lc.rows[0].pol, pod: lc.rows[0].pod,
    container_type: lc.rows[0].container_type, fees: parseJson(lc.rows[0].fees, []),
    cost_total: money(lc.rows[0].cost_total), sell_total: money(lc.rows[0].sell_total),
    total: money(lens.side === "receivable" ? lc.rows[0].sell_total : lc.rows[0].cost_total),
  };
  const fr = await pool.query(
    `SELECT id, currency, gp20, hq40, customer_gp20, customer_hq40
       FROM freight_rates
      WHERE lower(btrim(carrier))=lower(btrim($1)) AND lower(btrim(pol))=lower(btrim($2))
        AND lower(btrim(pod))=lower(btrim($3)) AND COALESCE(status,'active')!='withdrawn'
      ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 1`,
    [carrier, pol, pod]
  );
  if (fr.rows[0]) {
    const is20 = /20/.test(ct), sell = lens.side === "receivable";
    const amount = money(sell ? (is20 ? fr.rows[0].customer_gp20 : fr.rows[0].customer_hq40) : (is20 ? fr.rows[0].gp20 : fr.rows[0].hq40));
    if (amount > 0) out.freightRate = { id: fr.rows[0].id, currency: fr.rows[0].currency || "CNY", amount };
  }
  return out;
}

export function sanitizeForExternal(payload, lens, parties = {}) {
  if (lens.role === "internal") return payload;
  const safe = { ...payload };
  if (lens.side === "payable") {
    safe.buyer = parties.buyer;
    safe.seller = parties.seller;
  }
  safe.bill_lines = (safe.bill_lines || []).map(line => redactLine(line));
  safe.invoices = (safe.invoices || []).map(invoice => redactInvoice(invoice));
  delete safe.amount;
  delete safe.cost_amount;
  delete safe.sale_amount;
  delete safe.gross_profit;
  delete safe.cost;
  delete safe.sale;
  delete safe.payer_company_code;
  delete safe.supplier_company_code;
  delete safe.counterparty_company_code;
  delete safe.local_charge_baseline;
  delete safe.freight_rate_baseline;
  delete safe.exw_transfer_to_customer;
  return safe;
}

export const redactPayloadForLens = sanitizeForExternal;

function redactLine(line) {
  const { cost_amount, sale_amount, gross_profit, cost, sale, customer, customer_name, payer_company_code, supplier, supplier_company_code, counterparty_company_code, counterparty_amount, raw, ...safe } = line || {};
  return safe;
}

function redactInvoice(invoice) {
  const { cost_amount, sale_amount, gross_profit, cost, sale, customer, customer_name, payer_company_code, supplier_company_code, counterparty_company_code, counterparty_amount, ...safe } = invoice || {};
  return safe;
}

// 港杂开票拆两张:①代理港杂费(带税1%) ②国际货代服务费(免税)。banks={bank,accounts}由调用方传(避免循环依赖)
export function defaultInvoices(sp, total, currency, bl, cntr, mode = "self", banks = {}) {
  const SELLER_BANK = banks.bank || "", ACCOUNTS = banks.accounts || {};
  const invoiceTotal = money(sp.port_charge_invoice_total || total);
  const taxedBase = Math.min(money(sp.taxed_port_charge || 0), invoiceTotal);
  const freeAmt = money(invoiceTotal - taxedBase);
  const remark = `开户行 ${SELLER_BANK} · ${currency === "USD" ? "美金账号" : "人民币账号"} ${ACCOUNTS[currency] || ACCOUNTS.CNY} · 提单号 ${bl}${cntr ? " · " + cntr : ""}`;
  return [
    { id: "invoice-agency", currency, title: "增值税普通发票", mode,
      item_name: "*经纪代理服务*代理港杂费", unit: "项", qty: 1,
      amount_ex_tax: taxedBase, tax_rate: 0.01, tax_amount: money(taxedBase * 0.01), total_with_tax: money(taxedBase * 1.01), remark },
    { id: "invoice-service", currency, title: "增值税普通发票", mode,
      item_name: "*经纪代理服务*国际货物运输代理服务费", unit: "项", qty: 1,
      amount_ex_tax: freeAmt, tax_rate: 0, tax_amount: 0, total_with_tax: freeAmt, remark },
  ];
}

// 客户海运单=单行商业发票IV(USD无税);FOB下客户只付海运费
export function oceanInvoice(currency, total, bl, cntr, banks = {}) {
  const SELLER_BANK = banks.bank || "", ACCOUNTS = banks.accounts || {};
  const amt = money(total);
  const remark = `开户行 ${SELLER_BANK} · ${currency === "USD" ? "美金账号" : "人民币账号"} ${ACCOUNTS[currency] || ACCOUNTS.CNY} · 提单号 ${bl}${cntr ? " · " + cntr : ""}`;
  return [
    { id: "invoice-ocean", currency, title: "商业发票", mode: "self",
      item_name: "*运输服务*海运费", unit: "票", qty: 1,
      amount_ex_tax: amt, tax_rate: 0, tax_amount: 0, total_with_tax: amt, remark },
  ];
}
