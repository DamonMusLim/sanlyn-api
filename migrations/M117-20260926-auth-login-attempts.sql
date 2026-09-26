-- 登录防暴力破解计数表（api/db/lib/login-guard.js 用；代码里也有 CREATE IF NOT EXISTS 兜底）
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id bigserial PRIMARY KEY,
  username text NOT NULL,          -- 小写后的登录名（可能是不存在的账号）
  ip text,                         -- nginx X-Real-IP；直连为 NULL
  ok boolean NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_login_attempts_user_at ON auth_login_attempts (username, at DESC);
CREATE INDEX IF NOT EXISTS auth_login_attempts_ip_at   ON auth_login_attempts (ip, at DESC) WHERE ip IS NOT NULL;
