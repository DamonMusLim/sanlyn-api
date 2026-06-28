// api/db/sales-dashboard.js — Admin Sales Dashboard KPI endpoints
// 6 sub-routes: /kpi, /customers, /country, /category, /ocean, /trend
// Admin-only (requireRole). All SQL avoids orders×products cartesian JOIN.
import { getPool, setCors } from "../db.js";
import { requireRole } from "../auth.js";

// ── Period filter helper ──
function periodFilter(period, alias = "") {
  const col = alias ? `${alias}.payment_date` : "payment_date";
  switch (period) {
    case "m":  return `AND ${col} >= date_trunc('month', NOW())`;
    case "q":  return `AND ${col} >= date_trunc('quarter', NOW())`;
    case "h":  return `AND ${col} >= NOW() - INTERVAL '6 months'`;
    case "y":  return `AND ${col} >= date_trunc('year', NOW())`;
    default:   return ""; // "all" = no lower bound
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireRole(req, res, ["admin"])) return;

  const pool = getPool();
  const { sub } = req.query;
  const period = req.query.period || "all";

  try {
    // ── /api/db/sales-dashboard?sub=kpi ──────────────────────────────
    if (sub === "kpi") {
      const pf = periodFilter(period);
      const [rev, orders, shipped, containers] = await Promise.all([
        pool.query(`
          SELECT
            COALESCE(SUM(amount),0) AS total_revenue,
            COUNT(*) AS payment_count
          FROM finance_payments WHERE 1=1 ${pf}
        `),
        pool.query(`
          SELECT
            COUNT(*) AS total_orders,
            COUNT(*) FILTER (WHERE status='shipped') AS shipped,
            COUNT(*) FILTER (WHERE status NOT IN ('shipped','cancelled')) AS pipeline
          FROM orders WHERE deleted_at IS NULL
        `),
        pool.query(`
          SELECT
            COALESCE(SUM(amount),0) AS shipped_revenue,
            COUNT(DISTINCT CASE WHEN raw->>'companyCode' IS NOT NULL THEN raw->>'companyCode' END) AS paying_customers
          FROM finance_payments WHERE 1=1 ${pf}
        `),
        pool.query(`
          SELECT COUNT(*) AS container_count, COALESCE(SUM(freight_cost),0) AS total_freight
          FROM shipping_plans WHERE bl_no IS NOT NULL
        `),
      ]);
      const totalRevenue = parseFloat(rev.rows[0].total_revenue);
      const shippedOrders = parseInt(orders.rows[0].shipped);
      const aov = shippedOrders > 0 ? totalRevenue / shippedOrders : 0;
      return res.json({ success: true, data: {
        total_revenue: totalRevenue,
        payment_count: parseInt(rev.rows[0].payment_count),
        total_orders: parseInt(orders.rows[0].total_orders),
        shipped_orders: shippedOrders,
        pipeline_orders: parseInt(orders.rows[0].pipeline),
        aov: Math.round(aov),
        container_count: parseInt(containers.rows[0].container_count),
        total_freight: parseFloat(containers.rows[0].total_freight),
        paying_customers: parseInt(shipped.rows[0].paying_customers),
      }});
    }

    // ── /api/db/sales-dashboard?sub=customers ────────────────────────
    if (sub === "customers") {
      const pf = periodFilter(period);
      const result = await pool.query(`
        SELECT
          COALESCE(c.name_en, fp.raw->>'companyCode', '⚠ Unattributed') AS customer,
          c.company_code,
          COUNT(fp.id) AS payment_count,
          COALESCE(SUM(fp.amount), 0) AS total_paid
        FROM finance_payments fp
        LEFT JOIN customers c ON c.company_code = fp.raw->>'companyCode'
        WHERE 1=1 ${pf}
        GROUP BY c.name_en, c.company_code, fp.raw->>'companyCode'
        ORDER BY total_paid DESC
        LIMIT 15
      `);
      const totalPaid = result.rows.reduce((s, r) => s + parseFloat(r.total_paid), 0);
      const rows = result.rows.map(r => ({
        ...r,
        total_paid: parseFloat(r.total_paid),
        pct: totalPaid > 0 ? Math.round(parseFloat(r.total_paid) / totalPaid * 1000) / 10 : 0,
      }));
      return res.json({ success: true, data: rows, total: totalPaid });
    }

    // ── /api/db/sales-dashboard?sub=country ──────────────────────────
    if (sub === "country") {
      const pf = periodFilter(period);
      const result = await pool.query(`
        SELECT
          COALESCE(c.raw->>'country', 'Unknown') AS country,
          COUNT(fp.id) AS payment_count,
          COALESCE(SUM(fp.amount), 0) AS total_paid
        FROM finance_payments fp
        LEFT JOIN customers c ON c.company_code = fp.raw->>'companyCode'
        WHERE fp.raw->>'companyCode' IS NOT NULL ${pf}
        GROUP BY c.raw->>'country'
        ORDER BY total_paid DESC
      `);
      const totalPaid = result.rows.reduce((s, r) => s + parseFloat(r.total_paid), 0);
      const rows = result.rows.map(r => ({
        ...r,
        total_paid: parseFloat(r.total_paid),
        pct: totalPaid > 0 ? Math.round(parseFloat(r.total_paid) / totalPaid * 1000) / 10 : 0,
      }));
      return res.json({ success: true, data: rows, total: totalPaid });
    }

    // ── /api/db/sales-dashboard?sub=category ─────────────────────────
    // NOTE: orders × products NOT joined (no products table join here).
    // display_category is stored in orders.raw.products[0].display_category (denormalized).
    if (sub === "category") {
      const result = await pool.query(`
        SELECT
          COALESCE(raw->'products'->0->>'display_category', 'uncategorized') AS dc,
          COUNT(*) AS orders,
          SUM(
            (SELECT COALESCE(SUM((it->>'qty')::numeric), 0)
             FROM jsonb_array_elements(raw->'products') it)
          ) AS total_qty
        FROM orders
        WHERE deleted_at IS NULL AND status = 'shipped'
        GROUP BY 1
        ORDER BY 2 DESC
      `);
      return res.json({ success: true, data: result.rows.map(r => ({
        ...r,
        orders: parseInt(r.orders),
        total_qty: parseFloat(r.total_qty || 0),
      })) });
    }

    // ── /api/db/sales-dashboard?sub=ocean ────────────────────────────
    if (sub === "ocean") {
      const [summary, forwarders] = await Promise.all([
        pool.query(`
          SELECT
            COUNT(*) AS container_count,
            COALESCE(SUM(freight_cost), 0) AS total_freight_cost,
            COALESCE(SUM(freight_sale_cny), 0) AS total_freight_sale,
            COUNT(*) FILTER (WHERE gross_weight_kg IS NOT NULL AND gross_weight_kg > 0) AS has_gw,
            COALESCE(SUM(gross_weight_kg), 0) AS total_gw
          FROM shipping_plans
          WHERE bl_no IS NOT NULL
        `),
        pool.query(`
          SELECT
            COALESCE(forwarder_cn, raw->>'forwarder', 'Unknown') AS forwarder,
            COUNT(*) AS shipments
          FROM shipping_plans
          WHERE bl_no IS NOT NULL
          GROUP BY 1
          ORDER BY 2 DESC
          LIMIT 10
        `),
      ]);
      return res.json({ success: true, data: {
        summary: {
          container_count: parseInt(summary.rows[0].container_count),
          total_freight_cost: parseFloat(summary.rows[0].total_freight_cost),
          total_freight_sale: parseFloat(summary.rows[0].total_freight_sale),
          total_gw: parseFloat(summary.rows[0].total_gw),
          has_gw: parseInt(summary.rows[0].has_gw),
        },
        forwarders: forwarders.rows.map(r => ({
          forwarder: r.forwarder,
          shipments: parseInt(r.shipments),
        })),
      }});
    }

    // ── /api/db/sales-dashboard?sub=trend ────────────────────────────
    if (sub === "trend") {
      const result = await pool.query(`
        SELECT
          TO_CHAR(date_trunc('month', payment_date), 'YYYY-MM') AS month,
          COALESCE(SUM(amount), 0) AS revenue,
          COUNT(*) AS payments
        FROM finance_payments
        WHERE payment_date IS NOT NULL
        GROUP BY date_trunc('month', payment_date)
        ORDER BY 1
      `);
      return res.json({ success: true, data: result.rows.map(r => ({
        month: r.month,
        revenue: parseFloat(r.revenue),
        payments: parseInt(r.payments),
      })) });
    }

    return res.status(400).json({ error: "Unknown sub-route. Use ?sub=kpi|customers|country|category|ocean|trend" });

  } catch (err) {
    console.error("[sales-dashboard]", err);
    return res.status(500).json({ error: "Internal server error", message: err.message });
  }
}
