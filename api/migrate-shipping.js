/**
 * GET /api/migrate-shipping
 * 临时用，跑完就删！
 * 给 shipping_plans 表补列
 */
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const pool = getPool();

    const sqls = [
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS shipment_no TEXT`,
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS contract_no TEXT`,
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS container_type TEXT`,
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS cutoff_date TEXT`,
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS forwarder_cn TEXT`,
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS freight_cost NUMERIC`,
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS freight_sale_usd NUMERIC`,
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS port_surcharge_total NUMERIC`,
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS trucking_cost_total NUMERIC`,
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS customs_cost_total NUMERIC`,
      `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS flow_status TEXT`,
    ];

    const results = [];
    for (const sql of sqls) {
      await pool.query(sql);
      results.push(sql.replace("ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS ", "✅ "));
    }

    // 顺便查一下现有列
    const cols = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'shipping_plans'
      ORDER BY ordinal_position
    `);

    return res.status(200).json({
      ok: true,
      applied: results,
      columns: cols.rows.map(r => `${r.column_name} (${r.data_type})`),
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
