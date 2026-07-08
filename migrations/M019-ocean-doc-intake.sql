CREATE TABLE IF NOT EXISTS ocean_doc_intake (
  id BIGSERIAL PRIMARY KEY,
  doc_type TEXT,
  confidence TEXT,
  extracted JSONB NOT NULL DEFAULT '{}'::jsonb,
  match_candidates JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending_review',
  matched_shipping_plan_id INTEGER,
  matched_order_no TEXT,
  confirmed_note TEXT,
  file_url TEXT,
  uploader TEXT,
  confirmed_by TEXT,
  confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ocean_doc_intake_status
  ON ocean_doc_intake(status);

CREATE TABLE IF NOT EXISTS ocean_doc_uploads (
  id BIGSERIAL PRIMARY KEY,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  uploader TEXT,
  note TEXT,
  size_bytes BIGINT,
  upload_ip TEXT,
  processed BOOLEAN DEFAULT FALSE,
  intake_id BIGINT REFERENCES ocean_doc_intake(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
