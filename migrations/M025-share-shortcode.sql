-- M025: 分享短码表(短码→账号+页面, 解析器铸token跳转; JWT不进分享链接)
CREATE TABLE IF NOT EXISTS share_links (
  id SERIAL PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  account_id INTEGER NOT NULL,
  page TEXT NOT NULL,
  path TEXT NOT NULL,
  created_by TEXT,
  expires_at TIMESTAMPTZ,
  revoked BOOLEAN DEFAULT FALSE,
  hits INTEGER DEFAULT 0,
  last_hit_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_share_links_code ON share_links(code);
