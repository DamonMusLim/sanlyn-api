CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS canonical_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  domain TEXT NOT NULL,
  doc_type TEXT,
  file_sha256 TEXT NOT NULL,
  source_path TEXT,
  original_filename TEXT,
  uploader TEXT,
  duplicate_status TEXT NOT NULL DEFAULT 'unique',
  duplicate_of UUID REFERENCES canonical_documents(id),
  linked_table TEXT,
  linked_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_canonical_documents_hash_domain
  ON canonical_documents(domain, file_sha256);

CREATE INDEX IF NOT EXISTS idx_canonical_documents_linked
  ON canonical_documents(linked_table, linked_id);
