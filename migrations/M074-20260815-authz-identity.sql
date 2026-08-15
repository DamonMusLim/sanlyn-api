-- M074 · 权限框架第一步: people 主身份 + 帽子/能力只读解析基础
-- 范围: 只建表、回填映射和默认能力；不接任何业务接口。

CREATE TABLE IF NOT EXISTS people (
  person_id BIGSERIAL PRIMARY KEY,
  display_name TEXT NOT NULL,
  person_type TEXT NOT NULL DEFAULT 'employee',
  status TEXT NOT NULL DEFAULT 'active',
  source_hr_employee_id INTEGER UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT people_person_type_chk CHECK (person_type IN ('employee','temp','contractor','system')),
  CONSTRAINT people_status_chk CHECK (status IN ('active','inactive','left'))
);

CREATE TABLE IF NOT EXISTS person_identities (
  identity_id BIGSERIAL PRIMARY KEY,
  person_id BIGINT NOT NULL REFERENCES people(person_id) ON DELETE RESTRICT,
  source_system TEXT NOT NULL,
  identity_type TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  display_label TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT person_identities_source_chk CHECK (source_system IN ('backend','hr','clerk','system')),
  CONSTRAINT person_identities_type_chk CHECK (identity_type IN ('username','user_id','employee_id','session_user','clerk_user','system'))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_person_identities_active_key
  ON person_identities(source_system, identity_type, lower(identity_key))
  WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_person_identities_person
  ON person_identities(person_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS hats (
  hat_code TEXT PRIMARY KEY,
  hat_name TEXT NOT NULL,
  description TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS person_hats (
  person_hat_id BIGSERIAL PRIMARY KEY,
  person_id BIGINT NOT NULL REFERENCES people(person_id) ON DELETE RESTRICT,
  hat_code TEXT NOT NULL REFERENCES hats(hat_code) ON DELETE RESTRICT,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ,
  assigned_by TEXT NOT NULL DEFAULT 'migration:M074',
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT person_hats_valid_window_chk CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_person_hats_active
  ON person_hats(person_id, hat_code)
  WHERE valid_until IS NULL;
CREATE INDEX IF NOT EXISTS idx_person_hats_lookup
  ON person_hats(person_id, valid_from, valid_until);

CREATE TABLE IF NOT EXISTS hat_capabilities (
  hat_capability_id BIGSERIAL PRIMARY KEY,
  hat_code TEXT NOT NULL REFERENCES hats(hat_code) ON DELETE CASCADE,
  capability TEXT NOT NULL,
  constraints JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(hat_code, capability)
);

CREATE TABLE IF NOT EXISTS authz_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value JSONB NOT NULL,
  note TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS authz_audit_log (
  audit_id BIGSERIAL PRIMARY KEY,
  action TEXT NOT NULL,
  person_id BIGINT REFERENCES people(person_id) ON DELETE SET NULL,
  source JSONB NOT NULL DEFAULT '{}'::jsonb,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO hats(hat_code, hat_name, description) VALUES
  ('ceo', 'CEO', '公司最终负责人；定价和钱相关最终决策归这里。'),
  ('store_manager', '店长', '门店日常管理；请假和额度内报销可审批。'),
  ('clerk', '店员', '提交和查看自己的日常事项，无审批/拍板能力。'),
  ('finance_reviewer', '财务复核', '复核报销票据和金额，不代表付款权限。'),
  ('system_admin', '系统管理员', '维护系统配置，不天然拥有业务审批权。'),
  ('temp_worker', '临时工', '最小权限：打卡和查看自己。')
ON CONFLICT (hat_code) DO UPDATE SET
  hat_name = EXCLUDED.hat_name,
  description = EXCLUDED.description,
  is_active = true;

INSERT INTO authz_settings(setting_key, setting_value, note) VALUES
  ('reimb.store_manager.final_approve_limit_cny', '{"amount":200,"currency":"CNY"}'::jsonb,
   '占位值：Damon 已确认店长额度内可终批，但具体金额待 Damon 确认。')
ON CONFLICT (setting_key) DO UPDATE SET
  setting_value = EXCLUDED.setting_value,
  note = EXCLUDED.note,
  updated_at = now();

INSERT INTO hat_capabilities(hat_code, capability, constraints) VALUES
  ('ceo', 'price.view_cost', '{}'::jsonb),
  ('ceo', 'price.decide', '{}'::jsonb),
  ('ceo', 'price.submit_request', '{}'::jsonb),
  ('ceo', 'reimb.approve', '{"scope":"final"}'::jsonb),
  ('ceo', 'reimb.review_docs', '{}'::jsonb),
  ('ceo', 'staff.assign_hat', '{}'::jsonb),
  ('ceo', 'report.view_money', '{}'::jsonb),
  ('ceo', 'audit.view_authz', '{}'::jsonb),
  ('store_manager', 'price.submit_request', '{}'::jsonb),
  ('store_manager', 'leave.approve', '{}'::jsonb),
  ('store_manager', 'leave.view_team', '{}'::jsonb),
  ('store_manager', 'reimb.approve', '{"scope":"final_within_limit","setting":"reimb.store_manager.final_approve_limit_cny","amount":200,"currency":"CNY"}'::jsonb),
  ('store_manager', 'staff.manage', '{"scope":"daily_profile"}'::jsonb),
  ('store_manager', 'task.assign', '{}'::jsonb),
  ('store_manager', 'report.view_ops', '{}'::jsonb),
  ('store_manager', 'approval.view_queue', '{"scope":"store"}'::jsonb),
  ('store_manager', 'approval.act', '{"scope":"store"}'::jsonb),
  ('clerk', 'price.submit_request', '{}'::jsonb),
  ('clerk', 'approval.withdraw_own', '{}'::jsonb),
  ('clerk', 'staff.view_self', '{}'::jsonb),
  ('clerk', 'time.clock', '{}'::jsonb),
  ('finance_reviewer', 'reimb.review_docs', '{}'::jsonb),
  ('finance_reviewer', 'approval.view_queue', '{"scope":"finance"}'::jsonb),
  ('system_admin', 'audit.view_authz', '{"scope":"technical"}'::jsonb),
  ('temp_worker', 'time.clock', '{}'::jsonb),
  ('temp_worker', 'staff.view_self', '{}'::jsonb)
ON CONFLICT (hat_code, capability) DO UPDATE SET
  constraints = EXCLUDED.constraints;

INSERT INTO people(display_name, person_type, status, source_hr_employee_id)
SELECT e.name,
       'employee',
       CASE WHEN e.employment_status = 'left' THEN 'left' ELSE 'active' END,
       e.id
  FROM hr_employees e
 WHERE e.employment_status = 'active' OR e.id IN (35, 39)
ON CONFLICT (source_hr_employee_id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status = EXCLUDED.status,
  updated_at = now();

INSERT INTO person_identities(person_id, source_system, identity_type, identity_key, display_label)
SELECT p.person_id, 'hr', 'employee_id', p.source_hr_employee_id::text, p.display_name
  FROM people p
 WHERE p.source_hr_employee_id IS NOT NULL
ON CONFLICT (source_system, identity_type, lower(identity_key)) WHERE is_active
DO UPDATE SET person_id = EXCLUDED.person_id, display_label = EXCLUDED.display_label;

INSERT INTO person_identities(person_id, source_system, identity_type, identity_key, display_label)
SELECT p.person_id, 'clerk', 'session_user', p.source_hr_employee_id::text, p.display_name
  FROM people p
 WHERE p.source_hr_employee_id IS NOT NULL
ON CONFLICT (source_system, identity_type, lower(identity_key)) WHERE is_active
DO UPDATE SET person_id = EXCLUDED.person_id, display_label = EXCLUDED.display_label;

INSERT INTO person_identities(person_id, source_system, identity_type, identity_key, display_label)
SELECT p.person_id, 'backend', 'username', lower(a.username), a.username
  FROM people p
  JOIN accounts a ON lower(a.username) = 'damon_sl'
 WHERE p.source_hr_employee_id = 35
ON CONFLICT (source_system, identity_type, lower(identity_key)) WHERE is_active
DO UPDATE SET person_id = EXCLUDED.person_id, display_label = EXCLUDED.display_label;

INSERT INTO person_identities(person_id, source_system, identity_type, identity_key, display_label)
SELECT p.person_id, 'backend', 'user_id', a.id::text, a.username
  FROM people p
  JOIN accounts a ON lower(a.username) = 'damon_sl'
 WHERE p.source_hr_employee_id = 35
ON CONFLICT (source_system, identity_type, lower(identity_key)) WHERE is_active
DO UPDATE SET person_id = EXCLUDED.person_id, display_label = EXCLUDED.display_label;

INSERT INTO person_identities(person_id, source_system, identity_type, identity_key, display_label)
SELECT p.person_id, 'backend', 'username', lower(a.username), a.username
  FROM people p
  JOIN accounts a ON lower(a.username) = 'test999' OR a.id::text = '39'
 WHERE p.source_hr_employee_id = 39
ON CONFLICT (source_system, identity_type, lower(identity_key)) WHERE is_active
DO UPDATE SET person_id = EXCLUDED.person_id, display_label = EXCLUDED.display_label;

INSERT INTO person_identities(person_id, source_system, identity_type, identity_key, display_label)
SELECT p.person_id, 'backend', 'user_id', a.id::text, a.username
  FROM people p
  JOIN accounts a ON lower(a.username) = 'test999' OR a.id::text = '39'
 WHERE p.source_hr_employee_id = 39
ON CONFLICT (source_system, identity_type, lower(identity_key)) WHERE is_active
DO UPDATE SET person_id = EXCLUDED.person_id, display_label = EXCLUDED.display_label;

INSERT INTO person_hats(person_id, hat_code, assigned_by, note)
SELECT p.person_id, 'clerk', 'migration:M074', 'active clerk/default staff hat'
  FROM people p
  JOIN hr_employees e ON e.id = p.source_hr_employee_id
 WHERE (e.role = 'clerk' OR p.source_hr_employee_id = 39)
   AND p.source_hr_employee_id <> 35
ON CONFLICT (person_id, hat_code) WHERE valid_until IS NULL DO NOTHING;

INSERT INTO person_hats(person_id, hat_code, assigned_by, note)
SELECT p.person_id, 'store_manager', 'migration:M074', 'manager role backfill'
  FROM people p
  JOIN hr_employees e ON e.id = p.source_hr_employee_id
 WHERE (e.role = 'manager' OR p.source_hr_employee_id = 35)
   AND p.source_hr_employee_id <> 39
ON CONFLICT (person_id, hat_code) WHERE valid_until IS NULL DO NOTHING;

INSERT INTO person_hats(person_id, hat_code, assigned_by, note)
SELECT p.person_id, 'ceo', 'migration:M074', 'Damon explicit decision: hr_employees.id=35 has CEO hat'
  FROM people p
 WHERE p.source_hr_employee_id = 35
ON CONFLICT (person_id, hat_code) WHERE valid_until IS NULL DO NOTHING;

COMMENT ON TABLE people IS '统一主身份。hr_employees 只是来源之一；临时工/保洁可登记为 temp/contractor 且不必发登录凭据。';
COMMENT ON TABLE person_identities IS '三套身份到 person_id 的映射：后台账号、hr_employees、clerk/session。解析不到不得伪造身份。';
COMMENT ON TABLE person_hats IS '人戴帽子的时间窗。转移店长帽子时先关闭旧记录 valid_until，再给新人 INSERT 新记录，不改代码。';
COMMENT ON TABLE hat_capabilities IS '帽子到能力的默认授权；constraints 保存额度/范围等可审计条件。';
