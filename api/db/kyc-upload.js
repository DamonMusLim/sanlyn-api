// kyc-upload.js
// 客户/工厂上传 KYC 文件后调用此端点 — 把 OSS URL + 元数据写入 customers.kyc_docs JSONB
// 文件实际上传走前端 OSS (已有基础设施)，这里只登记
//
// POST /api/db/kyc-upload
//   body: {
//     company_code,                     // 必填
//     doc_type,                         // business_license / bank / iso22000 / haccp / fda / msds / en71 / tax / other
//     url,                              // OSS 公网 URL
//     file_name,
//     size,                             // bytes
//     country?,                         // CN/MY/SG/HK 等 (用于 OCR 选模板)
//     ocr_extracted?,                   // 客户端如已 OCR，可一并传入
//     expires_at?,                      // 文件本身有效期 (营业执照常 5 年)
//   }
//
// 效果:
//   1. 写入 customers.kyc_docs[doc_type] = { url, file_name, ..., verified:false, uploaded_at }
//   2. 标记 customers.kyc_status = 'pending' (重置审核状态)
//   3. 触发 audit_logs 记录
//   4. 企微推送通知 admin
//
// 公开端点 (注册流可用，无 JWT)，但优先取 req.user.company_code

import { getPool, setCors } from "../db.js";
import { writeAudit } from "./audit-helper.js";

var WECOM_WEBHOOK = process.env.WECOM_WEBHOOK_URL || "";
var BASE_URL      = process.env.APP_BASE_URL || "https://ai.sanlyn.cn";

var ALLOWED_DOC_TYPES = [
  "business_license", "bank", "tax",
  "iso22000", "haccp", "fda", "msds", "en71",
  "factory_audit", "other",
];

async function pingAdmin({ company_code, doc_type, file_name }) {
  if (!WECOM_WEBHOOK) return { skipped: true };
  try {
    await fetch(WECOM_WEBHOOK, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        msgtype: "markdown",
        markdown: { content: [
          "## 📎 KYC Document Uploaded",
          "**Company:** " + company_code,
          "**Doc Type:** " + doc_type,
          "**File:** " + (file_name || "(unnamed)"),
          "[Review KYC](" + BASE_URL + "/admin/kyc-review)",
        ].join("\n") },
      }),
    });
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  var pool = getPool();
  var b = req.body || {};

  var company_code = b.company_code || req.user?.company_code;
  var doc_type = b.doc_type;
  var url = b.url;

  if (!company_code) return res.status(400).json({ error: "company_code required" });
  if (!doc_type || !ALLOWED_DOC_TYPES.includes(doc_type)) {
    return res.status(400).json({ error: "doc_type must be one of: " + ALLOWED_DOC_TYPES.join(", ") });
  }
  if (!url) return res.status(400).json({ error: "url required" });

  try {
    // Find customer
    var custQ = await pool.query(
      "SELECT id, company_code, kyc_docs, kyc_status FROM customers WHERE company_code = $1 LIMIT 1",
      [company_code]
    );
    if (!custQ.rows.length) return res.status(404).json({ error: "customer not found" });
    var cust = custQ.rows[0];

    var prevDocs = cust.kyc_docs || {};
    var prevStatus = cust.kyc_status;

    // Build new doc entry
    var docEntry = {
      url, file_name: b.file_name || null, size: b.size || null,
      country: b.country || null,
      uploaded_at: new Date().toISOString(),
      uploaded_by: req.user?.email || req.user?.username || "self",
      verified: false,
    };
    if (b.ocr_extracted) docEntry.ocr_extracted = b.ocr_extracted;
    if (b.expires_at) docEntry.expires_at = b.expires_at;

    var newDocs = { ...prevDocs, [doc_type]: docEntry };

    await pool.query(
      `UPDATE customers
       SET kyc_docs = $1::jsonb,
           kyc_status = CASE WHEN kyc_status = 'verified' THEN 'pending' ELSE kyc_status END,
           updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify(newDocs), cust.id]
    );

    // Audit
    writeAudit(pool, req, {
      action: "kyc.upload",
      entity_type: "customer",
      entity_id: cust.id,
      before: { [doc_type]: prevDocs[doc_type] || null, kyc_status: prevStatus },
      after:  { [doc_type]: { url: docEntry.url, file_name: docEntry.file_name }, kyc_status: "pending" },
      note: "Uploaded " + doc_type,
    }).catch(() => {});

    // Notify admin
    pingAdmin({ company_code, doc_type, file_name: b.file_name }).catch(() => {});

    return res.status(200).json({
      success: true,
      company_code,
      doc_type,
      kyc_status: "pending",
      total_docs: Object.keys(newDocs).length,
    });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
