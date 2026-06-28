// /api/db/migrate-orders.js — Add missing columns for portal order creation
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var results = [];

    // Add order_no column (for portal-generated ORD-YYYYMMDD-XXXX numbers)
    try {
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_no VARCHAR(30)");
      results.push("order_no: added");
    } catch (e) { results.push("order_no: " + e.message); }

    // Add company_code column (links to tenant/company)
    try {
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS company_code VARCHAR(50)");
      results.push("company_code: added");
    } catch (e) { results.push("company_code: " + e.message); }

    // Add created_by column (who created the order: portal, admin, jdy-sync)
    try {
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_by VARCHAR(50) DEFAULT 'jdy-sync'");
      results.push("created_by: added");
    } catch (e) { results.push("created_by: " + e.message); }

    // Add source column (portal, admin, jdy)
    try {
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS source VARCHAR(20) DEFAULT 'jdy'");
      results.push("source: added");
    } catch (e) { results.push("source: " + e.message); }

    // Add jdy_synced column
    try {
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS jdy_synced BOOLEAN DEFAULT false");
      results.push("jdy_synced: added");
    } catch (e) { results.push("jdy_synced: " + e.message); }

    // Add jdy_entry_id column
    try {
      await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS jdy_entry_id VARCHAR(50)");
      results.push("jdy_entry_id: added");
    } catch (e) { results.push("jdy_entry_id: " + e.message); }

    // Check current table structure
    var cols = await pool.query("SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name='orders' ORDER BY ordinal_position");

    return res.status(200).json({
      success: true,
      migrationResults: results,
      currentColumns: cols.rows
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
