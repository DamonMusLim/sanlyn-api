// api/db/freight-bill-intake.js
// POST /api/db/freight-bill-intake
//
// Write freight supplier bill rows with explicit company-master resolution.
// No order join: caller must pass customer_company_code / factory_company_code
// when a rebill payer is needed.

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { normalizeChargeName } from "./lib/portcharge-close-loop.js";

const FOB_TERMS = new Set(["FOB", "FCA", "EXW"]);
const ABSORBED_TERMS = new Set(["CIF", "CFR", "CIP", "CPT", "DDP", "DAP"]);

const OPTIONAL_BILL_COLUMNS = [
  "supplier_company_code",
  "payer_company_code",
  "payer_type",
  "freight_term",
];

let billColumnsCache = null;

function norm(v) {
  return String(v ?? "").trim();
}

function upper(v) {
  return norm(v).toUpperCase();
}

function json(v, fallback) {
  if (v === undefined) return fallback;
  return v;
}

function asNumber(v, field) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) {
    const err = new Error(`${field} is not a valid number`);
    err.status = 409;
    err.code = "parse_required";
    err.field = field;
    throw err;
  }
  return n;
}

function companyLabel(row) {
  return row?.name_cn || row?.name_en || row?.code || "";
}

function typeText(row) {
  return upper(row?.type);
}

function hasCompanyRole(row, role) {
  const t = typeText(row);
  if (role === "customer") return ["CUSTOMER", "BUYER", "CLIENT"].includes(t) || /客户|买方/.test(row?.type || "");
  if (role === "factory") return ["FACTORY", "MANUFACTURER"].includes(t) || /工厂|制造/.test(row?.type || "");
  if (role === "forwarder") {
    return ["FORWARDER", "CO-LOADER", "COLOADER", "LOGISTICS"].includes(t) || /货代|同行|物流/.test(row?.type || "");
  }
  return false;
}

function isOceanCost(category) {
  const c = norm(category);
  return /海运费|ocean\s*freight|sea\s*freight/i.test(c);
}

function isOriginLocalCost(category) {
  const c = norm(category);
  return /港杂|THC|VGM|PTF|文件费|安保费|仓单|设备管理|起运港|码头|港建|订舱|操作费|集港/i.test(c);
}

function inferPayerNeed(costCategory, freightTerm) {
  const term = upper(freightTerm);

  if (isOceanCost(costCategory)) {
    if (FOB_TERMS.has(term)) return { need: "customer", payerType: "customer" };
    if (ABSORBED_TERMS.has(term)) return { need: null, absorbed: true };
    return {
      conflict: true,
      need: "specify_payer",
      expect: "customer",
      reason: "海运费需要明确 freight_term/incoterm 才能判断是否向客户收取",
    };
  }

  if (isOriginLocalCost(costCategory)) {
    return { need: "factory", payerType: "factory" };
  }

  return {
    conflict: true,
    need: "specify_payer",
    expect: "customer_or_factory",
    reason: "费目无法自动判断付款方,请从主表选定找谁要",
  };
}

async function getBillColumns(pool) {
  if (billColumnsCache) return billColumnsCache;
  const r = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_name = 'freight_supplier_bills'`
  );
  billColumnsCache = new Set(r.rows.map(row => row.column_name));
  return billColumnsCache;
}

async function resolvePlanIdForBill(pool, blNo, linkPlanId) {
  const raw = norm(linkPlanId);
  if (/^[0-9]+$/.test(raw)) return raw;

  const plans = await pool.query(
    `SELECT id
       FROM shipping_plans
      WHERE bl_no = $1
        AND bl_no NOT LIKE '%#%'
      ORDER BY id
      LIMIT 2`,
    [blNo]
  );
  if (plans.rows.length === 1) return String(plans.rows[0].id);
  if (!raw) return null;

  const err = new Error(plans.rows.length ? "link_plan_id ambiguous by bl_no" : "link_plan_id cannot resolve by bl_no");
  err.status = 409;
  err.code = plans.rows.length ? "ambiguous_plan" : "plan_not_found";
  err.field = "link_plan_id";
  throw err;
}

async function findCompanies(pool, q) {
  const term = norm(q);
  if (!term) return [];

  const byCode = await pool.query(
    `SELECT id, code, name_en, name_cn, type
       FROM companies
      WHERE UPPER(code) = UPPER($1)
      LIMIT 2`,
    [term]
  );
  if (byCode.rows.length) return byCode.rows;

  const like = `%${term}%`;
  const byName = await pool.query(
    `SELECT id, code, name_en, name_cn, type
       FROM companies
      WHERE name_cn ILIKE $1 OR name_en ILIKE $1
      ORDER BY
        CASE
          WHEN name_cn = $2 OR name_en = $2 THEN 0
          WHEN name_cn ILIKE $3 OR name_en ILIKE $3 THEN 1
          ELSE 2
        END,
        code
      LIMIT 5`,
    [like, term, `${term}%`]
  );
  return byName.rows;
}

async function getCompanyByCode(pool, code) {
  if (!norm(code)) return null;
  const r = await pool.query(
    `SELECT id, code, name_en, name_cn, type
       FROM companies
      WHERE UPPER(code) = UPPER($1)
      LIMIT 1`,
    [code]
  );
  return r.rows[0] || null;
}

async function resolveSupplier(pool, body) {
  const overrideCode = body.override && typeof body.override === "object" ? body.override.code : null;
  const code = norm(overrideCode || body.supplier_company_code || body.supplier_code);
  const query = norm(body.supplier_query || body.supplier);

  if (code) {
    const company = await getCompanyByCode(pool, code);
    if (!company) {
      return {
        status: 409,
        payload: { ok: false, need: "specify_supplier", reason: "supplier code not found in companies", code },
      };
    }
    return { company };
  }

  if (!query) {
    return {
      status: 409,
      payload: { ok: false, need: "specify_supplier", reason: "supplier_query or supplier_code required" },
    };
  }

  const matches = await findCompanies(pool, query);
  if (matches.length === 1) return { company: matches[0] };

  return {
    status: 409,
    payload: {
      ok: false,
      need: "specify_supplier",
      reason: matches.length ? "supplier_query matched multiple companies" : "supplier_query not found in companies",
      matches: matches.map(r => ({ code: r.code, name: companyLabel(r), type: r.type })),
    },
  };
}

async function resolvePayer(pool, body) {
  const costCategory = norm(body.cost_category);
  const freightTerm = norm(body.freight_term || body.incoterm);
  const inferred = inferPayerNeed(costCategory, freightTerm);

  if (inferred.conflict) {
    return { status: 409, payload: { ok: false, need: inferred.need, expect: inferred.expect, reason: inferred.reason } };
  }

  if (inferred.absorbed) {
    return { payer: null, payerType: null, freightTerm, rebillStatus: "absorbed" };
  }

  const expect = inferred.need;
  const code = expect === "customer" ? norm(body.customer_company_code) : norm(body.factory_company_code);

  if (!code) {
    return {
      status: 409,
      payload: {
        ok: false,
        need: "specify_payer",
        expect,
        reason: "订单关联不可靠,请从主表选定找谁要",
      },
    };
  }

  const company = await getCompanyByCode(pool, code);
  if (!company) {
    return {
      status: 422,
      payload: { ok: false, error: "payer_not_found", expect, code, reason: "payer code not found in companies" },
    };
  }

  if (!hasCompanyRole(company, expect)) {
    return {
      status: 422,
      payload: {
        ok: false,
        error: "payer_type_mismatch",
        expect,
        actual: company.type,
        code: company.code,
        name: companyLabel(company),
      },
    };
  }

  return { payer: company, payerType: expect, freightTerm, rebillStatus: "to_rebill" };
}

function buildRaw(body, supplier, payer, payerType, freightTerm) {
  return {
    source: "freight-bill-intake",
    supplier_company_code: supplier.code,
    supplier_company_id: supplier.id,
    payer_company_code: payer?.code || null,
    payer_type: payerType,
    customer_company_code: body.customer_company_code || null,
    factory_company_code: body.factory_company_code || null,
    freight_term: freightTerm || null,
    input: json(body.raw, {}),
  };
}

function errorResponse(err, res) {
  if (err.status === 409) {
    return res.status(409).json({
      ok: false,
      need: err.code || "parse_required",
      field: err.field,
      reason: err.message,
    });
  }
  console.error("[freight-bill-intake]", err);
  return res.status(500).json({ ok: false, error: "Internal server error", detail: err.message });
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;
  if (req.user?.role !== "admin" && req.user?.role !== "finance") {
    return res.status(403).json({ ok: false, error: "admin or finance role required" });
  }

  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST required" });
  }

  const body = req.body || {};
  const pool = getPool();

  try {
    let costCategory = norm(body.cost_category);
    const blNo = norm(body.bl_no);
    const currency = upper(body.currency);
    const qty = asNumber(body.qty ?? 1, "qty");
    const unitPrice = asNumber(body.unit_price, "unit_price");
    const amount = asNumber(body.amount ?? (unitPrice !== null && qty !== null ? unitPrice * qty : null), "amount");

    if (!costCategory) {
      return res.status(409).json({ ok: false, need: "specify_cost_category", reason: "cost_category required" });
    }
    if (!blNo) {
      return res.status(409).json({ ok: false, need: "specify_bl_no", reason: "bl_no required" });
    }
    if (!currency) {
      return res.status(409).json({ ok: false, need: "specify_currency", reason: "currency required" });
    }
    if (amount === null) {
      return res.status(409).json({ ok: false, need: "specify_amount", reason: "amount required" });
    }

    const supplierResult = await resolveSupplier(pool, body);
    if (supplierResult.status) return res.status(supplierResult.status).json(supplierResult.payload);
    const supplier = supplierResult.company;
    const chargeNorm = await normalizeChargeName(pool, costCategory, body.carrier || body.shipping_line || "*", blNo);
    costCategory = chargeNorm.name || costCategory;

    if ((isOceanCost(costCategory) || isOriginLocalCost(costCategory)) && !hasCompanyRole(supplier, "forwarder")) {
      return res.status(422).json({
        ok: false,
        error: "role_mismatch",
        expect: "forwarder",
        actual: supplier.type,
        supplier_company_code: supplier.code,
        supplier: companyLabel(supplier),
        reason: "海运费/港杂等货代费成本方必须是 forwarder",
      });
    }

    const payerResult = await resolvePayer(pool, body);
    if (payerResult.status) return res.status(payerResult.status).json(payerResult.payload);

    const payer = payerResult.payer;
    const payerType = payerResult.payerType;
    const freightTerm = payerResult.freightTerm;
    const raw = buildRaw(body, supplier, payer, payerType, freightTerm);
    raw.original_name = chargeNorm.original_name || null;
    raw.unmapped = Boolean(chargeNorm.unmapped);
    const linkPlanId = await resolvePlanIdForBill(pool, blNo, body.link_plan_id);

    const base = {
      supplier: companyLabel(supplier),
      supplier_type: supplier.type,
      bill_month: body.bill_month || null,
      bill_file: body.bill_file || null,
      bl_no: blNo,
      container_no: body.container_no || null,
      cost_category: costCategory,
      amount,
      currency,
      qty,
      unit_price: unitPrice,
      pair_id: body.pair_id || null,
      rebill_status: payerResult.rebillStatus,
      incoterm: freightTerm || null,
      link_plan_id: linkPlanId,
      link_agency_id: body.link_agency_id || null,
      reconciled: false,
      reconcile_note: body.reconcile_note || null,
      source_row: body.source_row || null,
      raw,
    };

    const columns = await getBillColumns(pool);
    const optional = {
      supplier_company_code: supplier.code,
      payer_company_code: payer?.code || null,
      payer_type: payerType,
      freight_term: freightTerm || null,
    };

    for (const col of OPTIONAL_BILL_COLUMNS) {
      if (columns.has(col)) base[col] = optional[col];
    }

    const keys = Object.keys(base);
    const vals = keys.map(k => (k === "raw" ? JSON.stringify(base[k]) : base[k]));
    const placeholders = keys.map((_, i) => `$${i + 1}`);

    const r = await pool.query(
      `INSERT INTO freight_supplier_bills (${keys.join(", ")})
       VALUES (${placeholders.join(", ")})
       RETURNING *`,
      vals
    );

    return res.status(201).json({
      ok: true,
      data: r.rows[0],
      supplier: {
        code: supplier.code,
        type: supplier.type,
        name: companyLabel(supplier),
      },
      payer: payer ? {
        code: payer.code,
        type: payer.type,
        name: companyLabel(payer),
        payer_type: payerType,
      } : null,
    });
  } catch (err) {
    return errorResponse(err, res);
  }
}
