// GET /api/db/fee-alerts — 费用预警面板，只读；未接入数据不反推假数。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function clampLimit(value) {
  const n = Number.parseInt(value || "200", 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(n, 500);
}

function basis(state, note, extra = {}) {
  return { state, note, ...extra };
}

async function loadInvoiceAlerts(pool, limit) {
  const sql = `
WITH base AS (
  SELECT b.id::text AS bill_id, b.bl_no, b.bill_month, b.supplier, b.cost_category,
         b.amount, b.currency, b.link_plan_id::text AS link_plan_id,
         sp.id AS shipping_plan_id, sp._id AS shipping_plan_uid, sp.shipment_no,
         sp.etd, COALESCE(sp.customer_cn, sp.customer_en, sp.customer) AS customer,
         EXISTS (
           SELECT 1 FROM finance_invoice_bill_links l
            WHERE l.bill_id::text = b.id::text
         ) AS has_invoice_link
    FROM freight_supplier_bills b
    LEFT JOIN shipping_plans sp
      ON NULLIF(BTRIM(b.link_plan_id::text), '') IS NOT NULL
     AND (sp.id::text = b.link_plan_id::text OR sp._id::text = b.link_plan_id::text)
   WHERE COALESCE(b.rebill_status, '') NOT IN ('voided', 'absorbed')
),
classified AS (
  SELECT *,
    CASE
      WHEN NULLIF(BTRIM(link_plan_id), '') IS NULL THEN 'no_shipping_plan_link'
      WHEN shipping_plan_id IS NULL THEN 'shipping_plan_unresolved'
      WHEN NULLIF(BTRIM(bill_month), '') IS NULL THEN 'no_bill_month'
      ELSE NULL
    END AS unknown_reason
  FROM base
),
counts AS (
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE unknown_reason IS NULL)::int AS eligible,
         COUNT(*) FILTER (WHERE unknown_reason IS NULL AND NOT has_invoice_link)::int AS alert_count,
         COUNT(*) FILTER (WHERE unknown_reason IS NOT NULL)::int AS unknown_count,
         COUNT(*) FILTER (WHERE unknown_reason = 'no_shipping_plan_link')::int AS no_shipping_plan_link,
         COUNT(*) FILTER (WHERE unknown_reason = 'shipping_plan_unresolved')::int AS shipping_plan_unresolved,
         COUNT(*) FILTER (WHERE unknown_reason = 'no_bill_month')::int AS no_bill_month
    FROM classified
),
alert_rows AS (
  SELECT COALESCE(json_agg(json_build_object(
    'id', bill_id,
    'bill_no', bill_id,
    'bl_no', bl_no,
    'bill_month', bill_month,
    'supplier', supplier,
    'cost_category', cost_category,
    'amount', amount,
    'currency', currency,
    'shipping_plan_id', shipping_plan_id,
    'shipping_plan_uid', shipping_plan_uid,
    'shipment_no', shipment_no,
    'customer', customer,
    'etd', to_char(etd, 'YYYY-MM-DD'),
    'basis', '已挂靠shipping_plans且bill_month有值；finance_invoice_bill_links无对应bill_id'
  ) ORDER BY bill_month NULLS LAST, bl_no NULLS LAST, bill_id), '[]'::json) AS rows
  FROM (
    SELECT * FROM classified
     WHERE unknown_reason IS NULL AND NOT has_invoice_link
     ORDER BY bill_month NULLS LAST, bl_no NULLS LAST, bill_id
     LIMIT $1
  ) x
)
SELECT counts.*, alert_rows.rows FROM counts, alert_rows`;
  const row = (await pool.query(sql, [limit])).rows[0] || {};
  const reasons = {
    no_shipping_plan_link: Number(row.no_shipping_plan_link || 0),
    shipping_plan_unresolved: Number(row.shipping_plan_unresolved || 0),
    no_bill_month: Number(row.no_bill_month || 0),
  };
  return {
    invoiced: {
      state: "ready",
      count: Number(row.alert_count || 0),
      rows: Array.isArray(row.rows) ? row.rows : [],
      basis: basis("ready", "仅统计已挂靠 shipping_plans 且 bill_month 有值、但未出现在 finance_invoice_bill_links 的账单行。", {
        table: "freight_supplier_bills + finance_invoice_bill_links",
        total: Number(row.total || 0),
        eligible: Number(row.eligible || 0),
      }),
    },
    unknown: {
      count: Number(row.unknown_count || 0),
      reasons,
      rows: [],
      basis: basis("unknown", "挂不到 shipping_plans 或无账期字段的账单无法判断，不进入业务预警。"),
    },
  };
}

async function loadSettlementState(pool) {
  const q = await pool.query("SELECT COUNT(*)::int AS n FROM finance_settlement_links");
  const total = Number(q.rows[0]?.n || 0);
  if (total <= 1) {
    return {
      state: "not_connected",
      count: null,
      rows: [],
      basis: basis("not_connected", "核销链接表当前仅 1 行，写入管道修复后自动生效。", {
        table: "finance_settlement_links",
        total,
      }),
    };
  }
  return {
    state: "not_connected",
    count: null,
    rows: [],
    basis: basis("not_connected", "核销口径尚未在本面板启用；避免用不完整链接反推未核销数。", {
      table: "finance_settlement_links",
      total,
    }),
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;

  try {
    const pool = getPool();
    const limit = clampLimit(req.query?.limit);
    const invoiceData = await loadInvoiceAlerts(pool, limit);
    const settled = await loadSettlementState(pool);
    res.status(200).json({
      success: true,
      generated_at: new Date().toISOString(),
      invoiced: invoiceData.invoiced,
      settled,
      unknown: invoiceData.unknown,
    });
  } catch (err) {
    console.error("[fee-alerts]", err);
    res.status(500).json({ success: false, error: err.message });
  }
}
