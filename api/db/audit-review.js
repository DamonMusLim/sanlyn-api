// GET /api/db/audit-review — 审核管理专项只读聚合
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const MODULES = [
  { key: "quote", label: "报价审核", tables: [
    { name: "supply_chain_quote_requests", fields: ["id", "status", "created_at"], title: ["title", "route_code", "customer_name"] },
    { name: "ddp_quotes", fields: ["id", "status", "created_at"], title: ["quote_no", "customer_name"] },
    { name: "service_rates", fields: ["id", "review_status", "created_at"], title: ["carrier", "route_code", "service_type"] },
  ] },
  { key: "fee_template", label: "费用模板审核", tables: [
    { name: "carrier_tariff_standards", fields: ["id", "review_status", "created_at"], title: ["carrier", "port", "charge_item_code"] },
    { name: "fee_name_candidates", fields: ["id", "status", "created_at"], title: ["raw_name", "canonical_name"] },
    { name: "service_rates", fields: ["id", "review_status", "created_at"], title: ["service_type", "charge_item"] },
  ] },
  { key: "order", label: "订单审核", tables: [
    { name: "orders", fields: ["id", "status", "created_at"], title: ["order_no", "customer_name"] },
    { name: "order_drafts", fields: ["id", "status", "created_at"], title: ["order_no", "customer_name"] },
  ] },
  { key: "bl", label: "提单审核", tables: [
    { name: "ocean_doc_intake", fields: ["id", "status", "created_at"], title: ["doc_type", "bl_no"] },
    { name: "bl_confirmation_events", fields: ["id", "status", "created_at"], title: ["bl_no", "event_type"] },
    { name: "canonical_documents", fields: ["id", "processing_status", "created_at"], title: ["doc_type", "bl_no"] },
  ] },
  { key: "fee", label: "费用审核", tables: [
    { name: "freight_supplier_bills", fields: ["id", "rebill_status", "created_at"], title: ["bl_no", "cost_category", "supplier"] },
    { name: "local_charges", fields: ["id", "review_status", "created_at"], title: ["bl_no", "charge_item"] },
  ] },
  { key: "bill", label: "账单审核", tables: [
    { name: "finance_invoices_in", fields: ["id", "review_status", "created_at"], title: ["invoice_no", "seller_name"] },
    { name: "finance_invoices_out", fields: ["id", "review_status", "created_at"], title: ["invoice_no", "buyer_name"] },
    { name: "invoice_drafts", fields: ["id", "status", "created_at"], title: ["invoice_no", "customer_name"] },
  ] },
  { key: "company", label: "往来公司审核", tables: [
    { name: "companies", fields: ["id", "status", "created_at"], title: ["name", "company_name", "official_name"] },
    { name: "company_aliases", fields: ["id", "status", "created_at"], title: ["alias", "company_name"] },
    { name: "company_brand_permissions", fields: ["id", "review_status", "created_at"], title: ["company_code", "brand"] },
  ] },
  { key: "contract", label: "合同审核", tables: [
    { name: "purchase_contracts", fields: ["id", "status", "created_at"], title: ["contract_no", "supplier"] },
    { name: "shipping_plan_contract_splits", fields: ["id", "created_at"], title: ["contract_no", "shipping_plan_id"] },
    { name: "company_billing_policies", fields: ["id", "updated_at"], title: ["company_code", "policy_name"] },
  ] },
];

const STATUS_COLS = ["review_status", "status", "processing_status", "rebill_status"];
const PENDING = ["pending", "pending_review", "needs_internal_review", "needs_fix", "blocked", "proposed", "mgr_ok"];
const DONE = ["approved", "accepted", "confirmed", "resolved", "done", "auto_accepted", "rejected"];

function clean(v, max = 80) {
  return String(v ?? "").trim().slice(0, max);
}

function ident(v) {
  return '"' + String(v).replace(/"/g, '""') + '"';
}

function moduleFor(key) {
  return MODULES.find((m) => m.key === key) || MODULES[0];
}

async function columnMap(pool, tableNames) {
  const r = await pool.query(
    `SELECT table_name,column_name
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name = ANY($1)`,
    [tableNames]
  );
  const map = new Map();
  r.rows.forEach((x) => {
    if (!map.has(x.table_name)) map.set(x.table_name, new Set());
    map.get(x.table_name).add(x.column_name);
  });
  return map;
}

function pick(cols, candidates) {
  return candidates.find((c) => cols.has(c)) || "";
}

function expr(cols, candidates, fallback = "NULL") {
  const usable = candidates.filter((c) => cols.has(c)).map((c) => `NULLIF(${ident(c)}::text,'')`);
  return usable.length ? `COALESCE(${usable.join(",")})` : fallback;
}

async function tableStatus(pool, table, cols) {
  const missing = table.fields.filter((f) => !cols.has(f));
  const presentCore = table.fields.filter((f) => cols.has(f));
  if (!presentCore.length) {
    return { table: table.name, state: "not_connected", missing, fill_rate: null, total: null, pending: null, rows: [] };
  }
  const filledExprs = presentCore.map((f) => `COUNT(${ident(f)})`).join(" + ");
  const denom = `${presentCore.length} * NULLIF(COUNT(*),0)`;
  const status = pick(cols, STATUS_COLS);
  const dateCol = pick(cols, ["created_at", "updated_at", "issue_date"]);
  const idExpr = cols.has("id") ? "id::text" : "ctid::text";
  const title = expr(cols, table.title, idExpr);
  const wherePending = status ? `WHERE lower(COALESCE(${ident(status)}::text,'')) = ANY($1)` : "WHERE false";
  const counts = await pool.query(
    `SELECT COUNT(*)::int AS total,
            CASE WHEN COUNT(*)=0 THEN NULL
                 ELSE ROUND(((${filledExprs})::numeric / (${denom}) * 100),1) END AS fill_rate
       FROM ${ident(table.name)}`
  );
  const total = Number(counts.rows[0]?.total || 0);
  if (!total) {
    return { table: table.name, state: "not_connected", missing, fill_rate: null, total: null, pending: null, rows: [] };
  }
  const pending = status ? await pool.query(
    `SELECT COUNT(*)::int AS n FROM ${ident(table.name)} ${wherePending}`,
    [PENDING]
  ) : { rows: [{ n: null }] };
  const rows = status ? await pool.query(
    `SELECT ${idExpr} AS id, ${title} AS title, ${ident(status)}::text AS status,
            ${dateCol ? `to_char(${ident(dateCol)},'YYYY-MM-DD HH24:MI')` : "NULL"} AS created_at
       FROM ${ident(table.name)} ${wherePending}
      ORDER BY ${dateCol ? ident(dateCol) + " DESC NULLS LAST," : ""} ${idExpr} DESC
      LIMIT 20`,
    [PENDING]
  ) : { rows: [] };
  return {
    table: table.name,
    state: missing.length ? "partial" : "ready",
    missing,
    fill_rate: counts.rows[0]?.fill_rate === null ? null : Number(counts.rows[0].fill_rate),
    total,
    pending: pending.rows[0]?.n === null ? null : Number(pending.rows[0].n || 0),
    rows: rows.rows,
    status_field: status || null,
  };
}

async function todosFor(pool, mod) {
  try {
    const tables = mod.tables.map((t) => t.name);
    const vals = [tables, mod.key, "%" + mod.label.replace("审核", "") + "%"];
    const r = await pool.query(
      `SELECT id::text AS id, check_code, severity, target_table, target_id,
              description AS title, status,
              to_char(created_at,'YYYY-MM-DD HH24:MI') AS created_at
         FROM operation_todos
        WHERE (target_table = ANY($1)
           OR lower(check_code) LIKE '%' || $2 || '%'
           OR description LIKE $3)
          AND status NOT IN ('approved','rejected','resolved','done')
        ORDER BY created_at DESC,id DESC
        LIMIT 40`,
      vals
    );
    return { state: "ready", rows: r.rows, count: r.rows.length };
  } catch (e) {
    return { state: "not_connected", rows: [], count: null, reason: "缺 operation_todos 或字段 id/check_code/severity/target_table/target_id/description/status/created_at" };
  }
}

async function buildModule(pool, mod) {
  const cmap = await columnMap(pool, mod.tables.map((t) => t.name));
  const tables = [];
  for (const t of mod.tables) {
    const cols = cmap.get(t.name);
    if (!cols) {
      tables.push({ table: t.name, state: "not_connected", missing: t.fields, fill_rate: null, total: null, pending: null, rows: [] });
    } else {
      tables.push(await tableStatus(pool, t, cols));
    }
  }
  const todo = await todosFor(pool, mod);
  const best = tables.find((t) => t.state === "ready") || tables.find((t) => t.state === "partial") || tables[0];
  return {
    key: mod.key,
    label: mod.label,
    generated_at: new Date().toISOString(),
    source: best,
    tables,
    todo,
    status_options: { pending: PENDING, done: DONE },
    note: "只读审核专项；未接入/零数据不反推数量，不提供忽略或审批写入。",
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });
  try {
    const pool = getPool();
    const key = clean(req.query.type || req.query.module || "quote", 40);
    const mod = moduleFor(key);
    const data = await buildModule(pool, mod);
    return res.status(200).json({ success: true, data, modules: MODULES.map(({ key, label }) => ({ key, label })) });
  } catch (err) {
    console.error("[audit-review]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
