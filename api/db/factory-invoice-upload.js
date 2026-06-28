// api/db/factory-invoice-upload.js
// 工厂进项票门户的文件接收 + 持久化层（从 factory-portal.js 抽出，遵守单文件 ≤500 行铁律）。
//   - readUploadPayload：兼容 multipart 与 base64 两种上传体
//   - validateFile：大小/类型白名单校验
//   - uploadToOss：落 OSS（documents/factory-invoices/<factory>/...）
//   - insertFinanceInvoice：写 finance_invoices_in，老库缺列时兜底最小列集

import fs from "fs";
import OSS from "ali-oss";
import { IncomingForm } from "formidable";
import { first, cleanString, extOf, safeNamePart, randomId } from "./factory-portal-utils.js";

const MAX_FILE_SIZE = 20 * 1024 * 1024;

const MIME_OK = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

const EXT_OK = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"]);

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const form = new IncomingForm({
      multiples: false,
      maxFileSize: MAX_FILE_SIZE,
      allowEmptyFiles: false,
    });
    form.parse(req, (err, fields, files) => {
      if (err) return reject(err);
      resolve({ fields, files });
    });
  });
}

function decodeBase64File(body) {
  const b64 = cleanString(body.file_base64 || body.file || body.data);
  if (!b64) return null;

  const m = b64.match(/^data:([^;]+);base64,(.+)$/);
  const mime = cleanString(body.mime_type || body.mimetype || (m ? m[1] : ""));
  const data = m ? m[2] : b64;
  const buffer = Buffer.from(data, "base64");
  const fileName = cleanString(body.file_name || body.filename || `invoice.${mime === "application/pdf" ? "pdf" : "jpg"}`);
  return { buffer, fileName, mime: mime || "application/octet-stream", size: buffer.length };
}

export async function readUploadPayload(req) {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    const { fields, files } = await parseMultipart(req);
    const fileObj = first(files.file) || first(files.invoice) || first(Object.values(files)[0]);
    if (!fileObj) return { fields, file: null };
    const buffer = fs.readFileSync(fileObj.filepath);
    return {
      fields,
      file: {
        buffer,
        fileName: fileObj.originalFilename || fileObj.newFilename || "invoice",
        mime: fileObj.mimetype || "application/octet-stream",
        size: fileObj.size || buffer.length,
      },
    };
  }

  const fields = req.body || {};
  return { fields, file: decodeBase64File(fields) };
}

export function validateFile(file) {
  if (!file) return "file required";
  if (file.size > MAX_FILE_SIZE) return "file too large";
  const ext = extOf(file.fileName);
  if (!MIME_OK.has(file.mime) && !EXT_OK.has(ext)) return "only PDF or image invoice files are allowed";
  return null;
}

export async function uploadToOss(factoryCode, invoiceNo, file) {
  const bucket = process.env.OSS_BUCKET;
  const region = process.env.OSS_REGION;
  if (!bucket || !region || !process.env.OSS_ACCESS_KEY_ID || !process.env.OSS_ACCESS_KEY_SECRET) {
    throw new Error("OSS env missing");
  }

  const ext = extOf(file.fileName) || (file.mime === "application/pdf" ? ".pdf" : ".jpg");
  const key = `documents/factory-invoices/${safeNamePart(factoryCode)}/${randomId()}__${safeNamePart(invoiceNo)}${ext}`;

  const client = new OSS({
    region,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
    bucket,
  });

  await client.put(key, file.buffer, { mime: file.mime || "application/octet-stream" });
  return {
    key,
    url: `https://${bucket}.${region}.aliyuncs.com/${key}`,
  };
}

export async function insertFinanceInvoice(pool, data) {
  const fullSql = `
    INSERT INTO finance_invoices_in
      (invoice_no, invoice_code, invoice_type, issue_date,
       seller_name, seller_tax_id, buyer_name, buyer_tax_id,
       seller_company_code, buyer_company_code,
       amount_ex_tax, total_tax, amount_incl_tax, tax_rate,
       contract_nos, customs_nos,
       review_status, source, attachments, raw, line_items,
       created_at, updated_at)
    VALUES
      ($1, $2, '增值税专用发票', $3::date,
       $4, $5, $6, $7,
       $8, $9,
       $10, $11, $12, $13,
       $14::text[], $15::text[],
       $16, 'factory_portal', $17::jsonb, $18::jsonb, $19::jsonb,
       NOW(), NOW())
    RETURNING id
  `;

  const params = [
    data.invoiceNo,
    data.invoiceCode || null,
    data.issueDate || null,
    data.sellerName || null,
    data.sellerTaxId || null,
    data.buyerName || null,
    data.buyerTaxId || null,
    data.factoryCode,
    data.buyerCompanyCode || null,
    data.amountExTax,
    data.totalTax,
    data.amountInclTax,
    data.taxRate,
    data.contractNos || [],
    data.customsNos || [],
    data.reviewStatus || "pending",
    JSON.stringify(data.attachments),
    JSON.stringify(data.raw),
    JSON.stringify(data.lineItems || []),
  ];

  try {
    const r = await pool.query(fullSql, params);
    return r.rows[0]?.id;
  } catch (e) {
    if (e.code !== "42703") throw e;

    // 老库列缺失兜底：只写题目要求中的最小核心列。
    const minSql = `
      INSERT INTO finance_invoices_in
        (invoice_no, invoice_type,
         seller_name, seller_tax_id, seller_company_code,
         amount_ex_tax, amount_incl_tax, tax_rate,
         contract_nos, customs_nos, review_status,
         created_at, updated_at)
      VALUES
        ($1, '增值税专用发票',
         $4, $5, $8,
         $10, $12, $13,
         $14::text[], $15::text[], $16,
         NOW(), NOW())
      RETURNING id
    `;
    const r = await pool.query(minSql, params);
    return r.rows[0]?.id;
  }
}
