// /api/vessel-subscribe.js
// Vercel Serverless Function — L3A 替代
import OSS from "ali-oss";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-cron-secret");
}

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
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  const cronSecret = req.headers["x-cron-secret"] || req.query.secret;
  if (process.env.CRON_SECRET && cronSecret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const client = getOSSClient();
    const plans = await readOSSJson(client, "data/shipping_plans.json");
    const withBL = plans.filter(p => p.blNo && p.blNo.trim() !== "");
    if (withBL.length === 0) return res.status(200).json({ success: true, subscribed: 0 });
    const token = await getToken();
    if (!token) throw new Error("Failed to get 4portun token");
    const existing = await readOSSJson(client, "data/subscriptions.json");
    const existingBLs = new Set(existing.map(s => s.blNo));
    const results = [];
    for (const plan of withBL) {
      if (existingBLs.has(plan.blNo)) continue;
      try {
        const resp = await fetch("https://prod-api.4portun.com/openapi/gateway/api/v2/subscribeOceanTracking", {
          method: "POST",
          headers: { "Content-Type": "application/json", "appId": process.env.PORTUN_APP_ID || "SHYBB", "Authorization": `Bearer ${token}` },
          body: JSON.stringify({ appId: process.env.PORTUN_APP_ID || "SHYBB", billNo: plan.blNo, carrierCode: plan.carrierCode || plan.shippingLine || "COSCO", dataType: ["CARRIER"], callbackUrl: "https://sanlyn-api.vercel.app/api/vessel-callback" }),
        });
        const r = await resp.json();
        if (r.data?.subscriptionId) {
          results.push({ shipmentNo: plan.shipmentNo, blNo: plan.blNo, containerNo: plan.containerNo || "", carrierCode: plan.carrierCode || plan.shippingLine || "", subscriptionId: r.data.subscriptionId, subscribedAt: new Date().toISOString() });
        }
      } catch (e) { console.error(`subscribe error ${plan.blNo}:`, e.message); }
    }
    const merged = [...existing, ...results];
    await writeOSSJson(client, "data/subscriptions.json", merged);
    return res.status(200).json({ success: true, newSubscriptions: results.length, totalSubscriptions: merged.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
