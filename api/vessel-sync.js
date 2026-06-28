// /api/vessel-sync.js
// Vercel Serverless Function — L3B 替代
import OSS from "ali-oss";
import { getPool } from "./db.js";

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

    // ── RDS同步tracking字段 ──
    try {
      const pool = getPool();
      for (const u of updates) {
        if (!u.blNo) continue;
        await pool.query(`
          UPDATE shipping_plans SET
            eta = CASE WHEN $8::text != '' THEN $8::timestamptz ELSE eta END,
            vessel = CASE WHEN $6::text != '' THEN $6::text ELSE vessel END,
            voyage = CASE WHEN $7::text != '' THEN $7::text ELSE voyage END,
            raw = raw || jsonb_build_object(
              'currentStatus', $2::text,
              'currentStatusCn', $3::text,
              'trackingUpdatedAt', $4::text,
              'atd', $5::text,
              'vessel', $6::text,
              'voyage', $7::text,
              'eta', $8::text
            )
          WHERE bl_no = $1 OR raw->>'blNo' = $1
        `, [
          u.blNo,
          u.currentStatus || "",
          u.currentStatusCn || "",
          u.trackingUpdatedAt || "",
          u.atd || "",
          u.vessel || "",
          u.voyage || "",
          u.eta || "",
        ]);
      }
    } catch(rdsErr) { console.error('[vessel-sync RDS]', rdsErr.message); }

    // ── JDY 回写 tracking 字段（ETD + ETA only）──
    // 4portun tracking → JDY 海运计划表，用于触发通知（如开港通知车队）
    // 注意：船公司(_widget_1765450157283) 和 航次(_widget_1765450157284) 由货代报价带入，不覆盖
    const JDY_API = "https://api.jiandaoyun.com/api/v5";
    const JDY_TOKEN = process.env.JDY_TOKEN || "jgAipmndimpj0endT0wStd6gpspAQpAd";
    const JDY_APP_ID = "689cb08a93c073210bfc772b";
    const JDY_ENTRY_ID = "6912a100e6f679d3089bd434"; // 海运计划表
    // Widget IDs — S83 新建的 4portun 专用字段
    const W_ETD_4P = "_widget_1774869524862";  // ETD（开船日，4portun atd 实际开航）
    const W_ETA_4P = "_widget_1774869524863";  // ETA（预计到港日，4portun 最新 ETA）
    // 原有 ETA 字段也同步更新
    const W_ETA_SO = "_widget_1771626741567";  // ETA（预计到港日）SO区域
    let jdyWriteCount = 0;

    try {
      const pool2 = getPool();
      for (const u of updates) {
        if (!u.blNo) continue;
        // 从 RDS 获取 JDY _id（shipping_plans.raw._id）
        const idRes = await pool2.query(
          `SELECT raw->>'_id' as jdy_id FROM shipping_plans WHERE bl_no = $1 OR raw->>'blNo' = $1 LIMIT 1`,
          [u.blNo]
        );
        const jdyId = idRes.rows[0]?.jdy_id;
        if (!jdyId) continue;

        // Build update payload — only ETD/ETA, don't touch 船公司/航次
        const updateFields = {};
        if (u.atd) updateFields[W_ETD_4P] = { value: u.atd };     // 4portun 实际开航
        if (u.eta) {
          updateFields[W_ETA_4P] = { value: u.eta };               // 4portun 最新 ETA
          updateFields[W_ETA_SO] = { value: u.eta };               // SO区域 ETA 也同步
        }
        if (Object.keys(updateFields).length === 0) continue;

        try {
          await fetch(`${JDY_API}/app/entry/data/update`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${JDY_TOKEN}` },
            body: JSON.stringify({
              app_id: JDY_APP_ID, entry_id: JDY_ENTRY_ID,
              data_id: jdyId,
              data: updateFields,
            }),
          });
          jdyWriteCount++;
        } catch(jdyUpdateErr) {
          console.error(`[vessel-sync JDY update] ${u.blNo}:`, jdyUpdateErr.message);
        }
      }
    } catch(jdyErr) { console.error('[vessel-sync JDY]', jdyErr.message); }

    return res.status(200).json({ success: true, updated: updates.length, jdyWritten: jdyWriteCount, total: merged.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
