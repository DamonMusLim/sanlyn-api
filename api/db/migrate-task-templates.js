import { getPool, setCors } from "../db.js";

const DDL = `
CREATE TABLE IF NOT EXISTS task_templates (
  id BIGSERIAL PRIMARY KEY,
  key VARCHAR(100) NOT NULL UNIQUE,
  source VARCHAR(100) NOT NULL,
  title_template TEXT NOT NULL,
  priority VARCHAR(2) NOT NULL,
  owner_role VARCHAR(64) NOT NULL,
  dedupe_pattern TEXT NOT NULL,
  resolution_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  recommended_action TEXT,
  notify_cc JSONB NOT NULL DEFAULT '[]'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT task_templates_priority_check CHECK (priority IN ('P0','P1','P2','P3')),
  CONSTRAINT task_templates_notify_cc_array_check CHECK (jsonb_typeof(notify_cc) = 'array')
);

CREATE INDEX IF NOT EXISTS idx_task_templates_source_active
  ON task_templates(source, active);
CREATE INDEX IF NOT EXISTS idx_task_templates_owner_role_active
  ON task_templates(owner_role, active);

CREATE TABLE IF NOT EXISTS role_routing (
  id BIGSERIAL PRIMARY KEY,
  logical_role VARCHAR(64) NOT NULL,
  match_type VARCHAR(40) NOT NULL,
  match_value VARCHAR(160) NOT NULL,
  priority INT NOT NULL DEFAULT 100,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT role_routing_match_type_check
    CHECK (match_type IN ('employees.title_key','accounts.role','accounts.username')),
  CONSTRAINT role_routing_unique_match UNIQUE (logical_role, match_type, match_value)
);

CREATE INDEX IF NOT EXISTS idx_role_routing_role_active
  ON role_routing(logical_role, active, priority);

CREATE OR REPLACE FUNCTION trg_task_templates_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS task_templates_touch_updated_at ON task_templates;
CREATE TRIGGER task_templates_touch_updated_at
  BEFORE UPDATE ON task_templates
  FOR EACH ROW EXECUTE FUNCTION trg_task_templates_touch_updated_at();

DROP TRIGGER IF EXISTS role_routing_touch_updated_at ON role_routing;
CREATE TRIGGER role_routing_touch_updated_at
  BEFORE UPDATE ON role_routing
  FOR EACH ROW EXECUTE FUNCTION trg_task_templates_touch_updated_at();
`;

const SEED_SQL = `
INSERT INTO role_routing (logical_role, match_type, match_value, priority, active, raw)
VALUES
  ('documentation', 'employees.title_key', 'app.people.title.documentationLead', 10, TRUE,
   '{"note":"planned logical title; no current canonical documentation role"}'::jsonb),
  ('documentation', 'employees.title_key', 'app.people.title.tradeDocs', 20, TRUE,
   '{"note":"secondary docs owner title if present"}'::jsonb),
  ('finance', 'employees.title_key', 'app.people.title.financeLead', 10, TRUE,
   '{"note":"known title_key pattern from employee model"}'::jsonb),
  ('customs', 'employees.title_key', 'app.people.title.customsLead', 10, TRUE,
   '{"note":"planned customs owner title"}'::jsonb),
  ('customs', 'employees.title_key', 'app.people.title.customsSpecialist', 20, TRUE,
   '{"note":"secondary customs title if present"}'::jsonb),
  ('logistics', 'accounts.role', 'logistics', 10, TRUE,
   '{"note":"existing accounts.role value"}'::jsonb)
ON CONFLICT (logical_role, match_type, match_value) DO UPDATE SET
  priority = EXCLUDED.priority,
  active = EXCLUDED.active,
  raw = role_routing.raw || EXCLUDED.raw;

INSERT INTO task_templates (
  key, source, title_template, priority, owner_role, dedupe_pattern,
  resolution_policy, recommended_action, notify_cc, active, raw
) VALUES
  (
    'ocean_docs_missing',
    'business_gap_health',
    '海运明天截关缺单据：{order_no}',
    'P0',
    'documentation',
    'ocean_docs_missing:{order_no}:{doc_kind}',
    '{
      "requires_evidence": true,
      "auto_recheck": true,
      "done_when": ["required_docs_uploaded", "doc_links_verified"],
      "close_policy": "evidence_required"
    }'::jsonb,
    '补齐缺失单据并上传凭证；若已出货且有BL，先查上游同步链路，不要直接建噪音任务。',
    '["damon"]'::jsonb,
    TRUE,
    '{"domain":"ocean","owner_object_type":"order","level":"doc"}'::jsonb
  ),
  (
    'finance_rebate_zero',
    'business_gap_health',
    '已出货退税额为0：{order_no}',
    'P0',
    'finance',
    'finance_rebate_zero:{order_no}',
    '{
      "requires_evidence": true,
      "auto_recheck": true,
      "done_when": ["declaration_amount_copied_from_pdf", "rebate_amount_recomputed"],
      "close_policy": "declaration_value_must_be_recorded"
    }'::jsonb,
    '读取报关单PDF照抄申报货值，再复算退税；不能用 shipped+BL 关闭申报货值=0 问题。',
    '["damon"]'::jsonb,
    TRUE,
    '{"domain":"finance","owner_object_type":"order","level":"order"}'::jsonb
  ),
  (
    'customs_declare_missing',
    'business_gap_health',
    '报关资料缺：{order_no}',
    'P1',
    'customs',
    'customs_declare_missing:{order_no}:{missing_kind}',
    '{
      "requires_evidence": true,
      "auto_recheck": true,
      "done_when": ["customs_docs_present", "customs_link_verified"],
      "close_policy": "check_root_cause_first"
    }'::jsonb,
    '先查 customs_data、报关单PDF、shipped+BL 和上游同步；确认真缺后补资料链路。',
    '["damon"]'::jsonb,
    TRUE,
    '{"domain":"customs","owner_object_type":"order","level":"doc"}'::jsonb
  )
ON CONFLICT (key) DO UPDATE SET
  source = EXCLUDED.source,
  title_template = EXCLUDED.title_template,
  priority = EXCLUDED.priority,
  owner_role = EXCLUDED.owner_role,
  dedupe_pattern = EXCLUDED.dedupe_pattern,
  resolution_policy = EXCLUDED.resolution_policy,
  recommended_action = EXCLUDED.recommended_action,
  notify_cc = EXCLUDED.notify_cc,
  active = EXCLUDED.active,
  raw = task_templates.raw || EXCLUDED.raw;
`;

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "POST only" });
  }

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(DDL);
    await client.query(SEED_SQL);
    const summary = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM task_templates) AS templates,
        (SELECT COUNT(*)::int FROM task_templates WHERE active) AS active_templates,
        (SELECT COUNT(*)::int FROM role_routing) AS routes,
        (SELECT COUNT(*)::int FROM role_routing WHERE active) AS active_routes
    `);
    await client.query("COMMIT");
    return res.status(200).json({
      success: true,
      message: "task_templates + role_routing ready",
      summary: summary.rows[0],
      seeded_templates: ["ocean_docs_missing", "finance_rebate_zero", "customs_declare_missing"],
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(function() {});
    console.error("[migrate-task-templates]", err);
    return res.status(500).json({ success: false, error: String(err.message || err) });
  } finally {
    client.release();
  }
}
