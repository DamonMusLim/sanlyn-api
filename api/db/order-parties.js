import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const ORDER_COLS = [
  "id", "_id", "order_no", "contract_no", "customer", "consignee",
  "issuing_company", "issuing_company_id", "customer_company_id",
  "seller_company_id", "seller_code", "factory", "factory_company_id",
  "factory_code", "forward_meta",
];
const COMPANY_COLS = ["id", "code", "name_en", "name_cn", "type", "relationship_type"];
const SHIP_COLS = ["id", "_id", "shipment_no", "contract_no", "order_contract_nos", "order_nos", "contract_nos", "bl_no", "container_no"];
const DOC_COLS = ["id", "_id", "order_id", "order_no", "contract_no", "bl_no", "doc_type", "type", "category", "file_url", "url", "oss_url", "filename", "file_name", "name", "created_at", "updated_at", "issue_date"];
const BILL_COLS = ["id", "supplier_company_code", "bill_file", "bl_no", "container_no", "amount", "currency", "cost_category", "reconciled", "bill_month"];

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

function clean(v) { return String(v ?? "").trim(); }
function norm(v) { return clean(v).replace(/\s+/g, " ").toLowerCase(); }

function uniq(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const s = clean(value);
    if (!s) continue;
    const k = norm(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function splitNames(value) { return uniq(clean(value).split(/[、,，;；/]+/)); }

function dateOnly(v) {
  if (!v) return null;
  try { return new Date(v).toISOString().slice(0, 10); } catch { return String(v).slice(0, 10); }
}

function orderRefs(order, blNos) {
  return uniq([
    order.id, order._id, order.order_no, order.contract_no,
    ...(blNos || []),
  ].filter((v) => v !== null && v !== undefined).map(String));
}

async function loadOrder(pool, query) {
  const cols = await tableColumns(pool, "orders", ORDER_COLS);
  if (!cols.length) return null;

  const conds = [];
  const params = [];
  if (query.contract_no && cols.includes("contract_no")) {
    params.push(clean(query.contract_no));
    conds.push(`contract_no = $${params.length}`);
  }
  if (query.order_no && cols.includes("order_no")) {
    params.push(clean(query.order_no));
    conds.push(`order_no = $${params.length}`);
  }
  if (query.id) {
    const id = clean(query.id);
    if (cols.includes("id")) {
      params.push(id);
      conds.push(`id::text = $${params.length}`);
    }
    if (cols.includes("_id")) {
      params.push(id);
      conds.push(`_id::text = $${params.length}`);
    }
  }
  if (!conds.length) return null;

  const r = await pool.query(
    `SELECT ${cols.join(", ")} FROM orders WHERE ${conds.join(" OR ")} LIMIT 1`,
    params
  );
  return r.rows[0] || null;
}

async function loadShipments(pool, order) {
  const cols = await tableColumns(pool, "shipping_plans", SHIP_COLS);
  if (!cols.includes("bl_no")) return [];

  const conds = [];
  const params = [];
  const contractNo = clean(order.contract_no);
  const orderNo = clean(order.order_no);

  function addNeedle(column, value) {
    if (!value || !cols.includes(column)) return;
    params.push(value);
    if (column === "contract_no") conds.push(`${column} = $${params.length}`);
    else conds.push(`${column}::text ILIKE '%' || $${params.length} || '%'`);
  }

  addNeedle("contract_no", contractNo);
  addNeedle("order_contract_nos", contractNo);
  addNeedle("order_contract_nos", orderNo);
  addNeedle("contract_nos", contractNo);
  addNeedle("order_nos", orderNo);
  if (!conds.length) return [];

  const r = await pool.query(
    `SELECT ${cols.join(", ")}
       FROM shipping_plans
      WHERE ${conds.join(" OR ")}
      ORDER BY ${cols.includes("id") ? "id" : cols[0]} DESC
      LIMIT 50`,
    params
  );
  return r.rows;
}

async function loadCompanies(pool, names, codes) {
  const cols = await tableColumns(pool, "companies", COMPANY_COLS);
  if (!cols.length) return { byName: new Map(), byCode: new Map() };

  const n = uniq(names).map(norm);
  const c = uniq(codes).map((x) => clean(x).toUpperCase());
  if (!n.length && !c.length) return { byName: new Map(), byCode: new Map() };

  const conds = [];
  const params = [];
  if (n.length && (cols.includes("name_en") || cols.includes("name_cn"))) {
    params.push(n);
    const parts = [];
    if (cols.includes("name_en")) parts.push(`lower(btrim(name_en)) = ANY($${params.length}::text[])`);
    if (cols.includes("name_cn")) parts.push(`lower(btrim(name_cn)) = ANY($${params.length}::text[])`);
    conds.push(`(${parts.join(" OR ")})`);
  }
  if (c.length && cols.includes("code")) {
    params.push(c);
    conds.push(`upper(btrim(code)) = ANY($${params.length}::text[])`);
  }

  const r = await pool.query(
    `SELECT ${cols.join(", ")} FROM companies WHERE ${conds.join(" OR ")}`,
    params
  );
  const byName = new Map();
  const byCode = new Map();
  for (const row of r.rows) {
    for (const key of [row.name_en, row.name_cn].map(norm).filter(Boolean)) byName.set(key, row);
    if (row.code) byCode.set(clean(row.code).toUpperCase(), row);
  }
  return { byName, byCode };
}

function companyLabel(c, fallback) { return clean(c?.name_en) || clean(c?.name_cn) || clean(fallback); }

function participant(role, names, companies) {
  const linked = companies.filter(Boolean);
  return {
    role,
    names: uniq([...names, ...linked.map((c) => companyLabel(c))]),
    company_codes: uniq(linked.map((c) => c.code)),
    company_ids: uniq(linked.map((c) => c.id).filter((v) => v !== null && v !== undefined).map(String)),
    link_status: linked.length ? "linked" : "text_only",
  };
}

function buildParticipants(order, bills, companyIndex) {
  const entries = [];
  const customerNames = splitNames(order.customer);
  const consigneeNames = norm(order.consignee) && norm(order.consignee) !== norm(order.customer)
    ? splitNames(order.consignee)
    : [];
  const issuingNames = splitNames(order.issuing_company);
  const factoryNames = splitNames(order.factory);
  const forwarderCodes = uniq(bills.map((b) => b.supplier_company_code));

  function byNames(names) { return names.map((name) => companyIndex.byName.get(norm(name))).filter(Boolean); }
  function byCodes(codes) { return codes.map((code) => companyIndex.byCode.get(clean(code).toUpperCase())).filter(Boolean); }

  if (customerNames.length) entries.push(participant("customer", customerNames, byNames(customerNames)));
  if (consigneeNames.length) entries.push(participant("consignee", consigneeNames, byNames(consigneeNames)));
  if (issuingNames.length) entries.push(participant("issuing", issuingNames, byNames(issuingNames)));
  if (factoryNames.length) entries.push(participant("factory", factoryNames, byNames(factoryNames)));
  if (forwarderCodes.length) {
    const companies = byCodes(forwarderCodes);
    const names = forwarderCodes.map((code) => companyLabel(companyIndex.byCode.get(clean(code).toUpperCase()), code));
    entries.push(participant("forwarder", names, companies));
  }
  return entries;
}

async function loadDocuments(pool, order, blNos) {
  const cols = await tableColumns(pool, "documents", DOC_COLS);
  if (!cols.length) return [];
  const refs = orderRefs(order, blNos);
  const conds = [];
  for (const c of ["order_id", "order_no", "contract_no", "bl_no"]) {
    if (cols.includes(c)) conds.push(`${c}::text = ANY($1::text[])`);
  }
  if (!refs.length || !conds.length) return [];

  const r = await pool.query(
    `SELECT ${cols.join(", ")}
       FROM documents
      WHERE ${conds.join(" OR ")}
      ORDER BY ${cols.includes("created_at") ? "created_at" : cols[0]} DESC NULLS LAST
      LIMIT 1000`,
    [refs]
  );
  const seen = new Set();
  return r.rows.map(docDto).filter((d) => {
    const key = `${d.type || ""}|${d.url || ""}|${d.filename || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function ownerRole(type) {
  const t = norm(type).replace(/[^a-z0-9_/-]/g, "");
  if (["po", "pc", "purchase_contract", "purchase-order", "quarantine", "quarantine_report", "ciq_report", "qr"].includes(t)) return "factory";
  if (["cd", "customs", "customs_declaration", "customs_docs"].includes(t)) return "issuing";
  if (["iv", "invoice", "commercial_invoice", "pl", "packing_list", "sc", "sales_contract", "co", "origin_cert", "certificate_of_origin"].includes(t)) return "issuing";
  if (["so", "bl", "bill_of_lading", "debit", "dn", "freight_bill", "freight_debit_note", "sea_freight_bill"].includes(t)) return "forwarder";
  return null;
}

function docDto(d) {
  const type = d.doc_type || d.type || d.category || null;
  return {
    type,
    filename: d.filename || d.file_name || d.name || null,
    url: d.file_url || d.url || d.oss_url || null,
    date: dateOnly(d.issue_date || d.created_at || d.updated_at),
    owner_role: ownerRole(type),
  };
}

async function loadFreightBills(pool, blNos) {
  const cols = await tableColumns(pool, "freight_supplier_bills", BILL_COLS);
  if (!cols.includes("bl_no") || !blNos.length) return [];
  const r = await pool.query(
    // Intentional raw-table read: party dossier needs full bill evidence, including voided/direct-paid rows.
    `SELECT ${cols.join(", ")}
       FROM freight_supplier_bills
      WHERE bl_no = ANY($1::text[])
      ORDER BY ${cols.includes("bill_month") ? "bill_month" : cols[0]} DESC NULLS LAST`,
    [blNos]
  );
  return r.rows.map((b) => ({
    supplier_company_code: b.supplier_company_code ?? null,
    bill_file: b.bill_file ?? null,
    bl_no: b.bl_no ?? null,
    container_no: b.container_no ?? null,
    amount: b.amount ?? null,
    currency: b.currency ?? null,
    cost_category: b.cost_category ?? null,
    reconciled: b.reconciled ?? null,
    bill_month: b.bill_month ?? null,
  }));
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const { contract_no, order_no, id } = req.query || {};
  if (!contract_no && !order_no && !id) {
    return res.status(400).json({ error: "contract_no, order_no or id required" });
  }

  try {
    const pool = getPool();
    const order = await loadOrder(pool, { contract_no, order_no, id });
    if (!order) return res.status(404).json({ error: "order_not_found" });

    const shipments = await loadShipments(pool, order);
    const blNos = uniq(shipments.map((s) => s.bl_no));
    const freightBills = await loadFreightBills(pool, blNos);

    const partyNames = [
      ...splitNames(order.customer),
      ...splitNames(order.consignee),
      ...splitNames(order.issuing_company),
      ...splitNames(order.factory),
    ];
    const companyIndex = await loadCompanies(
      pool,
      partyNames,
      freightBills.map((b) => b.supplier_company_code)
    );
    const documents = await loadDocuments(pool, order, blNos);

    return res.json({
      success: true,
      order: { id: order.id ?? order._id ?? null, order_no: order.order_no ?? null, contract_no: order.contract_no ?? null },
      bl_nos: blNos,
      participants: buildParticipants(order, freightBills, companyIndex),
      documents,
      freight_bills: freightBills,
      finance: { status: "pending_reconcile" },
    });
  } catch (err) {
    console.error("[order-parties]", err.message);
    return res.status(500).json({ error: "Query failed", code: "DB_ERROR" });
  }
}
