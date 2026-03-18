// /api/vessel-sync.js
// Vercel Serverless Function — L3B 替代
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

async function getToken() {
  const res = await fetch("https://prod-api.4portun.com/openapi/auth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "appId": "SHYBB" },
    body: JSON.stringify({ appId: process.env.PORTUN_APP_ID || "SHYBB", secret: process.env.PORTUN_SECRET }),
  });
  const data = await res.json();
  return data.data;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();
  const cronSecret = req.headers["x-cron-secret"] || req.query.secret;
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const client = getOSSClient();
    const subscriptions = await readOSSJson(client, "data/subscriptions.json");
    if (subscriptions.length === 0) return res.status(200).json({ success: true, updated: 0 });
    const token = await getToken();
    if (!token) throw new Error("Failed to get 4portun token");
    const updates = [];
    for (const sub of subscriptions) {
      if (!sub.subscriptionId) continue;
      try {
        const resp = await fetch("https://prod-api.4portun.com/openapi/gateway/api/v2/getOceanTracking", {
          method: "POST",
          headers: { "Content-Type": "application/json", "appId": process.env.PORTUN_APP_ID || "SHYBB", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ subscriptionId: sub.subscriptionId }),
        });
        const r = await resp.json();
        const d = r.data;
        if (!d) continue;
        const places = d.places || [];
        const pol = places.find(p => p.type === "1" || p.type === "2");
        const pod = places.find(p => p.type === "4" || p.type === "5");
        const firstCtn = (d.containers || [])[0] || {};
        updates.push({
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
        });
      } catch (e) { console.error(`tracking error ${sub.subscriptionId}:`, e.message); }
    }
    const plans = await readOSSJson(client, "data/shipping_plans.json");
    const updatesMap = {};
    updates.forEach(u => { if (u.blNo) updatesMap[u.blNo] = u; });
    const FIELDS = ["vessel","voyage","atd","eta","currentStatus","currentStatusCn","trackingUpdatedAt","lat","lng"];
    const merged = plans.map(p => {
      const upd = updatesMap[p.blNo];
      if (!upd) return p;
      const result = { ...p };
      for (const f of FIELDS) { if (upd[f] != null) result[f] = upd[f]; }
      return result;
    });
    await writeOSSJson(client, "data/shipping_plans.json", merged);
    return res.status(200).json({ success: true, updated: updates.length, total: merged.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
