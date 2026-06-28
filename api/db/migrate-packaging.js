// /api/db/migrate-packaging.js — 包材库存表迁移 + 种子数据
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS packaging_materials (
        id             SERIAL PRIMARY KEY,
        sku_code       VARCHAR(64) UNIQUE NOT NULL,
        name           VARCHAR(255) NOT NULL,
        spec           VARCHAR(255),
        unit           VARCHAR(32) DEFAULT '个',
        current_stock  NUMERIC(12,2) DEFAULT 0,
        safety_stock   NUMERIC(12,2) DEFAULT 0,
        product_skus   JSONB DEFAULT '[]',
        supplier       VARCHAR(255),
        unit_cost      NUMERIC(12,4),
        notes          TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS packaging_logs (
        id             SERIAL PRIMARY KEY,
        material_id    INT REFERENCES packaging_materials(id) ON DELETE CASCADE,
        type           VARCHAR(32) NOT NULL,
        quantity       NUMERIC(12,2) NOT NULL,
        before_stock   NUMERIC(12,2),
        after_stock    NUMERIC(12,2),
        operator       VARCHAR(128),
        notes          TEXT,
        created_at     TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_packaging_logs_material ON packaging_logs(material_id);
    `);
    return res.status(200).json({ success: true, message: "packaging_materials + packaging_logs tables created" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
