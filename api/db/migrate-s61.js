// sanlyn-api/api/db/migrate-s61.js
// 一次性建表脚本，部署后 curl 调用一次，然后删掉
// 用法: curl https://sanlyn-api.vercel.app/api/db/migrate-s61
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const pool = getPool();

    await pool.query(`
      CREATE TABLE IF NOT EXISTS customs_data (
        _id            TEXT PRIMARY KEY,
        customs_no     TEXT,
        shipment_no    TEXT,
        contract_no    TEXT,
        customs_dec_official  JSONB,
        release_note         JSONB,
        booking_note         JSONB,
        bl_draft             JSONB,
        bl_final             JSONB,
        customs_dec          JSONB,
        origin_cert          JSONB,
        quarantine_report    JSONB,
        seal_photos          JSONB,
        factory_sign         JSONB,
        loading_details      JSONB DEFAULT '[]'::jsonb,
        raw                  JSONB,
        updated_at           TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_customs_data_shipment ON customs_data (shipment_no)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_customs_data_contract ON customs_data (contract_no)`);

    // 验证
    const check = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'customs_data' ORDER BY ordinal_position`);
    const cols = check.rows.map(r => r.column_name);

    return res.status(200).json({
      success: true,
      message: "customs_data table created",
      columns: cols,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
