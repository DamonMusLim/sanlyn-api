ALTER TABLE bank_slip_links ADD COLUMN IF NOT EXISTS shipment_no TEXT;
ALTER TABLE bank_slip_links ADD COLUMN IF NOT EXISTS selection_source TEXT DEFAULT 'ocr_candidate';
-- selection_source: 'ocr_candidate' | 'manual_input'

ALTER TABLE bank_slips ADD COLUMN IF NOT EXISTS audit_status TEXT DEFAULT 'not_run';
-- 'not_run' | 'passed' | 'warning' | 'blocked' | 'approved_override'
ALTER TABLE bank_slips ADD COLUMN IF NOT EXISTS audit_risk_level TEXT;
-- 'low' | 'medium' | 'high'
ALTER TABLE bank_slips ADD COLUMN IF NOT EXISTS confirmed_by TEXT;
ALTER TABLE bank_slips ADD COLUMN IF NOT EXISTS confirmed_at TIMESTAMPTZ;
ALTER TABLE bank_slips ADD COLUMN IF NOT EXISTS reviewed_by TEXT;
ALTER TABLE bank_slips ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;
ALTER TABLE bank_slips ADD COLUMN IF NOT EXISTS review_note TEXT;

CREATE TABLE IF NOT EXISTS bank_slip_audits (
  id BIGSERIAL PRIMARY KEY,
  slip_id BIGINT NOT NULL REFERENCES bank_slips(id),
  audit_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low','medium','high')),
  findings JSONB NOT NULL DEFAULT '[]'::jsonb
);
