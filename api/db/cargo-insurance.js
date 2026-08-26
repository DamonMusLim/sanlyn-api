// 货运保险 · read-only lens over insurance_policies.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const READ_ROLES = new Set(["admin", "logistics", "sales", "ops", "finance", "operator", "ceo", "superadmin"]);
const VERSION = "v2026.08.26-1";
const CORE_FIELDS = [
  ["order_ref", "订单号"], ["shipping_plan_id", "海运计划ID"], ["status", "状态"],
  ["insured_name", "被保险人"], ["policyholder_name", "投保人"], ["policyholder_tax_id", "投保人税号"],
  ["bl_no", "提单号"], ["contract_no", "合同号"], ["vessel_voyage", "船名航次"],
  ["pol", "起运港"], ["pod", "目的港"], ["etd", "ETD"], ["cargo_description", "货物描述"],
  ["packing_qty", "件数包装"], ["invoice_amount", "发票金额"], ["currency", "币种"],
  ["markup_pct", "加成比例"], ["insured_amount", "保险金额"], ["goods_category", "货类"],
  ["transport_mode", "运输方式"], ["insurer", "保险公司"], ["rate", "费率"],
  ["premium_rmb", "保费人民币"], ["policy_no", "保单号"], ["policy_pdf_url", "保单PDF"],
  ["filled_at", "填单时间"], ["submitted_at", "提交时间"],
];
const MONEY_FIELDS = new Set(["invoice_amount", "insured_amount", "premium_rmb", "rate", "markup_pct"]);

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}

function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}

function hasValue(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

function pct(filled, total) {
  if (!total) return null;
  return Math.round((filled * 1000) / total) / 10;
}

async function tableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(r.rows[0]?.name);
}

async function columns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function colExpr(name, colSet) {
  return colSet.has(name) ? `p.${name}` : `NULL AS ${name}`;
}

function coverage(rows, colSet) {
  const total = rows.length;
  return CORE_FIELDS.map(([name, label]) => {
    if (!colSet.has(name)) return { name, label, state: "not_connected", filled: 0, total, fill_rate: null };
    const filled = rows.filter((r) => hasValue(r[name])).length;
    return { name, label, state: filled ? "ready" : "not_connected", filled, total, fill_rate: pct(filled, total) };
  });
}

function missingFor(row, colSet) {
  return CORE_FIELDS
    .filter(([name]) => !colSet.has(name) || !hasValue(row[name]))
    .map(([name, label]) => ({ name, label, reason: colSet.has(name) ? "empty" : "not_connected" }));
}

function searchConds(colSet, params, q) {
  const search = clean(q.q || q.search || q.bl_no || q.order_ref, 100);
  if (!search) return [];
  const cols = ["order_ref", "bl_no", "contract_no", "policy_no", "insured_name", "policyholder_name", "insurer"]
    .filter((name) => colSet.has(name))
    .map((name) => `p.${name}::text ILIKE $${params.length + 1}`);
  if (!cols.length) return [];
  params.push(`%${search}%`);
  return [`(${cols.join(" OR ")})`];
}

function stateConds(colSet, params, q) {
  const state = clean(q.state, 40);
  if (!state) return [];
  if (state === "not_connected") return ["TRUE = FALSE"];
  if (state === "missing_policy" && colSet.has("policy_no")) return ["NULLIF(BTRIM(p.policy_no::text), '') IS NULL"];
  if (state === "submitted" && colSet.has("submitted_at")) return ["p.submitted_at IS NOT NULL"];
  if (colSet.has("status")) {
    params.push(state);
    return [`p.status::text = $${params.length}`];
  }
  return [];
}

async function listRows(pool, colSet, q) {
  const limit = Math.min(parseInt(q.limit, 10) || 120, 200);
  const params = [];
  const conds = [];
  if (colSet.has("deleted_at")) conds.push("p.deleted_at IS NULL");
  conds.push(...searchConds(colSet, params, q));
  conds.push(...stateConds(colSet, params, q));
  params.push(limit);
  const id = colSet.has("id") ? "p.id::text AS id" : "NULL AS id";
  const fields = CORE_FIELDS.map(([name]) => colExpr(name, colSet)).join(", ");
  const order = [
    colSet.has("created_at") ? "p.created_at DESC NULLS LAST" : "",
    colSet.has("etd") ? "p.etd DESC NULLS LAST" : "",
    colSet.has("id") ? "p.id DESC" : "1",
  ].filter(Boolean).join(", ");
  const r = await pool.query(
    `SELECT ${id}, ${fields}
       FROM insurance_policies p
      ${conds.length ? "WHERE " + conds.join(" AND ") : ""}
      ORDER BY ${order}
      LIMIT $${params.length}`,
    params
  );
  return r.rows;
}

function alertFor(row, colSet) {
  const alerts = [];
  const now = Date.now();
  const etd = hasValue(row.etd) ? new Date(row.etd) : null;
  const submitted = colSet.has("submitted_at") && hasValue(row.submitted_at);
  const hasPolicy = colSet.has("policy_no") && hasValue(row.policy_no);
  const status = clean(row.status, 80);
  if (submitted && !hasPolicy) alerts.push({ kind: "submitted_missing_policy", label: "已提交但缺保单号", basis: "insurance_policies.submitted_at + policy_no" });
  if (etd && !Number.isNaN(etd.getTime()) && etd.getTime() < now && !hasPolicy && /待|draft|pending|filled/i.test(status)) {
    alerts.push({ kind: "etd_passed_no_policy", label: "ETD已过但未见保单号", basis: "insurance_policies.etd + policy_no + status" });
  }
  return alerts;
}

function rowOut(row, colSet) {
  const missing = missingFor(row, colSet);
  const out = { id: row.id, alerts: alertFor(row, colSet), missing_count: missing.length, missing };
  CORE_FIELDS.forEach(([name]) => { out[name] = row[name]; });
  return out;
}

function metrics(rows, colSet) {
  const fields = coverage(rows, colSet);
  const one = (name) => fields.find((f) => f.name === name) || null;
  return {
    policies: rows.length,
    policy_no_rate: one("policy_no"),
    insured_amount_rate: one("insured_amount"),
    premium_rate: one("premium_rmb"),
    amount_fields: Array.from(MONEY_FIELDS),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!READ_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "GET required");

  try {
    const pool = getPool();
    if (!(await tableExists(pool, "insurance_policies"))) {
      return res.status(200).json({
        success: true, version: VERSION, generated_at: new Date().toISOString(), state: "not_connected",
        data: [], selected: null, metrics: { policies: 0 },
        coverage: { total_rows: 0, fields: coverage([], new Set()), missing_tables: ["insurance_policies"] },
      });
    }
    const colSet = await columns(pool, "insurance_policies");
    const rows = await listRows(pool, colSet, req.query || {});
    const data = rows.map((r) => rowOut(r, colSet));
    return res.status(200).json({
      success: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      state: rows.length ? "ready" : "not_connected",
      data,
      selected: data[0] || null,
      metrics: metrics(rows, colSet),
      coverage: { total_rows: rows.length, fields: coverage(rows, colSet), missing_tables: [] },
    });
  } catch (err) {
    console.error("[cargo-insurance]", err);
    return fail(res, 500, err.message);
  }
}
