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

    const client = getOSSClient();
    const plans = await readOSSJson(client, "data/shipping_plans.json");
    const FIELDS = ["vessel","voyage","atd","eta","currentStatus","currentStatusCn","trackingUpdatedAt","lat","lng"];

    let updated = false;
    const merged = plans.map(p => {
      if (p.blNo !== update.blNo) return p;
      updated = true;
      const result = { ...p };
      for (const f of FIELDS) { if (update[f] != null) result[f] = update[f]; }
      return result;
    });

    if (updated) {
      await writeOSSJson(client, "data/shipping_plans.json", merged);
      console.log(`[vessel-callback] updated: ${update.blNo} status=${update.currentStatus}`);
    }

    return res.status(200).json({ success: true, updated, blNo: update.blNo });
  } catch (err) {
    console.error("[vessel-callback] error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
