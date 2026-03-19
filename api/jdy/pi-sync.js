import { getPool, setCors } from "../db.js";

const JDY_TOKEN = "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const JDY_APP   = "689cb08a93c073210bfc772b";
const JDY_ENTRY = "6419d478b9b91b00091e4d73";
const CN_WIDGET = "_widget_1679903024720";
const FIELD_MAP = {
  pi:              "_widget_1769418068618",
  contract:        "_widget_1771709164165",
  invoice:         "_widget_1769078158887",
  packingList:     "_widget_1771709164164",
  factoryContract: "_widget_1771628524623",
};

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    let { contractNo } = req.body;
    if (!contractNo) return res.status(400).json({ error: "contractNo required" });
    contractNo = contractNo.replace(/^\[|\]$/g, "").trim();
    if (!contractNo) return res.status(400).json({ error: "contractNo empty after cleaning" });

    // 1. 用filter精确查JDY订单主表
    const jdyRes = await fetch("https://api.jiandaoyun.com/api/v5/app/entry/data/list", {
      method: "POST",
      headers: { "Authorization": "Bearer " + JDY_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        app_id: JDY_APP, entry_id: JDY_ENTRY,
        data_filter: { rel: "and", conds: [{ field: CN_WIDGET, type: "text", method: "eq", value: contractNo }] },
        limit: 1,
      })
    });
    const jdyData = await jdyRes.json();
    const row = (jdyData.data || jdyData.data_list || [])[0];
    if (!row) return res.status(404).json({ error: "Contract not found: " + contractNo });

    // 2. 读现有documents.json
    const docsRes = await fetch("https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/data/documents.json");
    const docsRaw = await docsRes.json();
    const docs = Array.isArray(docsRaw) ? docsRaw : (docsRaw.documents || docsRaw.data || []);
    const idx = docs.findIndex(d => d.contractNo === contractNo || d.orderNo === contractNo);
    const docEntry = idx >= 0 ? { ...docs[idx] } : { contractNo };

    // 3. 逐个字段下载上传OSS
    const results = {};
    for (const [field, widget] of Object.entries(FIELD_MAP)) {
      const files = row[widget] || [];
      if (!files.length) continue;
      const f = files[0];
      if (!f.url) continue;
      try {
        const fileData = await fetch(f.url, { timeout: 30000 }).then(r => r.arrayBuffer());
        const fname = f.name || (field + "_" + contractNo + ".xlsx");
        const ossPath = "documents/" + field + "/" + fname;
        const boundary = "FormBoundary" + Date.now();
        const body = Buffer.concat([
          Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\n" + ossPath + "\r\n"),
          Buffer.from("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + fname + "\"\r\nContent-Type: application/octet-stream\r\n\r\n"),
          Buffer.from(fileData),
          Buffer.from("\r\n--" + boundary + "--\r\n"),
        ]);
        const ossRes = await fetch("https://sanlyn-api.vercel.app/api/oss-upload", {
          method: "POST",
          headers: { "Content-Type": "multipart/form-data; boundary=" + boundary },
          body,
        });
        const ossData = await ossRes.json();
        const ossUrl = ossData.url || ("https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/" + ossPath);
        docEntry[field] = { url: ossUrl, name: fname, size: f.size || fileData.byteLength };
        results[field] = ossUrl;
      } catch(e) {
        results[field] = "error: " + e.message;
      }
    }

    // 4. 写回documents.json
    docEntry.updatedAt = new Date().toISOString();
    if (idx >= 0) docs[idx] = docEntry; else docs.push(docEntry);
    const docsJson = JSON.stringify(docs);
    const boundary2 = "FormBoundary" + Date.now();
    const uploadBody = Buffer.concat([
      Buffer.from("--" + boundary2 + "\r\nContent-Disposition: form-data; name=\"path\"\r\n\r\ndata/documents.json\r\n"),
      Buffer.from("--" + boundary2 + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"documents.json\"\r\nContent-Type: application/json\r\n\r\n"),
      Buffer.from(docsJson),
      Buffer.from("\r\n--" + boundary2 + "--\r\n"),
    ]);
    await fetch("https://sanlyn-api.vercel.app/api/oss-upload", {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=" + boundary2 },
      body: uploadBody,
    });

    return res.status(200).json({ success: true, contractNo, synced: results });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
