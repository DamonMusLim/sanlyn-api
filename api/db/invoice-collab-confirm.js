import crypto from "crypto";
import { getPool, setCors } from "../db.js";

const KIND = "port_charge_invoice_confirmation";
const SELLER_NAME = "上海洋宝宝国际物流有限公司";
const SELLER_BANK = "中国银行厦门文灶支行";
const ACCOUNTS = { CNY: "433849860868", USD: "433849630299" };

function hashToken(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

function clean(v, max = 200) {
  return String(v || "").trim().slice(0, max);
}

function money(v) {
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
    `SELECT meta
       FROM magic_links
      WHERE token_hash=$1 AND recipient_role='factory_booking'
        AND expires_at > NOW() AND revoked_at IS NULL
      LIMIT 1`,
    [hashToken(raw)]
  );
  const meta = parseJson(r.rows[0]?.meta, {});
  const scope = meta?.factory_scope || null;
  const label = clean(scope?.label, 80);
  const shipmentId = Number.parseInt(meta?.shipment_id, 10);
  if (!r.rows.length || !shipmentId || !label) return null;
  return { shipmentId, scope: { ...scope, label } };
}

async function loadShipment(pool, ctx) {
  const r = await pool.query(
    `SELECT sp.id, sp.shipment_no, sp.bl_no, sp.pol, sp.pod, sp.vessel, sp.voyage,
            sp.container_type, sp.container_qty, sp.issuing_company,
            sp.raw->'cost_lines' AS cost_lines,
            (SELECT COALESCE(json_agg(json_build_object('order_no', o.order_no, 'factory', o.factory)), '[]'::json)
               FROM orders o WHERE o.shipping_plan_id=sp.id) AS orders
       FROM shipping_plans sp
      WHERE sp.id=$1`,
    [ctx.shipmentId]
  );
  const sp = r.rows[0];
  if (!sp) return null;
  const orders = (sp.orders || []).filter(o => matchFactory(ctx.scope.label, o.factory));
  if (!orders.length) return null;
  const factory = await loadCompany(pool, ctx.scope.label);
  return { ...sp, orders, factory_company_code: factory.code || "" };
}

async function loadCompany(pool, nameOrCode) {
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

async function loadSeller(pool) {
  const r = await pool.query(
    `SELECT code, name_cn, name_en, tax_id
       FROM companies
      WHERE name_cn ILIKE '%洋宝宝%' OR name_en ILIKE '%OCEAN BABY%'
      ORDER BY id ASC LIMIT 1`
  );
  const row = r.rows[0] || {};
  return { name: row.name_cn || row.name_en || SELLER_NAME, tax_id: row.tax_id || "" };
}

function containerSummary(sp) {
  const qty = Number(sp.container_qty || 0);
  const type = clean(sp.container_type || "40HC", 20);
  return qty ? `${qty}×${type}` : "";
}

async function defaultLines(pool, sp) {
  const blNo = clean(sp.bl_no || sp.shipment_no || "", 80);
  const payerCode = clean(sp.factory_company_code, 40);
  if (!blNo || !payerCode) return [];

  const r = await pool.query(
    `SELECT bl_no, cost_category, amount, sale_amount, currency, unit_price, qty, charge_basis
       FROM active_freight_supplier_bills
      WHERE bl_no=$1
        AND payer_company_code=$2
        AND (cost_category !~* '海运|ocean|freight')
        AND COALESCE(amount,0)>0
      ORDER BY id`,
    [blNo, payerCode]
  );

  return r.rows.map(row => {
    const lineAmount = row.sale_amount !== null && row.sale_amount !== undefined && String(row.sale_amount) !== ""
      ? row.sale_amount
      : row.amount;
    return {
      bl_no: clean(row.bl_no || blNo, 80),
      name: clean(row.cost_category || "港杂费", 80),
      basis: clean(row.charge_basis || "整票", 24),
      unit_price: money(row.unit_price),
      qty: money(row.qty || 1) || 1,
      amount: money(lineAmount),
      currency: clean(row.currency || "CNY", 8).toUpperCase(),
    };
  });
}

async function buildPayload(pool, sp, buyer, seller, saved) {
  const billLines = await defaultLines(pool, sp);
  const billLineNotice = billLines.length ? "" : "该票暂无港杂账单,请财务核对";
  const currency = billLines[0]?.currency || "CNY";
  const total = money(billLines.filter(l => l.currency === currency).reduce((s, l) => s + Number(l.amount || 0), 0));
  const exTax = money(total / 1.01);
  const tax = money(total - exTax);
  const bl = clean(sp.bl_no || sp.shipment_no || "");
  const cntr = containerSummary(sp);
  return {
    status: saved?.status || "draft",
    shipment: {
      shipment_no: sp.shipment_no || "",
      bl_no: bl,
      vessel: sp.vessel || "",
      voyage: sp.voyage || "",
      pol: sp.pol || "",
      pod: sp.pod || "",
      container_summary: cntr,
    },
    buyer: {
      name: saved?.payload?.buyer?.name || buyer.name_cn || buyer.name_en || sp.issuing_company || "",
      tax_id: saved?.payload?.buyer?.tax_id || buyer.tax_id || "",
    },
    seller,
    bill_lines: saved?.payload?.bill_lines || billLines,
    bill_line_notice: saved?.payload?.bill_line_notice || billLineNotice,
    needs_finance_review: saved?.payload?.needs_finance_review ?? !billLines.length,
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

async function handleGet(req, res, pool, ctx) {
  const sp = await loadShipment(pool, ctx);
  if (!sp) return res.status(404).json({ ok: false, error: "not_found" });
  const buyer = await loadCompany(pool, ctx.scope.label || sp.issuing_company);
  const seller = await loadSeller(pool);
  const ref = `shipment:${ctx.shipmentId}:factory:${ctx.scope.label}:invoice-default`;
  const saved = await pool.query(
    `SELECT status, payload, updated_at FROM invoice_collab_confirm_overrides
      WHERE ref=$1 AND kind=$2 LIMIT 1`,
    [ref, KIND]
  );
  return res.json({ ok: true, ref, kind: KIND, data: await buildPayload(pool, sp, buyer, seller, saved.rows[0]) });
}

function sanitizeDraft(body) {
  const d = body?.draft || {};
  const priceChanged = Boolean(d.price_changed);
  return {
    buyer: { name: clean(d.buyer?.name, 120), tax_id: clean(d.buyer?.tax_id, 40) },
    bill_lines: Array.isArray(d.bill_lines) ? d.bill_lines.map(l => ({
      bl_no: clean(l.bl_no, 80),
      name: clean(l.name, 80), basis: clean(l.basis, 24),
      unit_price: money(l.unit_price), qty: money(l.qty) || 1,
      amount: money(l.amount), currency: clean(l.currency || "CNY", 8).toUpperCase(),
    })).slice(0, 80) : [],
    invoices: Array.isArray(d.invoices) ? d.invoices.slice(0, 12) : [],
    contacts: {
      finance: Array.isArray(d.contacts?.finance) ? d.contacts.finance.map(x => clean(x, 120)).filter(Boolean).slice(0, 20) : [],
      ops: Array.isArray(d.contacts?.ops) ? d.contacts.ops.map(x => clean(x, 120)).filter(Boolean).slice(0, 20) : [],
      business: Array.isArray(d.contacts?.business) ? d.contacts.business.map(x => clean(x, 120)).filter(Boolean).slice(0, 20) : [],
    },
    save_as_default: Boolean(d.save_as_default),
    invoice_mode: clean(d.invoice_mode || "self", 24),
    price_changed: priceChanged,
  };
}

async function handlePost(req, res, pool, ctx) {
  const sp = await loadShipment(pool, ctx);
  if (!sp) return res.status(404).json({ ok: false, error: "not_found" });
  const payload = sanitizeDraft(req.body);
  if (!payload.buyer.name || !payload.buyer.tax_id) return res.status(400).json({ ok: false, error: "buyer_required" });
  if (!payload.contacts.finance.length) return res.status(400).json({ ok: false, error: "finance_email_required" });
  const status = payload.price_changed ? "pending_our_review" : "external_confirmed";
  const ref = `shipment:${ctx.shipmentId}:factory:${ctx.scope.label}:invoice-default`;
  const r = await pool.query(
    `INSERT INTO invoice_collab_confirm_overrides
       (ref, kind, shipment_id, factory_scope, status, payload, actor_label, confirmed_at, updated_at)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7,now(),now())
     ON CONFLICT (ref, kind) DO UPDATE SET
       status=EXCLUDED.status, payload=EXCLUDED.payload, actor_label=EXCLUDED.actor_label,
       confirmed_at=now(), updated_at=now()
     RETURNING ref, kind, status, updated_at`,
    [ref, KIND, ctx.shipmentId, JSON.stringify(ctx.scope), status, JSON.stringify(payload), ctx.scope.label]
  );
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
