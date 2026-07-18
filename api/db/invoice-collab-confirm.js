import crypto from "crypto";
import { getPool, setCors } from "../db.js";
const KIND = "port_charge_invoice_confirmation";
const SELLER_NAME = "上海洋宝宝国际物流有限公司";
export const SELLER_BANK = "中国银行厦门文灶支行";
export const ACCOUNTS = { CNY: "433849860868", USD: "433849630299" };
function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

export function clean(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}
export function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function parseJson(v, fallback) {
  if (!v) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}
function matchFactory(label, factory) {
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

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoice_collab_confirm_overrides (
      ref text NOT NULL,
      kind text NOT NULL,
      shipment_id integer NOT NULL,
      factory_scope jsonb NOT NULL,
      status text NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','external_confirmed','pending_our_review')),
      payload jsonb NOT NULL DEFAULT '{}'::jsonb,
      actor_label text,
      confirmed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (ref, kind)
    )`);
}

async function validateToken(pool, raw) {
  if (!raw || String(raw).length < 16) return null;
  const r = await pool.query(
    `SELECT recipient_role, meta
       FROM magic_links
      WHERE token_hash=$1
        AND recipient_role IN ('factory_booking','customer_booking','trucking_booking','broker_booking','supplier_portal','shipper_booking')
        AND expires_at > NOW() AND revoked_at IS NULL
      LIMIT 1`,
    [hashToken(raw)]
  );
  if (!r.rows.length) return null;
  const meta = parseJson(r.rows[0]?.meta, {});
  const scope = meta?.factory_scope || meta?.shipper_scope || null;
  const label = clean(scope?.label || meta?.company_label, 80);
  const shipmentId = Number.parseInt(meta?.shipment_id, 10);
  if (!shipmentId) return null;
  const role = clean(r.rows[0].recipient_role, 40);
  const fieldProfile = clean(meta?.field_profile, 40);
  const internal = fieldProfile === "shipping_booking" || fieldProfile === "upstream_downstream";
  return { shipmentId, role, meta, internal, scope: { ...(scope || {}), label } };
}

async function loadShipment(pool, ctx) {
  const colsR = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='shipping_plans'`);
  const cols = new Set(colsR.rows.map(row => row.column_name));
  const companyJoin = (alias, col) => cols.has(col) ? `LEFT JOIN companies ${alias} ON ${alias}.id = sp.${col}` : `LEFT JOIN companies ${alias} ON false`;
  const r = await pool.query(
    `SELECT sp.id, sp.shipment_no, sp.bl_no, sp.pol, sp.pod, sp.vessel, sp.voyage,
            sp.container_type, sp.container_qty, sp.issuing_company, sp.carrier_code, sp.shipping_line,
            sp.freight_term, sp.customs_arrange,
            sp.customer, sp.customer_en, sp.hbl_no,
            cf.code AS forwarder_code, COALESCE(cf.name_cn, cf.name_en) AS forwarder_name,
            ct.code AS trucking_code, COALESCE(ct.name_cn, ct.name_en) AS trucking_name,
            cb.code AS broker_code, COALESCE(cb.name_cn, cb.name_en) AS broker_name,
            cc.code AS customer_code, COALESCE(cc.name_cn, cc.name_en) AS customer_company_name,
            sp.raw->'cost_lines' AS cost_lines,
            (SELECT COALESCE(json_agg(json_build_object('order_no', o.order_no, 'factory', o.factory)), '[]'::json)
               FROM orders o WHERE o.shipping_plan_id=sp.id) AS orders
       FROM shipping_plans sp
       ${companyJoin("cf", "forwarder_company_id")}
       ${companyJoin("ct", "trucking_company_id")}
       ${companyJoin("cb", "customs_broker_id")}
       ${companyJoin("cc", "customer_company_id")}
      WHERE sp.id=$1`,
    [ctx.shipmentId]
  );
  const sp = r.rows[0];
  if (!sp) return null;
  let orders = sp.orders || [];
  let partyCompany = {};
  if (ctx.role === "factory_booking" && !ctx.internal) {
    if (!ctx.scope.label) return null;
    orders = orders.filter(o => matchFactory(ctx.scope.label, o.factory));
    if (!orders.length) return null;
    partyCompany = await loadCompany(pool, ctx.scope.label);
  } else if (ctx.role === "shipper_booking" && !ctx.internal) {
    if (!ctx.scope.label) return null; partyCompany = await loadCompany(pool, ctx.scope.label);
  } else if (ctx.role === "supplier_portal" && !ctx.internal && ctx.scope.label) {
    partyCompany = await loadCompany(pool, ctx.scope.label);
  }
  if (ctx.role === "customer_booking" && !sp.customer_code) {
    const customer = await loadCompany(pool, sp.customer_en || sp.customer || sp.issuing_company);
    sp.customer_code = customer.code || "";
    sp.customer_company_name = sp.customer_company_name || customer.name_cn || customer.name_en || "";
  }
  return { ...sp, orders, party_company: partyCompany };
}

export async function loadCompany(pool, nameOrCode) {
  const key = clean(nameOrCode, 120);
  if (!key) return {};
  const r = await pool.query(
    `SELECT code, name_cn, name_en, factory_name, tax_id
       FROM companies
      WHERE code=$1 OR name_cn=$1 OR name_en=$1 OR factory_name=$1
         OR name_cn ILIKE '%'||$1||'%' OR factory_name ILIKE '%'||$1||'%'
      ORDER BY CASE WHEN code=$1 THEN 0 WHEN name_cn=$1 THEN 1 ELSE 9 END, id ASC
      LIMIT 1`,
    [key]
  );
  return r.rows[0] || {};
}

export async function loadSeller(pool) {
  const r = await pool.query(
    `SELECT code, name_cn, name_en, tax_id
       FROM companies
      WHERE name_cn ILIKE '%洋宝宝%' OR name_en ILIKE '%OCEAN BABY%'
      ORDER BY id ASC LIMIT 1`
  );
  const row = r.rows[0] || {};
  return { name: row.name_cn || row.name_en || SELLER_NAME, name_en: row.name_en || "", tax_id: row.tax_id || "" };
}

function companyView(c, fallback = "") {
  return { name: c?.name_cn || c?.name_en || c?.factory_name || fallback || "", name_en: c?.name_en || "", tax_id: c?.tax_id || "" };
}

function containerSummary(sp) {
  const qty = Number(sp.container_qty || 0);
  const type = clean(sp.container_type || "40HC", 20);
  return qty ? `${qty}×${type}` : "";
}

function partyLens(ctx, sp) {
  if (ctx.internal) return { role: "internal", side: "all", code: null, segment: "all" };
  if (ctx.role === "customer_booking") {
    return { role: "customer", side: "receivable", code: clean(sp.customer_code, 40), segment: "customer" };
  }
  if (ctx.role === "shipper_booking") return { role: "shipper", side: "receivable", code: clean(sp.party_company?.code, 40), segment: "port_charge" };
  if (ctx.role === "trucking_booking") {
    return { role: "supplier", side: "payable", code: clean(sp.trucking_code, 40), segment: "truck" };
  }
  if (ctx.role === "broker_booking") {
    return { role: "supplier", side: "payable", code: clean(sp.broker_code, 40), segment: "customs" };
  }
  if (ctx.role === "factory_booking") {
    return { role: "supplier", side: "payable", code: clean(sp.party_company?.code, 40), segment: "factory" };
  }
  return { role: "supplier", side: "payable", code: clean(sp.party_company?.code, 40), segment: (ctx.meta?.segments || [])[0] || "supplier" };
}

async function defaultLines(pool, sp, ctx) {
  const blNo = clean(sp.bl_no || sp.hbl_no || sp.shipment_no || "", 80);
  const lens = partyLens(ctx, sp);
  const exwTransfer = clean(sp.freight_term, 20).toUpperCase() === "EXW";
  if (!blNo || (lens.role !== "internal" && !lens.code)) return { lines: [], exwTransfer, lens };

  const params = [blNo];
  const where = ["bl_no=$1"];
  if (lens.side === "payable") {
    params.push(lens.code);
    where.push(`supplier_company_code=$${params.length}`, "COALESCE(amount,0)>0");
  } else if (lens.side === "receivable") {
    if (lens.segment === "port_charge") {
      // 港杂账单：按提单带出下游客户的港杂，不靠 payer_company_code
      // (backfill 默认填 BABI 不可靠；Damon 定"只按上下游/走自己系统"，一票一提单=一个下游客户)
      where.push("COALESCE(sale_amount,0)>0");
    } else {
      params.push(lens.code);
      where.push(`payer_company_code=$${params.length}`, "COALESCE(sale_amount,0)>0");
    }
  } else {
    where.push("(COALESCE(amount,0)>0 OR COALESCE(sale_amount,0)>0)");
  }
  const r = await pool.query(
    `SELECT bl_no, cost_category, canonical_category, fob_scope,
            amount, sale_amount, currency, unit_price, qty, charge_basis,
            supplier, supplier_company_code, payer_company_code
       FROM active_freight_supplier_bills
      WHERE ${where.join(" AND ")}
      ORDER BY id`,
    params
  );

  const customsArrange = clean(sp.customs_arrange, 20).toLowerCase();
  const lines = [];
  for (const row of r.rows) {
    const scope = clean(row.fob_scope, 16) || classifyFobScope(row.canonical_category, row.cost_category);
    if (lens.role === "customer" && Number(row.sale_amount || 0) <= 0) continue;
    if (lens.role === "supplier" && Number(row.amount || 0) <= 0) continue;
    // 港杂账单只带起运港真港杂(origin scope)：海运费/拖车/报关/目的港等一律不进港杂账单，需要再手动加行
    if (lens.segment === "port_charge" && scope !== "origin") continue;
    if (ctx.role === "factory_booking") {
      if (scope === "freight" || scope === "destination") continue;
      if (scope === "declaration" && customsArrange === "factory") continue;
    }
    const visibleAmount = lens.side === "receivable" ? row.sale_amount : row.amount;
    const line = {
      bl_no: clean(row.bl_no || blNo, 80),
      name: clean(row.cost_category || "港杂费", 80),
      basis: clean(row.charge_basis || "整票", 24),
      unit_price: money(row.unit_price),
      qty: money(row.qty || 1) || 1,
      amount: money(visibleAmount),
      currency: clean(row.currency || "CNY", 8).toUpperCase(),
      fob_scope: scope,
      review: scope === "review",
      segment: lens.segment,
      line_side: lens.side,
    };
    if (lens.role === "internal") {
      line.cost_amount = money(row.amount);
      line.sale_amount = money(row.sale_amount);
      line.gross_profit = money(Number(row.sale_amount || 0) - Number(row.amount || 0));
    }
    lines.push(line);
  }
  return { lines, exwTransfer, lens };
}

async function loadLaneBenchmarks(pool, sp, lens) {
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

async function buildPayload(pool, sp, buyer, seller, saved, ctx) {
  const defaults = await defaultLines(pool, sp, ctx);
  const lane = ctx.role === "shipper_booking" ? { localCharge: null, freightRate: null } : await loadLaneBenchmarks(pool, sp, defaults.lens);
  const billLines = defaults.lines;
  const payloadBillLines = saved?.payload?.bill_lines || billLines;
  const billLineNotice = billLines.length ? "" : "费用尚未录入";
  const currency = payloadBillLines[0]?.currency || "CNY";
  const total = money(payloadBillLines.filter(l => l.currency === currency).reduce((s, l) => s + Number(l.amount || 0), 0));
  const exTax = money(total / 1.01);
  const tax = money(total - exTax);
  const bl = clean(sp.bl_no || sp.shipment_no || "");
  const savedCntrs = Array.isArray(saved?.payload?.shipment_containers) && saved.payload.shipment_containers.length
    ? saved.payload.shipment_containers.map(c => ({ type: clean(c.type, 20), count: money(c.count) })).filter(c => c.type)
    : null;
  const containers = savedCntrs || (Number(sp.container_qty) ? [{ type: clean(sp.container_type || "40HC", 20), count: Number(sp.container_qty) }] : []);
  const cntr = savedCntrs
    ? containers.filter(c => c.type && Number(c.count)).map(c => `${Number(c.count)}×${c.type}`).join(" + ")
    : containerSummary(sp);
  return {
    is_internal: Boolean(ctx.internal),
    status: saved?.status || "draft",
    confirmed_at: saved?.confirmed_at || null,
    line_side: defaults.lens.side,
    settlement_mode: saved?.payload?.settlement_mode || "monthly",
    local_charge_baseline: lane.localCharge,
    freight_rate_baseline: lane.freightRate,
    shipment: {
      shipment_no: sp.shipment_no || "",
      bl_no: bl,
      vessel: sp.vessel || "",
      voyage: sp.voyage || "",
      pol: sp.pol || "",
      pod: sp.pod || "",
      freight_term: (ctx.internal || defaults.lens.role === "customer") ? (sp.freight_term || "") : "",
      customs_arrange: sp.customs_arrange || "",
      container_summary: cntr,
      containers,
      billing_segment: defaults.lens.segment,
    },
    buyer: {
      name: saved?.payload?.buyer?.name || buyer.name || buyer.name_cn || buyer.name_en || sp.issuing_company || "",
      tax_id: saved?.payload?.buyer?.tax_id || buyer.tax_id || "",
    },
    seller,
    bill_lines: payloadBillLines,
    bill_line_notice: saved?.payload?.bill_line_notice || billLineNotice,
    needs_finance_review: saved?.payload?.needs_finance_review ?? !billLines.length,
    ...(ctx.role === "shipper_booking" ? {} : { exw_transfer_to_customer: Boolean(defaults.exwTransfer && payloadBillLines.length) }),
    invoices: saved?.payload?.invoices || [{
      id: "invoice-1",
      currency,
      title: "增值税普通发票",
      mode: "self",
      item_name: "*经纪代理服务*港杂费",
      unit: "项",
      qty: 1,
      total_with_tax: total,
      amount_ex_tax: exTax,
      tax_rate: 0.01,
      tax_amount: tax,
      remark: `开户行 ${SELLER_BANK} · ${currency === "USD" ? "美金账号" : "人民币账号"} ${ACCOUNTS[currency] || ACCOUNTS.CNY} · 提单号 ${bl}${cntr ? " · " + cntr : ""}`,
    }],
    contacts: saved?.payload?.contacts || { finance: [], ops: [], business: [] },
    save_as_default: saved?.payload?.save_as_default ?? true,
    updated_at: saved?.updated_at || null,
  };
}

async function partiesForView(pool, sp, ctx) {
  const own = await loadSeller(pool);
  if (ctx.role === "shipper_booking") return { buyer: companyView(sp.party_company, ctx.scope.label), seller: own };
  if (ctx.internal || ctx.role === "customer_booking") {
    const buyer = await loadCompany(pool, sp.customer_code || sp.customer_company_name || sp.customer_en || sp.customer || sp.issuing_company);
    return { buyer: companyView(buyer, sp.customer_company_name || sp.customer_en || sp.customer || sp.issuing_company), seller: own };
  }
  let sellerCompany = sp.party_company || {};
  if (ctx.role === "trucking_booking") sellerCompany = await loadCompany(pool, sp.trucking_code || sp.trucking_name);
  if (ctx.role === "broker_booking") sellerCompany = await loadCompany(pool, sp.broker_code || sp.broker_name);
  return { buyer: own, seller: companyView(sellerCompany, ctx.scope.label || sp.forwarder_name || sp.trucking_name || sp.broker_name) };
}

function invoiceRef(ctx) {
  const key = clean(ctx.scope.label || ctx.meta?.company_label || ctx.role, 80).replace(/\s+/g, "_");
  return `shipment:${ctx.shipmentId}:${ctx.internal ? "internal" : ctx.role}:${key}:invoice-default`;
}

async function handleGet(req, res, pool, ctx) {
  const sp = await loadShipment(pool, ctx);
  if (!sp) return res.status(404).json({ ok: false, error: "not_found" });
  const { buyer, seller } = await partiesForView(pool, sp, ctx);
  const ref = invoiceRef(ctx);
  const saved = await pool.query(
    `SELECT status, payload, confirmed_at, updated_at FROM invoice_collab_confirm_overrides
      WHERE ref=$1 AND kind=$2 LIMIT 1`,
    [ref, KIND]
  );
  return res.json({ ok: true, ref, kind: KIND, data: await buildPayload(pool, sp, buyer, seller, saved.rows[0], ctx) });
}

function sanitizeDraft(body) {
  const d = body?.draft || {};
  return {
    buyer: { name: clean(d.buyer?.name, 120), tax_id: clean(d.buyer?.tax_id, 40) },
    bill_lines: Array.isArray(d.bill_lines) ? d.bill_lines.map(l => ({
      bl_no: clean(l.bl_no, 80),
      name: clean(l.name, 80), basis: clean(l.basis, 24),
      container_type: clean(l.container_type, 20),
      unit_price: money(l.unit_price), qty: money(l.qty) || 1,
      amount: money(l.amount), currency: clean(l.currency || "CNY", 8).toUpperCase(),
      fob_scope: clean(l.fob_scope, 16),
      review: Boolean(l.review),
    })).slice(0, 80) : [],
    shipment_containers: Array.isArray(d.shipment_containers) ? d.shipment_containers
      .map(c => ({ type: clean(c.type, 20), count: money(c.count) }))
      .filter(c => c.type).slice(0, 20) : [],
    invoices: Array.isArray(d.invoices) ? d.invoices.slice(0, 12) : [],
    contacts: {
      finance: Array.isArray(d.contacts?.finance) ? d.contacts.finance.map(x => clean(x, 120)).filter(Boolean).slice(0, 20) : [],
      ops: Array.isArray(d.contacts?.ops) ? d.contacts.ops.map(x => clean(x, 120)).filter(Boolean).slice(0, 20) : [],
      business: Array.isArray(d.contacts?.business) ? d.contacts.business.map(x => clean(x, 120)).filter(Boolean).slice(0, 20) : [],
    },
    save_as_default: Boolean(d.save_as_default),
    invoice_mode: clean(d.invoice_mode || "self", 24),
    settlement_mode: clean(d.settlement_mode || "monthly", 16) === "single" ? "single" : "monthly",
    price_changed: Boolean(d.price_changed),
  };
}

function billLinesChanged(serverLines, clientLines) {
  if (serverLines.length !== clientLines.length) return true;
  const norm = (lines) => lines.map(l => ({ name: clean(l.name, 80).toLowerCase(), amount: money(l.amount) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.amount - b.amount);
  const a = norm(serverLines), b = norm(clientLines);
  return a.some((l, i) => l.name !== b[i].name || Math.abs(l.amount - b[i].amount) > 0.01);
}

async function lockLocalChargeBaseline(pool, sp, payload, ctx) {
  if (!ctx.internal) return null;
  const defaults = await defaultLines(pool, sp, ctx);
  const billLines = defaults.lines; if (!billLines.length) return null;
  const carrier = clean(sp.carrier_code || sp.shipping_line || sp.forwarder_name, 80);
  const pol = clean(sp.pol, 100), pod = clean(sp.pod, 100);
  const ct = clean(payload.shipment_containers[0]?.type || sp.container_type || "40HC", 20);
  if (!carrier || !pol || !pod || !ct) return null;
  const exists = await pool.query(
    `SELECT id FROM local_charges
      WHERE lower(btrim(carrier))=lower(btrim($1)) AND lower(btrim(pol))=lower(btrim($2))
        AND lower(btrim(pod))=lower(btrim($3)) AND lower(btrim(container_type))=lower(btrim($4))
      LIMIT 1`,
    [carrier, pol, pod, ct]
  );
  if (exists.rows.length) return exists.rows[0];
  const fees = billLines.map(l => ({
    feeName: l.name, unit: l.basis, unitPrice: l.unit_price, qty: l.qty,
    amount: l.amount, currency: l.currency, direction: defaults.lens.side === "receivable" ? "应收" : "应付",
  }));
  const total = money(billLines.reduce((s, l) => s + Number(l.amount || 0), 0));
  const r = await pool.query(
    `INSERT INTO local_charges (carrier, pol, pod, company_name, container_type, fees, cost_total, sell_total, raw, remarks)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::jsonb,$10) RETURNING id`,
    [carrier, pol, pod, clean(payload.seller?.name || ctx.scope.label, 120), ct, JSON.stringify(fees),
      defaults.lens.side === "payable" ? total : 0, defaults.lens.side === "receivable" ? total : 0,
      JSON.stringify({ created_by: "invoice_collab_confirm", shipment_id: ctx.shipmentId, ref: invoiceRef(ctx) }),
      "invoice_collab_confirm locked baseline"]
  );
  return r.rows[0];
}

async function handlePost(req, res, pool, ctx) {
  const sp = await loadShipment(pool, ctx);
  if (!sp) return res.status(404).json({ ok: false, error: "not_found" });
  const payload = sanitizeDraft(req.body);
  payload.line_side = partyLens(ctx, sp).side;
  if (!payload.buyer.name || !payload.buyer.tax_id) return res.status(400).json({ ok: false, error: "buyer_required" });
  if (!payload.contacts.finance.length) return res.status(400).json({ ok: false, error: "finance_email_required" });
  payload.price_changed = billLinesChanged((await defaultLines(pool, sp, ctx)).lines, payload.bill_lines);
  const status = payload.price_changed ? "pending_our_review" : "external_confirmed";
  const ref = invoiceRef(ctx);
  const r = await pool.query(
    `INSERT INTO invoice_collab_confirm_overrides
       (ref, kind, shipment_id, factory_scope, status, payload, actor_label, confirmed_at, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,now(),now())
     ON CONFLICT (ref, kind) DO UPDATE SET
       status=EXCLUDED.status, payload=EXCLUDED.payload, actor_label=EXCLUDED.actor_label,
       confirmed_at=now(), updated_at=now()
     RETURNING ref, kind, status, confirmed_at, updated_at`,
    [ref, KIND, ctx.shipmentId, JSON.stringify(ctx.scope), status, JSON.stringify(payload), ctx.scope.label]
  );
  if (status === "external_confirmed") await lockLocalChargeBaseline(pool, sp, payload, ctx);
  return res.json({ ok: true, draft: r.rows[0] });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  try {
    await ensureTable(pool);
    const token = req.method === "GET" ? req.query?.token : req.body?.token;
    const ctx = await validateToken(pool, token);
    if (!ctx) return res.status(401).json({ ok: false, error: "invalid_token" });
    if (req.method === "GET") return handleGet(req, res, pool, ctx);
    if (req.method === "POST") return handlePost(req, res, pool, ctx);
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  } catch (err) {
    console.error("[invoice-collab-confirm]", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
}
