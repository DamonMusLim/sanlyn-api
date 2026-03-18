import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { contractNo, piUrl, piName } = req.body;
    if (!contractNo || !piUrl) return res.status(400).json({ error: "contractNo and piUrl required" });

    // 1. 从JDY下载PI文件
    const fileRes = await fetch(piUrl);
    if (!fileRes.ok) throw new Error("Failed to fetch PI from JDY: " + fileRes.status);
    const fileBuffer = await fileRes.arrayBuffer();
    const contentType = fileRes.headers.get("content-type") || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const fileName = piName || ("PI_" + contractNo + ".xlsx");
    const ossPath = "documents/pi/" + fileName;

    // 2. 上传到OSS
    const fd = new FormData();
    fd.append("file", new Blob([fileBuffer], { type: contentType }), fileName);
    fd.append("path", ossPath);
    const ossRes = await fetch("https://sanlyn-api.vercel.app/api/oss-upload", { method: "POST", body: fd });
    if (!ossRes.ok) throw new Error("OSS upload failed: " + ossRes.status);
    const ossData = await ossRes.json();
    const ossUrl = ossData.url || ("https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/" + ossPath);
    const piObj = { url: ossUrl, name: fileName, size: fileBuffer.byteLength };

    // 3. 更新OSS documents.json
    const docsRes = await fetch("https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/data/documents.json");
    const docsData = await docsRes.json();
    const docs = Array.isArray(docsData) ? docsData : (docsData.documents || []);
    const idx = docs.findIndex(d => d.contractNo === contractNo || d.orderNo === contractNo);
    if (idx >= 0) {
      docs[idx].pi = piObj;
      docs[idx].updatedAt = new Date().toISOString();
    } else {
      docs.push({ contractNo, pi: piObj, updatedAt: new Date().toISOString() });
    }
    const uploadFd = new FormData();
    uploadFd.append("file", new Blob([JSON.stringify(docs)], { type: "application/json" }), "documents.json");
    uploadFd.append("path", "data/documents.json");
    await fetch("https://sanlyn-api.vercel.app/api/oss-upload", { method: "POST", body: uploadFd });

    // 4. 尝试写RDS（如果表存在）
    try {
      const pool = getPool();
      await pool.query(`
        INSERT INTO documents (contract_no, pi, updated_at)
        VALUES ($1, $2, NOW())
        ON CONFLICT (contract_no)
        DO UPDATE SET pi = $2, updated_at = NOW()
      `, [contractNo, JSON.stringify(piObj)]);
    } catch(dbErr) {
      console.warn("RDS write skipped:", dbErr.message);
    }

    return res.status(200).json({ success: true, contractNo, ossUrl });
  } catch (err) {
    console.error("pi-sync error:", err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
