CREATE TABLE IF NOT EXISTS document_canonical_versions (
  id bigserial PRIMARY KEY,
  doc_type text NOT NULL,
  business_key_type text NOT NULL,
  business_key text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL,
  source text NOT NULL,
  storage_uri text,
  snapshot_json jsonb,
  locked_at timestamptz,
  locked_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_canonical_audit_logs (
  id bigserial PRIMARY KEY,
  canonical_version_id bigint REFERENCES document_canonical_versions(id) ON DELETE SET NULL,
  doc_type text NOT NULL,
  business_key_type text NOT NULL,
  business_key text NOT NULL,
  action text NOT NULL,
  actor text,
  reason text,
  before_json jsonb,
  after_json jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dcv_doc_type_chk') THEN
    ALTER TABLE document_canonical_versions
      ADD CONSTRAINT dcv_doc_type_chk
      CHECK (doc_type IN ('freight_invoice','customs_declaration'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dcv_business_key_type_chk') THEN
    ALTER TABLE document_canonical_versions
      ADD CONSTRAINT dcv_business_key_type_chk
      CHECK (business_key_type IN ('cy_no','order_id'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dcv_status_chk') THEN
    ALTER TABLE document_canonical_versions
      ADD CONSTRAINT dcv_status_chk
      CHECK (status IN ('draft','locked','superseded'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dcv_source_chk') THEN
    ALTER TABLE document_canonical_versions
      ADD CONSTRAINT dcv_source_chk
      CHECK (source IN ('render','upload','manual'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dcal_action_chk') THEN
    ALTER TABLE document_canonical_audit_logs
      ADD CONSTRAINT dcal_action_chk
      CHECK (action IN ('lock','unlock','supersede'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_dcv_one_locked_per_doc_key
  ON document_canonical_versions (doc_type, business_key_type, business_key)
  WHERE status = 'locked';

CREATE INDEX IF NOT EXISTS idx_dcv_doc_key_created
  ON document_canonical_versions (doc_type, business_key_type, business_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dcal_doc_key_created
  ON document_canonical_audit_logs (doc_type, business_key_type, business_key, created_at DESC);
