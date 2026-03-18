// /api/doc-convert.js
// Vercel Serverless Function — 阿里云 IMM 文档转换
// 接收 OSS 文件路径（Excel/Word），调用 IMM ConvertOfficeFormat 转成 PDF
// 转换结果保存到 OSS pdfs/ 目录，返回 PDF URL

import crypto from "crypto";

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ── 阿里云 RPC 签名 ──────────────────────────────────────────
function rpcSign(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  const canonicalQuery = sortedKeys.map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`
  ).join("&");
  const strToSign = `POST&${encodeURIComponent("/")}&${encodeURIComponent(canonicalQuery)}`;
  return crypto.createHmac("sha1", secret + "&").update(strToSign).digest("base64");
}

// ── 调用 IMM ConvertOfficeFormat ─────────────────────────────
async function convertToPDF(srcOssKey, tgtOssKey) {
  const ak = process.env.OSS_ACCESS_KEY_ID;
  const sk = process.env.OSS_ACCESS_KEY_SECRET;
  const bucket = process.env.OSS_BUCKET || "sanlyn-files";
  const region = "cn-hongkong";
  const project = "sanlyn-imm";

  // OSS URI 格式: oss://bucket/key
  const srcUri = `oss://${bucket}/${srcOssKey}`;
  const tgtUri = `oss://${bucket}/${tgtOssKey}`;

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
    SrcUri: srcUri,
    TgtUri: tgtUri,
    TgtType: "pdf",
  };

  params.Signature = rpcSign(params, sk);

  const body = Object.keys(params).map(k =>
    `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`
  ).join("&");

  const endpoint = `https://imm.${region}.aliyuncs.com/`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  return res.json();
}

// ── Main handler ─────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "Method not allowed" });

  try {
    const { srcKey, filename } = req.body;
    // srcKey: OSS 文件路径，如 "data/contracts/FS2026001.xlsx"
    // filename: 输出文件名（不含扩展名），如 "FS2026001"

    if (!srcKey) {
      return res.status(400).json({ success: false, error: "Missing srcKey" });
    }

    // 生成目标 PDF 路径
    const baseName = filename || srcKey.split("/").pop().replace(/\.[^.]+$/, "");
    const tgtKey = `pdfs/${baseName}_${Date.now()}.pdf`;

    console.log(`[doc-convert] ${srcKey} → ${tgtKey}`);

    // 调用 IMM 转换
    const immRes = await convertToPDF(srcKey, tgtKey);
    console.log("[doc-convert] IMM response:", JSON.stringify(immRes).slice(0, 300));

    if (immRes.RequestId && !immRes.Code) {
      // 成功
      const bucket = process.env.OSS_BUCKET || "sanlyn-files";
      const region = process.env.OSS_REGION || "oss-cn-hongkong";
      const pdfUrl = `https://${bucket}.${region}.aliyuncs.com/${tgtKey}`;

      return res.status(200).json({
        success: true,
        pdfUrl,
        tgtKey,
        pages: immRes.TgtLoc?.PageCount || null,
      });
    } else {
      console.error("[doc-convert] IMM error:", immRes);
      return res.status(500).json({
        success: false,
        error: immRes.Message || "IMM conversion failed",
        code: immRes.Code,
      });
    }

  } catch (err) {
    console.error("[doc-convert] error:", err);
    return res.status(500).json({ success: false, error: err.message || "Conversion failed" });
  }
}
