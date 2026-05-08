// migrate-inner-unit.js
// Standardizes product unit fields:
//   bg_bx  → inner_qty  (how many pieces/bags/cans per CTN)
//   (new)  → inner_unit (the name of that unit: bag, PCS, can, bottle, etc.)
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();
  var log = [];

  try {
    // 1. Rename bg_bx → inner_qty (safe: IF EXISTS guard via DO block)
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='products' AND column_name='bg_bx'
        ) AND NOT EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name='products' AND column_name='inner_qty'
        ) THEN
          ALTER TABLE products RENAME COLUMN bg_bx TO inner_qty;
        END IF;
      END $$;
    `);
    log.push("inner_qty: bg_bx renamed (or already done)");

    // 2. Add inner_unit — defaults to 'PCS' (most universal trade unit)
    await pool.query(`
      ALTER TABLE products ADD COLUMN IF NOT EXISTS inner_unit VARCHAR(16) DEFAULT 'PCS';
    `);
    log.push("inner_unit: added (default='bag')");

    // 3. Verify
    var cols = await pool.query(`
      SELECT column_name, data_type, column_default
      FROM information_schema.columns
      WHERE table_name = 'products'
        AND column_name IN ('inner_qty', 'inner_unit', 'unit')
      ORDER BY column_name
    `);
    log.push("Columns now: " + JSON.stringify(cols.rows));

    var sample = await pool.query(`
      SELECT sku, unit, inner_qty, inner_unit
      FROM products
      WHERE active = true AND inner_qty > 0
      LIMIT 5
    `);
    log.push("Sample rows: " + JSON.stringify(sample.rows));

    return res.status(200).json({ success: true, log });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message, log });
  }
}
