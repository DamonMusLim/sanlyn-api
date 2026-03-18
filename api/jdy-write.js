// /api/jdy-write.js
// Vercel 代理 — 前端调此接口写入 JDY，避免 CORS
// 支持 upsert：同合同号已有记录则 update，否则 create

function setCors(req, res) {
  const allowed = [
    "https://sanlyn-os.vercel.app",
    "https://ai.sanlynos.com",
    "http://localhost:5173",
    "http://localhost:3000",
  ];
  const origin = req.headers.origin || "";
  if (allowed.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const JDY_TOKEN = process.env.JDY_TOKEN || "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const JDY_APP   = "689cb08a93c073210bfc772b";

// 查询 JDY 中同合同号的记录
async function findExisting(entry_id, contractNo) {
  if (!contractNo) return null;
  try {
    const res = await fetch("https://api.jiandaoyun.com/api/v5/app/entry/data/list", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${JDY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        app_id: JDY_APP,
        entry_id,
        limit: 1,
        filter: {
          rel: "and",
          cond: [
            { field: "_widget_1770376270481", type: "eq", val: [contractNo] },
          ],
        },
      }),
    });
    const data = await res.json();
    const rows = data?.data || [];
    return rows.length > 0 ? rows[0]._id : null;
  } catch (e) {
    console.warn("[jdy-write] findExisting error:", e.message);
    return null;
  }
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { entry_id, data, contractNo } = req.body;

    if (!entry_id || !data) {
      return res.status(400).json({ success: false, error: "Missing entry_id or data" });
    }

    // 查找是否已有同合同号记录
    const existingId = contractNo ? await findExisting(entry_id, contractNo) : null;
    console.log("[jdy-write] contractNo:", contractNo, "existingId:", existingId);

    let url, body;
    if (existingId) {
      // update
      url = "https://api.jiandaoyun.com/api/v5/app/entry/data/update";
      body = { app_id: JDY_APP, entry_id, data_id: existingId, data };
    } else {
      // create
      url = "https://api.jiandaoyun.com/api/v5/app/entry/data/create";
      body = { app_id: JDY_APP, entry_id, data };
    }

    const jdyRes = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${JDY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const jdyData = await jdyRes.json();
    console.log("[jdy-write]", existingId ? "updated" : "created", JSON.stringify(jdyData).slice(0, 200));

    const recordId = existingId || jdyData?.data?._id || null;
    return res.status(200).json({ success: true, action: existingId ? "update" : "create", recordId, data: jdyData });

  } catch (err) {
    console.error("[jdy-write] error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
