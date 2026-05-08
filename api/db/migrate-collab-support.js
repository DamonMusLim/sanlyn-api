import { getPool, setCors } from "../db.js";

// migrate-collab-support.js
// ── Air-A · Collab Sheet Backend V2 ─────────────────────────────────────
// Creates 11 tables:
//   Support tables (5):
//     1. drivers
//     2. driver_assignments      (Magic Link tokens — hash-only)
//     3. driver_reviews          (private per rater_company_id)
//     4. collab_sheet_outputs    (DAS file回流)
//     5. collab_sheet_templates  (Config Center seeds 9 sheet_types)
//   Sheet tables (6 — each sheet_type gets its own table; pattern follows
//                    Claude-D's loading_collab_sheets):
//     6.  customs_draft_sheets
//     7.  inspection_request_sheets
//     8.  cert_application_sheets
//     9.  trucking_pickup_sheets
//     10. trucking_evidence_sheets   (FK → driver_assignments via magic_link_assignment_id)
//     11. doc_revision_sheets
//
// Forbidden-to-external fields are intentionally NOT in any of these tables —
// schema-level isolation, not UI guard.

var STATEMENTS = [

  // ── 1. drivers ─────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS drivers (
    id                BIGSERIAL PRIMARY KEY,
    phone             VARCHAR(20) UNIQUE NOT NULL,
    name              TEXT,
    truck_plate       TEXT,
    trucking_company_id UUID,
    id_card_last4     VARCHAR(4),
    active            BOOLEAN DEFAULT TRUE,
    rating_avg        NUMERIC(3,2),
    rating_count      INT DEFAULT 0,
    credit_score      INT DEFAULT 80,
    blacklist         BOOLEAN DEFAULT FALSE,
    blacklist_reason  TEXT,
    accepts_side_cargo BOOLEAN DEFAULT FALSE,
    side_cargo_rate   JSONB,
    created_at        TIMESTAMPTZ DEFAULT NOW(),
    updated_at        TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_drivers_company ON drivers(trucking_company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_drivers_active  ON drivers(active, blacklist)`,

  // ── 2. driver_assignments (Magic Link, hash-only) ──────────────────────
  `CREATE TABLE IF NOT EXISTS driver_assignments (
    id                  BIGSERIAL PRIMARY KEY,
    driver_id           BIGINT REFERENCES drivers(id) ON DELETE SET NULL,
    collab_sheet_id     BIGINT,
    collab_sheet_table  VARCHAR(64),
    order_id            INT,
    task_type           TEXT,
    magic_token_hash    TEXT UNIQUE NOT NULL,
    issued_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at          TIMESTAMPTZ NOT NULL,
    revoked_at          TIMESTAMPTZ,
    used_at             TIMESTAMPTZ,
    status              TEXT DEFAULT 'assigned',
    uploaded_files      JSONB DEFAULT '[]'::jsonb,
    created_by          TEXT,
    created_at          TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_driver_assignments_token  ON driver_assignments(magic_token_hash)`,
  `CREATE INDEX IF NOT EXISTS idx_driver_assignments_driver ON driver_assignments(driver_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_driver_assignments_order  ON driver_assignments(order_id)`,

  // ── 3. driver_reviews (private per rater_company_id) ───────────────────
  `CREATE TABLE IF NOT EXISTS driver_reviews (
    id                BIGSERIAL PRIMARY KEY,
    driver_id         BIGINT REFERENCES drivers(id) ON DELETE CASCADE,
    rater_role        TEXT,
    rater_company_id  UUID,
    order_id          INT,
    rating            SMALLINT CHECK (rating BETWEEN 1 AND 5),
    comment           TEXT,
    flags             TEXT[],
    created_at        TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_driver_reviews_driver ON driver_reviews(driver_id, rater_company_id)`,

  // ── 4. collab_sheet_outputs ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS collab_sheet_outputs (
    id                  BIGSERIAL PRIMARY KEY,
    source_sheet_table  VARCHAR(64) NOT NULL,
    source_sheet_id     BIGINT NOT NULL,
    document_id         INT NOT NULL,
    output_type         VARCHAR(32) NOT NULL,
    is_primary          BOOLEAN DEFAULT FALSE,
    visibility_scope    VARCHAR(32) DEFAULT 'internal_only'
      CHECK (visibility_scope IN ('customer_visible','internal_only','factory_visible',
                                  'trucking_visible','customs_visible','driver_visible')),
    created_at          TIMESTAMPTZ DEFAULT NOW()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uniq_collab_sheet_outputs_primary
     ON collab_sheet_outputs(source_sheet_table, source_sheet_id) WHERE is_primary = TRUE`,
  `CREATE INDEX IF NOT EXISTS idx_collab_outputs_doc        ON collab_sheet_outputs(document_id)`,
  `CREATE INDEX IF NOT EXISTS idx_collab_outputs_visibility ON collab_sheet_outputs(visibility_scope)`,

  // ── 5. collab_sheet_templates (Config Center) ──────────────────────────
  `CREATE TABLE IF NOT EXISTS collab_sheet_templates (
    id                         BIGSERIAL PRIMARY KEY,
    sheet_type                 VARCHAR(64) UNIQUE NOT NULL,
    template_version           INT NOT NULL DEFAULT 1,
    title                      TEXT NOT NULL,
    description                TEXT,
    fields_schema              JSONB NOT NULL,
    note_channels              TEXT[] NOT NULL,
    status_flow                TEXT[] NOT NULL,
    output_types               TEXT[],
    allowed_owner_roles        TEXT[] NOT NULL,
    allowed_participant_roles  TEXT[] NOT NULL,
    magic_link_allowed         BOOLEAN DEFAULT FALSE,
    delegate_allowed           BOOLEAN DEFAULT TRUE,
    created_at                 TIMESTAMPTZ DEFAULT NOW(),
    updated_at                 TIMESTAMPTZ DEFAULT NOW()
  )`,

  // ── 6-11. Sheet tables (one per sheet_type) ────────────────────────────
  // Pattern: same envelope as loading_collab_sheets, just different fillable fields.
  // Common columns (all tables have):
  //   id / order_id / order_no / contract_no / owner_company_code / assignee_user / assignee_name
  //   due_at / status (CHECK enum) / fields_json (sheet-specific fillable JSONB)
  //   participant_note / customer_visible_note / factory_visible_note
  //   forwarder_visible_note / customs_visible_note / driver_visible_note
  //   internal_note (admin-only) / audit_note (admin-only)
  //   reviewed_by / reviewed_at / revision_reason
  //   submitted_at / approved_at / completed_at / created_at / updated_at

  // 6. customs_draft_sheets (owner=customs_broker)
  `CREATE TABLE IF NOT EXISTS customs_draft_sheets (
    id                      BIGSERIAL PRIMARY KEY,
    order_id                INT REFERENCES orders(id) ON DELETE CASCADE,
    order_no                TEXT,
    contract_no             TEXT,
    owner_company_code      VARCHAR(64) NOT NULL,
    assignee_user           TEXT,
    assignee_name           TEXT,
    due_at                  DATE,
    status                  VARCHAR(24) NOT NULL DEFAULT 'assigned',
    declaration             JSONB NOT NULL DEFAULT '{}'::jsonb,
    factory_address         TEXT,
    pol                     VARCHAR(8),
    participant_note        TEXT,
    customer_visible_note   TEXT,
    factory_visible_note    TEXT,
    forwarder_visible_note  TEXT,
    customs_visible_note    TEXT,
    driver_visible_note     TEXT,
    internal_note           TEXT,
    audit_note              TEXT,
    reviewed_by             TEXT,
    reviewed_at             TIMESTAMPTZ,
    revision_reason         TEXT,
    submitted_at            TIMESTAMPTZ,
    approved_at             TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT customs_draft_status_chk CHECK (status IN
      ('draft','assigned','in_progress','submitted','under_review','needs_revision',
       'approved','completed','cancelled','expired'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_customs_draft_company_status ON customs_draft_sheets(owner_company_code, status)`,
  `CREATE INDEX IF NOT EXISTS idx_customs_draft_order          ON customs_draft_sheets(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_customs_draft_status_created ON customs_draft_sheets(status, created_at DESC)`,

  // 7. inspection_request_sheets (owner=factory; produces multiple cert outputs)
  `CREATE TABLE IF NOT EXISTS inspection_request_sheets (
    id                      BIGSERIAL PRIMARY KEY,
    order_id                INT REFERENCES orders(id) ON DELETE CASCADE,
    order_no                TEXT,
    contract_no             TEXT,
    owner_company_code      VARCHAR(64) NOT NULL,
    assignee_user           TEXT,
    assignee_name           TEXT,
    due_at                  DATE,
    status                  VARCHAR(24) NOT NULL DEFAULT 'assigned',
    inspection              JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_certs         TEXT[] DEFAULT '{}'::text[],
    participant_note        TEXT,
    customer_visible_note   TEXT,
    factory_visible_note    TEXT,
    forwarder_visible_note  TEXT,
    customs_visible_note    TEXT,
    driver_visible_note     TEXT,
    internal_note           TEXT,
    audit_note              TEXT,
    reviewed_by             TEXT,
    reviewed_at             TIMESTAMPTZ,
    revision_reason         TEXT,
    submitted_at            TIMESTAMPTZ,
    approved_at             TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT inspection_request_status_chk CHECK (status IN
      ('draft','assigned','in_progress','submitted','under_review','needs_revision',
       'approved','completed','cancelled','expired'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_inspection_req_company_status ON inspection_request_sheets(owner_company_code, status)`,
  `CREATE INDEX IF NOT EXISTS idx_inspection_req_order          ON inspection_request_sheets(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_inspection_req_status_created ON inspection_request_sheets(status, created_at DESC)`,

  // 8. cert_application_sheets (owner=factory)
  `CREATE TABLE IF NOT EXISTS cert_application_sheets (
    id                      BIGSERIAL PRIMARY KEY,
    order_id                INT REFERENCES orders(id) ON DELETE CASCADE,
    order_no                TEXT,
    contract_no             TEXT,
    owner_company_code      VARCHAR(64) NOT NULL,
    assignee_user           TEXT,
    assignee_name           TEXT,
    due_at                  DATE,
    status                  VARCHAR(24) NOT NULL DEFAULT 'assigned',
    cert_country            VARCHAR(2),
    cert_type               VARCHAR(32),
    application_data        JSONB NOT NULL DEFAULT '{}'::jsonb,
    participant_note        TEXT,
    customer_visible_note   TEXT,
    factory_visible_note    TEXT,
    forwarder_visible_note  TEXT,
    customs_visible_note    TEXT,
    driver_visible_note     TEXT,
    internal_note           TEXT,
    audit_note              TEXT,
    reviewed_by             TEXT,
    reviewed_at             TIMESTAMPTZ,
    revision_reason         TEXT,
    submitted_at            TIMESTAMPTZ,
    approved_at             TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT cert_app_status_chk CHECK (status IN
      ('draft','assigned','in_progress','submitted','under_review','needs_revision',
       'approved','completed','cancelled','expired'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_cert_app_company_status ON cert_application_sheets(owner_company_code, status)`,
  `CREATE INDEX IF NOT EXISTS idx_cert_app_order          ON cert_application_sheets(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_cert_app_status_created ON cert_application_sheets(status, created_at DESC)`,

  // 9. trucking_pickup_sheets (owner=trucking/forwarder)
  `CREATE TABLE IF NOT EXISTS trucking_pickup_sheets (
    id                      BIGSERIAL PRIMARY KEY,
    order_id                INT REFERENCES orders(id) ON DELETE CASCADE,
    order_no                TEXT,
    contract_no             TEXT,
    owner_company_code      VARCHAR(64) NOT NULL,
    assignee_user           TEXT,
    assignee_name           TEXT,
    due_at                  DATE,
    status                  VARCHAR(24) NOT NULL DEFAULT 'assigned',
    pickup                  JSONB NOT NULL DEFAULT '{}'::jsonb,
    participant_note        TEXT,
    customer_visible_note   TEXT,
    factory_visible_note    TEXT,
    forwarder_visible_note  TEXT,
    customs_visible_note    TEXT,
    driver_visible_note     TEXT,
    internal_note           TEXT,
    audit_note              TEXT,
    reviewed_by             TEXT,
    reviewed_at             TIMESTAMPTZ,
    revision_reason         TEXT,
    submitted_at            TIMESTAMPTZ,
    approved_at             TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT trucking_pickup_status_chk CHECK (status IN
      ('draft','assigned','in_progress','submitted','under_review','needs_revision',
       'approved','completed','cancelled','expired'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trucking_pickup_company_status ON trucking_pickup_sheets(owner_company_code, status)`,
  `CREATE INDEX IF NOT EXISTS idx_trucking_pickup_order          ON trucking_pickup_sheets(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trucking_pickup_status_created ON trucking_pickup_sheets(status, created_at DESC)`,

  // 10. trucking_evidence_sheets (owner=trucking; driver fills via Magic Link)
  `CREATE TABLE IF NOT EXISTS trucking_evidence_sheets (
    id                          BIGSERIAL PRIMARY KEY,
    order_id                    INT REFERENCES orders(id) ON DELETE CASCADE,
    order_no                    TEXT,
    contract_no                 TEXT,
    owner_company_code          VARCHAR(64) NOT NULL,
    assignee_user               TEXT,
    assignee_name               TEXT,
    due_at                      DATE,
    status                      VARCHAR(24) NOT NULL DEFAULT 'assigned',
    evidence                    JSONB NOT NULL DEFAULT '{}'::jsonb,
    container_no                VARCHAR(32),
    seal_no                     VARCHAR(32),
    gate_location               TEXT,
    magic_link_assignment_id    BIGINT REFERENCES driver_assignments(id) ON DELETE SET NULL,
    participant_note            TEXT,
    customer_visible_note       TEXT,
    factory_visible_note        TEXT,
    forwarder_visible_note      TEXT,
    customs_visible_note        TEXT,
    driver_visible_note         TEXT,
    internal_note               TEXT,
    audit_note                  TEXT,
    reviewed_by                 TEXT,
    reviewed_at                 TIMESTAMPTZ,
    revision_reason             TEXT,
    submitted_at                TIMESTAMPTZ,
    approved_at                 TIMESTAMPTZ,
    completed_at                TIMESTAMPTZ,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT trucking_evidence_status_chk CHECK (status IN
      ('draft','assigned','in_progress','submitted','under_review','needs_revision',
       'approved','completed','cancelled','expired'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_trucking_evidence_company_status ON trucking_evidence_sheets(owner_company_code, status)`,
  `CREATE INDEX IF NOT EXISTS idx_trucking_evidence_order          ON trucking_evidence_sheets(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_trucking_evidence_status_created ON trucking_evidence_sheets(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_trucking_evidence_assignment     ON trucking_evidence_sheets(magic_link_assignment_id)`,

  // 11. doc_revision_sheets
  `CREATE TABLE IF NOT EXISTS doc_revision_sheets (
    id                      BIGSERIAL PRIMARY KEY,
    order_id                INT REFERENCES orders(id) ON DELETE CASCADE,
    order_no                TEXT,
    contract_no             TEXT,
    owner_company_code      VARCHAR(64) NOT NULL,
    assignee_user           TEXT,
    assignee_name           TEXT,
    due_at                  DATE,
    status                  VARCHAR(24) NOT NULL DEFAULT 'assigned',
    source_document_id      INT NOT NULL,
    revision_request_reason TEXT NOT NULL,
    target_document_id      INT,
    revision_data           JSONB NOT NULL DEFAULT '{}'::jsonb,
    participant_note        TEXT,
    customer_visible_note   TEXT,
    factory_visible_note    TEXT,
    forwarder_visible_note  TEXT,
    customs_visible_note    TEXT,
    driver_visible_note     TEXT,
    internal_note           TEXT,
    audit_note              TEXT,
    reviewed_by             TEXT,
    reviewed_at             TIMESTAMPTZ,
    revision_reason         TEXT,
    submitted_at            TIMESTAMPTZ,
    approved_at             TIMESTAMPTZ,
    completed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT doc_revision_status_chk CHECK (status IN
      ('draft','assigned','in_progress','submitted','under_review','needs_revision',
       'approved','completed','cancelled','expired'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_doc_revision_company_status ON doc_revision_sheets(owner_company_code, status)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_revision_order          ON doc_revision_sheets(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_revision_status_created ON doc_revision_sheets(status, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_doc_revision_source_doc     ON doc_revision_sheets(source_document_id)`,

  // updated_at trigger function (shared)
  `CREATE OR REPLACE FUNCTION trg_touch_updated_at_collab() RETURNS TRIGGER AS $func$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $func$ LANGUAGE plpgsql`,

  // attach trigger to all 6 sheet tables (idempotent via DROP TRIGGER IF EXISTS)
  `DROP TRIGGER IF EXISTS customs_draft_sheets_touch         ON customs_draft_sheets`,
  `CREATE TRIGGER customs_draft_sheets_touch       BEFORE UPDATE ON customs_draft_sheets       FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at_collab()`,
  `DROP TRIGGER IF EXISTS inspection_request_sheets_touch    ON inspection_request_sheets`,
  `CREATE TRIGGER inspection_request_sheets_touch  BEFORE UPDATE ON inspection_request_sheets  FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at_collab()`,
  `DROP TRIGGER IF EXISTS cert_application_sheets_touch      ON cert_application_sheets`,
  `CREATE TRIGGER cert_application_sheets_touch    BEFORE UPDATE ON cert_application_sheets    FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at_collab()`,
  `DROP TRIGGER IF EXISTS trucking_pickup_sheets_touch       ON trucking_pickup_sheets`,
  `CREATE TRIGGER trucking_pickup_sheets_touch     BEFORE UPDATE ON trucking_pickup_sheets     FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at_collab()`,
  `DROP TRIGGER IF EXISTS trucking_evidence_sheets_touch     ON trucking_evidence_sheets`,
  `CREATE TRIGGER trucking_evidence_sheets_touch   BEFORE UPDATE ON trucking_evidence_sheets   FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at_collab()`,
  `DROP TRIGGER IF EXISTS doc_revision_sheets_touch          ON doc_revision_sheets`,
  `CREATE TRIGGER doc_revision_sheets_touch        BEFORE UPDATE ON doc_revision_sheets        FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at_collab()`,

  // also drivers table touch trigger
  `DROP TRIGGER IF EXISTS drivers_touch ON drivers`,
  `CREATE TRIGGER drivers_touch BEFORE UPDATE ON drivers FOR EACH ROW EXECUTE FUNCTION trg_touch_updated_at_collab()`,

  // Seed 9 sheet_type rows into collab_sheet_templates (idempotent via ON CONFLICT)
  `INSERT INTO collab_sheet_templates
    (sheet_type, title, description, fields_schema, note_channels, status_flow,
     output_types, allowed_owner_roles, allowed_participant_roles,
     magic_link_allowed, delegate_allowed)
   VALUES
    ('factory_loading_confirmation', '工厂装柜确认表',
     '工厂填写装柜实绩 + 装柜照片',
     '{"sections":["product_quantity","loading_pickup","container_info","photos","notes"]}'::jsonb,
     ARRAY['participant_note','factory_visible_note','internal_note','audit_note'],
     ARRAY['draft','assigned','in_progress','submitted','under_review','needs_revision','approved','completed'],
     ARRAY['loading_record'],
     ARRAY['factory'], ARRAY['factory','internal'],
     FALSE, TRUE),
    ('qc_checklist', 'QC 自检清单',
     '工厂自检 / Sanlyn 复检',
     '{"sections":["batch","qc_items","photos"]}'::jsonb,
     ARRAY['participant_note','factory_visible_note','internal_note'],
     ARRAY['draft','assigned','in_progress','submitted','under_review','needs_revision','approved','completed'],
     ARRAY['lab_report'],
     ARRAY['factory'], ARRAY['factory','internal'],
     FALSE, TRUE),
    ('customer_missing_info', '客户补充信息表',
     '客户补 SI / 唛头 / 收货地址',
     '{"sections":["si","marks","consignee"]}'::jsonb,
     ARRAY['participant_note','customer_visible_note','internal_note'],
     ARRAY['draft','assigned','in_progress','submitted','under_review','needs_revision','approved','completed'],
     ARRAY[]::text[],
     ARRAY['customer'], ARRAY['customer','internal'],
     FALSE, TRUE),
    ('customs_draft', '报关底稿',
     '报关行起草 / 工厂确认申报要素',
     '{"sections":["declaration","factory_address","pol"]}'::jsonb,
     ARRAY['participant_note','factory_visible_note','customs_visible_note','internal_note','audit_note'],
     ARRAY['draft','assigned','in_progress','submitted','under_review','needs_revision','approved','completed'],
     ARRAY['CD'],
     ARRAY['customs_broker'], ARRAY['factory','customs_broker','internal'],
     FALSE, TRUE),
    ('inspection_request', '出口商检申请',
     '工厂申请商检 (HC/VET/PHYTO 等)',
     '{"sections":["batch","inspection","requested_certs"]}'::jsonb,
     ARRAY['participant_note','factory_visible_note','customs_visible_note','internal_note'],
     ARRAY['draft','assigned','in_progress','submitted','under_review','needs_revision','approved','completed'],
     ARRAY['HC','VET','PHYTO'],
     ARRAY['factory'], ARRAY['factory','customs_broker','internal'],
     FALSE, TRUE),
    ('certificate_application', '产地证申请',
     'CO / FORM E 等产地证申请',
     '{"sections":["country","cert_type","application_data"]}'::jsonb,
     ARRAY['participant_note','factory_visible_note','internal_note'],
     ARRAY['draft','assigned','in_progress','submitted','under_review','needs_revision','approved','completed'],
     ARRAY['CO','FORM_E','FORM_F','FORM_X'],
     ARRAY['factory'], ARRAY['factory','customs_broker','internal'],
     FALSE, TRUE),
    ('trucking_pickup_confirmation', '拖车提柜预约表',
     '拖车 / 货代预约提柜窗口',
     '{"sections":["pickup_window","gate_location"]}'::jsonb,
     ARRAY['participant_note','forwarder_visible_note','factory_visible_note','internal_note'],
     ARRAY['draft','assigned','in_progress','submitted','under_review','needs_revision','approved','completed'],
     ARRAY[]::text[],
     ARRAY['trucking','forwarder'], ARRAY['trucking','forwarder','factory','internal'],
     FALSE, TRUE),
    ('trucking_loading_evidence', '装柜证据表 (司机)',
     '司机扫码上传铅封照 / VGM / Gate-in 时间',
     '{"sections":["seal","gate","vgm","photos"]}'::jsonb,
     ARRAY['participant_note','driver_visible_note','forwarder_visible_note','internal_note'],
     ARRAY['draft','assigned','in_progress','submitted','under_review','needs_revision','approved','completed'],
     ARRAY['loading_record'],
     ARRAY['trucking'], ARRAY['driver','trucking','forwarder','internal'],
     TRUE, FALSE),
    ('document_revision_request', '文件修订请求',
     '客户/内部要求修订已生成的文件',
     '{"sections":["source_doc","reason","revision_data"]}'::jsonb,
     ARRAY['participant_note','customer_visible_note','factory_visible_note','internal_note','audit_note'],
     ARRAY['draft','assigned','in_progress','submitted','under_review','needs_revision','approved','completed'],
     ARRAY[]::text[],
     ARRAY['internal','customer'], ARRAY['internal','customer','factory'],
     FALSE, TRUE)
   ON CONFLICT (sheet_type) DO NOTHING`,
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    const pool = getPool();
    const results = [];
    for (const sql of STATEMENTS) {
      try {
        await pool.query(sql);
        results.push({ ok: true, sql: sql.slice(0, 80).replace(/\s+/g, " ") + "..." });
      } catch (e) {
        results.push({ ok: false, sql: sql.slice(0, 80).replace(/\s+/g, " ") + "...", err: e.message });
      }
    }
    return res.status(200).json({ success: true, count: results.length, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
