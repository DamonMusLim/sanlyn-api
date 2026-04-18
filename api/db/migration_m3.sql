-- ============================================================
-- M3 Document Pipeline — Migration SQL
-- 版本：Phase 1
-- 日期：2026-04-13
-- 执行顺序严格按下方顺序；全部幂等（CREATE TABLE/INDEX IF NOT EXISTS）
-- 可重复执行，不影响现有数据和表结构
-- ============================================================

-- ────────────────────────────────────────────────
-- ① document_archive_batches（无依赖，最先建）
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_archive_batches (
  id             SERIAL PRIMARY KEY,
  _id            TEXT UNIQUE NOT NULL,
  batch_no       TEXT UNIQUE NOT NULL,
  period         TEXT NOT NULL,                    -- 'YYYY-MM'
  company_code   TEXT NOT NULL,
  status         TEXT DEFAULT 'open',              -- 'open' | 'reviewing' | 'closed'
  shipment_nos   TEXT[] DEFAULT '{}',
  doc_count      INT DEFAULT 0,
  complete_count INT DEFAULT 0,
  missing_count  INT DEFAULT 0,
  created_by     TEXT NOT NULL,
  closed_by      TEXT,
  closed_at      TIMESTAMPTZ,
  notes          TEXT,
  raw            JSONB DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_period_co
  ON document_archive_batches(period, company_code);

CREATE INDEX IF NOT EXISTS idx_archive_status
  ON document_archive_batches(status);

-- ────────────────────────────────────────────────
-- ② document_files（shipment_no 文本引用，无硬 FK）
-- 包含 file_url UNIQUE INDEX（Phase 1 去重策略）
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_files (
  id               SERIAL PRIMARY KEY,
  _id              TEXT UNIQUE NOT NULL,
  shipment_no      TEXT NOT NULL,
  contract_no      TEXT,
  doc_type         TEXT NOT NULL,
  file_name        TEXT NOT NULL DEFAULT '',
  file_url         TEXT NOT NULL,
  file_size        BIGINT,
  mime_type        TEXT,
  page_count       INT,
  upload_by        TEXT NOT NULL DEFAULT 'system',
  extract_status   TEXT DEFAULT 'pending',
  archive_batch_id TEXT,
  notes            TEXT,
  raw              JSONB DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- Phase 1 去重策略：基于 OSS URL 稳定性假设
-- 升级路径见 M3_phase1_plan_v2.md §九.2
CREATE UNIQUE INDEX IF NOT EXISTS idx_docfiles_url
  ON document_files(file_url);

CREATE INDEX IF NOT EXISTS idx_docfiles_shipment
  ON document_files(shipment_no);

CREATE INDEX IF NOT EXISTS idx_docfiles_type
  ON document_files(doc_type);

CREATE INDEX IF NOT EXISTS idx_docfiles_status
  ON document_files(extract_status);

CREATE INDEX IF NOT EXISTS idx_docfiles_archive
  ON document_files(archive_batch_id);

-- ────────────────────────────────────────────────
-- ③ document_extract_tasks（依赖 document_files._id）
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_extract_tasks (
  id              SERIAL PRIMARY KEY,
  _id             TEXT UNIQUE NOT NULL,
  file_id         TEXT NOT NULL,               -- → document_files._id
  shipment_no     TEXT NOT NULL,
  doc_type        TEXT NOT NULL,
  model           TEXT NOT NULL,               -- 'qwen_vl' | 'claude' | 'minimax' | 'manual'
  stage           TEXT NOT NULL,               -- 'extract' | 'refine' | 'validate'
  status          TEXT DEFAULT 'pending',      -- 'pending'|'queued'|'running'|'done'|'failed'|'abandoned'
  attempt_count   INT DEFAULT 0,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  error_msg       TEXT,
  result_count    INT DEFAULT 0,
  triggered_by    TEXT DEFAULT 'upload',       -- 'upload'|'batch_cron'|'manual'|'retry'
  parent_task_id  TEXT,                        -- refine/validate task 指向 extract task
  raw             JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dxtask_file_id
  ON document_extract_tasks(file_id);

CREATE INDEX IF NOT EXISTS idx_dxtask_status
  ON document_extract_tasks(status);

CREATE INDEX IF NOT EXISTS idx_dxtask_model
  ON document_extract_tasks(model);

CREATE INDEX IF NOT EXISTS idx_dxtask_shipment
  ON document_extract_tasks(shipment_no);

-- ────────────────────────────────────────────────
-- ④ document_field_results（依赖 extract_tasks + document_files）
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_field_results (
  id                      SERIAL PRIMARY KEY,
  _id                     TEXT UNIQUE NOT NULL,
  task_id                 TEXT NOT NULL,       -- → document_extract_tasks._id
  file_id                 TEXT NOT NULL,       -- → document_files._id
  shipment_no             TEXT NOT NULL,

  -- 字段内容
  field_name              TEXT NOT NULL,
  field_value             TEXT,
  field_value_normalized  TEXT,

  -- 质量评估
  confidence              NUMERIC(4,3),        -- 0.000–1.000
  format_valid            BOOLEAN,             -- Phase 1 置 NULL，Phase 2 填充
  business_valid          BOOLEAN,             -- Phase 1 置 NULL，Phase 2 填充

  -- 来源标识
  source_engine           TEXT NOT NULL,       -- 'qwen_vl'|'claude_review'|'minimax'|'manual'
  source_stage            TEXT NOT NULL,       -- 'extract'|'refine'|'validate'|'manual'

  -- 状态
  status                  TEXT DEFAULT 'pending',

  -- 人工采用记录
  is_accepted             BOOLEAN DEFAULT FALSE,
  accepted_by             TEXT,
  accepted_at             TIMESTAMPTZ,

  -- Merge 记录（Phase 2 填充）
  target_table            TEXT,
  target_column           TEXT,
  merged_at               TIMESTAMPTZ,
  merged_by               TEXT,

  raw                     JSONB DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dxresult_task_id
  ON document_field_results(task_id);

CREATE INDEX IF NOT EXISTS idx_dxresult_shipment
  ON document_field_results(shipment_no);

CREATE INDEX IF NOT EXISTS idx_dxresult_field_name
  ON document_field_results(field_name);

CREATE INDEX IF NOT EXISTS idx_dxresult_status
  ON document_field_results(status);

CREATE INDEX IF NOT EXISTS idx_dxresult_accepted
  ON document_field_results(is_accepted);

-- ────────────────────────────────────────────────
-- ⑤ document_missing_items（依赖 document_field_results，result_id 可空）
-- result_id 可空场景约束见 M3_phase1_plan_v2.md §九.3
-- ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_missing_items (
  id              SERIAL PRIMARY KEY,
  _id             TEXT UNIQUE NOT NULL,
  shipment_no     TEXT NOT NULL,
  contract_no     TEXT,

  -- 问题分类
  issue_type      TEXT NOT NULL,               -- 'missing'|'conflict'|'low_confidence'|'invalid_format'
  severity        TEXT NOT NULL DEFAULT 'warning', -- 'critical'|'warning'|'info'

  -- 问题详情
  field_name      TEXT,
  doc_type        TEXT,
  description     TEXT NOT NULL,
  expected_val    TEXT,
  actual_val      TEXT,
  -- result_id 可空：仅纯缺失项 / 业务规则扫描项 / 无对应 field_result 的问题项
  result_id       TEXT,                        -- → document_field_results._id（可空）

  -- 状态
  status          TEXT DEFAULT 'open',         -- 'open'|'reviewing'|'resolved'|'dismissed'
  auto_generated  BOOLEAN DEFAULT TRUE,
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,
  resolve_note    TEXT,

  raw             JSONB DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_missing_shipment
  ON document_missing_items(shipment_no);

CREATE INDEX IF NOT EXISTS idx_missing_status
  ON document_missing_items(status);

CREATE INDEX IF NOT EXISTS idx_missing_severity
  ON document_missing_items(severity);

CREATE INDEX IF NOT EXISTS idx_missing_type
  ON document_missing_items(issue_type);

-- ============================================================
-- Migration 完成
-- 验证：SELECT table_name FROM information_schema.tables
--        WHERE table_name LIKE 'document_%' ORDER BY table_name;
-- ============================================================
