-- 执行顺序: 1) M074a-...-schema.sql  2) M074b-...-backfill.sql  3) M074c-...-selfcheck.sql
-- M074b must run after M074a.
-- Backfill product_master, define master_sync(), and run hard self-checks.

DO $$
DECLARE
  r record;
  v_product_id bigint;
  v_existing_product_id bigint;
  v_external_id bigint;
BEGIN
  FOR r IN
    WITH latest_sku AS (
      SELECT max(ps.snapshot_date) AS snapshot_date FROM petstore_skus ps
    ),
    latest_barcode AS (
      SELECT DISTINCT ON (pl.product_code)
        pl.product_code,
        pl.barcode
      FROM petstore_pricing_log pl
      WHERE pl.barcode IS NOT NULL AND pl.barcode <> ''
      ORDER BY pl.product_code, pl.synced_at DESC NULLS LAST, pl.id DESC
    )
    SELECT
      ps.product_code,
      ps.product_name,
      ps.category,
      ps.spec,
      round(ps.cost_price::numeric, 2) AS cost_price,
      round(ps.out_price::numeric, 2) AS out_price,
      round(ps.stock_num::numeric, 2) AS stock_num,
      ps.shelf_list,
      ps.supplier,
      ps.snapshot_date,
      ps.synced_at,
      (ps.snapshot_date = ls.snapshot_date) AS is_current,
      lb.barcode,
      ss.brand,
      ss.pet_type,
      ss.shelf_life_days,
      ss.expire_date_batch,
      ss.compliance_status
    FROM petstore_skus ps
    CROSS JOIN latest_sku ls
    LEFT JOIN latest_barcode lb ON lb.product_code = ps.product_code
    LEFT JOIN petstore_sku_supp ss ON ss.product_code = ps.product_code
    ORDER BY ps.product_code
  LOOP
    SELECT pei.product_id, pei.id
      INTO v_existing_product_id, v_external_id
    FROM product_external_ids pei
    WHERE pei.source_system = 'jelly_orange'
      AND pei.external_product_code = r.product_code
    ORDER BY pei.is_current DESC, pei.valid_from DESC, pei.id DESC
    LIMIT 1;

    IF v_existing_product_id IS NULL THEN
      INSERT INTO product_master (
        standard_product_name, standard_spec, display_category,
        brand, pet_type, shelf_life_days, expire_date_batch, compliance_status,
        show_in_catalog, notes,
        pos_product_name, pos_category, pos_spec,
        pos_brand, pos_pet_type, pos_shelf_life_days, pos_expire_date_batch, pos_compliance_status,
        cost_price, out_price, stock_num, shelf_list, barcode, supplier,
        pos_cost_price, pos_out_price, pos_stock_num, pos_shelf_list, pos_barcode, pos_supplier
      ) VALUES (
        r.product_name, r.spec, r.category,
        r.brand, r.pet_type, r.shelf_life_days, r.expire_date_batch, r.compliance_status,
        true, NULL,
        r.product_name, r.category, r.spec,
        r.brand, r.pet_type, r.shelf_life_days, r.expire_date_batch, r.compliance_status,
        r.cost_price, r.out_price, r.stock_num, r.shelf_list, r.barcode, r.supplier,
        r.cost_price, r.out_price, r.stock_num, r.shelf_list, r.barcode, r.supplier
      )
      RETURNING product_id INTO v_product_id;

      INSERT INTO product_external_ids (
        product_id, source_system, external_product_code, barcode,
        valid_from, valid_to, is_current, last_seen_at, confidence, match_reason
      ) VALUES (
        v_product_id, 'jelly_orange', r.product_code, r.barcode,
        COALESCE(r.snapshot_date::date, current_date),
        CASE WHEN r.is_current THEN NULL ELSE COALESCE(r.snapshot_date::date, current_date) END,
        r.is_current, COALESCE(r.synced_at, now()), 1, 'initial_backfill_product_code'
      );
    ELSE
      v_product_id := v_existing_product_id;

      UPDATE product_master pm SET
        standard_product_name = COALESCE(pm.standard_product_name, r.product_name),
        standard_spec = COALESCE(pm.standard_spec, r.spec),
        display_category = COALESCE(pm.display_category, r.category),
        brand = COALESCE(pm.brand, r.brand),
        pet_type = COALESCE(pm.pet_type, r.pet_type),
        shelf_life_days = COALESCE(pm.shelf_life_days, r.shelf_life_days),
        expire_date_batch = COALESCE(pm.expire_date_batch, r.expire_date_batch),
        compliance_status = COALESCE(pm.compliance_status, r.compliance_status),
        show_in_catalog = COALESCE(pm.show_in_catalog, true),
        pos_product_name = r.product_name,
        pos_category = r.category,
        pos_spec = r.spec,
        pos_brand = r.brand,
        pos_pet_type = r.pet_type,
        pos_shelf_life_days = r.shelf_life_days,
        pos_expire_date_batch = r.expire_date_batch,
        pos_compliance_status = r.compliance_status,
        cost_price = r.cost_price,
        out_price = r.out_price,
        stock_num = r.stock_num,
        shelf_list = r.shelf_list,
        barcode = r.barcode,
        supplier = r.supplier,
        pos_cost_price = r.cost_price,
        pos_out_price = r.out_price,
        pos_stock_num = r.stock_num,
        pos_shelf_list = r.shelf_list,
        pos_barcode = r.barcode,
        pos_supplier = r.supplier,
        updated_at = now()
      WHERE pm.product_id = v_product_id;

      UPDATE product_external_ids pei SET
        product_id = v_product_id,
        barcode = r.barcode,
        is_current = r.is_current,
        valid_to = CASE WHEN r.is_current THEN NULL ELSE COALESCE(r.snapshot_date::date, current_date) END,
        last_seen_at = COALESCE(r.synced_at, now()),
        updated_at = now()
      WHERE pei.id = v_external_id;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION master_sync()
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  WITH latest_sku AS (
    SELECT max(ps.snapshot_date) AS snapshot_date FROM petstore_skus ps
  ),
  latest_barcode AS (
    SELECT DISTINCT ON (pl.product_code)
      pl.product_code,
      pl.barcode
    FROM petstore_pricing_log pl
    WHERE pl.barcode IS NOT NULL AND pl.barcode <> ''
    ORDER BY pl.product_code, pl.synced_at DESC NULLS LAST, pl.id DESC
  ),
  src AS (
    SELECT
      ps.product_code,
      ps.product_name AS src_product_name,
      ps.category AS src_category,
      ps.spec AS src_spec,
      round(ps.cost_price::numeric, 2) AS src_cost_price,
      round(ps.out_price::numeric, 2) AS src_out_price,
      round(ps.stock_num::numeric, 2) AS src_stock_num,
      ps.shelf_list AS src_shelf_list,
      lb.barcode AS src_barcode,
      ps.supplier AS src_supplier,
      ss.brand AS src_brand,
      ss.pet_type AS src_pet_type,
      ss.shelf_life_days AS src_shelf_life_days,
      ss.expire_date_batch AS src_expire_date_batch,
      ss.compliance_status AS src_compliance_status,
      ps.synced_at AS src_synced_at
    FROM petstore_skus ps
    JOIN latest_sku ls ON ls.snapshot_date = ps.snapshot_date
    LEFT JOIN petstore_sku_supp ss ON ss.product_code = ps.product_code
    LEFT JOIN latest_barcode lb ON lb.product_code = ps.product_code
  ),
  matched AS (
    SELECT
      pm.product_id,
      pm.standard_product_name AS mst_standard_product_name,
      pm.standard_spec AS mst_standard_spec,
      pm.display_category AS mst_display_category,
      pm.brand AS mst_brand,
      pm.pet_type AS mst_pet_type,
      pm.shelf_life_days AS mst_shelf_life_days,
      pm.expire_date_batch AS mst_expire_date_batch,
      pm.compliance_status AS mst_compliance_status,
      pm.show_in_catalog AS mst_show_in_catalog,
      pm.notes AS mst_notes,
      pm.pos_product_name AS mst_pos_product_name,
      pm.pos_category AS mst_pos_category,
      pm.pos_spec AS mst_pos_spec,
      pm.pos_brand AS mst_pos_brand,
      pm.pos_pet_type AS mst_pos_pet_type,
      pm.pos_shelf_life_days AS mst_pos_shelf_life_days,
      pm.pos_expire_date_batch AS mst_pos_expire_date_batch,
      pm.pos_compliance_status AS mst_pos_compliance_status,
      pm.cost_price AS mst_cost_price,
      pm.out_price AS mst_out_price,
      pm.stock_num AS mst_stock_num,
      pm.shelf_list AS mst_shelf_list,
      pm.barcode AS mst_barcode,
      pm.supplier AS mst_supplier,
      pm.pos_cost_price AS mst_pos_cost_price,
      pm.pos_out_price AS mst_pos_out_price,
      pm.pos_stock_num AS mst_pos_stock_num,
      pm.pos_shelf_list AS mst_pos_shelf_list,
      pm.pos_barcode AS mst_pos_barcode,
      pm.pos_supplier AS mst_pos_supplier,
      src.src_product_name,
      src.src_category,
      src.src_spec,
      src.src_cost_price,
      src.src_out_price,
      src.src_stock_num,
      src.src_shelf_list,
      src.src_barcode,
      src.src_supplier,
      src.src_brand,
      src.src_pet_type,
      src.src_shelf_life_days,
      src.src_expire_date_batch,
      src.src_compliance_status
    FROM product_master pm
    JOIN product_external_ids pei
      ON pei.product_id = pm.product_id
     AND pei.source_system = 'jelly_orange'
     AND pei.is_current
    JOIN src ON src.product_code = pei.external_product_code
  ),
  field_values AS (
    SELECT
      m.product_id,
      v.field_name,
      v.master_value,
      v.incoming_value,
      v.last_seen_incoming_value
    FROM matched m
    CROSS JOIN LATERAL (VALUES
      ('standard_product_name', m.mst_standard_product_name, m.src_product_name, m.mst_pos_product_name),
      ('standard_spec', m.mst_standard_spec, m.src_spec, m.mst_pos_spec),
      ('display_category', m.mst_display_category, m.src_category, m.mst_pos_category),
      ('brand', m.mst_brand, m.src_brand, m.mst_pos_brand),
      ('pet_type', m.mst_pet_type, m.src_pet_type, m.mst_pos_pet_type),
      ('shelf_life_days', m.mst_shelf_life_days::text, m.src_shelf_life_days::text, m.mst_pos_shelf_life_days::text),
      ('expire_date_batch', m.mst_expire_date_batch, m.src_expire_date_batch, m.mst_pos_expire_date_batch),
      ('compliance_status', m.mst_compliance_status, m.src_compliance_status, m.mst_pos_compliance_status),
      ('show_in_catalog', m.mst_show_in_catalog::text, NULL, NULL),
      ('notes', m.mst_notes, NULL, NULL),
      ('pos_product_name', m.mst_pos_product_name, m.src_product_name, m.mst_pos_product_name),
      ('pos_category', m.mst_pos_category, m.src_category, m.mst_pos_category),
      ('pos_spec', m.mst_pos_spec, m.src_spec, m.mst_pos_spec),
      ('cost_price', m.mst_cost_price::text, m.src_cost_price::text, m.mst_pos_cost_price::text),
      ('out_price', m.mst_out_price::text, m.src_out_price::text, m.mst_pos_out_price::text),
      ('stock_num', m.mst_stock_num::text, m.src_stock_num::text, m.mst_pos_stock_num::text),
      ('shelf_list', m.mst_shelf_list, m.src_shelf_list, m.mst_pos_shelf_list),
      ('barcode', m.mst_barcode, m.src_barcode, m.mst_pos_barcode),
      ('supplier', m.mst_supplier, m.src_supplier, m.mst_pos_supplier)
    ) AS v(field_name, master_value, incoming_value, last_seen_incoming_value)
  ),
  owned AS (
    SELECT
      fv.product_id,
      fv.field_name,
      fv.master_value,
      fv.incoming_value,
      fv.last_seen_incoming_value,
      eo.owner,
      eo.accept_source_updates
    FROM field_values fv
    JOIN product_field_effective_ownership eo
      ON eo.product_id = fv.product_id
     AND eo.field_name = fv.field_name
  ),
  conflict_upsert AS (
    INSERT INTO product_field_conflicts (
      product_id, field_name, master_value, incoming_value,
      last_seen_incoming_value, incoming_source, status, detected_at, last_seen_at
    )
    SELECT
      o.product_id,
      o.field_name,
      o.master_value,
      o.incoming_value,
      o.last_seen_incoming_value,
      'jelly_orange',
      'open',
      now(),
      now()
    FROM owned o
    WHERE o.owner = 'ours'
      AND o.incoming_value IS DISTINCT FROM o.last_seen_incoming_value
    ON CONFLICT (product_id, field_name) WHERE status = 'open'
    DO UPDATE SET
      master_value = EXCLUDED.master_value,
      incoming_value = EXCLUDED.incoming_value,
      last_seen_incoming_value = EXCLUDED.last_seen_incoming_value,
      last_seen_at = now()
    RETURNING product_id
  ),
  patch AS (
    SELECT
      o.product_id,
      max(CASE WHEN o.field_name = 'standard_product_name' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS standard_product_name,
      max(CASE WHEN o.field_name = 'standard_spec' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS standard_spec,
      max(CASE WHEN o.field_name = 'display_category' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS display_category,
      max(CASE WHEN o.field_name = 'brand' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS brand,
      max(CASE WHEN o.field_name = 'pet_type' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS pet_type,
      max(CASE WHEN o.field_name = 'shelf_life_days' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS shelf_life_days,
      max(CASE WHEN o.field_name = 'expire_date_batch' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS expire_date_batch,
      max(CASE WHEN o.field_name = 'compliance_status' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS compliance_status,
      max(CASE WHEN o.field_name = 'cost_price' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS cost_price,
      max(CASE WHEN o.field_name = 'out_price' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS out_price,
      max(CASE WHEN o.field_name = 'stock_num' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS stock_num,
      max(CASE WHEN o.field_name = 'shelf_list' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS shelf_list,
      max(CASE WHEN o.field_name = 'barcode' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS barcode,
      max(CASE WHEN o.field_name = 'supplier' AND o.owner = 'pos' AND o.accept_source_updates THEN o.incoming_value END) AS supplier
    FROM owned o
    GROUP BY o.product_id
  )
  UPDATE product_master pm SET
    standard_product_name = COALESCE(patch.standard_product_name, pm.standard_product_name),
    standard_spec = COALESCE(patch.standard_spec, pm.standard_spec),
    display_category = COALESCE(patch.display_category, pm.display_category),
    brand = COALESCE(patch.brand, pm.brand),
    pet_type = COALESCE(patch.pet_type, pm.pet_type),
    shelf_life_days = COALESCE(patch.shelf_life_days::integer, pm.shelf_life_days),
    expire_date_batch = COALESCE(patch.expire_date_batch, pm.expire_date_batch),
    compliance_status = COALESCE(patch.compliance_status, pm.compliance_status),
    pos_product_name = m.src_product_name,
    pos_category = m.src_category,
    pos_spec = m.src_spec,
    pos_brand = m.src_brand,
    pos_pet_type = m.src_pet_type,
    pos_shelf_life_days = m.src_shelf_life_days,
    pos_expire_date_batch = m.src_expire_date_batch,
    pos_compliance_status = m.src_compliance_status,
    cost_price = COALESCE(patch.cost_price::numeric, pm.cost_price),
    out_price = COALESCE(patch.out_price::numeric, pm.out_price),
    stock_num = COALESCE(patch.stock_num::numeric, pm.stock_num),
    shelf_list = COALESCE(patch.shelf_list, pm.shelf_list),
    barcode = COALESCE(patch.barcode, pm.barcode),
    supplier = COALESCE(patch.supplier, pm.supplier),
    pos_cost_price = m.src_cost_price,
    pos_out_price = m.src_out_price,
    pos_stock_num = m.src_stock_num,
    pos_shelf_list = m.src_shelf_list,
    pos_barcode = m.src_barcode,
    pos_supplier = m.src_supplier,
    updated_at = now()
  FROM patch
  JOIN matched m ON m.product_id = patch.product_id
  WHERE pm.product_id = patch.product_id;

  WITH latest_sku AS (
    SELECT max(ps.snapshot_date) AS snapshot_date FROM petstore_skus ps
  )
  UPDATE product_external_ids pei SET
    is_current = false,
    valid_to = current_date,
    updated_at = now()
  WHERE pei.source_system = 'jelly_orange'
    AND pei.is_current
    AND NOT EXISTS (
      SELECT 1
      FROM petstore_skus ps
      JOIN latest_sku ls ON ls.snapshot_date = ps.snapshot_date
      WHERE ps.product_code = pei.external_product_code
    );

  WITH latest_sku AS (
    SELECT max(ps.snapshot_date) AS snapshot_date FROM petstore_skus ps
  )
  UPDATE product_external_ids pei SET
    last_seen_at = COALESCE(ps.synced_at, now()),
    valid_to = NULL,
    updated_at = now()
  FROM petstore_skus ps
  JOIN latest_sku ls ON ls.snapshot_date = ps.snapshot_date
  WHERE pei.source_system = 'jelly_orange'
    AND pei.is_current
    AND pei.external_product_code = ps.product_code;
END $$;

SELECT master_sync();
