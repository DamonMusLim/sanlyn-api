// /api/db/seed-huihe-charges.js — One-time: seed Huihe COSCO Tianjin→Port Klang charges
// 惠禾国际 COSCO 天津→巴生西 港杂费报价
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // Ensure table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS local_charges (
      id SERIAL PRIMARY KEY,
      carrier VARCHAR(50),
      pol VARCHAR(100),
      pod VARCHAR(100),
      company_name VARCHAR(200),
      container_type VARCHAR(20) DEFAULT '20GP',
      fees JSONB DEFAULT '{}',
      cost_total NUMERIC(10,2) DEFAULT 0,
      sell_total NUMERIC(10,2) DEFAULT 0,
      free_time JSONB DEFAULT '{}',
      remarks TEXT,
      raw JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const records = [
    // ── 20GP ──
    {
      carrier: "COSCO",
      pol: "Tianjin",
      pod: "Port Klang West",
      company_name: "天津惠禾国际货运代理有限责任公司",
      container_type: "20GP",
      fees: [
        { feeName: "港杂费", amount: 252, unit: "柜" },
        { feeName: "THC", amount: 640, unit: "柜" },
        { feeName: "铅封费", amount: 30, unit: "柜" },
        { feeName: "VGM信息代输费", amount: 20, unit: "柜" },
        { feeName: "设备管理费", amount: 50, unit: "柜" },
        { feeName: "舱单传输费", amount: 100, unit: "票" },
        { feeName: "文件费", amount: 500, unit: "票" },
        { feeName: "电放费", amount: 300, unit: "票" },
      ],
      cost_total: 980,   // 每柜: 252+640+30+20+50 = 992/柜 但Damon说成本980
      sell_total: 985,    // 销售价
      remarks: "20GP和40GP柜的成本一样980，销售价985。票费另算：舱单100+文件500+电放300=900/票",
    },
    // ── 40GP/40HC ──
    {
      carrier: "COSCO",
      pol: "Tianjin",
      pod: "Port Klang West",
      company_name: "天津惠禾国际货运代理有限责任公司",
      container_type: "40GP",
      fees: [
        { feeName: "港杂费", amount: 356, unit: "柜" },
        { feeName: "THC", amount: 972, unit: "柜" },
        { feeName: "铅封费", amount: 30, unit: "柜" },
        { feeName: "VGM信息代输费", amount: 20, unit: "柜" },
        { feeName: "设备管理费", amount: 50, unit: "柜" },
        { feeName: "舱单传输费", amount: 100, unit: "票" },
        { feeName: "文件费", amount: 500, unit: "票" },
        { feeName: "电放费", amount: 300, unit: "票" },
      ],
      cost_total: 980,   // Damon说20和40成本一样980
      sell_total: 985,
      remarks: "40GP/40HC柜费同20GP。票费另算：舱单100+文件500+电放300=900/票",
    },
  ];

  const inserted = [];
  for (const rec of records) {
    // Check if already exists
    const existing = await pool.query(
      "SELECT id FROM local_charges WHERE carrier=$1 AND pol ILIKE $2 AND container_type=$3 AND company_name=$4 LIMIT 1",
      [rec.carrier, "%" + rec.pol + "%", rec.container_type, rec.company_name]
    );

    if (existing.rowCount > 0) {
      // Update
      await pool.query(
        `UPDATE local_charges SET fees=$1, cost_total=$2, sell_total=$3, remarks=$4, updated_at=NOW()
         WHERE id=$5`,
        [JSON.stringify(rec.fees), rec.cost_total, rec.sell_total, rec.remarks, existing.rows[0].id]
      );
      inserted.push({ id: existing.rows[0].id, action: "updated", carrier: rec.carrier, type: rec.container_type });
    } else {
      // Insert
      const r = await pool.query(
        `INSERT INTO local_charges (carrier, pol, pod, company_name, container_type, fees, cost_total, sell_total, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [rec.carrier, rec.pol, rec.pod, rec.company_name, rec.container_type,
         JSON.stringify(rec.fees), rec.cost_total, rec.sell_total, rec.remarks]
      );
      inserted.push({ id: r.rows[0].id, action: "inserted", carrier: rec.carrier, type: rec.container_type });
    }
  }

  // Verify
  const all = await pool.query("SELECT id, carrier, pol, pod, company_name, container_type, cost_total, sell_total, fees FROM local_charges ORDER BY id");

  return res.status(200).json({
    success: true,
    operations: inserted,
    total: all.rowCount,
    data: all.rows,
  });
}
