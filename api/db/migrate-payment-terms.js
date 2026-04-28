import { getPool, setCors } from "../db.js";

// ═══════════════════════════════════════════════════════════════
// Payment Terms migration — adds two columns to orders table
//
// payment_term:
//   'tt_30_70'     → TT 30% deposit + 70% before shipment
//   'tt_full'      → TT 100% advance
//   'tt_balance_bl'→ Deposit + balance against B/L
//   'monthly_30'   → Monthly statement, 30 days net
//   'monthly_60'   → Monthly statement, 60 days net
//   'invoice_30'   → Open account 30 days from invoice
//   'invoice_60'   → Open account 60 days from invoice
//   'cod'          → Cash on delivery
//   'lc_at_sight'  → L/C at sight
//   'custom'       → Free-text custom terms (stored in payment_term_note)
//   NULL           → Not yet agreed (triggers task to factory)
//
// payment_term_status:
//   'pending'   → Awaiting factory proposal (default if NULL term)
//   'proposed'  → Factory submitted, awaiting Sanlyn admin approval
//   'approved'  → Locked in, used for due-date calculation
//   'rejected'  → Sanlyn admin rejected; factory must re-propose
// ═══════════════════════════════════════════════════════════════

var STATEMENTS = [
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_term         VARCHAR(32)  DEFAULT NULL`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_term_status  VARCHAR(16)  DEFAULT 'pending'`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_term_note    TEXT         DEFAULT ''`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_term_proposed_by  INT  DEFAULT NULL`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_term_proposed_at  TIMESTAMPTZ DEFAULT NULL`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_term_approved_by  INT  DEFAULT NULL`,
  `ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_term_approved_at  TIMESTAMPTZ DEFAULT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_orders_payment_term_status ON orders(payment_term_status) WHERE payment_term_status <> 'approved'`,
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    var pool = getPool();
    var log = [];
    for (var sql of STATEMENTS) {
      await pool.query(sql);
      log.push("OK: " + sql.slice(0, 90));
    }
    res.status(200).json({ ok: true, columns_added: 7, indexes_added: 1, log });
  } catch (err) {
    console.error("[migrate-payment-terms] failed:", err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
