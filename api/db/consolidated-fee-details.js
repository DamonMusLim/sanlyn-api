// GET /api/db/consolidated-fee-details — 集运费用明细，只读 freight_supplier_bills 真源。
import { requireAuth } from "../auth.js";
import { getPool, setCors } from "../db.js";

const VERSION = "v2026.09.05-1";
const TABLE = "freight_supplier_bills";
const REQUIRED = [
  "id", "bill_month", "supplier", "cost_category", "amount", "currency",
  "qty", "unit_price", "bl_no", "container_no", "rebill_status",
];
const OPTIONAL = [
  "supplier_company_code", "payer_company_code", "currency_norm", "incoterm",
  "link_plan_id", "reconciled", "ap_status", "ap_paid_amount", "ap_paid_at",
  "ar_status", "ar_paid_amount", "ar_paid_at", "payment_note", "bill_file", "fee_status",
  "sale_amount", "total_price", "tax_rate", "tax_amount", "exchange_rate", "raw",
  "settlement_company", "charge_basis", "direction",
];
const DETAIL_COLS = REQUIRED.concat(OPTIONAL);
const TAX_COLS = ["tax_rate", "tax_amount", "total_price"];
const FX_PATH = "'freight_rate_snapshot','fx'";

function clean(v, max = 160) {
  return String(v ?? "").trim().slice(0, max);
}

function intVal(v, fallback = 120) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 300) : fallback;
}

function hasValue(v) {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim() !== "";
  return true;
}

function money(v) {
  if (!hasValue(v)) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function pct(filled, total) {
  if (!total) return null;
  return Number(((Number(filled || 0) / Number(total)) * 100).toFixed(1));
}

async function tableExists(pool) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = $1`,
    [TABLE]
  );
  return r.rowCount > 0;
}

async function tableColumns(pool) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [TABLE]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function selectList(cols) {
  return DETAIL_COLS.map((c) => (cols.has(c) ? `"${c}" AS "${c}"` : `NULL AS "${c}"`)).join(", ");
}

function missingFields(cols) {
  return REQUIRED.filter((c) => !cols.has(c));
}

async function coverage(pool, cols) {
  const wanted = DETAIL_COLS.filter((c) => cols.has(c));
  const total = await pool.query(`SELECT COUNT(*)::int AS n FROM ${TABLE}`);
  const totalRows = Number(total.rows[0]?.n || 0);
  const fields = [];
  for (const name of wanted) {
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE NULLIF(BTRIM("${name}"::text), '') IS NOT NULL)::int AS filled
         FROM ${TABLE}`
    );
    const filled = Number(r.rows[0]?.filled || 0);
    fields.push({ name, filled, total: totalRows, fill_rate_percent: pct(filled, totalRows) });
  }
  return { total_rows: totalRows, missing_fields: missingFields(cols), fields };
}

function fxSnapshot(raw) {
  if (!raw || typeof raw !== "object") return null;
  const fx = raw.freight_rate_snapshot?.fx;
  if (!fx || typeof fx !== "object") return null;
  return {
    rate: fx.rate ?? null,
    date: fx.date ?? null,
    source: fx.source ?? null,
  };
}

function addFilter(q, params, conds, cols, queryKey, column) {
  const value = clean(q[queryKey]);
  if (!value || !cols.has(column)) return;
  params.push(`%${value}%`);
  conds.push(`"${column}"::text ILIKE $${params.length}`);
}

function filters(q, cols) {
  const params = [];
  const conds = [];
  addFilter(q, params, conds, cols, "month", "bill_month");
  addFilter(q, params, conds, cols, "supplier", "supplier");
  addFilter(q, params, conds, cols, "category", "cost_category");
  addFilter(q, params, conds, cols, "bl", "bl_no");
  addFilter(q, params, conds, cols, "container", "container_no");
  const status = clean(q.status, 32);
  if (status && cols.has("ap_status")) {
    params.push(status);
    conds.push(`COALESCE("ap_status",'') = $${params.length}`);
  }
  const any = clean(q.q);
  if (any) {
    const parts = ["bl_no", "container_no", "supplier", "cost_category", "bill_file"].filter((c) => cols.has(c));
    if (parts.length) {
      params.push(`%${any}%`);
      conds.push(`(${parts.map((c) => `"${c}"::text ILIKE $${params.length}`).join(" OR ")})`);
    }
  }
  return { where: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

async function fetchRows(pool, cols, q) {
  const built = filters(q, cols);
  built.params.push(intVal(q.limit));
  const order = cols.has("bill_month") ? `"bill_month" DESC NULLS LAST, "id" DESC` : `"id" DESC`;
  const r = await pool.query(
    `SELECT ${selectList(cols)}
       FROM ${TABLE}
       ${built.where}
      ORDER BY ${order}
      LIMIT $${built.params.length}`,
    built.params
  );
  return r.rows.map((x) => ({
    id: x.id,
    bill_month: x.bill_month || null,
    supplier: x.supplier || null,
    supplier_company_code: x.supplier_company_code || null,
    payer_company_code: x.payer_company_code || null,
    cost_category: x.cost_category || null,
    amount: money(x.amount),
    sale_amount: money(x.sale_amount),
    currency: x.currency_norm || x.currency || null,
    qty: money(x.qty),
    unit_price: money(x.unit_price),
    total_price: money(x.total_price),
    tax_rate: money(x.tax_rate),
    tax_amount: money(x.tax_amount),
    exchange_rate: money(x.exchange_rate),
    fx_snapshot: fxSnapshot(x.raw),
    bl_no: x.bl_no || null,
    container_no: x.container_no || null,
    incoterm: x.incoterm || null,
    charge_basis: x.charge_basis || null,
    link_plan_id: x.link_plan_id || null,
    rebill_status: x.rebill_status || null,
    fee_status: x.fee_status || null,
    direction: x.direction || null,
    reconciled: x.reconciled === null ? null : !!x.reconciled,
    ap_status: x.ap_status || null,
    ap_paid_amount: money(x.ap_paid_amount),
    ap_paid_at: x.ap_paid_at || null,
    ar_status: x.ar_status || null,
    ar_paid_amount: money(x.ar_paid_amount),
    ar_paid_at: x.ar_paid_at || null,
    payment_note: x.payment_note || null,
    bill_file: x.bill_file || null,
    settlement_company: x.settlement_company || null,
  }));
}

async function fetchTicketMargins(pool, cols, rows) {
  const bls = [...new Set(rows.map((r) => r.bl_no).filter(Boolean))];
  if (!bls.length) return new Map();
  if (!cols.has("sale_amount")) {
    return new Map(bls.map((bl) => [bl, { missing_sale_column: true, currencies: [] }]));
  }
  const currencyExpr = cols.has("currency_norm")
    ? `COALESCE(NULLIF(currency_norm,''), NULLIF(currency,''), '未记录币种')`
    : `COALESCE(NULLIF(currency,''), '未记录币种')`;
  const r = await pool.query(
    `SELECT bl_no,
            ${currencyExpr} AS currency,
            COUNT(*)::int AS line_count,
            COUNT(*) FILTER (WHERE sale_amount IS NULL)::int AS unpriced_count,
            COUNT(*) FILTER (WHERE amount IS NULL)::int AS missing_cost_count,
            SUM(sale_amount) FILTER (WHERE sale_amount IS NOT NULL) AS sale_sum,
            SUM(amount) FILTER (WHERE amount IS NOT NULL) AS cost_sum
       FROM ${TABLE}
      WHERE bl_no = ANY($1::text[])
      GROUP BY bl_no, ${currencyExpr}`,
    [bls]
  );
  const map = new Map();
  for (const row of r.rows) {
    const item = map.get(row.bl_no) || { missing_sale_column: false, currencies: [] };
    const unpriced = Number(row.unpriced_count || 0);
    const missingCost = Number(row.missing_cost_count || 0);
    const complete = unpriced === 0 && missingCost === 0;
    const sale = money(row.sale_sum);
    const cost = money(row.cost_sum);
    item.currencies.push({
      currency: row.currency,
      line_count: Number(row.line_count || 0),
      unpriced_count: unpriced,
      missing_cost_count: missingCost,
      sale_sum: sale,
      cost_sum: cost,
      profit: complete ? money(Number(sale || 0) - Number(cost || 0)) : null,
      complete,
    });
    map.set(row.bl_no, item);
  }
  return map;
}

function attachTicketMargins(rows, margins) {
  return rows.map((row) => ({
    ...row,
    ticket_margin: row.bl_no ? margins.get(row.bl_no) || null : {
      missing_bl_no: true,
      currencies: [],
    },
  }));
}

function summarize(rows) {
  const byCurrency = new Map();
  for (const row of rows) {
    if (row.amount === null || !row.currency) continue;
    byCurrency.set(row.currency, money((byCurrency.get(row.currency) || 0) + row.amount));
  }
  return {
    row_count: rows.length,
    currencies: [...byCurrency.entries()].map(([currency, amount]) => ({ currency, amount })),
    suppliers: new Set(rows.map((r) => r.supplier).filter(Boolean)).size,
    bl_count: new Set(rows.map((r) => r.bl_no).filter(Boolean)).size,
  };
}

function sourceMeta(cols) {
  const presentTaxCols = TAX_COLS.filter((c) => cols.has(c));
  return {
    table: TABLE,
    tax_columns_present: presentTaxCols,
    tax_columns_missing: TAX_COLS.filter((c) => !cols.has(c)),
    fx_snapshot_path: cols.has("raw") ? `raw->${FX_PATH}` : null,
    fx_note: cols.has("raw") ? "汇率只读每票冻结快照；缺快照时不现取汇率。" : "raw 列不存在，无法读取每票冻结汇率。",
    payment_time_note: "系统尚未记录收付时间,这里是\"没有记录\"不是\"确认没核销\"",
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    if (!(await tableExists(pool))) {
      return res.status(200).json({
        success: true, version: VERSION, generated_at: new Date().toISOString(),
        state: "not_connected", source: { table: TABLE },
        coverage: { total_rows: 0, missing_fields: REQUIRED, fields: [] },
        summary: { row_count: null, currencies: [], suppliers: null, bl_count: null },
        rows: [],
      });
    }
    const cols = await tableColumns(pool);
    const stats = await coverage(pool, cols);
    const connected = !stats.missing_fields.length && stats.total_rows > 0;
    const rows = connected ? await fetchRows(pool, cols, req.query || {}) : [];
    const margins = connected ? await fetchTicketMargins(pool, cols, rows) : new Map();
    return res.status(200).json({
      success: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      state: connected ? "ready" : "not_connected",
      source: sourceMeta(cols),
      coverage: stats,
      summary: summarize(rows),
      rows: attachTicketMargins(rows, margins),
    });
  } catch (err) {
    console.error("[consolidated-fee-details]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
