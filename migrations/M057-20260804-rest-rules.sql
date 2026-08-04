-- M057 · 固定休息日「规则」+ 调休申请审批
--
-- 0804 Damon：「员工要改每周五休息，下个月改每周一休息。把这个模块做出来，
--              以后我们自己改在后台，申请后要等审批。」
--
-- 为什么要规则表而不是继续往 hr_shifts 里塞：
--   hr_shifts 是**按天一行**的记录（现在 7 行 = 李美倩上周）。
--   「每周五休息」不是 7 条记录，是一条规则；「下个月改周一」也不是改历史，
--   是**新起一条规则、旧的到期**。混在一起就没法回答「8 月那会儿规矩是什么」。

-- ── ① 休息日规则（按生效日切换，旧规则不删只封口）──
CREATE TABLE IF NOT EXISTS hr_rest_rules (
  id             SERIAL PRIMARY KEY,
  company_code   TEXT NOT NULL,
  employee_id    INTEGER REFERENCES hr_employees(id),   -- NULL = 全店通用
  weekday        SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0=周日 … 6=周六
  effective_from DATE NOT NULL,
  effective_to   DATE,                                   -- NULL = 一直有效
  note           TEXT,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rest_rules_lookup
  ON hr_rest_rules(company_code, employee_id, effective_from DESC);

COMMENT ON TABLE hr_rest_rules IS
  '每周几休息的规则。换规矩=新增一行 + 把旧行的 effective_to 封口,**不改旧行的 weekday** ——
   否则「8月那会儿规矩是什么」永远查不出来,算工资和考勤对不上账。';
COMMENT ON COLUMN hr_rest_rules.weekday IS '0=周日 1=周一 … 6=周六。跟 JS 的 getDay() 一致,省得两边换算错。';
COMMENT ON COLUMN hr_rest_rules.employee_id IS 'NULL=全店通用。个人规则优先于全店规则(取 effective_from 最新的那条)。';

-- ── ② 调休申请（员工发起 → 店长审批）──
-- 之前员工端「这周休哪天」是**点一下直接改 hr_shifts**,零审批。Damon 要的是「申请后要等审批」。
CREATE TABLE IF NOT EXISTS hr_rest_change_requests (
  id            SERIAL PRIMARY KEY,
  company_code  TEXT NOT NULL,
  employee_id   INTEGER NOT NULL REFERENCES hr_employees(id),
  employee_name TEXT,
  orig_date     DATE NOT NULL,        -- 本来该休的那天
  new_date      DATE NOT NULL,        -- 想换到哪天
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected | cancelled
  review_note   TEXT,
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ,
  applied_at    TIMESTAMPTZ,          -- 批准后真正写进 hr_shifts 的时间
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rest_chg_pending
  ON hr_rest_change_requests(company_code, status, created_at DESC);
-- 同一天不许挂两个待审的,免得批了两次
CREATE UNIQUE INDEX IF NOT EXISTS idx_rest_chg_one_pending
  ON hr_rest_change_requests(employee_id, orig_date) WHERE status='pending';

COMMENT ON TABLE hr_rest_change_requests IS
  '调休申请。员工只能提,改不了状态;批准后由服务端写 hr_shifts(orig_date→上班, new_date→休息)。
   拒了也留着 —— 「他这个月申请过几次调休」是绩效信息。';

-- ── ③ 种入 Damon 现在的规矩 ──
-- 本月：每周五休息（weekday=5）
INSERT INTO hr_rest_rules (company_code, employee_id, weekday, effective_from, effective_to, note, created_by)
SELECT 'JINFANG', NULL, 5, DATE '2026-08-01', DATE '2026-08-31', '每周五休息', 'damon'
WHERE NOT EXISTS (SELECT 1 FROM hr_rest_rules WHERE company_code='JINFANG' AND effective_from=DATE '2026-08-01');
-- 下个月起：每周一休息（weekday=1）
INSERT INTO hr_rest_rules (company_code, employee_id, weekday, effective_from, effective_to, note, created_by)
SELECT 'JINFANG', NULL, 1, DATE '2026-09-01', NULL, '9月起改成每周一休息', 'damon'
WHERE NOT EXISTS (SELECT 1 FROM hr_rest_rules WHERE company_code='JINFANG' AND effective_from=DATE '2026-09-01');
