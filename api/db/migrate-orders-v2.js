// /api/db/migrate-orders-v2.js — Full orders table schema migration
// Adds all new columns for the redesigned order system
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var results = [];

    var columns = [
      // Core identification
      ["order_no", "VARCHAR(30)"],
      ["contract_no", "VARCHAR(50)"],
      ["customer_po", "VARCHAR(50)"],
      ["company_code", "VARCHAR(50)"],
      ["company_name_cn", "VARCHAR(200)"],
      ["company_name_en", "VARCHAR(200)"],
      ["group_code", "VARCHAR(50)"],
      ["brand", "VARCHAR(200)"],
      ["category", "VARCHAR(100)"],

      // Customer / delivery
      ["consignee", "VARCHAR(200)"],
      ["customer_address", "TEXT"],
      ["phone", "VARCHAR(50)"],
      ["email", "VARCHAR(100)"],
      ["country", "VARCHAR(100)"],
      ["destination_port", "VARCHAR(100)"],
      ["pol", "VARCHAR(100)"],

      // Dates (3 core + required arrival)
      // created_at already exists
      ["delivery_date", "DATE"],
      ["confirmed_delivery", "DATE"],
      ["required_arrival", "DATE"],

      // Quantity / logistics
      ["total_qty", "INTEGER"],
      ["total_cbm", "NUMERIC(10,3)"],
      ["gross_weight", "NUMERIC(10,2)"],
      ["net_weight", "NUMERIC(10,2)"],
      ["container_type", "VARCHAR(10)"],
      ["container_qty", "INTEGER DEFAULT 1"],

      // Finance
      ["total_amount", "NUMERIC(12,2)"],
      ["total_amount_factory", "NUMERIC(12,2)"],
      ["currency", "VARCHAR(10) DEFAULT 'CNY'"],
      ["exchange_rate", "NUMERIC(8,4)"],
      ["profit", "NUMERIC(12,2)"],
      ["declare_amount", "NUMERIC(12,2)"],
      ["vat_rate", "NUMERIC(5,4)"],
      ["tax_rebate_rate", "NUMERIC(5,4)"],
      ["tax_rebate_amount", "NUMERIC(12,2)"],

      // Status
      ["status", "VARCHAR(30) DEFAULT 'pending'"],
      ["production_status", "VARCHAR(30)"],

      // Products subform (JSONB array)
      // raw already stores this, but adding explicit column for query
      ["products", "JSONB DEFAULT '[]'"],

      // Locked documents (archived versions only)
      ["locked_documents", "JSONB DEFAULT '{}'"],

      // Factory / issuing
      ["factory", "VARCHAR(200)"],
      ["issuing_company", "VARCHAR(200)"],
      ["issuing_company_en", "VARCHAR(200)"],
      ["remarks", "TEXT"],

      // Source tracking
      ["source", "VARCHAR(20) DEFAULT 'admin'"],
      ["created_by", "VARCHAR(50)"],
      ["jdy_synced", "BOOLEAN DEFAULT false"],
      ["jdy_entry_id", "VARCHAR(50)"],
    ];

    for (var col of columns) {
      try {
        await pool.query("ALTER TABLE orders ADD COLUMN IF NOT EXISTS " + col[0] + " " + col[1]);
        results.push(col[0] + ": ok");
      } catch (e) {
        results.push(col[0] + ": " + e.message);
      }
    }

    // Create index on order_no and company_code for faster lookups
    try {
      await pool.query("CREATE INDEX IF NOT EXISTS idx_orders_order_no ON orders (order_no)");
      results.push("idx_order_no: ok");
    } catch (e) { results.push("idx_order_no: " + e.message); }

    try {
      await pool.query("CREATE INDEX IF NOT EXISTS idx_orders_company_code ON orders (company_code)");
      results.push("idx_company_code: ok");
    } catch (e) { results.push("idx_company_code: " + e.message); }

    try {
      await pool.query("CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status)");
      results.push("idx_status: ok");
    } catch (e) { results.push("idx_status: " + e.message); }

    // Verify final schema
    var cols = await pool.query(
      "SELECT column_name, data_type, column_default FROM information_schema.columns WHERE table_name='orders' ORDER BY ordinal_position"
    );

    return res.status(200).json({
      success: true,
      migrationResults: results,
      totalColumns: cols.rows.length,
      columns: cols.rows
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
