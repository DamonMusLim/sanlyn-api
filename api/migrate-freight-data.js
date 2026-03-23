/**
 * POST /api/migrate-freight-data
 * 临时用，跑完删掉！
 * 批量写入货代报价数据到 freight_quotes 表
 */
import { getPool } from "./db.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const pool = getPool();
    const records = req.body.records || [];
    let upserted = 0;

    for (const r of records) {
      await pool.query(`
        INSERT INTO freight_quotes (
          jdy_id, carrier, forwarder, pol, pod, route_code,
          price_20gp, price_40hq, thc, valid_from, valid_to,
          next_sailing, eta, free_days, remarks, raw, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,NOW())
        ON CONFLICT (jdy_id) DO UPDATE SET
          carrier=EXCLUDED.carrier, forwarder=EXCLUDED.forwarder,
          pol=EXCLUDED.pol, pod=EXCLUDED.pod, route_code=EXCLUDED.route_code,
          price_20gp=EXCLUDED.price_20gp, price_40hq=EXCLUDED.price_40hq,
          thc=EXCLUDED.thc, valid_from=EXCLUDED.valid_from, valid_to=EXCLUDED.valid_to,
          next_sailing=EXCLUDED.next_sailing, eta=EXCLUDED.eta,
          free_days=EXCLUDED.free_days, remarks=EXCLUDED.remarks,
          raw=EXCLUDED.raw, updated_at=NOW()
      `, [
        r.jdy_id, r.carrier, r.forwarder, r.pol, r.pod, r.route_code,
        r.price_20gp, r.price_40hq, r.thc,
        r.valid_from || null, r.valid_to || null,
        r.next_sailing || null, r.eta || null,
        r.free_days, r.remarks,
        JSON.stringify(r),
      ]);
      upserted++;
    }

    return res.status(200).json({ ok: true, upserted });
  } catch(err) {
    return res.status(500).json({ error: err.message });
  }
}
