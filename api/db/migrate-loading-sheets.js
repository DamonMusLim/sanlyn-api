import { getPool, setCors } from "../db.js";

// Phase 1: loading_collab_sheets — Factory Loading Collab Sheet MVP
// Audit:  docs/prototypes/collab-sheets/factory-loading-field-matrix.csv (74 fields)
// Decision: schema-level isolation — forbidden-to-factory fields NOT stored here.

var STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS loading_collab_sheets (
    id              SERIAL PRIMARY KEY,
    order_id        INT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    order_no        TEXT,
    contract_no     TEXT,
    factory_code    VARCHAR(32) NOT NULL,
    assignee_user   TEXT,
    assignee_name   TEXT,
    due_at          DATE,
    status          VARCHAR(24) NOT NULL DEFAULT 'assigned',
    products        JSONB NOT NULL DEFAULT '[]'::jsonb,
    loading         JSONB NOT NULL DEFAULT '{}'::jsonb,
    photos          JSONB NOT NULL DEFAULT '[]'::jsonb,
    factory_visible_note  TEXT,
    participant_note      TEXT,
    internal_note         TEXT,
    reviewed_by     TEXT,
    reviewed_at     TIMESTAMPTZ,
    revision_reason TEXT,
    submitted_at    TIMESTAMPTZ,
    approved_at     TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT loading_sheets_status_chk CHECK (status IN
      ('assigned','in_progress','submitted','under_review','needs_revision','approved','completed'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_loading_sheets_factory_status ON loading_collab_sheets (factory_code, status)`,
  `CREATE INDEX IF NOT EXISTS idx_loading_sheets_order ON loading_collab_sheets (order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_loading_sheets_status_created ON loading_collab_sheets (status, created_at DESC)`,
  `CREATE OR REPLACE FUNCTION trg_set_updated_at_loading_sheets() RETURNS TRIGGER AS $func$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $func$ LANGUAGE plpgsql`,
  `DROP TRIGGER IF EXISTS loading_sheets_updated_at ON loading_collab_sheets`,
  `CREATE TRIGGER loading_sheets_updated_at BEFORE UPDATE ON loading_collab_sheets
     FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at_loading_sheets()`,
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  try {
    var pool = getPool();
    var results = [];
    for (var sql of STATEMENTS) {
      try {
        await pool.query(sql);
        results.push({ ok: true, sql: sql.slice(0, 80) + "..." });
      } catch (e) {
        results.push({ ok: false, sql: sql.slice(0, 80) + "...", err: e.message });
      }
    }
    return res.status(200).json({ success: true, results });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
