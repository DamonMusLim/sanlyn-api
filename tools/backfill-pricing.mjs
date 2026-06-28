import pg from "pg";

const { Pool } = pg;

const pool = new Pool({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT || "5432"),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: false,
});

const client = await pool.connect();

try {
  await client.query("BEGIN");

  const lineSubtotal = await client.query(`
    UPDATE order_line_items
       SET factory_subtotal = ROUND((qty_ctn * factory_price)::numeric, 2),
           updated_at = NOW()
     WHERE factory_subtotal IS NULL
       AND qty_ctn IS NOT NULL
       AND factory_price IS NOT NULL
  `);
  console.log("order_line_items.factory_subtotal backfilled:", lineSubtotal.rowCount);

  const orderFactoryTotals = await client.query(`
    WITH totals AS (
      SELECT order_id,
             ROUND(COALESCE(SUM(COALESCE(factory_subtotal, 0)), 0)::numeric, 2) AS factory_total
        FROM order_line_items
       GROUP BY order_id
    )
    UPDATE orders o
       SET factory_price_total = t.factory_total,
           updated_at = NOW()
      FROM totals t
     WHERE o.id = t.order_id
       AND o.factory_price_total IS NULL
  `);
  console.log("orders.factory_price_total backfilled:", orderFactoryTotals.rowCount);

  const markupRecalc = await client.query(`
    WITH pricing AS (
      SELECT id,
             factory_price_total,
             middleman_markup_pct,
             middleman_markup_total,
             CASE
               WHEN middleman_markup_pct IS NOT NULL AND factory_price_total IS NOT NULL
                 THEN ROUND((factory_price_total * middleman_markup_pct / 100)::numeric, 2)
               WHEN middleman_markup_total IS NOT NULL
                 THEN ROUND(middleman_markup_total::numeric, 2)
               ELSE NULL
             END AS markup_total,
             CASE
               WHEN middleman_markup_pct IS NOT NULL THEN ROUND(middleman_markup_pct::numeric, 2)
               WHEN middleman_markup_total IS NOT NULL AND factory_price_total IS NOT NULL AND factory_price_total <> 0
                 THEN ROUND((middleman_markup_total / factory_price_total * 100)::numeric, 2)
               ELSE NULL
             END AS markup_pct
        FROM orders
       WHERE middleman_markup_pct IS NOT NULL
          OR middleman_markup_total IS NOT NULL
    )
    UPDATE orders o
       SET middleman_markup_total = p.markup_total,
           middleman_markup_pct = p.markup_pct,
           customer_price_total = CASE
             WHEN p.factory_price_total IS NOT NULL
               THEN ROUND(p.factory_price_total + COALESCE(p.markup_total, 0), 2)
             ELSE NULL
           END,
           updated_at = NOW()
      FROM pricing p
     WHERE o.id = p.id
  `);
  console.log("markup/customer_price_total recalculated:", markupRecalc.rowCount);

  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK");
  console.error("backfill failed:", err);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
