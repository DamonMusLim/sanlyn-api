// api/db/workbench-kpi.js
// GET /api/db/workbench-kpi?period=m|q|y|all[&company_id=co-babi][&month=YYYY-MM]
//
// Returns aggregated KPI data for the admin workbench dashboard.
// Auth: NONE — this endpoint returns aggregate totals only (no PII, no
//   individual rows). The admin site (ac.sanlyn.cn) provides the UI gate.
//   If per-user scoping is needed in future, add requireAuth + company scope.
//
// company_id param maps to DB issuing_co via ISSUING_CO_MAP.
// Unknown or missing company_id → include all issuing_co values.
//
// month param (YYYY-MM): anchors the period to a specific accounting month.
//   e.g. month=2026-04 + period=m → April 2026 only
//        month=2026-04 + period=q → Q2 2026 (Apr-Jun)
//        month=2026-04 + period=y → full year 2026
//        period=all               → all time (month ignored)
import { getPool, setCors } from "../db.js";

// ---------------------------------------------------------------------------
// Frontend company ID → DB issuing_co name mapping.
// Source of truth: DB finance_payments.issuing_co distinct values.
// Update when new entities are added or name changes in the DB.
// ---------------------------------------------------------------------------
const ISSUING_CO_MAP = {
  'co-babi':    '厦门巴匕进出口有限公司',
  'co-sanlyn':  '上海洋宝宝国际物流有限公司',
  // co-zhongsha = factory (连云港中砂宠物用品有限公司), no issuing_co rows → 0
  // co-chongai, co-jianping = no issuing_co rows yet → 0
};

// month = "YYYY-MM" string (already validated) or null (use NOW())
function paymentPeriodFilter(period, month) {
  const anchor = month ? `'${month}-01'::date` : 'NOW()';
  switch (period) {
    case "q":   return `AND payment_date >= date_trunc('quarter', ${anchor})`;
    case "y":   return `AND payment_date >= date_trunc('year', ${anchor})`;
    case "all": return "";
    default:    // 'm' — exact month window when anchor provided
      if (month) {
        return `AND payment_date >= date_trunc('month', ${anchor})`
             + ` AND payment_date < date_trunc('month', ${anchor}) + INTERVAL '1 month'`;
      }
      return `AND payment_date >= date_trunc('month', ${anchor})`;
  }
}

function orderPeriodFilter(period, month) {
  const anchor = month ? `'${month}-01'::date` : 'NOW()';
  switch (period) {
    case "q":   return `AND updated_at >= date_trunc('quarter', ${anchor})`;
    case "y":   return `AND updated_at >= date_trunc('year', ${anchor})`;
    case "all": return "";
    default:    // 'm'
      if (month) {
        return `AND updated_at >= date_trunc('month', ${anchor})`
             + ` AND updated_at < date_trunc('month', ${anchor}) + INTERVAL '1 month'`;
      }
      return `AND updated_at >= date_trunc('month', ${anchor})`;
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const pool      = getPool();
  const period    = req.query.period    || "m";
  const companyId = req.query.company_id || null;

  // Validate month: must be YYYY-MM format to prevent any injection risk.
  const monthRaw = req.query.month || null;
  const month    = monthRaw && /^\d{4}-\d{2}$/.test(monthRaw) ? monthRaw : null;

  const ppf = paymentPeriodFilter(period, month);
  const opf = orderPeriodFilter(period, month);

  // ── Company filter ──────────────────────────────────────────────────
  // Map frontend company_id to DB issuing_co. Null = no filter (all companies).
  const issuingCo = companyId ? (ISSUING_CO_MAP[companyId] || null) : null;
  const companyKnownButNoData = companyId && !ISSUING_CO_MAP[companyId];

  // If company_id is known but has no issuing_co mapping (factory/other),
  // return zeros immediately — no DB queries needed.
  if (companyKnownButNoData) {
    return res.status(200).json({
      success: true,
      period,
      company_id: companyId,
      month: month || null,
      note: "no_issuing_co_for_company",
      data: {
        revenue:           { amount: 0, currency: "CNY" },
        cost:              { amount: 0, currency: "CNY" },
        estimatedProfit:   { amount: 0, currency: "CNY" },
        realizedProfit:    { amount: 0, currency: "CNY" },
        receivable:        { amount: 0, currency: "CNY" },
        payable:           { amount: 0, currency: "CNY" },
        uninvoicedRevenue: { amount: 0, currency: "CNY", count: 0 },
        unreceiptedCost:   { amount: 0, currency: "CNY", count: 0 },
        advance:           { amount: 0, currency: "CNY", count: 0 },
        profitAnomalyCount: 0, arRiskCount: 0, apRiskCount: 0,
        syncFailureCount: 0, highRiskCount: 0,
        ops: { shipmentsInProgress: 0, shipmentsCompletedMTD: 0, activeCustomers: 0, activeSuppliers: 0 },
      },
    });
  }

  // Build issuing_co clause (parameterized)
  const icClause = issuingCo ? "AND issuing_co = $1" : "";
  const icParams = issuingCo ? [issuingCo] : [];

  try {
    const [finRev, finCost, ordersKpi, ordersOps, receivables] = await Promise.all([

      // Revenue: AR payments in period
      pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS revenue, COUNT(*) AS payment_count
         FROM finance_payments
         WHERE direction IN ('AR', '收款', 'in') ${ppf} ${icClause}`,
        icParams
      ),

      // Cost: AP payments in period
      pool.query(
        `SELECT COALESCE(SUM(amount), 0) AS cost, COUNT(*) AS payment_count
         FROM finance_payments
         WHERE direction IN ('AP', '付款', 'out') ${ppf} ${icClause}`,
        icParams
      ),

      // Orders: in-progress + completed in period
      // Note: orders table uses company_code not issuing_co, so we can't filter by issuing_co here.
      // For simplicity, show all orders when no company filter, or all when company is mapped.
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status NOT IN ('shipped','cancelled','closed')) AS in_progress,
           COUNT(*) FILTER (WHERE status IN ('shipped','closed') ${opf})         AS completed
         FROM orders WHERE deleted_at IS NULL`
      ),

      // Ops: active customers / suppliers (no issuing_co on orders table)
      pool.query(
        `SELECT
           COUNT(DISTINCT customer) FILTER (WHERE created_at >= NOW() - INTERVAL '90 days') AS active_customers,
           COUNT(DISTINCT NULLIF(raw->>'companyCode', '')) AS active_suppliers
         FROM orders WHERE deleted_at IS NULL`
      ),

      // Receivables: total AR outstanding (gross) — filtered by issuing_co if specified
      pool.query(
        `SELECT
           COALESCE(SUM(GREATEST(o.total_amount - COALESCE(fp.received, 0), 0)), 0) AS receivable,
           COUNT(*) FILTER (WHERE o.total_amount > COALESCE(fp.received, 0)) AS receivable_count
         FROM orders o
         LEFT JOIN (
           SELECT contract_no, SUM(amount) AS received
           FROM finance_payments
           WHERE direction IN ('AR', '收款', 'in') ${icClause}
           GROUP BY contract_no
         ) fp ON o.contract_no = fp.contract_no
         WHERE o.deleted_at IS NULL AND o.total_amount > 0
           AND o.status NOT IN ('cancelled')`,
        icParams
      ),
    ]);

    const revenue    = parseFloat(finRev.rows[0].revenue)     || 0;
    const cost       = parseFloat(finCost.rows[0].cost)       || 0;
    const profit     = Math.round((revenue - cost) * 100) / 100;
    const receivable = parseFloat(receivables.rows[0].receivable) || 0;
    const rcvCount   = parseInt(receivables.rows[0].receivable_count) || 0;

    return res.status(200).json({
      success: true,
      period,
      company_id: companyId,
      month: month || null,
      data: {
        revenue:           { amount: revenue,    currency: "CNY" },
        cost:              { amount: cost,        currency: "CNY" },
        estimatedProfit:   { amount: profit,      currency: "CNY" },
        realizedProfit:    { amount: profit,      currency: "CNY" },
        receivable:        { amount: receivable,  currency: "CNY" },
        payable:           { amount: 0,           currency: "CNY" },
        uninvoicedRevenue: { amount: 0,           currency: "CNY", count: rcvCount },
        unreceiptedCost:   { amount: 0,           currency: "CNY", count: 0 },
        advance:           { amount: 0,           currency: "CNY", count: 0 },
        profitAnomalyCount: 0,
        arRiskCount:   rcvCount > 0 ? 1 : 0,
        apRiskCount:   0,
        syncFailureCount:  0,
        highRiskCount:     0,
        ops: {
          shipmentsInProgress:  parseInt(ordersKpi.rows[0].in_progress) || 0,
          shipmentsCompletedMTD: parseInt(ordersKpi.rows[0].completed)  || 0,
          activeCustomers: parseInt(ordersOps.rows[0].active_customers) || 0,
          activeSuppliers: parseInt(ordersOps.rows[0].active_suppliers) || 0,
        },
      },
    });

  } catch (err) {
    console.error("[workbench-kpi] error:", err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}
