// api/db/portal-dossier.js
// GET /api/portal/dossier
// Read-only company portal aggregate. No writes, no price/cost fields for customer/factory.

import { getPool, setCors } from "../db.js";
import { parsePortalAuth } from "../portal/middleware.js";

const ORDER_SCOPE_TYPES = new Set([
  "order_id", "order_no", "contract_no", "allowed_order_id", "allowed_order_no", "allowed_contract_no",
]);
const COMPANY_SCOPE_TYPES = new Set(["company", "company_code", "partner_company", "supplier_company"]);
const DOC_COLS = [
  "id", "_id", "order_id", "order_no", "contract_no", "bl_no",
  "doc_type", "type", "category", "file_url", "url", "oss_url", "path",
  "filename", "file_name", "name", "created_at", "updated_at", "issue_date",
];
const ORDER_COLS = [
  "id", "_id", "order_no", "contract_no", "customer", "factory",
  "company_code", "factory_code", "created_at", "updated_at",
];
const BILL_COLS = [
  "id", "supplier_company_code", "bill_file", "bl_no", "container_no",
  "amount", "currency", "cost_category", "reconciled", "bill_month", "link_agency_id",
];

function scopeValues(perms, types) {
  return (perms.scopes || [])
    .filter((s) => types.has(s.scope_type))
    .map((s) => String(s.scope_value || "").trim())
    .filter(Boolean);
}

function inferRole(perms) {
  const userType = perms.user?.user_type;
  const companyType = String(perms.company?.company_type || "").toLowerCase();
  const roles = new Set(perms.roles || []);
  if (userType === "customer" || companyType.includes("customer")) return "customer";
  if (userType === "factory" || companyType.includes("factory") || roles.has("factory_view")) return "factory";
  if (userType === "logistics" || roles.has("logistics_ocean") || roles.has("logistics_finance")) return "supply_chain";
  return null;
}

function failClosedScope(perms, role) {
  const companyCode = perms.company?.company_code;
  const companyId = perms.user?.company_id || perms.company?.id;
  if (!companyCode || !companyId || !role) return null;

  const orderRefs = scopeValues(perms, ORDER_SCOPE_TYPES);
  const companyScopes = scopeValues(perms, COMPANY_SCOPE_TYPES);
  const scopedToCompany = companyScopes.includes(companyCode);

  if (role === "customer" || role === "factory") {
    if (!orderRefs.length && !scopedToCompany) return null;
  } else if (role === "supply_chain") {
    if (!scopedToCompany) return null;
  } else {
    return null;
  }

  return {
    companyCode,
    companyName: perms.company?.company_name || null,
    orderRefs,
    companyScoped: scopedToCompany,
  };
}

async function tableColumns(pool, table, allowList) {
  const r = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  const have = new Set(r.rows.map((x) => x.column_name));
  return allowList.filter((c) => have.has(c));
}

function dateOnly(v) {
  if (!v) return null;
  try { return new Date(v).toISOString().slice(0, 10); } catch { return String(v).slice(0, 10); }
}

function orderRef(o) {
  return [o.id, o._id, o.order_no, o.contract_no].filter(Boolean).map(String);
}

function orderDto(o, docs) {
  return {
    id: o.id ?? null,
    _id: o._id ?? null,
    order_no: o.order_no ?? null,
    contract_no: o.contract_no ?? null,
    customer: o.customer ?? null,
    factory: o.factory ?? null,
    created_at: o.created_at ?? null,
    updated_at: o.updated_at ?? null,
    documents: docs,
    finance_status: { status: "pending_reconcile" },
  };
}

function docDto(d) {
  const url = d.file_url || d.url || d.oss_url || d.path || null;
  return {
    id: d.id ?? d._id ?? null,
    type: d.doc_type || d.type || d.category || null,
    filename: d.filename || d.file_name || d.name || null,
    url,
    date: dateOnly(d.issue_date || d.created_at || d.updated_at),
  };
}

function billDto(b) {
  return {
    id: b.id ?? null,
    bill_file: b.bill_file ?? null,
    bl_no: b.bl_no ?? null,
    container_no: b.container_no ?? null,
    amount: b.amount ?? null,
    currency: b.currency ?? null,
    cost_category: b.cost_category ?? null,
    reconciled: b.reconciled ?? null,
    bill_month: b.bill_month ?? null,
    link_agency_id: b.link_agency_id ?? null,
    finance_status: { status: "pending_reconcile" },
  };
}

async function loadOrders(pool, role, scope, limit) {
  const cols = await tableColumns(pool, "orders", ORDER_COLS);
  if (!cols.includes("order_no") && !cols.includes("contract_no") && !cols.includes("id")) return [];

  // 安全修复(2026-06-25)：按客户/工厂「名」精确匹配，绝不用 company_code/factory_code。
  // 根因：orders.company_code 已被污染——CN-00040 同时挂 ENRICH/DIBAQ/PETSOME 三家，
  // 按码匹配会让一家客户看到别家订单(串户泄露)。客户名是干净的(每名=一家)。
  const name = String(scope.companyName || "").trim();
  if (!name) return []; // 无法确定身份 → 不返回任何订单 (fail-closed)
  const params = [name];
  const conds = [];
  if (role === "customer" && cols.includes("customer")) {
    conds.push(`lower(btrim(customer)) = lower(btrim($1))`);
  } else if (role === "factory" && cols.includes("factory")) {
    conds.push(`lower(btrim(factory)) = lower(btrim($1))`);
  } else {
    return []; // 角色无可匹配的身份列 → 空
  }

  if (scope.orderRefs.length) {
    params.push(scope.orderRefs);
    const idx = params.length;
    const refConds = [];
    for (const c of ["id", "_id", "order_no", "contract_no"]) {
      if (cols.includes(c)) refConds.push(`${c}::text = ANY($${idx}::text[])`);
    }
    if (refConds.length) conds.push(`(${refConds.join(" OR ")})`);
  }
  if (!conds.length) return [];

  params.push(limit);
  const sql = `
    SELECT ${cols.join(", ")}
      FROM orders
     WHERE ${conds.join(" AND ")}
     ORDER BY ${cols.includes("updated_at") ? "updated_at" : cols[0]} DESC NULLS LAST
     LIMIT $${params.length}`;
  return (await pool.query(sql, params)).rows;
}

async function loadDocuments(pool, orders) {
  if (!orders.length) return new Map();
  const cols = await tableColumns(pool, "documents", DOC_COLS);
  if (!cols.length) return new Map();

  const refs = [...new Set(orders.flatMap(orderRef))];
  if (!refs.length) return new Map();

  const conds = [];
  for (const c of ["order_id", "order_no", "contract_no", "bl_no"]) {
    if (cols.includes(c)) conds.push(`${c}::text = ANY($1::text[])`);
  }
  if (!conds.length) return new Map();

  const r = await pool.query(
    `SELECT ${cols.join(", ")}
       FROM documents
      WHERE ${conds.join(" OR ")}
      ORDER BY ${cols.includes("created_at") ? "created_at" : cols[0]} DESC NULLS LAST
      LIMIT 1000`,
    [refs]
  );

  const byRef = new Map();
  for (const row of r.rows) {
    const dto = docDto(row);
    for (const ref of [row.order_id, row.order_no, row.contract_no, row.bl_no].filter(Boolean).map(String)) {
      if (!byRef.has(ref)) byRef.set(ref, []);
      byRef.get(ref).push(dto);
    }
  }
  return byRef;
}

function docsFor(order, docMap) {
  const seen = new Set();
  const out = [];
  for (const ref of orderRef(order)) {
    for (const d of docMap.get(ref) || []) {
      const key = `${d.id || ""}|${d.url || ""}|${d.type || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

async function loadBills(pool, scope, limit) {
  const cols = await tableColumns(pool, "freight_supplier_bills", BILL_COLS);
  if (!cols.includes("supplier_company_code")) return [];
  const selected = cols.filter((c) => c !== "supplier_company_code");
  if (!selected.length) return [];
  const r = await pool.query(
    // Intentional raw-table read: supplier dossiers need full bill history, including voided/direct-paid rows.
    `SELECT ${selected.join(", ")}
       FROM freight_supplier_bills
      WHERE supplier_company_code = $1
      ORDER BY ${cols.includes("bill_month") ? "bill_month" : cols[0]} DESC NULLS LAST
      LIMIT $2`,
    [scope.companyCode, limit]
  );
  return r.rows.map(billDto);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const pool = getPool();
  const perms = await parsePortalAuth(req, res, pool);
  if (!perms) return;

  const role = inferRole(perms);
  const scope = failClosedScope(perms, role);
  if (!scope) return res.status(403).json({ error: "Portal dossier scope required", code: "FORBIDDEN" });

  const limit = Math.min(Math.max(parseInt(req.query.limit || "100", 10) || 100, 1), 500);

  try {
    if (role === "supply_chain") {
      const bills = await loadBills(pool, scope, limit);
      return res.json({
        success: true,
        role,
        company_code: scope.companyCode,
        data: { bills, finance_status: { status: "pending_reconcile" } },
        count: bills.length,
      });
    }

    const orders = await loadOrders(pool, role, scope, limit);
    const docMap = await loadDocuments(pool, orders);
    const data = orders.map((o) => orderDto(o, docsFor(o, docMap)));
    return res.json({
      success: true,
      role,
      company_code: scope.companyCode,
      data: { orders: data, finance_status: { status: "pending_reconcile" } },
      count: data.length,
    });
  } catch (err) {
    console.error("[portal-dossier]", err.message);
    return res.status(500).json({ error: "Query failed", code: "DB_ERROR" });
  }
}
