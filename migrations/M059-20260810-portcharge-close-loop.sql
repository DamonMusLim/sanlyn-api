-- M059 2026-08-10 port charge close-loop support.
-- Idempotent schema only; run manually after review.

CREATE TABLE IF NOT EXISTS doc_issue_log (
  id bigserial PRIMARY KEY,
  doc_no text NOT NULL UNIQUE,
  bl_no text,
  doc_type text NOT NULL CHECK (doc_type IN ('fob_invoice','fob_portcharge','pure_portcharge')),
  total_usd numeric(14,2) NOT NULL DEFAULT 0,
  total_cny numeric(14,2) NOT NULL DEFAULT 0,
  generated_at timestamptz NOT NULL DEFAULT now(),
  generated_by text,
  snapshot jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_doc_issue_log_bl_type
  ON doc_issue_log (bl_no, doc_type, generated_at DESC);

CREATE TABLE IF NOT EXISTS fee_name_candidates (
  raw_name text PRIMARY KEY,
  occurrences integer NOT NULL DEFAULT 0 CHECK (occurrences >= 0),
  sample_bl text,
  suggested_standard text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','adopted','rejected')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_fee_name_candidates_status
  ON fee_name_candidates (status, last_seen_at DESC);
