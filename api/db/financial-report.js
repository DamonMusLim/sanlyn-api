// 财务报表 · read-only lens over real finance sources.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERSION = "v2026.08.26-1";
const READ_ROLES = new Set(["admin", "finance", "ceo", "superadmin"]);
const SOURCES = [
  { key: "payments", label: "收付流水", table: "finance_payments", date: "paid_date", fields: ["direction", "paid_amount", "this_amount", "amount", "currency", "paid_date", "payment_date", "contract_no", "order_no", "customer", "customer_en"] },
  { key: "settlements", label: "核销链接", table: "finance_settlement_links", date: "created_at", fields: ["payment_id", "target_type", "target_id", "amount_applied", "currency", "status", "created_at"] },
  { key: "invoice_out", label: "销项发票", table: "finance_invoices_out", date: "issue_date", fields: ["invoice_no", "issue_date", "buyer_name", "amount_incl_tax", "currency", "review_status"] },
  { key: "invoice_in", label: "进项发票", table: "finance_invoices_in", date: "issue_date", fields: ["invoice_no", "issue_date", "seller_name", "amount_incl_tax", "currency", "review_status"] },
];

function fail(res, status, error) {
  return res.status(status).json({ success: false, error });
}
function clean(v, max = 120) {
  return String(v ?? "").trim().slice(0, max);
}
function has(v) {
  return !(v === null || v === undefined || String(v).trim() === "");
}
function pct(filled, total) {
  if (!total) return null;
  return Math.round((filled * 1000) / total) / 10;
}
function qi(name) {
  return `"${name.replace(/"/g, '""')}"`;
}
function range(q) {
  const from = /^\d{4}-\d{2}-\d{2}$/.test(clean(q.from, 20)) ? clean(q.from, 20) : "2026-01-01";
  const to = /^\d{4}-\d{2}-\d{2}$/.test(clean(q.to, 20)) ? clean(q.to, 20) : "";
  return { from, to };
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
async function coverage(pool, src, cols, missingTable) {
  if (missingTable) {
    return { key: src.key, label: src.label, table: src.table, total_rows: null, fields: src.fields.map((name) => ({ name, filled: 0, total: null, fill_rate: null, state: "not_connected" })) };
  }
  const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM ${qi(src.table)}`)).rows[0]?.n || 0);
  const fields = [];
  for (const name of src.fields) {
    if (!cols.has(name)) {
      fields.push({ name, filled: 0, total, fill_rate: null, state: "not_connected" });
      continue;
    }
    const r = await pool.query(`SELECT COUNT(*) FILTER (WHERE NULLIF(BTRIM(${qi(name)}::text), '') IS NOT NULL)::int AS filled FROM ${qi(src.table)}`);
    const filled = Number(r.rows[0]?.filled || 0);
    fields.push({ name, filled, total, fill_rate: pct(filled, total), state: filled ? "ready" : "not_connected" });
  }
  return { key: src.key, label: src.label, table: src.table, total_rows: total, fields };
}
function coverageNote(src, cov) {
  if (cov.total_rows === null) return `未接入: 缺 ${src.table}；当前填充率 未接入`;
  const required = cov.fields.map((f) => `${f.name} ${f.fill_rate === null ? "未接入" : `${f.fill_rate}%`}`).join("；");
  return `${src.table} 样本 ${cov.total_rows || "未接入"}；当前填充率 ${required || "未接入"}`;
}
function amountExpr(cols) {
  const parts = [];
  if (cols.has("paid_amount")) parts.push("paid_amount");
  if (cols.has("this_amount")) parts.push("this_amount");
  if (cols.has("amount")) parts.push("amount");
  return parts.length ? `COALESCE(${parts.map(qi).join(", ")})` : "NULL::numeric";
}
function paymentDirectionCase() {
  return "CASE WHEN direction IN ('AP','付款','out','refund') THEN 'AP' WHEN COALESCE(direction,'') NOT IN ('out','refund') THEN 'AR' ELSE NULL END";
}
async function paymentSummary(pool, cols, rg) {
  if (!cols.has("direction")) return { state: "not_connected", reason: "未接入: 缺 finance_payments.direction；当前填充率 未接入", rows: [] };
  const date = cols.has("paid_date") ? "paid_date" : cols.has("payment_date") ? "payment_date" : "";
  if (!date) return { state: "not_connected", reason: "未接入: 缺 finance_payments.paid_date/payment_date；当前填充率 未接入", rows: [] };
  const params = [rg.from];
  const where = [`${qi(date)} >= $1::date`];
  if (rg.to) {
    params.push(rg.to);
    where.push(`${qi(date)} < ($2::date + interval '1 day')`);
  }
  const r = await pool.query(
    `SELECT currency, ${paymentDirectionCase()} AS direction, COUNT(*)::int AS records,
            SUM(${amountExpr(cols)}) AS amount
       FROM finance_payments WHERE ${where.join(" AND ")}
      GROUP BY currency, direction ORDER BY currency NULLS LAST, direction NULLS LAST`,
    params
  );
  return { state: r.rows.length ? "ready" : "not_connected", reason: r.rows.length ? null : `未接入: finance_payments.${date} 日期范围内无真实记录；当前填充率 0/0`, rows: r.rows };
}
async function settlementSummary(pool, cols, rg) {
  if (!cols.has("amount_applied") || !cols.has("created_at")) {
    return { state: "not_connected", reason: "未接入: 缺 finance_settlement_links.amount_applied/created_at；当前填充率 未接入", rows: [] };
  }
  const params = [rg.from];
  const where = ["created_at >= $1::date"];
  if (rg.to) {
    params.push(rg.to);
    where.push("created_at < ($2::date + interval '1 day')");
  }
  const r = await pool.query(
    `SELECT currency, COUNT(*)::int AS records, SUM(amount_applied) AS amount
       FROM finance_settlement_links WHERE ${where.join(" AND ")}
      GROUP BY currency ORDER BY currency NULLS LAST`,
    params
  );
  return { state: r.rows.length ? "ready" : "not_connected", reason: r.rows.length ? null : "未接入: 核销日期范围内无真实记录；当前填充率 0/0", rows: r.rows };
}
async function invoiceSummary(pool, table, cols, rg) {
  if (!cols.has("amount_incl_tax") || !cols.has("issue_date")) {
    return { state: "not_connected", reason: `未接入: 缺 ${table}.amount_incl_tax/issue_date；当前填充率 未接入`, rows: [] };
  }
  const params = [rg.from];
  const where = ["issue_date >= $1::date"];
  if (rg.to) {
    params.push(rg.to);
    where.push("issue_date < ($2::date + interval '1 day')");
  }
  const r = await pool.query(
    `SELECT currency, COUNT(*)::int AS records, SUM(amount_incl_tax) AS amount
       FROM ${qi(table)} WHERE ${where.join(" AND ")}
      GROUP BY currency ORDER BY currency NULLS LAST`,
    params
  );
  return { state: r.rows.length ? "ready" : "not_connected", reason: r.rows.length ? null : `未接入: ${table}.issue_date 日期范围内无真实记录；当前填充率 0/0`, rows: r.rows };
}
function metrics(sections) {
  return sections.map((s) => ({
    key: s.key,
    label: s.label,
    value: s.state === "ready" ? s.rows.reduce((n, r) => n + Number(r.records || 0), 0) : null,
    amount_state: s.rows.some((r) => has(r.amount)) ? "ready" : "not_connected",
    note: s.state === "ready" ? `依据 ${s.table}` : s.reason,
  }));
}
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return fail(res, 405, "GET required");
  if (!requireAuth(req, res)) return;
  if (!READ_ROLES.has(req.user?.role)) return fail(res, 403, "Forbidden");
  try {
    const pool = getPool();
    const rg = range(req.query || {});
    const maps = {};
    const out = { coverage: [], sections: [], missing_tables: [] };
    for (const src of SOURCES) {
      const exists = await tableExists(pool, src.table);
      const cols = exists ? await columns(pool, src.table) : new Set();
      maps[src.key] = { exists, cols, src };
      if (!exists) out.missing_tables.push(src.table);
      const cov = await coverage(pool, src, cols, !exists);
      out.coverage.push({ ...cov, note: coverageNote(src, cov) });
    }
    out.sections.push({ key: "payments", label: "收付汇总", table: "finance_payments", ...(maps.payments.exists ? await paymentSummary(pool, maps.payments.cols, rg) : { state: "not_connected", reason: "未接入: 缺 finance_payments；当前填充率 未接入", rows: [] }) });
    out.sections.push({ key: "settlements", label: "核销汇总", table: "finance_settlement_links", ...(maps.settlements.exists ? await settlementSummary(pool, maps.settlements.cols, rg) : { state: "not_connected", reason: "未接入: 缺 finance_settlement_links；当前填充率 未接入", rows: [] }) });
    out.sections.push({ key: "invoice_out", label: "销项发票汇总", table: "finance_invoices_out", ...(maps.invoice_out.exists ? await invoiceSummary(pool, "finance_invoices_out", maps.invoice_out.cols, rg) : { state: "not_connected", reason: "未接入: 缺 finance_invoices_out；当前填充率 未接入", rows: [] }) });
    out.sections.push({ key: "invoice_in", label: "进项发票汇总", table: "finance_invoices_in", ...(maps.invoice_in.exists ? await invoiceSummary(pool, "finance_invoices_in", maps.invoice_in.cols, rg) : { state: "not_connected", reason: "未接入: 缺 finance_invoices_in；当前填充率 未接入", rows: [] }) });
    res.json({ success: true, version: VERSION, generated_at: new Date().toISOString(), range: rg, metrics: metrics(out.sections), ...out });
  } catch (err) {
    console.error("[financial-report]", err);
    fail(res, 500, err.message);
  }
}
