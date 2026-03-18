import { getPool, setCors } from "../db.js";

const JDY_TOKEN = "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const JDY_APP   = "689cb08a93c073210bfc772b";
const JDY_ENTRY = "691e76b3cb637ee7ef1f25ca";  // 单证归档表
const PI_WIDGET = "_widget_1771739769157";
const CN_WIDGET = "_widget_1766730818801";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { contractNo } = req.body;
    if (!contractNo) return res.status(400).json({ error: "contractNo required" });

    // 1. 从JDY查这个合同号的PI文件
    // 分批拉取所有单证归档记录，找匹配合同号且有PI的
    let row = null;
    let lastId = undefined;
    outer: for (let page = 0; page < 20; page++) {
      const body = { app_id: JDY_APP, entry_id: JDY_ENTRY, limit: 100 };
      if (lastId) body.last_id = lastId;
      const jdyRes = await fetch("https://api.jiandaoyun.com/api/v5/app/entry/data/list", {
        method: "POST",
        headers: { "Authorization": "Bearer " + JDY_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const jdyData = await jdyRes.json();
      const rows = jdyData.data_list || jdyData.data || [];
      if (!rows.length) break;
      for (const r of rows) {
        if (r[CN_WIDGET] === contractNo && r[PI_WIDGET] && r[PI_WIDGET].length > 0) {
          row = r; break outer;
        }
      }
      if (rows.length < 100) break;
      lastId = rows[rows.length - 1]._id;
    }
    if (!row) return res.status(404).json({ error: "No PI file found for: " + contractNo });

    const piFiles = row[PI_WIDGET] || [];

    const piFile = piFiles[0];
    const piUrl  = piFile.url;
    const fileName = piFile.name || ("PI_" + contractNo + ".xlsx");

    // 2. 从JDY下载PI文件
    const fileRes = await fetch(piUrl);
    if (!fileRes.ok) throw new Error("Failed to fetch PI: " + fileRes.status);
    const fileBuffer = await fileRes.arrayBuffer();
    const contentType = fileRes.headers.get("content-type") || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const ossPath = "documents/pi/" + fileName;

    // 3. 上传到OSS
    const fd = new FormData();
    fd.append("file", new Blob([fileBuffer], { type: contentType }), fileName);
    fd.append("path", ossPath);
    const ossRes = await fetch("https://sanlyn-api.vercel.app/api/oss-upload", { method: "POST", body: fd });
    if (!ossRes.ok) throw new Error("OSS upload failed: " + ossRes.status);
    const ossData = await ossRes.json();
    const ossUrl = ossData.url || ("https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/" + ossPath);
    const piObj  = { url: ossUrl, name: fileName, size: fileBuffer.byteLength };

    // 4. 更新OSS documents.json
    const docsRes = await fetch("https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/data/documents.json");
    const docsRaw = await docsRes.json();
    const docs = Array.isArray(docsRaw) ? docsRaw : (docsRaw.documents || []);
    const idx = docs.findIndex(d => d.contractNo === contractNo || d.orderNo === contractNo);
    if (idx >= 0) { docs[idx].pi = piObj; docs[idx].updatedAt = new Date().toISOString(); }
    else { docs.push({ contractNo, pi: piObj, updatedAt: new Date().toISOString() }); }

    const uploadFd = new FormData();
    uploadFd.append("file", new Blob([JSON.stringify(docs)], { type: "application/json" }), "documents.json");
    uploadFd.append("path", "data/documents.json");
    await fetch("https://sanlyn-api.vercel.app/api/oss-upload", { method: "POST", body: uploadFd });

    // 5. 写RDS（如果表存在）
    try {
      const pool = getPool();
      await pool.query(`
        INSERT INTO documents (contract_no, pi, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (contract_no)
        DO UPDATE SET pi = $2, updated_at = NOW()
      `, [contractNo, JSON.stringify(piObj)]);
    } catch(dbErr) { console.warn("RDS skip:", dbErr.message); }

    return res.status(200).json({ success: true, contractNo, ossUrl });
  } catch (err) {
    console.error("pi-sync error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
