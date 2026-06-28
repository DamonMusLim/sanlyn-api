import { getPool, setCors } from "../db.js";

// migrate-field-visibility.js
// Powers the drag-and-drop field configurator (Air-C).
// Admin sets per-screen × per-field × per-role visibility/editability/order.
// Idempotent (CREATE TABLE IF NOT EXISTS + INSERT ... ON CONFLICT DO NOTHING).

var STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS field_visibility_config (
    id          BIGSERIAL PRIMARY KEY,
    screen      TEXT NOT NULL,
    field_key   TEXT NOT NULL,
    role        TEXT NOT NULL,
    visible     BOOLEAN DEFAULT TRUE,
    editable    BOOLEAN DEFAULT FALSE,
    sort_order  INTEGER DEFAULT 0,
    updated_at  TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (screen, field_key, role)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fvc_screen_role ON field_visibility_config(screen, role)`,

  // Seed defaults — customer_order_detail × customer.
  // Forbidden cost fields (factory_cost / trader_margin) explicitly seeded as
  // visible=false to give the configurator a starting "deny" baseline. Admin
  // can change them, but UI lens still strips the underlying API response.
  `INSERT INTO field_visibility_config (screen, field_key, role, visible, editable, sort_order) VALUES
     ('customer_order_detail', 'order_no',      'customer', TRUE,  FALSE, 1),
     ('customer_order_detail', 'contract_no',   'customer', TRUE,  FALSE, 2),
     ('customer_order_detail', 'etd',           'customer', TRUE,  FALSE, 3),
     ('customer_order_detail', 'eta',           'customer', TRUE,  FALSE, 4),
     ('customer_order_detail', 'bl_no',         'customer', TRUE,  FALSE, 5),
     ('customer_order_detail', 'factory_cost',  'customer', FALSE, FALSE, 99),
     ('customer_order_detail', 'trader_margin', 'customer', FALSE, FALSE, 99)
   ON CONFLICT (screen, field_key, role) DO NOTHING`,
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var results = [];
    for (var sql of STATEMENTS) {
      try {
        await pool.query(sql);
        results.push({ ok: true, sql: sql.slice(0, 80).replace(/\s+/g, " ") + "..." });
      } catch (e) {
        results.push({ ok: false, sql: sql.slice(0, 80).replace(/\s+/g, " ") + "...", err: e.message });
      }
    }
    return res.status(200).json({ success: true, count: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
