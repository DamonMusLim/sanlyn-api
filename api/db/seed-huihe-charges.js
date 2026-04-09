// /api/db/seed-huihe-charges.js — One-time: seed/update Huihe COSCO Tianjin→Port Klang charges
// 惠禾国际 COSCO 天津→巴生西 港杂费报价
// GET this endpoint to run the seed/update
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // Ensure table exists (with all columns)
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

  // 港杂费明细 from COSCO official rates (per 图2 screenshot)
  const fees20GP = [
    { feeName: "港杂费",       amount: 252,  unit: "柜" },
    { feeName: "THC",          amount: 640,  unit: "柜" },
    { feeName: "铅封费",       amount: 30,   unit: "柜" },
    { feeName: "VGM信息代输费", amount: 20,   unit: "柜" },
    { feeName: "设备管理费",   amount: 50,   unit: "柜" },
    { feeName: "舱单传输费",   amount: 100,  unit: "票" },
    { feeName: "文件费",       amount: 500,  unit: "票" },
    { feeName: "电放费",       amount: 300,  unit: "票" },
  ];

  const fees40HQ = [
    { feeName: "港杂费",       amount: 356,  unit: "柜" },
    { feeName: "THC",          amount: 972,  unit: "柜" },
    { feeName: "铅封费",       amount: 30,   unit: "柜" },
    { feeName: "VGM信息代输费", amount: 20,   unit: "柜" },
    { feeName: "设备管理费",   amount: 50,   unit: "柜" },
    { feeName: "舱单传输费",   amount: 100,  unit: "票" },
    { feeName: "文件费",       amount: 500,  unit: "票" },
    { feeName: "电放费",       amount: 300,  unit: "票" },
  ];

  const records = [
    // ── 20GP ──
    {
      carrier: "COSCO",
      pol: "Tianjin",
      pod: "Port Klang West",
      company_name: "天津惠禾国际货运代理有限责任公司",
      container_type: "20GP",
      fees: fees20GP,
      cost_total: 980,
      sell_total: 985,
      free_time: { days: 14 },
      raw: {
        transit: false,
        freeTime: 14,
        // ETD/ETA — update these when you have a specific sailing schedule
        etd: "",
        eta: "",
        voyage: "",
      },
      remarks: "20GP成本$980，报价$985。港杂费¥992/柜+票费¥900/票（舱单100+文件500+电放300）",
    },
    // ── 40HQ ──
    {
      carrier: "COSCO",
      pol: "Tianjin",
      pod: "Port Klang West",
      company_name: "天津惠禾国际货运代理有限责任公司",
      container_type: "40HQ",
      fees: fees40HQ,
      cost_total: 980,
      sell_total: 985,
      free_time: { days: 14 },
      raw: {
        transit: false,
        freeTime: 14,
        etd: "",
        eta: "",
        voyage: "",
      },
      remarks: "40HQ成本$980，报价$985。港杂费¥1428/柜+票费¥900/票（舱单100+文件500+电放300）",
    },
  ];

  const results = [];
  for (const rec of records) {
    // Look for existing record (match by carrier + pol + container_type)
    const existing = await pool.query(
      "SELECT id, container_type, company_name FROM local_charges WHERE carrier=$1 AND pol ILIKE $2 AND (container_type=$3 OR container_type=$4) LIMIT 1",
      [rec.carrier, "%" + rec.pol + "%", rec.container_type, rec.container_type.replace("HQ","GP").replace("HC","GP")]
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      await pool.query(
        `UPDATE local_charges
         SET company_name=$1, container_type=$2, fees=$3, cost_total=$4, sell_total=$5,
             free_time=$6, raw=$7, remarks=$8, updated_at=NOW()
         WHERE id=$9`,
        [
          rec.company_name,
          rec.container_type,
          JSON.stringify(rec.fees),
          rec.cost_total,
          rec.sell_total,
          JSON.stringify(rec.free_time),
          JSON.stringify(rec.raw),
          rec.remarks,
          row.id,
        ]
      );
      results.push({ id: row.id, action: "updated", type: rec.container_type, was: row.container_type });
    } else {
      const r = await pool.query(
        `INSERT INTO local_charges (carrier, pol, pod, company_name, container_type, fees, cost_total, sell_total, free_time, raw, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          rec.carrier, rec.pol, rec.pod, rec.company_name, rec.container_type,
          JSON.stringify(rec.fees), rec.cost_total, rec.sell_total,
          JSON.stringify(rec.free_time), JSON.stringify(rec.raw), rec.remarks,
        ]
      );
      results.push({ id: r.rows[0].id, action: "inserted", type: rec.container_type });
    }
  }

  // Verify final state
  const all = await pool.query(
    "SELECT id, carrier, pol, pod, company_name, container_type, cost_total, sell_total, free_time FROM local_charges ORDER BY id"
  );

  return res.status(200).json({
    success: true,
    operations: results,
    total: all.rowCount,
    records: all.rows,
  });
}
