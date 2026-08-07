BEGIN;

CREATE TABLE IF NOT EXISTS _bak_release_type_20260808 AS
SELECT id, shipment_no, release_type
FROM shipping_plans;

DO $$
DECLARE
  src_count integer;
  bak_count integer;
BEGIN
  SELECT COUNT(*) INTO src_count FROM shipping_plans;
  SELECT COUNT(*) INTO bak_count FROM _bak_release_type_20260808;
  IF src_count <> bak_count THEN
    RAISE EXCEPTION '_bak_release_type_20260808 row count mismatch: source %, backup %', src_count, bak_count;
  END IF;
END $$;

UPDATE shipping_plans
SET release_type = CASE
  WHEN release_type = 'SWB 海运单' THEN 'SWB'
  WHEN lower(release_type) = 'telex' THEN '电放'
  WHEN release_type = '电放 TELEX RELEASE' THEN '电放'
  ELSE release_type
END
WHERE release_type IN ('SWB 海运单', '电放 TELEX RELEASE')
   OR lower(release_type) = 'telex';

DO $$
DECLARE
  bad_values text;
BEGIN
  SELECT string_agg(DISTINCT COALESCE(NULLIF(release_type, ''), '<空>'), ', ')
  INTO bad_values
  FROM shipping_plans
  WHERE COALESCE(NULLIF(release_type, ''), '') NOT IN ('', 'SWB', '电放', '正本');

  IF bad_values IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected release_type values after normalize: %', bad_values;
  END IF;
END $$;

COMMIT;
