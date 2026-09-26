-- auth_login_attempts v2 in-place migration.
-- v1 is already live: keep existing rows and indexes, and keep v1/v2 columns in sync.

ALTER TABLE auth_login_attempts ADD COLUMN IF NOT EXISTS bucket text;
ALTER TABLE auth_login_attempts ADD COLUMN IF NOT EXISTS outcome text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'auth_login_attempts'::regclass
       AND conname = 'auth_login_attempts_outcome_v2_check'
  ) THEN
    ALTER TABLE auth_login_attempts
      ADD CONSTRAINT auth_login_attempts_outcome_v2_check
      CHECK (outcome IN ('pending','fail','ok','blocked'));
  END IF;
END $$;

ALTER TABLE auth_login_attempts ALTER COLUMN username DROP NOT NULL;
ALTER TABLE auth_login_attempts ALTER COLUMN ok DROP NOT NULL;

CREATE OR REPLACE FUNCTION auth_login_attempts_v1_v2_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.bucket IS NULL AND NEW.username IS NOT NULL THEN
    NEW.bucket := 'name:' || NEW.username;
  END IF;

  IF NEW.outcome IS NULL AND NEW.ok IS NOT NULL THEN
    NEW.outcome := CASE WHEN NEW.ok THEN 'ok' ELSE 'fail' END;
  END IF;

  IF NEW.username IS NULL AND NEW.bucket IS NOT NULL THEN
    NEW.username := NEW.bucket;
  END IF;

  IF NEW.ok IS NULL AND NEW.outcome IN ('ok','fail') THEN
    NEW.ok := (NEW.outcome = 'ok');
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS auth_login_attempts_v1_v2_sync_trg ON auth_login_attempts;
CREATE TRIGGER auth_login_attempts_v1_v2_sync_trg
BEFORE INSERT OR UPDATE ON auth_login_attempts
FOR EACH ROW EXECUTE FUNCTION auth_login_attempts_v1_v2_sync();

WITH mapped AS (
  SELECT l.id, count(a.id) AS account_count, min(a.id) AS account_id
    FROM auth_login_attempts l
    LEFT JOIN accounts a
      ON lower(a.username::text) = l.username
      OR lower(a.email::text) = l.username
   WHERE l.bucket IS NULL
   GROUP BY l.id
)
UPDATE auth_login_attempts l
   SET bucket = CASE
                  WHEN mapped.account_count = 1 THEN 'acct:' || mapped.account_id::text
                  ELSE 'name:' || l.username
                END
  FROM mapped
 WHERE l.id = mapped.id
   AND l.bucket IS NULL;

UPDATE auth_login_attempts
   SET outcome = CASE WHEN ok THEN 'ok' ELSE 'fail' END
 WHERE outcome IS NULL
   AND ok IS NOT NULL;

ALTER TABLE auth_login_attempts ALTER COLUMN bucket SET NOT NULL;
ALTER TABLE auth_login_attempts ALTER COLUMN outcome SET NOT NULL;

CREATE INDEX IF NOT EXISTS auth_login_attempts_bucket_ip_at ON auth_login_attempts (bucket, ip, at DESC);
CREATE INDEX IF NOT EXISTS auth_login_attempts_at ON auth_login_attempts (at);

-- 建议 cron 定期小批量清理（不要放在登录请求路径里）：
-- DELETE FROM auth_login_attempts
--  WHERE id IN (
--    SELECT id FROM auth_login_attempts
--     WHERE at < now() - interval '60 days'
--     ORDER BY id
--     LIMIT 5000
--  );
