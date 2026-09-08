-- M109b-20260909-accounts-missing-keys.sql
--
-- 🩸 2026-09-09 查 R16 migration 的 ON CONFLICT 目标时发现：
--    public.accounts —— 生产鉴权表 —— 【一个索引都没有】。
--    没有主键，username 上没有唯一约束，pg_indexes 查出来是 0 行。
--
-- 两个后果：
--   ① R16 的 M110 用了 ON CONFLICT (username)，没有唯一约束会直接报
--      "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--   ② 更要紧：用户名可以重复，而 /api/db/auth-login 的查询是
--      WHERE a.id::text = $1 OR a.username = $2 ... LIMIT 1
--      一旦出现重名，登录会匹配到哪一行取决于计划，等于鉴权不确定。
--
-- 当前数据是干净的（38 账号 / 38 个不同用户名 / id 无重复），
-- 但那是运气，不是约束。先补键再跑 M110。
--
-- ⛔ 本文件只加约束，不改任何一行数据。

BEGIN;

-- 先自证：有重名就中止，绝不在有脏数据的情况下硬加约束
DO $$
DECLARE dup int;
BEGIN
  SELECT count(*) INTO dup FROM (
    SELECT username FROM public.accounts GROUP BY username HAVING count(*) > 1
  ) x;
  IF dup > 0 THEN
    RAISE EXCEPTION 'accounts 有 % 个重复用户名，先人工合并再跑本迁移', dup;
  END IF;

  SELECT count(*) INTO dup FROM (
    SELECT id FROM public.accounts GROUP BY id HAVING count(*) > 1
  ) x;
  IF dup > 0 THEN
    RAISE EXCEPTION 'accounts 有 % 个重复 id，先人工合并再跑本迁移', dup;
  END IF;
END $$;

-- 主键（id 本来就 NOT NULL + 有 sequence 默认值，只是从没建过键）
ALTER TABLE public.accounts ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);

-- username 唯一（auth-login 按它查，M110 的 ON CONFLICT 也按它）
ALTER TABLE public.accounts ADD CONSTRAINT accounts_username_key UNIQUE (username);

-- 让 id 的序列跟上现有最大值，否则下次插入会撞主键
SELECT setval(
  pg_get_serial_sequence('public.accounts', 'id'),
  GREATEST((SELECT COALESCE(max(id), 0) FROM public.accounts), 1),
  true
);

COMMIT;

-- 验收：下面三条各应回 1 / 1 / >=38
--   SELECT count(*) FROM pg_constraint WHERE conrelid='public.accounts'::regclass AND contype='p';
--   SELECT count(*) FROM pg_constraint WHERE conrelid='public.accounts'::regclass AND conname='accounts_username_key';
--   SELECT last_value FROM accounts_id_seq;
