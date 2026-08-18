import { getPool, setCors } from "../db.js";

const PAYMENT_SCOPE =
  "payments use finance_payments.amount, direction COALESCE(direction,'') NOT IN ('out','refund'), matched by contract_no/order_no with payment id de-duplication; unlinked payments are reported separately and are not treated as customer debt";

const PAYMENT_CTES = `
WITH normalized_orders AS (
  SELECT
    o.*,
    NULLIF(BTRIM(o.contract_no), '') AS norm_contract_no,
    NULLIF(BTRIM(o.order_no), '') AS norm_order_no,
    COALESCE(NULLIF(BTRIM(o.total_amount::text), '')::numeric, 0) AS total_amount_num
  FROM orders o
), incoming_payments AS (
  SELECT
    p.id,
    COALESCE(NULLIF(BTRIM(p.amount::text), '')::numeric, 0) AS amount_num,
    NULLIF(BTRIM(p.contract_no), '') AS norm_contract_no,
    NULLIF(BTRIM(p.order_no), '') AS norm_order_no
  FROM finance_payments p
  WHERE COALESCE(p.direction, '') NOT IN ('out', 'refund')
), matched_payments AS (
  SELECT DISTINCT
    o.id AS order_id,
    p.id AS payment_id,
    p.amount_num
  FROM normalized_orders o
  JOIN incoming_payments p
    ON (
      o.norm_contract_no IS NOT NULL
      AND p.norm_contract_no IS NOT NULL
      AND o.norm_contract_no = p.norm_contract_no
    ) OR (
      o.norm_order_no IS NOT NULL
      AND p.norm_order_no IS NOT NULL
      AND o.norm_order_no = p.norm_order_no
    )
), payment_by_order AS (
  SELECT order_id, SUM(amount_num) AS received
  FROM matched_payments
  GROUP BY order_id
), unlinked_payments AS (
  SELECT COUNT(*)::int AS unlinked_payment_count,
         COALESCE(SUM(p.amount_num), 0) AS unlinked_payment_amount
  FROM incoming_payments p
  WHERE NOT EXISTS (
    SELECT 1
    FROM normalized_orders o
    WHERE (
      o.norm_contract_no IS NOT NULL
      AND p.norm_contract_no IS NOT NULL
      AND o.norm_contract_no = p.norm_contract_no
    ) OR (
      o.norm_order_no IS NOT NULL
      AND p.norm_order_no IS NOT NULL
      AND o.norm_order_no = p.norm_order_no
    )
  )
)`;

async function receivableMeta(pool) {
  const result = await pool.query(`
    ${PAYMENT_CTES}
    SELECT unlinked_payment_count, unlinked_payment_amount
    FROM unlinked_payments
  `);
  const first = result.rows[0] || {};
  return {
    payment_scope: PAYMENT_SCOPE,
    unlinked_payment_count: Number(first.unlinked_payment_count || 0),
    unlinked_payment_amount: first.unlinked_payment_amount || "0",
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const { type, customer } = req.query;
    if (type === "customer360") {
      const params = customer ? [`%${customer}%`] : [];
      const where = customer ? "WHERE o.customer ILIKE $1" : "";
      const result = await pool.query(`
        ${PAYMENT_CTES}
        SELECT o.customer,
          COUNT(*) AS order_count,
          SUM(o.total_amount_num) AS total_amount,
          COALESCE(SUM(pbo.received), 0) AS total_received,
          SUM(o.total_amount_num) - COALESCE(SUM(pbo.received), 0) AS outstanding
        FROM normalized_orders o
        LEFT JOIN payment_by_order pbo ON pbo.order_id = o.id
        ${where}
        GROUP BY o.customer
        ORDER BY total_amount DESC NULLS LAST
        LIMIT 50
      `, params);
      const meta = await receivableMeta(pool);
      const data = result.rows;
      return res.status(200).json({ success: true, data, ...meta });
    }
    if (type === "monthly") {
      const result = await pool.query(`
        SELECT TO_CHAR(created_at,'YYYY-MM') AS month, COUNT(*) AS order_count,
          SUM(CAST(total_amount AS NUMERIC)) AS total_amount, currency
        FROM orders WHERE created_at IS NOT NULL
        GROUP BY TO_CHAR(created_at,'YYYY-MM'), currency ORDER BY month DESC LIMIT 24
      `);
      return res.status(200).json({ success: true, data: result.rows });
    }
    if (type === "receivables") {
      const result = await pool.query(`
        ${PAYMENT_CTES}
        SELECT o._id AS contract_no, o.customer,
          o.total_amount_num AS invoiced,
          COALESCE(pbo.received, 0) AS received,
          o.total_amount_num - COALESCE(pbo.received, 0) AS outstanding,
          o.currency, o.created_at
        FROM normalized_orders o
        LEFT JOIN payment_by_order pbo ON pbo.order_id = o.id
        WHERE o.total_amount_num > 0
          AND o.total_amount_num > COALESCE(pbo.received, 0)
        ORDER BY outstanding DESC NULLS LAST
        LIMIT 100
      `);
      const meta = await receivableMeta(pool);
      const data = result.rows;
      return res.status(200).json({ success: true, data, count: result.rowCount, ...meta });
    }
    return res.status(400).json({ error: "type must be: customer360, monthly, receivables" });
  } catch (err) { return res.status(500).json({ success: false, error: err.message }); }
}
