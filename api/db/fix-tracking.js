import { getPool, setCors } from "../db.js";
const OSS_URL = "https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/data/shipping_plans.json";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  try {
    const pool = getPool();
    const r = await fetch(OSS_URL);
    const plans = await r.json();
    const hits = plans.filter(p => p.currentStatus || p.atd || p.vessel);
    let updated = 0;
    for (const p of hits) {
      const result = await pool.query(`
        UPDATE shipping_plans SET
          raw = raw || jsonb_build_object(
            'currentStatus', $2,
            'currentStatusCn', $3,
            'trackingUpdatedAt', $4,
            'atd', $5,
            'vessel', $6,
            'voyage', $7
          )
        WHERE bl_no = $1 OR raw->>'blNo' = $1
      `, [
        p.blNo || "",
        p.currentStatus || null,
        p.currentStatusCn || null,
        p.trackingUpdatedAt || null,
        p.atd || null,
        p.vessel || null,
        p.voyage || p.voyageNo || null,
      ]);
      updated += result.rowCount;
    }
    return res.status(200).json({ success: true, processed: hits.length, updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
