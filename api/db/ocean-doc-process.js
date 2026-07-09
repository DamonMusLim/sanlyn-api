import {
  linkCanonicalDocument,
  markCanonicalDocumentFailed,
  sha256Hex
} from "./canonical-document-registry.js";
import { classifyAndExtract, matchOceanDocCandidates } from "./ocean-doc-classify.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.resolve(__dirname, "..", "..");

function firstCandidate(candidates) {
  return Array.isArray(candidates) && candidates.length === 1 ? candidates[0] : null;
}

export async function processOceanDocUpload(pool, uploadRow) {
  const absPath = path.join(BASE_DIR, uploadRow.stored_path);
  if (!fs.existsSync(absPath)) throw new Error(`ocean doc file not found: ${absPath}`);

  const fileBytes = fs.readFileSync(absPath);
  const fileSha256 = uploadRow.file_sha256 || sha256Hex(fileBytes);
  let extracted, rawText;
  try {
    ({ extracted, rawText } = await classifyAndExtract(
      fileBytes,
      uploadRow.filename || uploadRow.stored_path,
      absPath,
      process.env.MINIMAX_API_KEY
    ));
  } catch (ocrErr) {
    await markCanonicalDocumentFailed(pool, "ocean_doc", fileSha256);
    await pool.query(
      `UPDATE ocean_doc_uploads SET note = COALESCE(note,'') || $1 WHERE id=$2`,
      [` OCR_FAIL: ${ocrErr.message}`.slice(0, 300), uploadRow.id]
    );
    throw ocrErr;
  }

  const matchCandidates = await matchOceanDocCandidates(pool, extracted);
  const only = firstCandidate(matchCandidates);
  const rawExtracted = { ...extracted, ocr_raw: rawText, ocr_model: "MiniMax-M3", upload_id: uploadRow.id };
  const intake = await pool.query(
    `INSERT INTO ocean_doc_intake (
       doc_type, confidence, extracted, match_candidates, status,
       matched_shipping_plan_id, matched_order_no, file_url, uploader
     ) VALUES ($1,$2,$3::jsonb,$4::jsonb,'pending_review',$5,$6,$7,$8)
     RETURNING id`,
    [
      extracted.doc_type || null,
      extracted.confidence || null,
      JSON.stringify(rawExtracted),
      JSON.stringify(matchCandidates),
      only?.shipping_plan_id || null,
      only?.order_nos?.[0] || null,
      uploadRow.stored_path,
      uploadRow.uploader || null
    ]
  );
  const intakeId = intake.rows[0].id;

  await pool.query(
    `UPDATE ocean_doc_uploads
        SET processed=TRUE, intake_id=$1
      WHERE id=$2`,
    [intakeId, uploadRow.id]
  );
  await linkCanonicalDocument(pool, {
    domain: "ocean_doc",
    file_sha256: fileSha256,
    linked_table: "ocean_doc_intake",
    linked_id: intakeId
  });

  return { intake_id: intakeId, status: "pending_review", candidates: matchCandidates.length };
}
