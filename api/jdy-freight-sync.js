/**
 * POST /api/jdy-freight-sync
 * 从JDY货代报价表批量同步到RDS freight_quotes
 * 手动触发：curl -X POST https://sanlyn-api.vercel.app/api/jdy-freight-sync
 */
import { getPool } from "./db.js";

const JDY_TOKEN = "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const JDY_APP_ID = "689cb08a93c073210bfc772b";
const JDY_ENTRY = "692d71da9e9f7fc0d52611a9";

const W = {
  carrier:    "_widget_1765191135618",
  pol:        "_widget_1764590764461",
  pod:        "_widget_1764590764463",
  validFrom:  "_widget_1766385879996",
  validTo:    "_widget_1766385879997",
  price20gp:  "_widget_1766460008891",
  price40hq:  "_widget_1766460008892",
  thc:        "_widget_1766460008893",
  nextSailing:"_widget_1766687802819",
  eta:        "_widget_1767157052893",
  forwarder:  "_widget_1764590764459",
  routeCode:  "_widget_1766167914318",
  remarks:    "_widget_1764585946456",
  freeDays:   "_widget_1767157052905",
};

function get(d, k) {
  const v = d[W[k]];
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in v) return v.value ?? null;
  return v;
}

function toDate(v) {
  if (!v) return null;
  try { return new Date(v).toISOString().slice(0, 10); } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const pool = getPool();
    let allRows = [];
    let lastId  = null;
    let hasMore = true;

    while (hasMore) {
      const body = { limit: 100, ...(lastId ? { last_id: lastId } : {}) };
      const r = await fetch(
        `https://api.jiandaoyun.com/api/v5/app/${JDY_APP_ID}/entry/${JDY_ENTRY}/data/list`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${JDY_TOKEN}` },
          body: JSON.stringify(body),
        }
      );
      const text = await r.text();
      if (!text || !text.trim()) break;
      const json = JSON.parse(text);
      if (json.code && json.code !== 0) { console.error("[jdy-freight-sync]", json); break; }
      const rows = json.data || [];
      allRows = allRows.concat(rows);
      hasMore = rows.length === 100;
      lastId  = rows.length > 0 ? rows[rows.length - 1]._id : null;
    }

    let upserted = 0;
    for (const d of allRows) {
      await pool.query(`
        INSERT INTO freight_quotes (jdy_id, carrier, forwarder, pol, pod, route_code,
          price_20gp, price_40hq, thc, valid_from, valid_to, next_sailing, eta,
          free_days, remarks, raw, updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,NOW())
        ON CONFLICT (jdy_id) DO UPDATE SET
          carrier=EXCLUDED.carrier, forwarder=EXCLUDED.forwarder,
          pol=EXCLUDED.pol, pod=EXCLUDED.pod, route_code=EXCLUDED.route_code,
          price_20gp=EXCLUDED.price_20gp, price_40hq=EXCLUDED.price_40hq,
          thc=EXCLUDED.thc, valid_from=EXCLUDED.valid_from, valid_to=EXCLUDED.valid_to,
          next_sailing=EXCLUDED.next_sailing, eta=EXCLUDED.eta,
          free_days=EXCLUDED.free_days, remarks=EXCLUDED.remarks,
          raw=EXCLUDED.raw, updated_at=NOW()
      `, [
        d._id,
        get(d,"carrier"), get(d,"forwarder"), get(d,"pol"), get(d,"pod"), get(d,"routeCode"),
        parseFloat(get(d,"price20gp"))||null, parseFloat(get(d,"price40hq"))||null,
        parseFloat(get(d,"thc"))||null,
        toDate(get(d,"validFrom")), toDate(get(d,"validTo")),
        toDate(get(d,"nextSailing")), toDate(get(d,"eta")),
        get(d,"freeDays"), get(d,"remarks"),
        JSON.stringify(d),
      ]);
      upserted++;
    }

    return res.status(200).json({ ok: true, total: allRows.length, upserted });
  } catch(err) {
    console.error("[jdy-freight-sync]", err);
    return res.status(500).json({ error: err.message });
  }
}
