import { applyLens, lensColumns, scopeWhere } from "./billing-tab-lens.js";

function side(direction) {
  if (direction === "payable") return {
    code: "supplier_company_code", total: "amount", status: "ap_status", paid: "ap_paid_amount",
  };
  if (direction === "receivable") return {
    code: "payer_company_code", total: "sale_amount", status: "ar_status", paid: "ar_paid_amount",
  };
  return null;
}

function round2(v) {
  const n = Number(v || 0);
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function emptyBucket() {
  return { payable: 0, receivable: 0, gross_profit: 0 };
}

function summarize(rows, role) {
  const byCurrency = {};
  for (const row of rows) {
    const currency = row.currency || "UNKNOWN";
    if (!byCurrency[currency]) byCurrency[currency] = emptyBucket();
    if (Object.prototype.hasOwnProperty.call(row, "amount")) {
      byCurrency[currency].payable += Number(row.amount || 0);
    }
    if (Object.prototype.hasOwnProperty.call(row, "sale_amount")) {
      byCurrency[currency].receivable += Number(row.sale_amount || 0);
    }
    if (Object.prototype.hasOwnProperty.call(row, "gross_profit")) {
      byCurrency[currency].gross_profit += Number(row.gross_profit || 0);
    }
  }

  return Object.entries(byCurrency).map(([currency, sums]) => {
    const out = { currency };
    if (role === "internal" || role === "oceanbaby" || role === "forwarder" || role === "factory") {
      out.payable = round2(sums.payable);
    }
    if (role === "internal" || role === "oceanbaby" || role === "customer") {
      out.receivable = round2(sums.receivable);
    }
    if (role === "internal" || role === "oceanbaby") {
      out.gross_profit = round2(sums.gross_profit);
    }
    return out;
  });
}

function buildScopedWhere(role, scopeCode, params) {
  const scoped = scopeWhere(role, scopeCode, params.length + 1);
  params.push(...scoped.params);
  return scoped.where;
}

export async function getShipmentBilling(pool, { bl_no, role, scopeCode }) {
  const blNo = String(bl_no || "").trim();
  if (!blNo) {
    const err = new Error("bl_no required");
    err.statusCode = 400;
    err.code = "missing_bl_no";
    throw err;
  }

  const params = [blNo];
  const conds = ["b.bl_no = $1"].concat(buildScopedWhere(role, scopeCode, params));
  const sql = `
    SELECT ${lensColumns(role).join(",\n           ")}
      FROM active_freight_supplier_bills b
     WHERE ${conds.join(" AND ")}
     ORDER BY b.id`;
  const r = await pool.query(sql, params);
  const lines = applyLens(r.rows, role);
  return { bl_no: blNo, lines, summary: summarize(lines, role) };
}

export async function getCompanyBilling(pool, { company_code, direction, role, scopeCode, limit }) {
  const s = side(direction);
  const companyCode = String(company_code || "").trim();
  if (!s) {
    const err = new Error("direction must be payable or receivable");
    err.statusCode = 400;
    err.code = "bad_direction";
    throw err;
  }
  if (!companyCode) {
    const err = new Error("company_code required");
    err.statusCode = 400;
    err.code = "missing_company_code";
    throw err;
  }

  if (role !== "internal" && role !== "oceanbaby" && companyCode !== String(scopeCode || "")) {
    const err = new Error("company_code out of scope");
    err.statusCode = 403;
    err.code = "out_of_scope";
    throw err;
  }

  const safeLimit = Math.min(Math.max(parseInt(limit || "200", 10) || 200, 1), 500);
  const params = [companyCode];
  const conds = [`b.${s.code} = $1`, `COALESCE(b.${s.total}, 0) > 0`]
    .concat(buildScopedWhere(role, scopeCode, params));
  params.push(safeLimit);

  const sql = `
    SELECT ${lensColumns(role).join(",\n           ")}
      FROM active_freight_supplier_bills b
     WHERE ${conds.join(" AND ")}
     ORDER BY b.updated_at DESC NULLS LAST, b.id DESC
     LIMIT $${params.length}`;
  const r = await pool.query(sql, params);
  const lines = applyLens(r.rows, role);
  return { company_code: companyCode, direction, lines, summary: summarize(lines, role) };
}
