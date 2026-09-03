-- Product-level certificate rules and certificates.
-- MSDS is tracked per product, not only per company.

CREATE TABLE IF NOT EXISTS product_cert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_type varchar(16) NOT NULL DEFAULT 'keyword',
  match_value varchar(128) NOT NULL,
  cert_key varchar(64) NOT NULL,
  note text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_cert_rules_match
  ON product_cert_rules (match_type, lower(match_value), cert_key);

CREATE INDEX IF NOT EXISTS idx_product_cert_rules_active
  ON product_cert_rules (active, match_type);

COMMENT ON TABLE product_cert_rules IS
  '产品级证件规则: 哪些品名关键词需要哪些证件。';
COMMENT ON COLUMN product_cert_rules.match_type IS
  '匹配类型; 本期只使用 keyword, 预留扩展。';
COMMENT ON COLUMN product_cert_rules.match_value IS
  '匹配值, 如 湿巾 或 wipe。';
COMMENT ON COLUMN product_cert_rules.cert_key IS
  '证件类型 key, 概念上对应 cert_type_config.cert_key。';

CREATE TABLE IF NOT EXISTS product_certs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_key varchar(128) NOT NULL,
  product_label varchar(256),
  company_code varchar(32),
  cert_key varchar(64) NOT NULL,
  cert_no varchar(128),
  file_url varchar(512),
  issue_date date,
  expire_date date,
  status varchar(16) NOT NULL DEFAULT 'pending',
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_product_certs_key_cert
  ON product_certs (product_key, cert_key);

CREATE INDEX IF NOT EXISTS idx_product_certs_expire_date
  ON product_certs (expire_date);

COMMENT ON TABLE product_certs IS
  '产品级证件: MSDS 等按归一化品名挂证, 可选出具工厂。';
COMMENT ON COLUMN product_certs.product_key IS
  '归一化品名: 小写去空格, 如 湿巾 或 wipe。';
COMMENT ON COLUMN product_certs.product_label IS
  '展示用原始品名。';
COMMENT ON COLUMN product_certs.company_code IS
  '出具方/工厂 company_code, 可空。';
COMMENT ON COLUMN product_certs.expire_date IS
  '有效期规则: MSDS 一年一换(Damon 0903 定); expire_date 缺省应 = issue_date + 1 年; 到期前 60 天提醒工厂重新出具。';

INSERT INTO product_cert_rules (match_type, match_value, cert_key, note)
VALUES
  ('keyword', '湿巾', 'msds', 'Damon 0903 定:船东抓柜要过,湿巾必须有 MSDS'),
  ('keyword', 'wipe', 'msds', '同上,英文品名')
ON CONFLICT (match_type, lower(match_value), cert_key) DO NOTHING;
