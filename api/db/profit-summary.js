// /api/db/profit-summary.js — 盈利分析汇总 (按BL)
// GET /api/db/profit-summary?tab=all|missing_cost|pending_rebate|completed
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const pool = getPool();
  const { tab } = req.query;

  try {
    const r = await pool.query(`
      WITH bl_base AS (
        SELECT
          o.bl_no,
          MAX(sp.id)           AS plan_id,
          MAX(sp.customer)     AS customer_name,
          MAX(sp.etd)          AS etd,
          MAX(sp.atd)          AS atd,
          COUNT(DISTINCT o.id) AS order_count,
          string_agg(DISTINCT o.order_no, ', ' ORDER BY o.order_no) AS order_nos,
          ROUND(SUM(COALESCE(oli.unit_price * oli.qty_ctn, 0))::numeric, 2)  AS revenue,
          ROUND(SUM(COALESCE(oli.factory_subtotal, 0))::numeric, 2)          AS factory_cost,
          COUNT(DISTINCT CASE WHEN (oli.factory_subtotal IS NULL OR oli.factory_subtotal = 0)
                              THEN o.id END)                                  AS missing_cost_orders
        FROM orders o
        JOIN order_line_items oli ON oli.order_id = o.id
        LEFT JOIN shipping_plans sp ON sp.bl_no = o.bl_no
        WHERE o.bl_no IS NOT NULL AND o.bl_no != ''
        GROUP BY o.bl_no
      ),
      bl_freight AS (
        SELECT
          bl_no,
          ROUND(SUM(
            CASE
              WHEN currency = 'CNY' THEN amount
              WHEN currency = 'USD' THEN amount * COALESCE(
                (SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' ORDER BY fetched_at DESC LIMIT 1),
                7.2)
              ELSE 0
            END
          )::numeric, 2) AS freight_cost_cny
        FROM our_freight_cost_lines
        WHERE bl_no IS NOT NULL
        GROUP BY bl_no
      ),
      bl_rebate AS (
        SELECT
          o.bl_no,
          ROUND(SUM(COALESCE(fer.rebate_expected, 0))::numeric, 2) AS rebate_expected,
          ROUND(SUM(COALESCE(fer.rebate_received, 0))::numeric, 2) AS rebate_received
        FROM finance_export_rebates fer
        JOIN orders o ON o.contract_no = fer.contract_no
        WHERE fer.contract_no IS NOT NULL AND o.bl_no IS NOT NULL
        GROUP BY o.bl_no
      )
      SELECT
        b.bl_no,
        b.plan_id,
        b.customer_name,
        b.etd,
        b.atd,
        b.order_count,
        b.order_nos,
        b.revenue,
        b.factory_cost,
        b.missing_cost_orders,
        COALESCE(f.freight_cost_cny, 0)   AS freight_cost_cny,
        COALESCE(r.rebate_expected, 0)    AS rebate_expected,
        COALESCE(r.rebate_received, 0)    AS rebate_received,
        ROUND((b.revenue - COALESCE(b.factory_cost, 0))::numeric, 2)
          AS gross_margin,
        ROUND((b.revenue
          - COALESCE(b.factory_cost, 0)
          - COALESCE(f.freight_cost_cny, 0)
          + COALESCE(r.rebate_expected, 0))::numeric, 2)
          AS net_profit_est
      FROM bl_base b
      LEFT JOIN bl_freight f ON f.bl_no = b.bl_no
      LEFT JOIN bl_rebate  r ON r.bl_no = b.bl_no
      ORDER BY COALESCE(b.atd, b.etd) DESC NULLS LAST, b.revenue DESC
    `);

    let rows = r.rows;

    if (tab === "missing_cost") {
      rows = rows.filter(x => Number(x.missing_cost_orders) > 0);
    } else if (tab === "pending_rebate") {
      rows = rows.filter(x => Number(x.rebate_expected) > 0 && Number(x.rebate_received) < Number(x.rebate_expected));
    } else if (tab === "completed") {
      rows = rows.filter(x =>
        Number(x.missing_cost_orders) === 0 &&
        Number(x.freight_cost_cny) > 0 &&
        (Number(x.rebate_expected) === 0 || Number(x.rebate_received) > 0)
      );
    }

    const totals = {
      revenue:          rows.reduce((s, x) => s + Number(x.revenue), 0),
      factory_cost:     rows.reduce((s, x) => s + Number(x.factory_cost), 0),
      freight_cost_cny: rows.reduce((s, x) => s + Number(x.freight_cost_cny), 0),
      rebate_expected:  rows.reduce((s, x) => s + Number(x.rebate_expected), 0),
      rebate_received:  rows.reduce((s, x) => s + Number(x.rebate_received), 0),
      gross_margin:     rows.reduce((s, x) => s + Number(x.gross_margin), 0),
      net_profit_est:   rows.reduce((s, x) => s + Number(x.net_profit_est), 0),
    };

    return res.status(200).json({ rows, totals, count: rows.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
