#!/usr/bin/env node
// insert_manifest.js
// 把 manifest_v2.json 里 bound_order_id 不为 null 的 185 条
// 批量 INSERT 进 document_files 表（ON CONFLICT file_url DO NOTHING）

import { readFileSync } from "fs";
import pg from "pg";
import crypto from "crypto";

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("localhost") ? false : { rejectUnauthorized: false },
});

const manifest = JSON.parse(
  readFileSync("/Users/mac/Desktop/Sanlyn/wechat-docs/manifest_v2.json", "utf8")
);

const matched = manifest.filter((r) => r.bound_order_id && r.oss_url);
console.log(`Total in manifest: ${manifest.length}, matched (will insert): ${matched.length}`);

let inserted = 0;
let skipped = 0;
let errors = 0;

for (const rec of matched) {
  const fileId = crypto.randomUUID();
  const shipmentNo = rec.bound_contract_no || "";
  const contractNo = rec.bound_contract_no || null;
  const docType    = rec.doc_kind_guess    || "other";
  const fileName   = rec.filename          || rec.oss_key?.split("/").pop() || "";
  const fileUrl    = rec.oss_url;
  const fileSize   = rec.size_bytes        || null;
  const mimeType   = fileName.endsWith(".pdf") ? "application/pdf"
                   : fileName.match(/\.(jpg|jpeg|png|gif)$/i) ? "image/jpeg"
                   : null;

  const raw = {
    sha256:        rec.sha256        || null,
    oss_key:       rec.oss_key       || null,
    match_signal:  rec.match_signal  || null,
    bound_order_id: rec.bound_order_id || null,
    extracted:     rec.extracted     || {},
    source:        "wechat_upload_v2",
    mtime_date:    rec.mtime_date    || null,
  };

  try {
    const result = await pool.query(
      `INSERT INTO document_files
         (_id, shipment_no, contract_no, doc_type, file_name,
          file_url, file_size, mime_type, upload_by, extract_status,
          raw, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
       ON CONFLICT (file_url) DO NOTHING`,
      [
        fileId, shipmentNo, contractNo, docType, fileName,
        fileUrl, fileSize, mimeType, "wechat_upload_v2", "pending",
        JSON.stringify(raw),
      ]
    );
    if (result.rowCount === 0) {
      skipped++;
      console.log(`  SKIP (already exists): ${fileName}`);
    } else {
      inserted++;
    }
  } catch (err) {
    errors++;
    console.error(`  ERROR: ${fileName} — ${err.message}`);
  }
}

console.log(`\n✅ Done. inserted=${inserted}, skipped=${skipped}, errors=${errors}`);
await pool.end();
