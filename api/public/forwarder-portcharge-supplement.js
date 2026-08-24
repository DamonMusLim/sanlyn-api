import { getPool, setCors } from "../db.js";
import { resolveForwarder } from "./_forwarder-portal-auth.js";

const STANDARD_CATEGORIES = [
  "THC", "VGM", "包干费", "报关费", "舱单信息费", "操作费", "场站费", "单证费", "电放费",
  "封条费", "封签费", "改单费", "港杂费", "提箱费", "拖车费", "EIR", "设备交接费",
  "订舱费", "申报费", "安保费", "港建费", "查验费",
];
const CURRENCIES = ["CNY", "USD"];

function send(res, status, body) {
  return res.status(status).json(body);
}

function text(v) {
  return String(v == null ? "" : v).trim();
}

function normCurrency(v) {
  const s = text(v).toUpperCase();
  if (s === "RMB" || s === "人民币") return "CNY";
  if (s === "US$" || s === "美元" || s === "美金") return "USD";
  return s;
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function queryValue(req, key) {
  return text(req.query && req.query[key]);
}

function categoryInfo(v) {
  const value = text(v);
  if (!value) return { error: "cost_category_required" };
  if (value.length > 80) return { error: "cost_category_too_long" };
  if (STANDARD_CATEGORIES.includes(value)) return { value, custom: false };
  if (value === "其他") return { value, custom: true };
  return { value, custom: true };
}

async function companyName(pool, companyId, fallback) {
  const { rows } = await pool.query(
    "SELECT name_cn, name_en FROM companies WHERE id::text = $1 LIMIT 1",
    [String(companyId)]
  );
  const row = rows[0] || {};
  return text(row.name_cn) || text(row.name_en) || text(fallback);
}

async function loadOwnedPlan(pool, token, args) {
  const companyId = text(token.company_id);
  const blNo = text(args.bl_no);
  const planId = text(args.plan_id);
  if (!companyId) return { status: 401, body: { ok: false, error: "missing_forwarder_company" } };
  if (!blNo && !planId) return { status: 400, body: { ok: false, error: "bl_no_or_plan_id_required" } };

  const where = planId ? "id::text = $1" : "BTRIM(COALESCE(bl_no,'')) = $1";
  const value = planId || blNo;
  const { rows } = await pool.query(
    `SELECT id, bl_no, forwarder_company_id, pol, pod, etd
       FROM shipping_plans
      WHERE ${where}
      ORDER BY id DESC
      LIMIT 5`,
    [value]
  );
  if (!rows.length) return { status: 404, body: { ok: false, error: "shipment_not_found" } };

  const owned = rows.find(row => text(row.forwarder_company_id) === companyId);
  if (!owned) return { status: 403, body: { ok: false, error: "forbidden", message: "该提单不属于当前货代" } };
  if (!text(owned.bl_no)) return { status: 400, body: { ok: false, error: "plan_missing_bl_no" } };
  return { plan: owned };
}

async function loadExisting(pool, blNo) {
  const { rows } = await pool.query(
    `SELECT id, cost_category, amount, currency, ap_status, supplement_source, created_at
       FROM freight_supplier_bills
      WHERE BTRIM(COALESCE(bl_no,'')) = $1
        AND (cost_category = ANY($2::text[]) OR supplement_source = 'forwarder_portal')
      ORDER BY created_at DESC NULLS LAST, id DESC`,
    [blNo, STANDARD_CATEGORIES]
  );
  return rows;
}

function suggestedCategories(existing) {
  const present = new Set((existing || []).map(row => text(row.cost_category)).filter(Boolean));
  return STANDARD_CATEGORIES.filter(cat => !present.has(cat));
}

async function handleGet(pool, token, req, res) {
  const planLoaded = await loadOwnedPlan(pool, token, {
    bl_no: queryValue(req, "bl_no"),
    plan_id: queryValue(req, "plan_id"),
  });
  if (planLoaded.status) return send(res, planLoaded.status, planLoaded.body);
  const blNo = text(planLoaded.plan.bl_no);
  const existing = await loadExisting(pool, blNo);
  return send(res, 200, {
    ok: true,
    bl_no: blNo,
    plan_id: planLoaded.plan.id,
    existing: existing.map(row => ({
      id: row.id,
      cost_category: row.cost_category,
      amount: row.amount,
      currency: row.currency,
      ap_status: row.ap_status,
    })),
    suggested_categories: suggestedCategories(existing),
    currencies: CURRENCIES,
  });
}

async function handleHistory(pool, token, req, res) {
  const planLoaded = await loadOwnedPlan(pool, token, { bl_no: queryValue(req, "bl_no") });
  if (planLoaded.status) return send(res, planLoaded.status, planLoaded.body);
  const blNo = text(planLoaded.plan.bl_no);
  const { rows } = await pool.query(
    `SELECT id, cost_category, amount, currency, qty, unit_price, ap_status,
            supplement_at, review_confirmed_at, raw
       FROM freight_supplier_bills
      WHERE BTRIM(COALESCE(bl_no,'')) = $1
        AND supplement_source = 'forwarder_portal'
      ORDER BY supplement_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC`,
    [blNo]
  );
  return send(res, 200, { ok: true, bl_no: blNo, history: rows });
}

function validateLines(lines) {
  if (!Array.isArray(lines) || !lines.length) {
    return { errors: [{ index: null, error: "lines_required" }], rows: [] };
  }
  const errors = [];
  const rows = lines.map((line, index) => {
    const cat = categoryInfo(line && line.cost_category);
    const amount = money(line && line.amount);
    const currency = normCurrency(line && line.currency);
    const qty = line && line.qty != null && text(line.qty) !== "" ? money(line.qty) : null;
    const remark = text(line && line.remark);
    if (cat.error) errors.push({ index, error: cat.error });
    if (amount == null || amount <= 0) errors.push({ index, error: "amount_must_be_positive" });
    if (!CURRENCIES.includes(currency)) errors.push({ index, error: "currency_must_be_CNY_or_USD" });
    if (qty != null && qty <= 0) errors.push({ index, error: "qty_must_be_positive" });
    if (remark.length > 500) errors.push({ index, error: "remark_too_long" });
    return {
      cost_category: cat.value,
      amount,
      currency,
      qty,
      unit_price: qty && amount != null ? Math.round((amount / qty) * 100) / 100 : null,
      remark,
      custom: !!cat.custom,
    };
  });
  return { errors, rows };
}

async function insertLine(client, base, line) {
  const dup = await client.query(
    `SELECT id
       FROM freight_supplier_bills
      WHERE BTRIM(COALESCE(bl_no,'')) = $1
        AND cost_category = $2
        AND currency = $3
        AND amount = $4
        AND supplement_source = 'forwarder_portal'
      ORDER BY created_at DESC NULLS LAST
      LIMIT 1`,
    [base.bl_no, line.cost_category, line.currency, line.amount]
  );
  if (dup.rows.length) return { skipped: { id: dup.rows[0].id, cost_category: line.cost_category, amount: line.amount, currency: line.currency } };

  const raw = {
    supplement: {
      source: "forwarder_portal",
      note: base.note,
      remark: line.remark || null,
      submitted_via: "portal",
      custom_category: line.custom,
    },
  };
  const inserted = await client.query(
    `INSERT INTO freight_supplier_bills
      (supplier, bl_no, cost_category, amount, currency, qty, unit_price, ap_status,
       source_row, raw, supplement_source, supplement_by, supplement_at,
       supplier_company_code, created_at, updated_at)
     VALUES
      ($1, $2, $3, $4, $5, $6, $7, 'pending_review',
       $8, $9::jsonb, 'forwarder_portal', $10, NOW(),
       $10, NOW(), NOW())
     RETURNING id, cost_category, amount, currency, ap_status`,
    [
      base.supplier,
      base.bl_no,
      line.cost_category,
      line.amount,
      line.currency,
      line.qty,
      line.unit_price,
      `forwarder_portal:${base.company_id}`,
      JSON.stringify(raw),
      base.company_id,
    ]
  );
  return { inserted: inserted.rows[0] };
}

async function handlePost(pool, token, req, res) {
  const body = req.body || {};
  const planLoaded = await loadOwnedPlan(pool, token, { bl_no: body.bl_no });
  if (planLoaded.status) return send(res, planLoaded.status, planLoaded.body);

  const checked = validateLines(body.lines);
  if (checked.errors.length) return send(res, 400, { ok: false, error: "invalid_lines", details: checked.errors });

  const companyId = text(token.company_id);
  const supplier = await companyName(pool, companyId, token.forwarder_co);
  const base = {
    bl_no: text(planLoaded.plan.bl_no),
    company_id: companyId,
    supplier,
    note: text(body.note),
  };

  const client = await pool.connect();
  const inserted = [];
  const skipped = [];
  try {
    await client.query("BEGIN");
    for (const line of checked.rows) {
      const result = await insertLine(client, base, line);
      if (result.inserted) inserted.push(result.inserted);
      if (result.skipped) skipped.push(result.skipped);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
  return send(res, 200, { ok: true, success: true, inserted, skipped });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  try {
    const resolved = await resolveForwarder(pool, req);
    if (resolved.error) return send(res, resolved.error, resolved.body);
    if (req.method === "GET" && queryValue(req, "action") === "history") {
      return handleHistory(pool, resolved.token, req, res);
    }
    if (req.method === "GET") return handleGet(pool, resolved.token, req, res);
    if (req.method === "POST") return handlePost(pool, resolved.token, req, res);
    return send(res, 405, { ok: false, error: "method_not_allowed" });
  } catch (e) {
    return send(res, e.status || 500, { ok: false, success: false, error: e.message || "server_error" });
  }
}
