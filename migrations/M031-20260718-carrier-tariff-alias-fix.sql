-- M031 2026-07-18 carrier tariff alias split for import uniqueness
-- Scope: seed-only fix. No production data import.

WITH seed(raw_carrier, raw_item_name, normalized_carrier, standard_item_code, standard_item_name, unit_basis, include_in_baseline, conditional_charge, confidence, notes) AS (
  VALUES
    ('*','检疫费','*','quarantine','检疫费','container',false,true,0.900,'M031 split from manifest_or_other'),
    ('*','舱单费','*','manifest','舱单费','bill',false,true,0.950,'M031 split from manifest_or_other'),
    ('*','场站小票费','*','station_ticket','场站小票费','container',false,true,0.950,'M031 split from manifest_or_other'),
    ('*','小票费/柜','*','station_ticket','场站小票费','container',false,true,0.920,'M031 split from manifest_or_other'),
    ('*','青岛港免费箱使','*','free_container_days','免费箱使','day',false,true,0.900,'M031 split from manifest_or_other'),
    ('*','出口服务费','*','export_service','出口服务费','bill',false,true,0.850,'M031 split from manifest_or_other'),
    ('*','操作费','*','operation_service','操作费','bill',false,true,0.850,'M031 split from manifest_or_other'),
    ('*','SW BILL','*','sw_bill','SW BILL','bill',false,true,0.800,'M031 split from manifest_or_other')
)
INSERT INTO carrier_tariff_charge_items (
  raw_carrier, raw_item_name, normalized_carrier, standard_item_code,
  standard_item_name, unit_basis, include_in_baseline, conditional_charge,
  confidence, notes
)
SELECT * FROM seed
ON CONFLICT (normalized_carrier, raw_item_name) DO UPDATE SET
  standard_item_code = EXCLUDED.standard_item_code,
  standard_item_name = EXCLUDED.standard_item_name,
  unit_basis = EXCLUDED.unit_basis,
  include_in_baseline = EXCLUDED.include_in_baseline,
  conditional_charge = EXCLUDED.conditional_charge,
  confidence = EXCLUDED.confidence,
  notes = EXCLUDED.notes;
