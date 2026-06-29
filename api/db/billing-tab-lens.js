import { callerCompanyScope, filterByRole, isInternalRole, roleFromAuth } from "../lib/viewmodel-adapter.js";

const BASE_COLUMNS = [
  "b.id",
  "b.bl_no",
  "b.container_no",
  "b.cost_category",
  "b.currency",
  "b.qty",
  "b.charge_basis",
  "b.incoterm",
  "b.updated_at",
];

const INTERNAL_EXTRA = [
  "b.supplier",
  "b.supplier_company_code",
  "b.payer_company_code",
  "b.amount",
  "b.sale_amount",
  "ROUND((COALESCE(b.sale_amount, 0) - COALESCE(b.amount, 0))::numeric, 2) AS gross_profit",
  "b.ap_status",
  "b.ap_paid_amount",
  "b.ar_status",
  "b.ar_paid_amount",
];

const PAYABLE_EXTRA = [
  "b.amount",
  "b.ap_status AS status",
  "b.ap_paid_amount AS paid_amount",
];

const FACTORY_EXTRA = [
  "b.amount",
  "b.ap_status AS status",
  "b.ap_paid_amount AS paid_amount",
];

const RECEIVABLE_EXTRA = [
  "b.sale_amount",
  "b.ar_status AS status",
  "b.ar_paid_amount AS paid_amount",
];

const FORBIDDEN_BY_ROLE = {
  forwarder: ["sale_amount", "gross_profit", "ar_status", "ar_paid_amount"],
  customer: ["amount", "gross_profit", "ap_status", "ap_paid_amount"],
  factory: ["sale_amount", "gross_profit", "ar_status", "ar_paid_amount"],
};

export function resolveBillingRole(req, token) {
  const rawRole = String(token?.role || token?.recipient_role || roleFromAuth(req) || "").toLowerCase();
  const jwtScope = callerCompanyScope(req);
  const scopeCode = token?.scopeCode || token?.scope_code || token?.company_code ||
    token?.supplier_company_code || token?.payer_company_code || token?.factory_company_code ||
    jwtScope.primary || null;

  if (isInternalRole(rawRole)) return { role: "internal", scopeCode: null };
  if (rawRole === "oceanbaby" || rawRole === "yangbaobao") {
    return { role: "oceanbaby", scopeCode: null };
  }
  if (["supplier_portal", "forwarder", "logistics"].includes(rawRole)) {
    return { role: "forwarder", scopeCode };
  }
  if (["customer", "customer_booking"].includes(rawRole)) {
    return { role: "customer", scopeCode };
  }
  if (["factory", "factory_booking"].includes(rawRole)) {
    return { role: "factory", scopeCode };
  }
  return { role: "anonymous", scopeCode: null };
}

export function lensColumns(role) {
  if (role === "internal" || role === "oceanbaby") return BASE_COLUMNS.concat(INTERNAL_EXTRA);
  if (role === "forwarder") return BASE_COLUMNS.concat(PAYABLE_EXTRA);
  if (role === "factory") return BASE_COLUMNS.concat(FACTORY_EXTRA);
  if (role === "customer") return BASE_COLUMNS.concat(RECEIVABLE_EXTRA);
  return BASE_COLUMNS.slice();
}

export function applyLens(rows, role) {
  const safeRows = filterByRole(rows, { role: role === "oceanbaby" ? "internal" : role }) || [];
  if (role === "internal" || role === "oceanbaby") return safeRows;

  const forbidden = new Set(FORBIDDEN_BY_ROLE[role] || ["amount", "sale_amount", "gross_profit"]);
  return safeRows.map((row) => {
    const out = { ...row };
    for (const field of forbidden) delete out[field];
    delete out.supplier_company_code;
    delete out.payer_company_code;
    delete out.supplier;
    return out;
  });
}

function customerCategorySql() {
  return `(
    b.canonical_category IN ('海运费','拖车费','ocean_freight','trucking')
    OR b.cost_category IN ('海运费','拖车费')
    OR b.cost_category ILIKE '%海运%'
    OR b.cost_category ILIKE '%拖车%'
    OR b.cost_category ILIKE '%ocean%'
    OR b.cost_category ILIKE '%freight%'
    OR b.cost_category ILIKE '%truck%'
  )`;
}

function factoryCategorySql() {
  return `(
    b.canonical_category IN ('港杂费','local_charge','port_charge')
    OR b.cost_category IN ('港杂费','THC','EIR','代理费','封签费','订舱费','单证费','报关费','VGM','舱单费')
    OR b.cost_category ILIKE '%港杂%'
    OR b.cost_category ILIKE '%local%'
    OR b.cost_category ILIKE '%port%'
  )`;
}

export function scopeWhere(role, scopeCode, startIndex = 1) {
  if (role === "internal" || role === "oceanbaby") return { where: [], params: [] };
  if (!scopeCode) return { where: ["FALSE"], params: [] };

  const p = `$${startIndex}`;
  if (role === "forwarder") {
    return {
      where: [`b.supplier_company_code = ${p}`, "COALESCE(b.amount, 0) > 0"],
      params: [String(scopeCode)],
    };
  }
  if (role === "customer") {
    return {
      where: [`b.payer_company_code = ${p}`, "COALESCE(b.sale_amount, 0) > 0", customerCategorySql()],
      params: [String(scopeCode)],
    };
  }
  if (role === "factory") {
    return {
      where: [`b.payer_company_code = ${p}`, "COALESCE(b.amount, 0) > 0", factoryCategorySql()],
      params: [String(scopeCode)],
    };
  }
  return { where: ["FALSE"], params: [] };
}
