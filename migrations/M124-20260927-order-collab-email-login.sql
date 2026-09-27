-- M124 订单协同·客户版「邮箱验证码首次登录」（Damon 0927「让他们用邮箱登入,初次登入账号不就好了」）
-- 验证码只存 hash（HMAC-SHA256），15 分钟有效，错 5 次作废
CREATE TABLE IF NOT EXISTS collab.customer_login_code (
  id           BIGSERIAL PRIMARY KEY,
  email        TEXT NOT NULL,
  company_code TEXT NOT NULL,
  sheet_id     BIGINT,
  code_hash    TEXT NOT NULL,
  tries        INT  NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ NOT NULL,
  used_at      TIMESTAMPTZ,
  ip           TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS customer_login_code_email_idx ON collab.customer_login_code (email, created_at DESC);
CREATE INDEX IF NOT EXISTS customer_login_code_live_idx ON collab.customer_login_code (email, company_code, expires_at) WHERE used_at IS NULL;
CREATE INDEX IF NOT EXISTS customer_login_code_ip_idx ON collab.customer_login_code (ip, created_at DESC);

-- 验证码信的模板键（mail_outbox.tpl_key 外键）
INSERT INTO email_templates (tpl_key, name, category, sender, subject, html, variables, is_active, is_system, updated_by)
VALUES ('order_collab_login_code', '订单协同·客户登录验证码 Login code', 'customer', 'petbaby',
        'Your login code: {code}', '<p>由系统按次生成（api/db/lib/po-collab-customer-login.js）</p>', '[]'::jsonb, true, true, 'M124')
ON CONFLICT (tpl_key) DO NOTHING;
