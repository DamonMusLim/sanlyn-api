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


/** 命中同一张发票号时原地更新。⛔ 不覆盖人工已定的 review_status；附件按 key 去重；raw 不浅覆盖。 */
async function updateExistingInvoice(pool, existing, data) {
  const MACHINE_OWNED = new Set(["pending", "ocr_failed", "over_issued", "under_issued",
                                 "seller_mismatch", "goods_mismatch", "suspect_dup", null, ""]);
  const keepStatus = !MACHINE_OWNED.has(existing.review_status);   // forge #2: 人工态不许冲
  await pool.query(
    `UPDATE finance_invoices_in SET
       invoice_code=COALESCE($2,invoice_code), issue_date=COALESCE($3::date,issue_date),
       seller_name=COALESCE($4,seller_name), seller_tax_id=COALESCE($5,seller_tax_id),
       buyer_name=COALESCE($6,buyer_name),  buyer_tax_id=COALESCE($7,buyer_tax_id),
       seller_company_code=COALESCE($8,seller_company_code),
       amount_ex_tax=COALESCE($9,amount_ex_tax), total_tax=COALESCE($10,total_tax),
       amount_incl_tax=COALESCE($11,amount_incl_tax), tax_rate=COALESCE($12,tax_rate),
       customs_nos = (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(customs_nos,'{}'::text[]) || $13::text[]))),
       contract_nos= (SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(contract_nos,'{}'::text[]) || $14::text[]))),
       review_status = CASE WHEN $19::boolean THEN review_status ELSE $15 END,
       line_items = CASE WHEN jsonb_array_length($16::jsonb)>0 THEN $16::jsonb ELSE line_items END,
       -- forge #3: 附件按 key 去重，重传同一文件不再堆积
       attachments = (
         SELECT COALESCE(jsonb_agg(a ORDER BY ord), '[]'::jsonb) FROM (
           -- 0817 二修：优先按文件内容 sha256 去重（每次上传 key 都是新的随机值，按 key 去重无效）
           SELECT DISTINCT ON (COALESCE(a->>'sha256', a->>'key', a->>'url')) a, ord
             FROM jsonb_array_elements(COALESCE(attachments,'[]'::jsonb) || $17::jsonb)
                  WITH ORDINALITY t(a, ord)
            ORDER BY COALESCE(a->>'sha256', a->>'key', a->>'url'), ord
         ) d),
       -- forge #4: 不浅覆盖，新载荷追加进 raw.reuploads[]
       -- forge 复审 #4：只留最近 10 次重传，避免 raw 无限膨胀（OCR 原文很大）
       raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object(
               'reuploads', (
                 SELECT COALESCE(jsonb_agg(x ORDER BY ord), '[]'::jsonb) FROM (
                   SELECT x, ord FROM jsonb_array_elements(
                     COALESCE(raw->'reuploads','[]'::jsonb)
                     || jsonb_build_array($18::jsonb || jsonb_build_object('at', now()::text))
                   ) WITH ORDINALITY t(x, ord)
                   ORDER BY ord DESC LIMIT 10
                 ) k)),
       updated_at=NOW()
     WHERE id=$1`,
    [existing.id, data.invoiceCode||null, data.issueDate||null,
     data.sellerName||null, data.sellerTaxId||null, data.buyerName||null, data.buyerTaxId||null,
     data.factoryCode, data.amountExTax, data.totalTax, data.amountInclTax, data.taxRate,
     data.customsNos||[], data.contractNos||[], data.reviewStatus||"pending",
     JSON.stringify(data.lineItems||[]), JSON.stringify(data.attachments),
     JSON.stringify(data.raw), keepStatus]
  );
  return existing.id;
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
    /* 0817: dedupe by invoice_no. Re-uploading the same invoice used to insert a second row,
       so the "already invoiced" total doubled (real case: 664707 showed 252,688 vs expected 126,344
       and flipped to over_issued). One invoice number = one row; re-upload refreshes it in place.
       Skip OCR_PENDING_* placeholders - those are distinct failed reads, not duplicates. */
    if (data.invoiceNo && !/^OCR_PENDING_/.test(String(data.invoiceNo))) {
      /* 0817 v2 (forge review FAIL -> rewritten). Two real bugs found by re-uploading the same PDF:
           b1 re-upload INSERTed a 2nd row -> "already invoiced" doubled (664707: expected 126,344, shown 252,688, flipped to over_issued)
           b2 OCR misread the 20-digit invoice no (...361311 read as ...363111) so exact-key dedupe missed

         forge rejected v1 on 5 counts; all fixed here:
           1) seller_tax_id+amount+date is NOT proof of "same invoice" (split/limit/re-issued invoices exist).
              -> never merge on it. Insert as a NEW row flagged suspected_duplicate + needs_review, let a human decide.
              Merging would silently delete one input invoice from the rebate pool = wrong money.
           2) review_status was overwritten unconditionally -> would reset a human confirmed/rejected state.
              -> only overwrite while the old state is still machine-owned (pending / ocr_* / *_mismatch).
           3) attachments were appended blindly -> same file piles up. Dedupe by key/url.
           4) raw was shallow-merged -> nested human notes could be clobbered. Keep old, park the new
              payload under raw.reuploads[] instead of overwriting.
           5) SELECT-then-INSERT races: two concurrent uploads both miss and both insert.
              -> a partial UNIQUE INDEX on invoice_no is the real fix (migration below); this code also
                 catches 23505 and falls back to the update path. */
      const dup = await pool.query(
        `SELECT id, review_status FROM finance_invoices_in WHERE invoice_no=$1 ORDER BY id LIMIT 1`,
        [data.invoiceNo]
      );
      if (dup.rows[0]?.id) return updateExistingInvoice(pool, dup.rows[0], data);

      if (data.sellerTaxId && data.amountInclTax !== null && data.issueDate) {
        const alt = await pool.query(
          `SELECT id, invoice_no FROM finance_invoices_in
            WHERE seller_tax_id=$1 AND amount_incl_tax=$2 AND issue_date=$3::date AND invoice_no <> $4
            ORDER BY id LIMIT 1`,
          [data.sellerTaxId, data.amountInclTax, data.issueDate, data.invoiceNo]
        );
        if (alt.rows[0]) {
          // flag only - do NOT merge (forge #1/#2)
          data.reviewStatus = "suspect_dup";
          data.raw = { ...(data.raw || {}), suspect_dup: {
            of_invoice_id: alt.rows[0].id, of_invoice_no: alt.rows[0].invoice_no,
            ocr_read: data.invoiceNo,
            reason: "same seller_tax_id + amount_incl_tax + issue_date but different invoice_no; could be an OCR digit misread OR a genuinely separate invoice - human must decide",
            at: new Date().toISOString() } };
        }
      }
    }

    const r = await pool.query(fullSql, params);
    return r.rows[0]?.id;
  } catch (e) {
    if (e.code === "23505") {          // forge #5: 并发下两个请求都没查到就都插 → 唯一索引拦住，回落更新
      const again = await pool.query(
        `SELECT id, review_status FROM finance_invoices_in WHERE invoice_no=$1 ORDER BY id LIMIT 1`,
        [data.invoiceNo]);
      if (again.rows[0]?.id) return updateExistingInvoice(pool, again.rows[0], data);
    }
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
