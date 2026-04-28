// migrate-order-flow-v3.js
// P0 schema additions for the v3 Order Flow design
// (see Sanlyn-OS/docs/order-flow-v3/MAPPING.md §6 + §15)
//
// Idempotent — safe to re-run.
//
// GET   ?dry_run=true   → returns the SQL plan + current state, NOTHING changed
// POST  (empty body)    → executes the migration

import { getPool, setCors } from "../db.js";

// ─── SQL plan (run in order) ───
var PLAN = [
  // orders — status machine + forward + factory + type + export mode
  ["orders.status default",      "ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'draft'"],
  ["orders.status_history",      "ALTER TABLE orders ADD COLUMN IF NOT EXISTS status_history JSONB DEFAULT '[]'::jsonb"],
  ["orders.forward_meta",        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS forward_meta   JSONB DEFAULT '{}'::jsonb"],
  ["orders.factory_code",        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS factory_code   VARCHAR(8)"],
  ["orders.export_mode",         "ALTER TABLE orders ADD COLUMN IF NOT EXISTS export_mode    VARCHAR(8) DEFAULT 'direct'"],
  ["orders.type",                "ALTER TABLE orders ADD COLUMN IF NOT EXISTS type           VARCHAR(16) DEFAULT 'order'"],
  ["idx orders.status",          "CREATE INDEX IF NOT EXISTS idx_orders_status        ON orders(status)"],
  ["idx orders.factory_code",    "CREATE INDEX IF NOT EXISTS idx_orders_factory_code  ON orders(factory_code)"],
  ["idx orders.type",            "CREATE INDEX IF NOT EXISTS idx_orders_type          ON orders(type)"],

  // products — factory_code, category, stock
  ["products.factory_code",      "ALTER TABLE products ADD COLUMN IF NOT EXISTS factory_code VARCHAR(8)"],
  ["products.category",          "ALTER TABLE products ADD COLUMN IF NOT EXISTS category     VARCHAR(16)"],
  ["products.stock",             "ALTER TABLE products ADD COLUMN IF NOT EXISTS stock        INTEGER DEFAULT 0"],
  ["idx products.factory_code",  "CREATE INDEX IF NOT EXISTS idx_products_factory_code ON products(factory_code)"],
  ["idx products.category",      "CREATE INDEX IF NOT EXISTS idx_products_category     ON products(category)"],

  // customers — partner master (buyer / factory / forwarder unified) + per-customer price overrides
  ["customers.role",             "ALTER TABLE customers ADD COLUMN IF NOT EXISTS role         VARCHAR(16) DEFAULT 'buyer'"],
  ["customers.name_short",       "ALTER TABLE customers ADD COLUMN IF NOT EXISTS name_short   VARCHAR(32)"],
  ["customers.port_default",     "ALTER TABLE customers ADD COLUMN IF NOT EXISTS port_default VARCHAR(64)"],
  ["customers.export_mode",      "ALTER TABLE customers ADD COLUMN IF NOT EXISTS export_mode  VARCHAR(8)"],
  ["customers.categories",       "ALTER TABLE customers ADD COLUMN IF NOT EXISTS categories      JSONB DEFAULT '[]'::jsonb"],
  ["customers.price_overrides",  "ALTER TABLE customers ADD COLUMN IF NOT EXISTS price_overrides JSONB DEFAULT '{}'::jsonb"],
  ["idx customers.role",         "CREATE INDEX IF NOT EXISTS idx_customers_role ON customers(role)"],

  // Backfill: derive products.factory_code from sku prefix (e.g. "ZC-1024" → "ZC")
  ["backfill products.factory_code",
    "UPDATE products SET factory_code = split_part(sku, '-', 1) WHERE factory_code IS NULL AND sku LIKE '%-%'"],
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  var pool = getPool();
  var dryRun = req.method === "GET" || req.query?.dry_run === "true";

  try {
    if (dryRun) {
      // Show current schema + planned SQL, change nothing
      var ordersCols = await pool.query(
        "SELECT column_name, data_type, column_default FROM information_schema.columns " +
        "WHERE table_name = 'orders' ORDER BY ordinal_position"
      );
      var productsCols = await pool.query(
        "SELECT column_name, data_type, column_default FROM information_schema.columns " +
        "WHERE table_name = 'products' ORDER BY ordinal_position"
      );
      var customersCols = await pool.query(
        "SELECT column_name, data_type, column_default FROM information_schema.columns " +
        "WHERE table_name = 'customers' ORDER BY ordinal_position"
      );

      return res.status(200).json({
        success: true,
        mode: "dry_run",
        plan: PLAN.map(function(p) { return { step: p[0], sql: p[1] }; }),
        currentState: {
          orders:    ordersCols.rows.map(function(c) { return c.column_name; }),
          products:  productsCols.rows.map(function(c) { return c.column_name; }),
          customers: customersCols.rows.map(function(c) { return c.column_name; }),
        },
        note: "POST to run. All steps use IF NOT EXISTS — safe to re-run."
      });
    }

    // ── Execute ──
    var results = [];
    for (var i = 0; i < PLAN.length; i++) {
      var step = PLAN[i][0];
      var sql  = PLAN[i][1];
      try {
        var t0 = Date.now();
        await pool.query(sql);
        results.push({ step, status: "ok", ms: Date.now() - t0 });
      } catch (e) {
        results.push({ step, status: "error", error: e.message });
      }
    }

    // Verify
    var verify = await pool.query(
      "SELECT " +
        "(SELECT COUNT(*) FROM information_schema.columns WHERE table_name='orders'    AND column_name IN ('status_history','forward_meta','factory_code','export_mode','type'))::int  AS orders_added, " +
        "(SELECT COUNT(*) FROM information_schema.columns WHERE table_name='products'  AND column_name IN ('factory_code','category','stock'))::int                                       AS products_added, " +
        "(SELECT COUNT(*) FROM information_schema.columns WHERE table_name='customers' AND column_name IN ('role','name_short','port_default','export_mode','categories','price_overrides'))::int AS customers_added, " +
        "(SELECT COUNT(*) FROM products WHERE factory_code IS NOT NULL)::int AS products_with_factory_code"
    );

    return res.status(200).json({
      success: true,
      mode: "executed",
      results,
      verify: verify.rows[0],
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
