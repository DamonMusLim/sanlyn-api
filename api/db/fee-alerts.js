// GET/POST/DELETE /api/db/fee-alerts — 费用预警面板；未接入数据不反推假数。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const IGNORE_SCOPE = "invoiced";
// Unit: percentage points, not a 0-1 ratio. Below 20% means the link table is
// too sparse to be treated as connected; real routes should quickly exceed it.
const INVOICE_LINK_COVERAGE_READY_PERCENT = 20;

function clampLimit(value) {
  const n = Number.parseInt(value || "200", 10);
  if (!Number.isFinite(n) || n <= 0) return 200;
  return Math.min(n, 500);
}

function basis(state, note, extra = {}) {
  return { state, note, ...extra };
}

function clean(v, max = 200) {
  return String(v ?? "").trim().slice(0, max);
}

function actorFrom(req) {
  const u = req.user || {};
  return clean(u.employee_code || u.staff_no || u.username || u.account || u.email || u.uid || u.id || u.sub || u.name || "unknown", 120);
}

function targetKey(id) {
  return clean(id, 160);
}

async function loadInvoiceAlerts(pool, limit, options = {}) {
  const sql = `
WITH ignored AS (
  SELECT target_key FROM alert_ignores
   WHERE scope=$2
),
base AS (
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
  SELECT *, i.target_key IS NOT NULL AS is_ignored,
    CASE
      WHEN NULLIF(BTRIM(link_plan_id), '') IS NULL THEN 'no_shipping_plan_link'
      WHEN shipping_plan_id IS NULL THEN 'shipping_plan_unresolved'
      WHEN NULLIF(BTRIM(bill_month), '') IS NULL THEN 'no_bill_month'
      ELSE NULL
    END AS unknown_reason
  FROM base
  LEFT JOIN ignored i ON i.target_key = bill_id
),
counts AS (
  SELECT COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE unknown_reason IS NULL)::int AS eligible,
         COUNT(*) FILTER (WHERE unknown_reason IS NULL AND NOT has_invoice_link AND ($3::boolean OR NOT is_ignored))::int AS alert_count,
         COUNT(*) FILTER (WHERE unknown_reason IS NOT NULL)::int AS unknown_count,
         COUNT(*) FILTER (WHERE unknown_reason = 'no_shipping_plan_link')::int AS no_shipping_plan_link,
         COUNT(*) FILTER (WHERE unknown_reason = 'shipping_plan_unresolved')::int AS shipping_plan_unresolved,
         COUNT(*) FILTER (WHERE unknown_reason = 'no_bill_month')::int AS no_bill_month
    FROM classified
),
invoice_link_stats AS (
  SELECT COUNT(*)::int AS invoice_link_rows,
         COUNT(DISTINCT NULLIF(BTRIM(bill_id::text), ''))::int AS invoice_link_distinct_bill_ids
    FROM finance_invoice_bill_links
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
     WHERE unknown_reason IS NULL AND NOT has_invoice_link AND ($3::boolean OR NOT is_ignored)
     ORDER BY bill_month NULLS LAST, bl_no NULLS LAST, bill_id
     LIMIT $1
  ) x
)
SELECT counts.*, invoice_link_stats.*, alert_rows.rows
  FROM counts, invoice_link_stats, alert_rows`;
  const row = (await pool.query(sql, [limit, IGNORE_SCOPE, !!options.includeIgnored])).rows[0] || {};
  const eligible = Number(row.eligible || 0);
  const invoiceLinkRows = Number(row.invoice_link_rows || 0);
  const invoiceLinkDistinctBillIds = Number(row.invoice_link_distinct_bill_ids || 0);
  const invoiceLinkCoveragePercent = eligible > 0 ? (invoiceLinkDistinctBillIds / eligible) * 100 : 100;
  const invoiceLinksConnected = invoiceLinkCoveragePercent >= INVOICE_LINK_COVERAGE_READY_PERCENT;
  const reasons = {
    no_shipping_plan_link: Number(row.no_shipping_plan_link || 0),
    shipping_plan_unresolved: Number(row.shipping_plan_unresolved || 0),
    no_bill_month: Number(row.no_bill_month || 0),
  };
  const invoiceBasisExtra = {
    table: "freight_supplier_bills + finance_invoice_bill_links",
    total: Number(row.total || 0),
    eligible,
    invoice_link_rows: invoiceLinkRows,
    invoice_link_distinct_bill_ids: invoiceLinkDistinctBillIds,
    invoice_link_coverage_percent: Number(invoiceLinkCoveragePercent.toFixed(2)),
    invoice_link_ready_threshold_percent: INVOICE_LINK_COVERAGE_READY_PERCENT,
  };
  const disconnectedNote = `发票挂靠数据尚未接入（finance_invoice_bill_links 当前 ${invoiceLinkRows} 行，覆盖 ${invoiceLinkCoveragePercent.toFixed(1)}%）。挂靠接口 /api/db/invoice-bill-match 已于 2026-08-26 补挂路由，产生数据后此处自动生效。`;
  return {
    invoiced: invoiceLinksConnected ? {
      state: "ready",
      count: Number(row.alert_count || 0),
      rows: Array.isArray(row.rows) ? row.rows : [],
      basis: basis("ready", "仅统计已挂靠 shipping_plans 且 bill_month 有值、但未出现在 finance_invoice_bill_links 的账单行。", {
        ...invoiceBasisExtra,
      }),
    } : {
      state: "not_connected",
      count: null,
      rows: [],
      basis: basis("not_connected", disconnectedNote, {
        ...invoiceBasisExtra,
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

async function assertReadyInvoice(pool, id) {
  const data = await loadInvoiceAlerts(pool, 500, { includeIgnored: true });
  if (data.invoiced.state !== "ready") return { ok: false, status: 403, error: "no_data alert cannot be ignored" };
  const row = (data.invoiced.rows || []).find((r) => String(r.id) === String(id));
  if (!row) return { ok: false, status: 404, error: "alert row not found" };
  return { ok: true, row };
}

async function ignoreAlert(req, res, pool) {
  const kind = clean(req.body?.kind || req.body?.tab || "invoiced", 80);
  const id = clean(req.body?.id, 160);
  if (kind !== "invoiced") return res.status(403).json({ success: false, error: "no_data alert cannot be ignored" });
  if (!id) return res.status(400).json({ success: false, error: "id required" });
  const found = await assertReadyInvoice(pool, id);
  if (!found.ok) return res.status(found.status).json({ success: false, error: found.error });
  const actor = actorFrom(req);
  const key = targetKey(id);
  const note = clean(req.body?.notes || `ignored by ${actor}`, 2000);
  await pool.query(
    `INSERT INTO alert_ignores (scope, target_key, actor, note)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (scope, target_key)
     DO UPDATE SET actor=EXCLUDED.actor, note=EXCLUDED.note, created_at=NOW()`,
    [IGNORE_SCOPE, key, actor, note]
  );
  return res.status(200).json({ success: true, ignored: true, scope: IGNORE_SCOPE, target_key: key });
}

async function unignoreAlert(req, res, pool) {
  const kind = clean(req.body?.kind || req.query?.kind || req.body?.tab || req.query?.tab || "invoiced", 80);
  const id = clean(req.body?.id || req.query?.id, 160);
  if (kind !== "invoiced") return res.status(403).json({ success: false, error: "no_data alert cannot be unignored" });
  if (!id) return res.status(400).json({ success: false, error: "id required" });
  await pool.query(
    `DELETE FROM alert_ignores
      WHERE scope=$1 AND target_key=$2`,
    [IGNORE_SCOPE, targetKey(id)]
  );
  return res.status(200).json({ success: true, ignored: false });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  try {
    const pool = getPool();
    if (req.method === "POST") return ignoreAlert(req, res, pool);
    if (req.method === "DELETE") return unignoreAlert(req, res, pool);
    if (req.method !== "GET") return res.status(405).json({ success: false, error: "Method not allowed" });
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
