import { setCors } from "../db.js";

const JDY_TOKEN = "qtgTVmm3322lgmYYiSCRhbC2oUNR0CNU";
const JDY_APP   = "689cb08a93c073210bfc772b";
const DOCS_ENTRY = "691e76b3cb637ee7ef1f25ca";
const OSS_UPLOAD = "https://sanlyn-api.vercel.app/api/oss-upload";

// 单证归档表字段映射
const DOC_FIELD_MAP = {
  bl:           "_widget_1763604147209",
  invoice:      "_widget_1771737294158",
  packingList:  "_widget_1763604147206",
  hc:           "_widget_1767008538946",
  vc:           "_widget_1767008538947",
  customsDecl:  "_widget_1767008538949",
  freightInv:   "_widget_1773914554424",
  so:           "_widget_1771737294154",
  coo:          "_widget_1763604147210",
};
const CN_WIDGET  = "_widget_1766730818801"; // 订单号/合同号
const BL_NO_WIDGET = "_widget_1773596720903"; // 提单号

async function uploadToOSS(fileUrl, fileName, ossPath) {
  const fileRes = await fetch(fileUrl);
  if (!fileRes.ok) throw new Error("fetch failed: " + fileRes.status);
  const fileBlob = await fileRes.blob();
  const fd = new FormData();
  fd.append("path", ossPath);
  fd.append("file", fileBlob, fileName);
  const ossRes = await fetch(OSS_UPLOAD, { method: "POST", body: fd });
  const ossData = await ossRes.json();
  return ossData.url || ("https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/" + ossPath);
}

export async function syncDocsByContractNo(contractNo) {
  // 从单证归档表按合同号查
  const jdyRes = await fetch("https://api.jiandaoyun.com/api/v5/app/entry/data/list", {
    method: "POST",
    headers: { "Authorization": "Bearer " + JDY_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: JDY_APP, entry_id: DOCS_ENTRY,
      data_filter: { rel: "and", conds: [{ field: CN_WIDGET, type: "text", method: "eq", value: contractNo }] },
      limit: 1,
    })
  });
  const jdyData = await jdyRes.json();
  const row = (jdyData.data || jdyData.data_list || [])[0];
  if (!row) return null;
  return await syncDocsFromRow(row, contractNo);
}

export async function syncDocsFromRow(row, contractNo) {
  const blNo = row[BL_NO_WIDGET] || "";
  
  // 读现有documents.json
  const docsRes = await fetch("https://sanlyn-files.oss-cn-hongkong.aliyuncs.com/data/documents.json");
  const docsRaw = await docsRes.json();
  const docs = Array.isArray(docsRaw) ? docsRaw : (docsRaw.documents || docsRaw.data || []);
  
  // 找或创建合同号记录
  const cnIdx = contractNo ? docs.findIndex(d => d.contractNo === contractNo) : -1;
  const cnEntry = cnIdx >= 0 ? { ...docs[cnIdx] } : { contractNo };
  
  // 找或创建BL号记录
  const blIdx = blNo ? docs.findIndex(d => d.blNo === blNo) : -1;
  const blEntry = blNo ? (blIdx >= 0 ? { ...docs[blIdx] } : { blNo }) : null;

  const results = {};
  for (const [field, widget] of Object.entries(DOC_FIELD_MAP)) {
    const files = row[widget] || [];
    if (!files.length) continue;
    const f = files[0];
    if (!f?.url) continue;
    try {
      const ext = (f.name || "").split(".").pop() || "pdf";
      const fname = field.toUpperCase() + "_" + (blNo || contractNo) + "." + ext;
      const ossPath = "documents/" + field + "/" + fname;
      const ossUrl = await uploadToOSS(f.url, fname, ossPath);
      const fileObj = { url: ossUrl, name: fname, size: f.size || 0 };
      if (cnEntry) cnEntry[field] = fileObj;
      if (blEntry) blEntry[field] = fileObj;
      results[field] = "ok";
    } catch(e) {
      results[field] = "error: " + e.message;
    }
  }

  // 更新docs数组
  cnEntry.updatedAt = new Date().toISOString();
  if (cnIdx >= 0) docs[cnIdx] = cnEntry;
  else if (contractNo) docs.push(cnEntry);
  
  if (blEntry) {
    blEntry.updatedAt = new Date().toISOString();
    if (blIdx >= 0) docs[blIdx] = blEntry;
    else docs.push(blEntry);
  }

  // 写回OSS
  const fd2 = new FormData();
  fd2.append("path", "data/documents.json");
  fd2.append("file", new Blob([JSON.stringify(docs)], { type: "application/json" }), "documents.json");
  await fetch(OSS_UPLOAD, { method: "POST", body: fd2 });
  
  return { contractNo, blNo, synced: results };
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "jdy-docs-sync" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;
    let contractNo, row;

    if (body.contractNo) {
      contractNo = body.contractNo.replace(/^\[|\]$/g, "").trim();
      const result = await syncDocsByContractNo(contractNo);
      return res.status(200).json({ success: true, ...result });
    } else if (body.data) {
      row = body.data;
      contractNo = row[CN_WIDGET] || "";
      if (!contractNo && !row[BL_NO_WIDGET]) return res.status(200).json({ skip: true });
      const result = await syncDocsFromRow(row, contractNo);
      return res.status(200).json({ success: true, ...result });
    } else {
      return res.status(200).json({ ok: true, skip: "no data" });
    }
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
EOFcat > /Users/mac/Desktop/sanlyn-api/api/jdy-sync.js << 'EOF'
import { syncDocsFromRow } from "./jdy/docs-sync.js";
import { setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method === "GET") return res.status(200).json({ ok: true, service: "jdy-sync" });
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const body = req.body;
    if (!body || Object.keys(body).length === 0) return res.status(200).json({ ok: true });
    
    const row = body.data || body;
    // 判断是单证归档表的推送
    if (body.data?.entryId === "691e76b3cb637ee7ef1f25ca" || body.entryId === "691e76b3cb637ee7ef1f25ca") {
      const cn = row["_widget_1766730818801"] || "";
      const result = await syncDocsFromRow(row, cn);
      return res.status(200).json({ success: true, ...result });
    }
    return res.status(200).json({ ok: true, skip: "unknown entry" });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
