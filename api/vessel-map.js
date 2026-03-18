// /api/vessel-map.js — v3
const BASE = "https://prod-api.4portun.com/openapi";

const CARRIER_MAP = {
  "KMTC":"KMTC","COSCO":"COSCO","COSU":"COSCO","MSCU":"MSC","MEDU":"MSC",
  "MAEU":"MAE","HLCU":"HLC","EITU":"ONE","ONEY":"ONE","CXDU":"COSCO",
  "NBXG":"CMA","CMDU":"CMA","YMLU":"YML","EVGU":"EVG","HDMU":"HMM",
  "ZIMU":"ZIM","OOLU":"OOCL","APLU":"APL","SITU":"SIT","FCIU":"FCL",
};

function guessCarrier(blNo) {
  if (!blNo) return null;
  const u = blNo.toUpperCase();
  for (const [p, c] of Object.entries(CARRIER_MAP)) {
    if (u.startsWith(p)) return c;
  }
  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const APP_ID = process.env.PORTUN_APP_ID || "SHYBB";
  const SECRET = process.env.PORTUN_SECRET;
  if (!SECRET) return res.status(500).json({ error: "Missing PORTUN_SECRET" });

  const body = req.method === "POST" ? req.body : req.query;
  const blNo        = (body?.blNo || body?.blno || "").trim().toUpperCase();
  const carrierCode = (body?.carrierCode || guessCarrier(blNo) || "").toUpperCase();

  if (!blNo)        return res.status(400).json({ error: "Missing blNo" });
  if (!carrierCode) return res.status(400).json({ error: "Cannot determine carrierCode for " + blNo });

  try {
    // Step 1: token
    const tokenRes  = await fetch(`${BASE}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: APP_ID, secret: SECRET }),
    });
    const tokenJson = await tokenRes.json();
    if (tokenJson.code !== 200 || !tokenJson.data)
      return res.status(502).json({ error: "Token fetch failed", detail: tokenJson });
    const token = tokenJson.data;

    // Step 2: 订阅 — 只用 CARRIER，不需要 portCode
    const subRes  = await fetch(`${BASE}/gateway/api/v2/subscribeOceanTracking`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "appId": APP_ID,
        "Authorization": token,
      },
      body: JSON.stringify({
        billNo: blNo,
        carrierCode,
        isExport: "E",
        dataType: ["CARRIER"],
      }),
    });
    const subJson      = await subRes.json();
    const subscriptionId = subJson?.data?.subscriptionId || null;

    return res.status(200).json({
      token,
      subscriptionId,
      appId: APP_ID,
      carrierCode,
      blNo,
      subCode: subJson?.code,
      subMsg:  subJson?.message,
    });

  } catch (err) {
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
}
