ALTER TABLE canonical_documents
  ADD COLUMN IF NOT EXISTS processing_status TEXT NOT NULL DEFAULT 'linked';

ALTER TABLE canonical_documents
  DROP CONSTRAINT IF EXISTS canonical_documents_processing_status_check;

ALTER TABLE canonical_documents
  ADD CONSTRAINT canonical_documents_processing_status_check
  CHECK (processing_status IN ('pending', 'linked', 'failed'));

DROP INDEX IF EXISTS idx_canonical_documents_hash_domain;

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_documents_hash_domain
  ON canonical_documents(domain, file_sha256)
  WHERE COALESCE(processing_status, 'linked') <> 'failed';
