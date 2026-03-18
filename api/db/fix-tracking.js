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
            'currentStatus', $2::text,
            'currentStatusCn', $3::text,
            'trackingUpdatedAt', $4::text,
            'atd', $5::text,
            'vessel', $6::text,
            'voyage', $7::text
          )
        WHERE bl_no = $1 OR raw->>'blNo' = $1
      `, [
        p.blNo || "",
        p.currentStatus || "",
        p.currentStatusCn || "",
        p.trackingUpdatedAt || "",
        p.atd || "",
        p.vessel || "",
        p.voyage || p.voyageNo || "",
      ]);
      updated += result.rowCount;
    }
    return res.status(200).json({ success: true, processed: hits.length, updated });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
