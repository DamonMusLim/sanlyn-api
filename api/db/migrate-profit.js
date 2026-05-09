// /api/db/migrate-profit.js — Orders profit structure columns
// POST /api/db/migrate-profit  (admin only)
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const pool = getPool();
  try {
    // Step 1: Add columns
    await pool.query(`
      ALTER TABLE orders
        ADD COLUMN IF NOT EXISTS factory_amount      NUMERIC,
        ADD COLUMN IF NOT EXISTS customer_amount     NUMERIC,
        ADD COLUMN IF NOT EXISTS margin_amount       NUMERIC,
        ADD COLUMN IF NOT EXISTS margin_pct          NUMERIC,
        ADD COLUMN IF NOT EXISTS quote_sent_at       TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS customer_replied_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS negotiation_rounds  INTEGER DEFAULT 0
    `);

    // Step 2: Backfill factory_amount from raw.products[].factoryPrice * qty
    const r = await pool.query(`
      UPDATE orders
      SET
        factory_amount = (
          SELECT SUM(
            COALESCE((item->>'factoryPrice')::numeric, 0) *
            COALESCE((item->>'qty')::numeric, 1)
          )
          FROM jsonb_array_elements(raw->'products') item
          WHERE (item->>'factoryPrice') IS NOT NULL
            AND (item->>'factoryPrice') != ''
            AND (item->>'factoryPrice')::numeric > 0
        ),
        customer_amount = total_amount,
        margin_amount = (
          CASE
            WHEN total_amount IS NOT NULL THEN
              total_amount - COALESCE((
                SELECT SUM(
                  COALESCE((item->>'factoryPrice')::numeric, 0) *
                  COALESCE((item->>'qty')::numeric, 1)
                )
                FROM jsonb_array_elements(raw->'products') item
                WHERE (item->>'factoryPrice') IS NOT NULL
                  AND (item->>'factoryPrice') != ''
                  AND (item->>'factoryPrice')::numeric > 0
              ), 0)
          END
        )
      WHERE raw->'products' IS NOT NULL
        AND jsonb_array_length(raw->'products') > 0
      RETURNING id
    `);

    // Step 3: Compute margin_pct
    const r2 = await pool.query(`
      UPDATE orders
      SET margin_pct = ROUND(margin_amount / NULLIF(factory_amount, 0) * 1000) / 10
      WHERE factory_amount > 0 AND margin_amount IS NOT NULL
      RETURNING id
    `);

    return res.status(200).json({
      success: true,
      columns_added: true,
      orders_backfilled: r.rowCount,
      margin_pct_computed: r2.rowCount,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
