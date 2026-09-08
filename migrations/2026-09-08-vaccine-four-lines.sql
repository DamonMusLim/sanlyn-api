-- 2026-09-08: pet vaccination model only. Do not connect petstore_pet_archive.
-- We copy the four-line model, not tatayisheng data.

BEGIN;

ALTER TABLE pet_vaccinations
  ADD COLUMN IF NOT EXISTS frequency_days integer,
  ADD COLUMN IF NOT EXISTS is_mandatory boolean;

ALTER TABLE pet_profiles
  ADD COLUMN IF NOT EXISTS color text,
  ADD COLUMN IF NOT EXISTS height_cm numeric,
  ADD COLUMN IF NOT EXISTS dog_license text,
  ADD COLUMN IF NOT EXISTS pet_status text,
  ADD COLUMN IF NOT EXISTS deworm_interval_months numeric,
  ADD COLUMN IF NOT EXISTS deworm_times_per_interval integer;

COMMENT ON COLUMN pet_vaccinations.frequency_days IS
  'Suggested interval in days for this line: external 30, internal 90, vaccine/rabies 365. Nullable because historic rows may not know it.';
COMMENT ON COLUMN pet_vaccinations.is_mandatory IS
  'Legal/mandatory immunization flag. Rabies should be true. Nullable because historic rows may not know it.';

COMMENT ON COLUMN pet_profiles.color IS
  '毛色。来自宠物档案原始属性，可空，不从品种或备注推断。';
COMMENT ON COLUMN pet_profiles.height_cm IS
  '身高，单位厘米。宠物档案属性，可空。';
COMMENT ON COLUMN pet_profiles.dog_license IS
  '犬证号。法定办证资料，可空。';
COMMENT ON COLUMN pet_profiles.pet_status IS
  '宠物状态，存中文，如饲养中/离世/走失。防疫提醒应排除非饲养中宠物。';
COMMENT ON COLUMN pet_profiles.deworm_interval_months IS
  '驱虫间隔月数。由它大夫 disinfest_frequency.month 拆出，可空。';
COMMENT ON COLUMN pet_profiles.deworm_times_per_interval IS
  '每个驱虫间隔内的次数。由它大夫 disinfest_frequency.times 拆出，可空。';

-- Do not add next_vaccine/next_rabies/next_deworm columns to pet_profiles:
-- next due dates must be derived from pet_vaccinations, otherwise pet_profiles
-- and pet_vaccinations become two writable truths and will drift.

-- Expected affected rows = 1 in the current production data, per Damon precheck.
-- The WHERE is intentionally narrow: only the existing mixed-in rabies rows
-- are split out of kind='疫苗'; no other vaccine/deworming rows are touched.
SELECT count(*) AS rabies_rows_to_reclassify
  FROM pet_vaccinations
 WHERE kind = '疫苗'
   AND drug_name LIKE '%狂犬%';

-- 狂犬从疫苗里拆出来单列，先放开 kind CHECK，避免下面重分类 UPDATE 被旧三值约束回滚。
ALTER TABLE pet_vaccinations DROP CONSTRAINT IF EXISTS pet_vaccinations_kind_check;
ALTER TABLE pet_vaccinations ADD CONSTRAINT pet_vaccinations_kind_check
  CHECK (kind = ANY (ARRAY['疫苗','狂犬','体内驱虫','体外驱虫']));

UPDATE pet_vaccinations
   SET kind = '狂犬',
       is_mandatory = true
 WHERE kind = '疫苗'
   AND drug_name LIKE '%狂犬%';

COMMIT;

-- Rollback plan, run manually only after confirming no new rabies rows depend on kind='狂犬':
-- BEGIN;
-- UPDATE pet_vaccinations
--    SET kind = '疫苗',
--        is_mandatory = NULL
--  WHERE kind = '狂犬'
--    AND drug_name LIKE '%狂犬%';
-- ALTER TABLE pet_vaccinations DROP CONSTRAINT IF EXISTS pet_vaccinations_kind_check;
-- ALTER TABLE pet_vaccinations ADD CONSTRAINT pet_vaccinations_kind_check
--   CHECK (kind = ANY (ARRAY['疫苗','体内驱虫','体外驱虫']));
-- ALTER TABLE pet_vaccinations
--   DROP COLUMN IF EXISTS is_mandatory,
--   DROP COLUMN IF EXISTS frequency_days;
-- ALTER TABLE pet_profiles
--   DROP COLUMN IF EXISTS deworm_times_per_interval,
--   DROP COLUMN IF EXISTS deworm_interval_months,
--   DROP COLUMN IF EXISTS pet_status,
--   DROP COLUMN IF EXISTS dog_license,
--   DROP COLUMN IF EXISTS height_cm,
--   DROP COLUMN IF EXISTS color;
-- COMMIT;
