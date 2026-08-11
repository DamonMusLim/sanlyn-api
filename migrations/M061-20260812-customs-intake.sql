-- M061: 录单执行器V1 — 审计表 + 幂等唯一索引 (2026-08-12, 重复号已核查为零)
CREATE TABLE IF NOT EXISTS intake_jobs(
  id bigserial PRIMARY KEY,
  file_sha256 text NOT NULL,
  doc_type text NOT NULL,
  payload jsonb NOT NULL,
  verify_result jsonb,
  status text NOT NULL CHECK (status IN ('written','blocked','overridden')),
  actor text,
  model text,
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_intake_jobs_sha ON intake_jobs(file_sha256);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fer_customs_no ON finance_export_rebates(customs_no);
CREATE UNIQUE INDEX IF NOT EXISTS uq_cd_declaration_no ON customs_declarations(declaration_no);
