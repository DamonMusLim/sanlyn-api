// scripts/setup-factories.js
// Run once locally: node scripts/setup-factories.js
// Creates factories table and seeds with current factory config

import pg from "pg";
const { Pool } = pg;

var pool = new Pool({
  host: "pgm-j6c92e9e7xe2qvingo.pg.rds.aliyuncs.com",
  port: 5432,
  database: "sanlyn_db",
  user: "sanlyn_admin",
  password: "SanlynRDS2026!",
  ssl: { rejectUnauthorized: false },
});

var SEED = [
  { name: "烟台中宠股份有限公司",       name_short: "中宠",   po_prefix: "ZC", ports: ["Qingdao 青岛"] },
  { name: "烟台中宠食品股份有限公司",   name_short: "中宠食品", po_prefix: "ZC", ports: ["Qingdao 青岛"] },
  { name: "福建泰迪宠物食品有限公司",   name_short: "泰迪",   po_prefix: "XM", ports: ["Xiamen 厦门"] },
  { name: "福建恒安国际贸易有限公司",   name_short: "恒安",   po_prefix: "XM", ports: ["Xiamen 厦门"] },
  { name: "江苏宠银进出口贸易有限公司", name_short: "宠银",   po_prefix: "CY", ports: ["Lianyungang 连云港", "Qingdao 青岛"] },
  { name: "连云港中砂宠物用品有限公司", name_short: "中砂",   po_prefix: "LL", ports: ["Lianyungang 连云港", "Qingdao 青岛"] },
  { name: "辽宁宠爱科技有限公司",       name_short: "宠爱",   po_prefix: "CL", ports: ["Jinzhou 锦州", "Tianjin 天津"] },
  { name: "霸州市天缘塑料冲压制品厂",   name_short: "天缘",   po_prefix: "TY", ports: ["Tianjin 天津"] },
  { name: "宣城福新宠物食品有限公司",   name_short: "福新",   po_prefix: "FX", ports: ["Shanghai 上海"] },
  { name: "广州润聪电子商务有限公司",   name_short: "润聪",   po_prefix: "RC", ports: ["Guangzhou 广州"] },
  { name: "山东爱舒乐卫生用品有限责任公司", name_short: "爱舒乐", po_prefix: "AL", ports: ["Qingdao 青岛"] },
];

async function run() {
  var client = await pool.connect();
  try {
    // Create table
    await client.query(`
      CREATE TABLE IF NOT EXISTS factories (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        name_short  TEXT,
        po_prefix   VARCHAR(10) NOT NULL,
        ports       TEXT[],
        notes       TEXT,
        is_active   BOOLEAN DEFAULT TRUE,
        created_at  TIMESTAMP DEFAULT NOW()
      )
    `);
    console.log("✓ factories table ready");

    // Seed data (skip if already exists by name)
    var inserted = 0;
    for (var f of SEED) {
      var exists = await client.query("SELECT id FROM factories WHERE name = $1", [f.name]);
      if (exists.rows.length) {
        console.log("  skip (exists):", f.name_short);
        continue;
      }
      await client.query(
        "INSERT INTO factories (name, name_short, po_prefix, ports) VALUES ($1, $2, $3, $4)",
        [f.name, f.name_short, f.po_prefix, f.ports]
      );
      console.log("  inserted:", f.name_short, "→", f.po_prefix);
      inserted++;
    }
    console.log(`\n✓ Done: ${inserted} factories inserted`);
  } finally {
    client.release();
    pool.end();
  }
}

run().catch(console.error);
