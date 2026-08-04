-- M058 · 员工建议/提议（首页那块从单向变双向）
-- 0804 Damon：「首页有个建议或者提议」
-- 现状：hr_day_agenda 里 kind='tip' 是 Damon 往下发的建议，员工只能看。
-- 店员是最先看见问题的人（哪个货老是找不到、哪个流程绕），这条路不通等于白瞎。
CREATE TABLE IF NOT EXISTS hr_suggestions (
  id            SERIAL PRIMARY KEY,
  company_code  TEXT NOT NULL,
  employee_id   INTEGER NOT NULL REFERENCES hr_employees(id),
  employee_name TEXT,
  content       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'new',   -- new | read | adopted | rejected
  reply         TEXT,
  replied_by    TEXT,
  replied_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_suggestions_new ON hr_suggestions(company_code, status, created_at DESC);
COMMENT ON TABLE hr_suggestions IS
  '员工提的建议。**不删只标状态** —— 「他提过什么、被采纳过几条」是绩效信息,也是判断这人上不上心的依据。
   采纳了要回一句 —— 提了石沉大海,第二次就没人提了。';
