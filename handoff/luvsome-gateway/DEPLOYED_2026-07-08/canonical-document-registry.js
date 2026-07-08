import crypto from "crypto";

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export async function findCanonicalDocumentByHash(pool, domain, fileSha256) {
  const r = await pool.query(
    `SELECT id, linked_table, linked_id, processing_status, created_at
       FROM canonical_documents
      WHERE domain = $1 AND file_sha256 = $2
        AND COALESCE(processing_status, 'linked') <> 'failed'
      LIMIT 1`,
    [domain, fileSha256]
  );
  return r.rows[0] || null;
}

export async function registerCanonicalDocument(pool, input) {
  const r = await pool.query(
    `INSERT INTO canonical_documents (
       domain, doc_type, file_sha256, source_path, original_filename, uploader,
       duplicate_status, linked_table, linked_id, processing_status
     ) VALUES (
       $1,$2,$3,$4,$5,$6,'unique',$7,$8,$9
     )
     ON CONFLICT (domain, file_sha256)
       WHERE COALESCE(processing_status, 'linked') <> 'failed'
       DO NOTHING
     RETURNING id`,
    [
      input.domain,
      input.doc_type || null,
      input.file_sha256,
      input.source_path || null,
      input.original_filename || null,
      input.uploader || null,
      input.linked_table || null,
      input.linked_id == null ? null : String(input.linked_id),
      input.processing_status || (input.linked_table && input.linked_id ? "linked" : "pending"),
    ]
  );
  return r.rows[0] || null;
}

export async function linkCanonicalDocument(pool, input) {
  const r = await pool.query(
    `UPDATE canonical_documents
        SET linked_table = $3,
            linked_id = $4,
            processing_status = 'linked'
      WHERE domain = $1
        AND file_sha256 = $2
        AND COALESCE(processing_status, 'linked') <> 'failed'
      RETURNING id`,
    [
      input.domain,
      input.file_sha256,
      input.linked_table,
      input.linked_id == null ? null : String(input.linked_id),
    ]
  );
  return r.rows[0] || null;
}

export async function markCanonicalDocumentFailed(pool, domain, fileSha256) {
  const r = await pool.query(
    `UPDATE canonical_documents
        SET processing_status = 'failed'
      WHERE domain = $1
        AND file_sha256 = $2
        AND COALESCE(processing_status, 'linked') = 'pending'
      RETURNING id`,
    [domain, fileSha256]
  );
  return r.rows[0] || null;
}
