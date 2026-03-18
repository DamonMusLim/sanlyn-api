import { getPool, setCors } from "../db.js";
const OSS_URL = "https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/data/finance_payments.json";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const pool = getPool();
    const r = await fetch(OSS_URL);
    const list = await r.json();
    let inserted = 0;
    for (const p of list) {
      await pool.query(`
        INSERT INTO finance_payments (_id,customer,currency,raw,updated_at)
        VALUES ($1,$2,$3,$4::jsonb,NOW())
        ON CONFLICT (_id) DO UPDATE SET customer=$2,currency=$3,raw=$4::jsonb,updated_at=NOW()
      `, [p._id||p.contractNo||p.orderNo, p.companyNameEN||p.customer||"", p.currency||"USD", JSON.stringify(p)]);
      inserted++;
    }
    return res.status(200).json({ success: true, inserted, total: list.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
