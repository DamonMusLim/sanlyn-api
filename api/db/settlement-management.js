// 核销管理 · finance_settlement_links read lens.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { appliedStatusWhere, linkJoinClause, linkMatchBasis, linkPaymentJoinClause } from "./settlement-management-matchers.js";
import { paymentRows, payIdentityExpr } from "./settlement-management-payments.js";
import { mergedPaymentRows, receiptConnectionMetrics, settlementReceiptRows } from "./settlement-management-receipts.js";
import { connectionState, linkStats, metrics, paymentStats } from "./settlement-management-stats.js";

const VERSION = "v2026.09.17-1";
const TABLE = "finance_settlement_links";
const PAY_TABLE = "finance_payments";
const READ_ROLES = new Set(["admin", "finance", "ceo", "superadmin"]);
const FIELDS = [
  ["id", "核销ID"], ["payment_id", "收付ID"], ["target_type", "核销对象"],
  ["target_id", "对象编号"], ["amount_applied", "核销金额"], ["currency", "币种"],
  ["status", "状态"], ["source", "来源"], ["created_by", "创建人"],
  ["created_at", "创建时间"], ["updated_at", "更新时间"],
];
const REQUIRED = ["payment_id", "target_type", "target_id", "amount_applied", "currency", "status"];
const PAY_FIELDS = [
  ["payment_id", "收付ID"], ["direction", "方向"], ["amount", "收款金额"],
  ["currency", "币种"], ["payment_date", "收付日期"], ["contract_no", "合同号"],
  ["order_no", "订单号"], ["customer", "客户"], ["bank_ref", "银行流水"],
  ["hgj_paid_amount", "收付已核销金额"], ["hgj_pending_amount", "收付未核销金额"],
];
const RAW_AMOUNT_EXPR = `CASE
  WHEN p.raw->>'receivedAmount' IS NULL THEN NULL
  WHEN regexp_replace(p.raw->>'receivedAmount', '[, ]', '', 'g') ~ '^-?\\d+(\\.\\d+)?$'
    THEN regexp_replace(p.raw->>'receivedAmount', '[, ]', '', 'g')::numeric
  ELSE NULL
END`;

function fail(res, status, error) { return res.status(status).json({ success: false, error }); }
function clean(v, max = 120) { return String(v ?? "").trim().slice(0, max); }
function has(v) {
  return !(v === null || v === undefined || String(v).trim() === "");
}
function pct(filled, total) {
  if (!total) return null;
  return Math.round((filled * 1000) / total) / 10;
}
function sqlIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}
async function tableExists(pool) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${TABLE}`]);
  return Boolean(r.rows[0]?.name);
}
async function namedTableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS name", [`public.${table}`]);
  return Boolean(r.rows[0]?.name);
}
async function tableColumns(pool) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [TABLE]
  );
  return new Set(r.rows.map((x) => x.column_name));
}
async function namedColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [table]
  );
  return new Set(r.rows.map((x) => x.column_name));
}
function selectExpr(name, cols) {
  if (name === "id" && cols.has("id")) return "l.id::text AS id";
  return cols.has(name) ? `l.${sqlIdent(name)} AS ${sqlIdent(name)}` : `NULL AS ${sqlIdent(name)}`;
}
function orderBy(cols) {
  return [
    cols.has("created_at") ? "l.created_at DESC NULLS LAST" : "",
    cols.has("updated_at") ? "l.updated_at DESC NULLS LAST" : "",
    cols.has("id") ? "l.id DESC" : "1",
  ].filter(Boolean).join(", ");
}
function whereClause(cols, params, q) {
  const where = [];
  const keyword = clean(q.q || q.search, 100);
  if (keyword) {
    const names = ["id", "payment_id", "target_type", "target_id", "status", "source", "created_by"];
    const parts = names.filter((n) => cols.has(n)).map((n) => `l.${sqlIdent(n)}::text ILIKE $${params.length + 1}`);
    if (parts.length) {
      params.push(`%${keyword}%`);
      where.push(`(${parts.join(" OR ")})`);
    }
  }
  const status = clean(q.status, 40);
  if (status && cols.has("status")) {
    params.push(status);
    where.push(`l.status = $${params.length}`);
  }
  const targetType = clean(q.target_type, 40);
  if (targetType && cols.has("target_type")) {
    params.push(targetType);
    where.push(`l.target_type = $${params.length}`);
  }
  return where.length ? `WHERE ${where.join(" AND ")}` : "";
}
async function coverage(pool, cols) {
  const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`)).rows[0]?.n || 0);
  const fields = [];
  for (const [name, label] of FIELDS) {
    if (!cols.has(name)) {
      fields.push({ name, label, state: "not_connected", filled: 0, total, fill_rate: null });
      continue;
    }
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE NULLIF(BTRIM(${sqlIdent(name)}::text), '') IS NOT NULL)::int AS filled FROM ${TABLE}`
    );
    const filled = Number(r.rows[0]?.filled || 0);
    fields.push({ name, label, state: filled ? "ready" : "not_connected", filled, total, fill_rate: pct(filled, total) });
  }
  return { table: TABLE, total_rows: total, fields };
}
async function paymentCoverage(pool, cols) {
  const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM ${PAY_TABLE}`)).rows[0]?.n || 0);
  const fields = [];
  for (const [name, label] of PAY_FIELDS) {
    const realName = name === "payment_id" ? (cols.has("id") ? "id" : null) : name;
    const amountNames = ["this_amount", "amount", "paid_amount"].filter((x) => cols.has(x));
    if ((name === "hgj_paid_amount" || name === "hgj_pending_amount") && cols.has(name === "hgj_paid_amount" ? "paid_amount" : "pending_amount")) {
      const real = name === "hgj_paid_amount" ? "paid_amount" : "pending_amount";
      const r = await pool.query(`SELECT COUNT(*) FILTER (WHERE ${sqlIdent(real)} IS NOT NULL)::int AS filled FROM ${PAY_TABLE}`);
      const filled = Number(r.rows[0]?.filled || 0);
      fields.push({ name, label, state: filled ? "ready" : "not_connected", filled, total, fill_rate: pct(filled, total), basis: [`${PAY_TABLE}.${real}`] });
      continue;
    }
    if (name === "amount" && (amountNames.length || cols.has("raw"))) {
      const amountParts = amountNames.map(sqlIdent);
      if (cols.has("raw")) amountParts.push(RAW_AMOUNT_EXPR.replaceAll("p.raw", "raw"));
      const r = await pool.query(`SELECT COUNT(*) FILTER (WHERE COALESCE(${amountParts.join(",")}) IS NOT NULL)::int AS filled FROM ${PAY_TABLE}`);
      const filled = Number(r.rows[0]?.filled || 0);
      const basis = amountNames.map((x) => `${PAY_TABLE}.${x}`);
      if (cols.has("raw")) basis.push(`${PAY_TABLE}.raw.receivedAmount`);
      fields.push({ name, label, state: filled ? "ready" : "not_connected", filled, total, fill_rate: pct(filled, total), basis });
      continue;
    }
    if (!realName || !cols.has(realName)) {
      fields.push({ name, label, state: "not_connected", filled: 0, total, fill_rate: null, basis: [`${PAY_TABLE}.${realName || name}`] });
      continue;
    }
    const r = await pool.query(`SELECT COUNT(*) FILTER (WHERE NULLIF(BTRIM(${sqlIdent(realName)}::text), '') IS NOT NULL)::int AS filled FROM ${PAY_TABLE}`);
    const filled = Number(r.rows[0]?.filled || 0);
    fields.push({ name, label, state: filled ? "ready" : "not_connected", filled, total, fill_rate: pct(filled, total), basis: [`${PAY_TABLE}.${realName}`] });
  }
  return { table: PAY_TABLE, total_rows: total, fields };
}
function notConnectedReason(cov, missing) {
  const rates = cov.fields
    .filter((f) => REQUIRED.includes(f.name))
    .map((f) => `${f.name} ${f.fill_rate === null ? "未接入" : `${f.fill_rate}%`}`)
    .join("；");
  return `未接入: 缺 ${missing.map((x) => `${TABLE}.${x}`).join(" / ") || "可核销真实链接"}；当前填充率 ${rates || "未接入"}`;
}
async function rows(pool, cols, query) {
  const limit = Math.min(Number.parseInt(query.limit, 10) || 600, 800);
  const params = [];
  const where = whereClause(cols, params, query);
  params.push(limit);
  const selected = FIELDS.map(([name]) => selectExpr(name, cols)).join(", ");
  const r = await pool.query(
    `SELECT ${selected} FROM ${TABLE} l ${where} ORDER BY ${orderBy(cols)} LIMIT $${params.length}`,
    params
  );
  return r.rows.map((x) => ({
    ...x,
    amount_applied: x.amount_applied === null || x.amount_applied === undefined ? null : Number(x.amount_applied),
  }));
}
function alertsFor(row) {
  const out = [];
  if (has(row.amount_applied) && Number(row.amount_applied) < 0) {
    out.push({ kind: "negative_settlement", label: "核销金额为负数", basis: `${TABLE}.amount_applied` });
  }
  if (has(row.amount_applied) && (!has(row.payment_id) || !has(row.target_id))) {
    out.push({ kind: "orphan_settlement", label: "有核销金额但缺收付ID或对象编号", basis: `${TABLE}.payment_id/target_id` });
  }
  return out;
}
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (!READ_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");
  if (req.method !== "GET") return fail(res, 405, "method not allowed: settlement-management is read-only");
  try {
    const pool = getPool();
    if (!(await tableExists(pool))) {
      return res.json({ success: true, version: VERSION, generated_at: new Date().toISOString(), state: "not_connected",
        reason: `未接入: 缺 ${TABLE}；当前填充率 未接入`, data: [], payments: [], selected: null,
        metrics: metrics([]), settlement_connection: { state: "not_connected", reason: `未接入: 缺 ${TABLE}；当前填充率 未接入`, fill_rate: null, basis: [] },
        coverage: { links: { table: TABLE, total_rows: 0, fields: [] }, payments: { table: PAY_TABLE, total_rows: 0, fields: [], state: "not_connected" } },
        missing_tables: [TABLE] });
    }
    const cols = await tableColumns(pool);
    const cov = await coverage(pool, cols);
    const payExists = await namedTableExists(pool, PAY_TABLE);
    const payCols = payExists ? await namedColumns(pool, PAY_TABLE) : new Set();
    const payCov = payExists ? await paymentCoverage(pool, payCols) : { table: PAY_TABLE, total_rows: 0, fields: [], state: "not_connected" };
    const payments = payExists ? await paymentRows(pool, payCols, cols, req.query || {}, req, linkJoinClause, linkMatchBasis) : { rows: [] };
    if (payments.error) return fail(res, 403, payments.error);
    const payStats = payExists ? await paymentStats(pool, payCols, cols, req.query || {}, req, payIdentityExpr, linkJoinClause) : { total_receipts: null, linked_receipts: null, unlinked_receipts: null };
    if (payStats.error) return fail(res, 403, payStats.error);
    const lStats = await linkStats(pool, cols, payCols, appliedStatusWhere, linkPaymentJoinClause, payIdentityExpr);
    const settlementPayments = await settlementReceiptRows(pool, cols, req.query || {}, appliedStatusWhere);
    const paymentData = mergedPaymentRows(payments.rows, settlementPayments);
    const settlementConnection = connectionState(lStats, payStats, payCols, cols, linkMatchBasis);
    const missing = REQUIRED.filter((x) => !cols.has(x));
    const data = missing.length ? [] : (await rows(pool, cols, req.query || {})).map((r) => ({ ...r, alerts: alertsFor(r) }));
    res.json({ success: true, version: VERSION, generated_at: new Date().toISOString(),
      state: settlementConnection.state, reason: settlementConnection.reason || (data.length || paymentData.length ? null : notConnectedReason(cov, missing)),
      data, payments: paymentData, selected: data[0] || null,
      metrics: { ...metrics(data), ...lStats, ...payStats, ...receiptConnectionMetrics(lStats, payStats), settlement_connection_state: settlementConnection.state },
      settlement_connection: settlementConnection,
      coverage: { links: cov, payments: payCov }, missing_tables: payExists ? [] : [PAY_TABLE] });
  } catch (err) {
    console.error("[settlement-management]", err);
    fail(res, 500, err.message);
  }
}
