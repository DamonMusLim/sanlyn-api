import { getPool, setCors } from "../db.js";
const OSS_URL = "https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/data/customers.json";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const pool = getPool();
    // 建表
    await pool.query(`
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        company_code TEXT UNIQUE,
        name TEXT,
        name_en TEXT,
        name_cn TEXT,
        short_code TEXT,
        group_id TEXT,
        raw JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    // 从OSS读取数据
    const r = await fetch(OSS_URL);
    const list = await r.json();
    let inserted = 0;
    for (const c of list) {
      await pool.query(`
        INSERT INTO customers (company_code, name, name_en, name_cn, short_code, group_id, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
        ON CONFLICT (company_code) DO UPDATE SET
          name=EXCLUDED.name, name_en=EXCLUDED.name_en, name_cn=EXCLUDED.name_cn,
          short_code=EXCLUDED.short_code, group_id=EXCLUDED.group_id,
          raw=EXCLUDED.raw, updated_at=NOW()
      `, [
        c.companyCode || c.code || "",
        c.name || c.nameEN || "",
        c.nameEN || c.name || "",
        c.nameCN || "",
        c.shortCode || "",
        c.groupId || "",
        JSON.stringify(c)
      ]);
      inserted++;
    }
    return res.status(200).json({ success: true, inserted, total: list.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
