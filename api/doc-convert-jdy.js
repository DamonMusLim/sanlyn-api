// /api/doc-convert-jdy.js
// Vercel Serverless Function — JDY 附件 → OSS → IMM PDF 转换
// 流程：下载 JDY 附件 URL → 上传到 OSS → IMM 转 PDF → 写回 orders.json pdfUrls
import OSS from "ali-oss";
import crypto from "crypto";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── OSS client ────────────────────────────────────────────────
function getOSSClient() {
  return new OSS({
    region: process.env.OSS_REGION,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET,
  });
}

// ── 从 JDY URL 下载附件，上传到 OSS ────────────────────────
async function downloadAndUploadToOSS(client, jdyUrl, ossKey) {
  const resp = await fetch(jdyUrl);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status} ${jdyUrl}`);
  const arrayBuffer = await resp.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await client.put(ossKey, buffer, {
    mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    headers: { "Cache-Control": "no-cache" },
  });
  console.log(`[doc-convert-jdy] uploaded to OSS: ${ossKey} (${buffer.length} bytes)`);
  return ossKey;
}

// ── 阿里云 RPC 签名 ───────────────────────────────────────────
function rpcSign(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");
  const strToSign = `POST&${encodeURIComponent("/")}&${encodeURIComponent(canonicalQuery)}`;
  return crypto.createHmac("sha1", secret + "&").update(strToSign).digest("base64");
}

// ── 调 IMM 转 PDF ─────────────────────────────────────────────
async function convertToPDF(srcOssKey, tgtOssKey) {
  const ak = process.env.OSS_ACCESS_KEY_ID;
  const sk = process.env.OSS_ACCESS_KEY_SECRET;
  const bucket = process.env.OSS_BUCKET || "sanlyn-files";
  const region = "cn-hongkong";
  const project = "sanlyn-imm";

  const params = {
    Action: "ConvertOfficeFormat",
    Version: "2017-09-06",
    Format: "JSON",
    AccessKeyId: ak,
    SignatureMethod: "HMAC-SHA1",
    SignatureVersion: "1.0",
    SignatureNonce: Math.random().toString(36).slice(2),
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    Project: project,
    SrcUri: `oss://${bucket}/${srcOssKey}`,
    TgtUri: `oss://${bucket}/${tgtOssKey}`,
    TgtType: "pdf",
  };
  params.Signature = rpcSign(params, sk);

  const body = Object.keys(params)
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join("&");

  const res = await fetch(`https://imm.${region}.aliyuncs.com/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return res.json();
}

// ── 读写 orders.json，写回 pdfUrls ───────────────────────────
async function writePdfUrlToOrder(client, orderId, docType, pdfUrl) {
  const ossKey = "data/orders.json";
  const result = await client.get(ossKey);
  const text = result.content.toString("utf-8");
  const parsed = JSON.parse(text);
  const arr = Array.isArray(parsed) ? parsed : (parsed.orders || parsed.data || []);

  const idx = arr.findIndex(o => o._id === orderId);
  if (idx < 0) throw new Error(`Order not found: ${orderId}`);

  arr[idx].pdfUrls = arr[idx].pdfUrls || {};
  arr[idx].pdfUrls[docType] = pdfUrl;

  const jsonString = JSON.stringify(arr, null, 2);
  await client.put(ossKey, Buffer.from(jsonString, "utf-8"), {
    mime: "application/json",
    headers: { "Cache-Control": "no-cache" },
  });
  console.log(`[doc-convert-jdy] pdfUrls.${docType} written for order ${orderId}`);
}

// ── Main handler ──────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { orderId, docType, jdyUrl, filename } = req.body;
    // orderId:  orders.json 里的 _id
    // docType:  sc / iv / pl / pi / po
    // jdyUrl:   JDY 附件原始 URL
    // filename: 原文件名（如 FS2026001_合同.xlsx）

    if (!orderId || !docType || !jdyUrl) {
      return res.status(400).json({ error: "Missing orderId / docType / jdyUrl" });
    }

    const client = getOSSClient();
    const ts = Date.now();
    const baseName = filename
      ? filename.replace(/\.[^.]+$/, "")
      : `${orderId}_${docType}`;

    // Step 1: 下载 JDY 附件 → 上传 OSS
    const srcKey = `attachments/${orderId}/${docType}_${ts}.xlsx`;
    await downloadAndUploadToOSS(client, jdyUrl, srcKey);

    // Step 2: IMM 转 PDF
    const tgtKey = `pdfs/${baseName}_${ts}.pdf`;
    const immRes = await convertToPDF(srcKey, tgtKey);
    console.log("[doc-convert-jdy] IMM:", JSON.stringify(immRes).slice(0, 200));

    if (immRes.Code) {
      return res.status(500).json({
        error: immRes.Message || "IMM conversion failed",
        code: immRes.Code,
      });
    }

    // Step 3: 生成 PDF 公开 URL
    const bucket = process.env.OSS_BUCKET || "sanlyn-files";
    const ossRegion = process.env.OSS_REGION || "oss-cn-hongkong";
    const pdfUrl = `https://${bucket}.${ossRegion}.aliyuncs.com/${tgtKey}`;

    // Step 4: 写回 orders.json
    await writePdfUrlToOrder(client, orderId, docType, pdfUrl);

    return res.status(200).json({ success: true, pdfUrl, tgtKey });
  } catch (err) {
    console.error("[doc-convert-jdy] error:", err);
    return res.status(500).json({ error: err.message || "Failed" });
  }
}
