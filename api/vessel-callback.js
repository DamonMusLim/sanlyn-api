// /api/vessel-callback.js
// 接收 4portun 主动推送的追踪更新
// 4portun 在船舶状态变化时会主动 POST 到此地址

import OSS from "ali-oss";

function getOSSClient() {
  return new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
  });
}

async function readOSSJson(client, key) {
  try {
    const result = await client.get(key);
    const text = result.content.toString("utf-8");
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : (parsed.data || []);
  } catch (e) { return []; }
}

async function writeOSSJson(client, key, data) {
  await client.put(key, Buffer.from(JSON.stringify(data, null, 2), "utf-8"), {
    mime: "application/json", headers: { "Cache-Control": "no-cache" },
  });
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const body = req.body;
    console.log("[vessel-callback] received:", JSON.stringify(body).slice(0, 300));

    const d = body.data || body;
    if (!d || !d.billNo) {
      return res.status(200).json({ success: true, skipped: "no billNo" });
    }

    const places = d.places || [];
    const pol = places.find(p => p.type === "1" || p.type === "2");
    const pod = places.find(p => p.type === "4" || p.type === "5");
    const firstCtn = (d.containers || [])[0] || {};

    // ── 2026-05-18: UPSERT PostgreSQL shipping_plans (was OSS-only) ──
    // OSS path kept below for legacy readers; primary truth is PG.
    try {
      const { getPool } = await import("./db.js");
      const pool = getPool();
      // POL/POD names from 4portun (Chinese name from "name", English from "nameEn")
      const polName = pol?.nameEn || pol?.name || null;
      const podName = pod?.nameEn || pod?.name || null;
      const etdVal = pol?.etd || null;
      const atdVal = pol?.atd || null;
      const etaVal = pod?.eta || null;
      const ataVal = pod?.ata || null;
      // UPSERT — match on bl_no. Insert if not found.
      const existing = await pool.query("SELECT id, pol, pod, etd, eta FROM shipping_plans WHERE bl_no = $1 LIMIT 1", [d.billNo]);
      if (existing.rows[0]) {
        // UPDATE — only fill empty fields, never overwrite manually entered data
        await pool.query(
          `UPDATE shipping_plans SET
             pol     = COALESCE(NULLIF(pol,''), $1),
             pod     = COALESCE(NULLIF(pod,''), $2),
             etd     = COALESCE(etd, $3::date),
             eta     = COALESCE(eta, $4::date),
             atd     = COALESCE(atd, $5::timestamptz),
             vessel  = COALESCE(NULLIF(vessel,''), $6),
             voyage  = COALESCE(NULLIF(voyage,''), $7),
             current_status      = $8,
             current_status_cn   = $9,
             tracking_updated_at = NOW(),
             updated_at = NOW()
           WHERE bl_no = $10`,
          [polName, podName, etdVal, etaVal, atdVal, pol?.vessel || null, pol?.voyage || null,
           firstCtn.currentStatusCode || null, firstCtn.descriptionCn || null, d.billNo]
        );
      } else {
        // INSERT new shipping_plan row — link to order via bl_no
        await pool.query(
          `INSERT INTO shipping_plans (bl_no, pol, pod, etd, eta, atd, vessel, voyage,
                                       current_status, current_status_cn, tracking_updated_at,
                                       source_system, created_at, updated_at)
           VALUES ($1, $2, $3, $4::date, $5::date, $6::timestamptz, $7, $8, $9, $10, NOW(),
                   'portun_callback', NOW(), NOW())`,
          [d.billNo, polName, podName, etdVal, etaVal, atdVal, pol?.vessel || null, pol?.voyage || null,
           firstCtn.currentStatusCode || null, firstCtn.descriptionCn || null]
        );
      }
      console.log(`[vessel-callback][PG] ${existing.rows[0] ? 'updated' : 'inserted'} bl=${d.billNo} pol=${polName} pod=${podName}`);
    } catch (pgErr) {
      console.error("[vessel-callback][PG] write failed:", pgErr.message);
      // Don't fail the whole callback — fall through to OSS path so Portune doesn't retry
    }

    const update = {
      blNo: d.billNo,
      vessel: pol?.vessel || null,
      voyage: pol?.voyage || null,
      atd: pol?.atd || null,
      eta: pod?.eta || null,
      currentStatus: firstCtn.currentStatusCode || null,
      currentStatusCn: firstCtn.descriptionCn || null,
      lat: firstCtn.lat || null,
      lng: firstCtn.lng || null,
      trackingUpdatedAt: new Date().toISOString(),
    };

    // ── Legacy OSS path (kept for any readers still pointing there) ──
    let updated = false;
    try {
      const client = getOSSClient();
      const plans = await readOSSJson(client, "data/shipping_plans.json");
      const FIELDS = ["vessel","voyage","atd","eta","currentStatus","currentStatusCn","trackingUpdatedAt","lat","lng"];
      const merged = plans.map(p => {
        if (p.blNo !== update.blNo) return p;
        updated = true;
        const result = { ...p };
        for (const f of FIELDS) { if (update[f] != null) result[f] = update[f]; }
        return result;
      });
      if (updated) await writeOSSJson(client, "data/shipping_plans.json", merged);
    } catch (ossErr) {
      console.log("[vessel-callback][OSS] skipped:", ossErr.message);
    }

    return res.status(200).json({ success: true, updated_oss: updated, blNo: update.billNo || d.billNo });
  } catch (err) {
    console.error("[vessel-callback] error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
