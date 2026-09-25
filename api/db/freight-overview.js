// GET /api/db/freight-overview — 海运费一票总览，只读 v_hy_freight_ticket_overview。
import { requireAuth } from "../auth.js";
import { getPool, setCors } from "../db.js";

const VERSION = "v2026.09.16-2";
const VIEW = "v_hy_freight_ticket_overview";
const ALL = "__ALL__";
const EMPTY = "(未填客户)";
const NUMERIC_FIELDS = [
  "freight_usd", "port_charge_cny", "port_charge_sale_cny", "received_cny",
  "pending_cny", "pending_slips", "fee_lines", "invoice_docs", "all_docs",
  "bills", "dup_count", "days_outstanding", "container_qty", "container_detail_count",
  "ap_bill_lines", "ap_payable_cny", "ap_payable_usd", "ap_paid_rows", "ap_paid_amount_total",
];
const BOOL_FIELDS = [
  "n_quoted", "n_booked", "n_so", "n_cutoff", "n_container", "n_loaded",
  "n_vgm", "n_customs", "n_released", "n_manifest", "n_departed", "n_bl",
  "n_arrived", "n_fee", "n_billed", "n_invoiced", "n_settled",
];

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clean(v) {
  return String(v ?? "").trim();
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function date10(v) {
  return v ? String(v).slice(0, 10) : null;
}

async function relationExists(pool, name) {
  const r = await pool.query(
    `SELECT 1 FROM information_schema.views WHERE table_schema = current_schema() AND table_name = $1
      UNION ALL
     SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1
      LIMIT 1`,
    [name]
  );
  return r.rowCount > 0;
}

async function tableColumns(pool, name) {
  const r = await pool.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = $1`,
    [name]
  );
  return new Set(r.rows.map((x) => x.column_name));
}

function normalizeRow(row) {
  const out = { ...row };
  for (const key of NUMERIC_FIELDS) out[key] = row[key] === null ? null : num(row[key]);
  for (const key of BOOL_FIELDS) out[key] = row[key] ? 1 : 0;
  return out;
}

function buildByCustomer(rows) {
  const out = { [ALL]: { n: 0, usd: 0, unpaid_usd: 0 } };
  for (const row of rows) {
    const key = clean(row.consignee) || EMPTY;
    if (!out[key]) out[key] = { n: 0, usd: 0, unpaid_usd: 0 };
    const unpaid = num(row.received_cny) <= 0;
    out[key].n += 1;
    out[key].usd = money(out[key].usd + num(row.freight_usd));
    if (unpaid) out[key].unpaid_usd = money(out[key].unpaid_usd + num(row.freight_usd));
    out[ALL].n += 1;
    out[ALL].usd = money(out[ALL].usd + num(row.freight_usd));
    if (unpaid) out[ALL].unpaid_usd = money(out[ALL].unpaid_usd + num(row.freight_usd));
  }
  return out;
}

async function bankCoverage(pool) {
  const r = await pool.query(
    `SELECT currency, max(tx_date) AS max_d
       FROM bank_flows
      WHERE entity_code='oceanbaby'
      GROUP BY currency`
  );
  const out = { USD: null, CNY: null };
  for (const row of r.rows) {
    const currency = String(row.currency || "").trim().toUpperCase();
    const cur = currency === "RMB" || currency === "人民币" ? "CNY" : currency;
    if (cur === "USD" || cur === "CNY") out[cur] = date10(row.max_d);
  }
  return out;
}

async function fetchRows(pool) {
  const spCols = await tableColumns(pool, "shipping_plans");
  const cbCols = await tableColumns(pool, "container_bookings");
  const spRaw = spCols.has("raw") ? "s.raw->>'transport_mode', s.raw->>'mode'" : "NULL";
  const transportMode = spCols.has("transport_mode") ? `COALESCE(s.transport_mode, ${spRaw})` : `COALESCE(${spRaw})`;
  const cbType = cbCols.has("container_type") ? "c.container_type" : cbCols.has("type") ? "c.type" : "NULL";
  const r = await pool.query(
    `WITH base AS (
       SELECT *
         FROM ${VIEW}
     )
     SELECT base.*,
            sp.transport_terms AS plan_transport_terms,
            ord.trade_terms AS order_trade_terms,
            COALESCE(NULLIF(BTRIM(sp.transport_terms), ''), NULLIF(BTRIM(ord.trade_terms), '')) AS transport_terms,
            sp.container_qty,
            sp.container_type,
            sp.transport_mode,
            cb.container_detail_count,
            cb.container_summary,
            ap.ap_bill_lines,
            ap.ap_payable_cny,
            ap.ap_payable_usd,
            ap.ap_paid_rows,
            ap.ap_paid_amount_total,
            CASE
              WHEN COALESCE(ap.ap_bill_lines, 0) = 0 THEN '无账单'
              WHEN COALESCE(ap.ap_paid_rows, 0) > 0 THEN '已付'
              WHEN COALESCE(ap.ap_paid_amount_total, 0) > 0 THEN '部分已付'
              ELSE '系统未记录'
            END AS ap_clearance_status
       FROM base
       LEFT JOIN LATERAL (
         SELECT s.id, s.contract_no, s.bl_no, s.transport_terms, s.container_qty, s.container_type,
                ${transportMode} AS transport_mode
           FROM shipping_plans s
          WHERE NULLIF(BTRIM(base.bl_no), '') IS NOT NULL
            AND UPPER(BTRIM(s.bl_no)) = UPPER(BTRIM(base.bl_no))
          ORDER BY s.etd DESC NULLS LAST, s.id DESC
          LIMIT 1
       ) sp ON TRUE
       LEFT JOIN LATERAL (
         SELECT o.trade_terms
           FROM orders o
          WHERE (sp.id IS NOT NULL AND o.shipping_plan_id = sp.id)
             OR (NULLIF(BTRIM(sp.contract_no), '') IS NOT NULL AND o.contract_no = sp.contract_no)
          ORDER BY o.id DESC
          LIMIT 1
       ) ord ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(qty), 0)::int AS container_detail_count,
                STRING_AGG(COALESCE(typ, '无柜型') || ' × ' || qty::text, ' + ' ORDER BY typ NULLS LAST) AS container_summary
           FROM (
             SELECT NULLIF(UPPER(BTRIM(${cbType})), '') AS typ, COUNT(*)::int AS qty
               FROM container_bookings c
              WHERE (sp.id IS NOT NULL AND c.shipping_plan_id = sp.id)
                 OR (NULLIF(BTRIM(base.bl_no), '') IS NOT NULL AND UPPER(BTRIM(c.bl_no)) = UPPER(BTRIM(base.bl_no)))
              GROUP BY 1
           ) x
       ) cb ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS ap_bill_lines,
                COALESCE(SUM(b.amount) FILTER (
                  WHERE UPPER(COALESCE(NULLIF(b.currency_norm, ''), NULLIF(b.currency, ''))) IN ('CNY','RMB','人民币')
                ), 0) AS ap_payable_cny,
                COALESCE(SUM(b.amount) FILTER (
                  WHERE UPPER(COALESCE(NULLIF(b.currency_norm, ''), NULLIF(b.currency, ''))) = 'USD'
                ), 0) AS ap_payable_usd,
                COUNT(*) FILTER (WHERE b.ap_status = 'paid')::int AS ap_paid_rows,
                COALESCE(SUM(b.ap_paid_amount), 0) AS ap_paid_amount_total
           FROM freight_supplier_bills b
          WHERE NULLIF(BTRIM(base.bl_no), '') IS NOT NULL
            AND UPPER(BTRIM(b.bl_no)) = UPPER(BTRIM(base.bl_no))
            AND COALESCE(b.rebill_status, '') NOT IN ('voided', 'absorbed')
       ) ap ON TRUE
      ORDER BY base.etd DESC NULLS LAST, base.bl_no NULLS LAST`
  );
  return r.rows.map(normalizeRow);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const pool = getPool();
    if (!(await relationExists(pool, VIEW))) {
      return res.status(500).json({ success: false, error: "视图 v_hy_freight_ticket_overview 不存在" });
    }
    const rows = await fetchRows(pool);
    return res.status(200).json({
      success: true,
      version: VERSION,
      generated_at: new Date().toISOString(),
      rows,
      coverage: await bankCoverage(pool),
      byCustomer: buildByCustomer(rows),
    });
  } catch (err) {
    console.error("[freight-overview]", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
