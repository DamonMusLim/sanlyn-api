-- 执行顺序: 1) M074a-...-schema.sql  2) M074b-...-backfill.sql  3) M074c-...-selfcheck.sql

DO $$
DECLARE
  v_count bigint;
BEGIN
  SELECT count(*) INTO v_count FROM product_master;
  IF v_count <> 2937 THEN RAISE EXCEPTION 'product_master count %, expected 2937', v_count; END IF;

  SELECT count(*) INTO v_count FROM product_external_ids WHERE source_system = 'jelly_orange' AND is_current;
  IF v_count <> 2936 THEN RAISE EXCEPTION 'current external ids %, expected 2936', v_count; END IF;

  SELECT count(*) INTO v_count FROM product_external_ids WHERE source_system = 'jelly_orange' AND NOT is_current;
  IF v_count <> 1 THEN RAISE EXCEPTION 'not_current external ids %, expected 1', v_count; END IF;

  SELECT count(*) INTO v_count FROM product_field_ownership_exceptions;
  IF v_count <> 0 THEN RAISE EXCEPTION 'ownership exceptions %, expected 0', v_count; END IF;

  SELECT count(*) INTO v_count
  FROM product_external_ids
  WHERE source_system = 'jelly_orange' AND is_current AND barcode IS NOT NULL AND barcode <> '';
  IF v_count <> 1140 THEN RAISE EXCEPTION 'current barcode mappings %, expected 1140', v_count; END IF;

  SELECT count(*) INTO v_count FROM product_field_conflicts WHERE status = 'open';
  IF v_count <> 0 THEN RAISE EXCEPTION 'open conflicts %, expected 0', v_count; END IF;

  SELECT count(*) INTO v_count FROM product_master_shadow_diff WHERE NOT is_expected;
  IF v_count <> 0 THEN RAISE EXCEPTION 'unexpected_shadow_diff_rows %, expected 0', v_count; END IF;

  SELECT count(*) INTO v_count
  FROM (
    SELECT external_product_code
    FROM product_external_ids
    WHERE source_system = 'jelly_orange' AND is_current
    GROUP BY external_product_code
    HAVING count(*) > 1
  ) d;
  IF v_count <> 0 THEN RAISE EXCEPTION 'current code duplicates %, expected 0', v_count; END IF;

  SELECT count(*) INTO v_count
  FROM (
    SELECT product_id, field_name
    FROM product_master_shadow_diff
    GROUP BY product_id, field_name
    HAVING count(*) > 1
  ) d;
  IF v_count <> 0 THEN RAISE EXCEPTION 'shadow_diff duplicates %, expected 0', v_count; END IF;
END $$;

DO $$
DECLARE
  v_product_id bigint;
  v_old_pos text;
  v_conflicts bigint;
BEGIN
  SELECT pm.product_id, pm.pos_product_name
    INTO v_product_id, v_old_pos
  FROM product_master pm
  JOIN product_external_ids pei ON pei.product_id = pm.product_id
  WHERE pei.source_system = 'jelly_orange'
    AND pei.is_current
    AND pm.pos_product_name IS NOT NULL
  ORDER BY pm.product_id
  LIMIT 1;

  UPDATE product_master
  SET pos_product_name = v_old_pos || '__m074_conflict_probe'
  WHERE product_id = v_product_id;

  PERFORM master_sync();

  SELECT count(*) INTO v_conflicts
  FROM product_field_conflicts
  WHERE product_id = v_product_id
    AND status = 'open';

  IF v_conflicts < 1 THEN
    RAISE EXCEPTION 'reverse validation A failed: expected conflict';
  END IF;

  UPDATE product_master
  SET pos_product_name = v_old_pos
  WHERE product_id = v_product_id;

  DELETE FROM product_field_conflicts
  WHERE product_id = v_product_id
    AND status = 'open';
END $$;

DO $$
DECLARE
  v_product_id bigint;
  v_src_cost numeric;
  v_old_cost numeric;
  v_old_pos_cost numeric;
  v_after_cost numeric;
BEGIN
  SELECT pm.product_id, ps.cost_price::numeric, pm.cost_price, pm.pos_cost_price
    INTO v_product_id, v_src_cost, v_old_cost, v_old_pos_cost
  FROM product_master pm
  JOIN product_external_ids pei ON pei.product_id = pm.product_id
  JOIN petstore_skus ps ON ps.product_code = pei.external_product_code
  WHERE pei.source_system = 'jelly_orange'
    AND pei.is_current
    AND ps.snapshot_date = (SELECT max(snapshot_date) FROM petstore_skus)
    AND ps.cost_price IS NOT NULL
  ORDER BY pm.product_id
  LIMIT 1;

  UPDATE product_master
  SET cost_price = round(v_src_cost + 1, 2),
      pos_cost_price = round(v_src_cost + 2, 2)
  WHERE product_id = v_product_id;

  PERFORM master_sync();

  SELECT cost_price INTO v_after_cost
  FROM product_master
  WHERE product_id = v_product_id;

  IF v_after_cost IS DISTINCT FROM round(v_src_cost, 2) THEN
    RAISE EXCEPTION 'reverse validation B failed: cost_price %, expected %', v_after_cost, round(v_src_cost, 2);
  END IF;

  UPDATE product_master
  SET cost_price = v_old_cost,
      pos_cost_price = v_old_pos_cost
  WHERE product_id = v_product_id;

  DELETE FROM product_field_conflicts
  WHERE product_id = v_product_id
    AND status = 'open';
END $$;

DO $$
DECLARE
  v_product_id bigint;
  v_old_cost numeric;
  v_after_cost numeric;
  v_count bigint;
BEGIN
  SELECT pm.product_id, pm.cost_price
    INTO v_product_id, v_old_cost
  FROM product_master pm
  JOIN product_external_ids pei ON pei.product_id = pm.product_id
  WHERE pei.source_system = 'jelly_orange'
    AND pei.is_current
    AND pm.cost_price IS NOT NULL
  ORDER BY pm.product_id
  LIMIT 1;

  INSERT INTO product_field_ownership_exceptions (
    product_id, field_name, owner, accept_source_updates, note
  ) VALUES (
    v_product_id, 'cost_price', 'ours', false, 'M074 reverse validation C'
  )
  ON CONFLICT (product_id, field_name) DO UPDATE SET
    owner = EXCLUDED.owner,
    accept_source_updates = EXCLUDED.accept_source_updates,
    note = EXCLUDED.note,
    locked_at = now();

  PERFORM master_sync();

  SELECT cost_price INTO v_after_cost
  FROM product_master
  WHERE product_id = v_product_id;

  IF v_after_cost IS NULL OR v_after_cost IS DISTINCT FROM v_old_cost THEN
    RAISE EXCEPTION 'reverse validation C failed: cost_price changed from % to %', v_old_cost, v_after_cost;
  END IF;

  DELETE FROM product_field_ownership_exceptions
  WHERE product_id = v_product_id
    AND field_name = 'cost_price';

  SELECT count(*) INTO v_count FROM product_field_ownership_exceptions;
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'reverse validation C cleanup failed: exceptions %, expected 0', v_count;
  END IF;

  DELETE FROM product_field_conflicts
  WHERE product_id = v_product_id
    AND status = 'open';
END $$;
