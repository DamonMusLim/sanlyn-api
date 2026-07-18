-- M030 2026-07-18 carrier official tariff batch 1
-- Scope: new tables + first alias seed only. Do not run on production until
-- Tencent information_schema has been checked against this draft.

CREATE TABLE IF NOT EXISTS carrier_tariff_versions (
  id              bigserial PRIMARY KEY,
  version         text NOT NULL UNIQUE,
  source_doc      text NOT NULL,
  source_hash     text,
  port            text NOT NULL,
  effective_from  date NOT NULL,
  effective_to    date,
  import_status   text NOT NULL DEFAULT 'draft'
                  CHECK (import_status IN ('draft','reviewed','active','archived','rejected')),
  imported_by     text,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  reviewed_by     text,
  reviewed_at     timestamptz,
  notes           text
);

CREATE TABLE IF NOT EXISTS carrier_tariff_charge_items (
  id                  bigserial PRIMARY KEY,
  raw_carrier         text NOT NULL,
  raw_item_name       text NOT NULL,
  normalized_carrier  text NOT NULL,
  standard_item_code  text NOT NULL,
  standard_item_name  text NOT NULL,
  unit_basis          text NOT NULL DEFAULT 'container'
                      CHECK (unit_basis IN ('container','bill','seal','day','shipment','other')),
  include_in_baseline boolean NOT NULL DEFAULT true,
  conditional_charge  boolean NOT NULL DEFAULT false,
  confidence          numeric(4,3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  notes               text,
  UNIQUE (normalized_carrier, raw_item_name)
);

CREATE TABLE IF NOT EXISTS carrier_tariff_standards (
  id                  bigserial PRIMARY KEY,
  version_id          bigint NOT NULL REFERENCES carrier_tariff_versions(id),
  carrier             text NOT NULL,
  port                text NOT NULL,
  container_type      text NOT NULL CHECK (container_type IN ('20GP','40GP','40HQ')),
  charge_item_code    text NOT NULL,
  charge_item_name    text NOT NULL,
  raw_item_name       text NOT NULL,
  amount_cny          numeric(12,2) NOT NULL CHECK (amount_cny >= 0),
  unit_basis          text NOT NULL DEFAULT 'container'
                      CHECK (unit_basis IN ('container','bill','seal','day','shipment','other')),
  required_flag       boolean NOT NULL DEFAULT true,
  conditional_flag    boolean NOT NULL DEFAULT false,
  station_name        text,
  route_scope         text,
  valid_from          date NOT NULL,
  valid_to            date,
  source_doc          text NOT NULL,
  source_sheet        text,
  source_row          integer,
  source_col          integer,
  raw_value           text,
  parse_confidence    numeric(4,3) CHECK (parse_confidence IS NULL OR parse_confidence BETWEEN 0 AND 1),
  review_status       text NOT NULL DEFAULT 'pending'
                      CHECK (review_status IN ('pending','confirmed','ignored','needs_fix')),
  raw                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cts_lookup
  ON carrier_tariff_standards (carrier, port, container_type, charge_item_code, valid_from DESC)
  WHERE review_status = 'confirmed';

CREATE INDEX IF NOT EXISTS idx_cts_version
  ON carrier_tariff_standards (version_id, carrier, port, container_type);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cts_version_scope
  ON carrier_tariff_standards (
    version_id, carrier, port, container_type, charge_item_code,
    COALESCE(station_name,''), COALESCE(route_scope,'')
  );

WITH seed(raw_carrier, raw_item_name, normalized_carrier, standard_item_code, standard_item_name, unit_basis, include_in_baseline, conditional_charge, confidence, notes) AS (
  VALUES
    ('*','场站','*','cfs','场站费','container',true,false,0.980,'batch1 alias seed'),
    ('*','场站费','*','cfs','场站费','container',true,false,0.980,'batch1 alias seed'),
    ('*','场站费（CFS）/柜','*','cfs','场站费','container',true,false,0.990,'batch1 alias seed'),
    ('*','场站/柜','*','cfs','场站费','container',true,false,0.980,'batch1 alias seed'),
    ('*','場站','*','cfs','场站费','container',true,false,0.980,'batch1 alias seed'),
    ('*','CFS','*','cfs','场站费','container',true,false,0.980,'batch1 alias seed'),
    ('*','DEPORT','*','cfs','场站费','container',true,false,0.900,'SWIRE source spelling'),
    ('*','港杂','*','port_due','港杂费','container',true,false,0.980,'batch1 alias seed'),
    ('*','港杂费','*','port_due','港杂费','container',true,false,0.980,'batch1 alias seed'),
    ('*','港杂费/柜','*','port_due','港杂费','container',true,false,0.980,'batch1 alias seed'),
    ('*','港杂/柜','*','port_due','港杂费','container',true,false,0.980,'batch1 alias seed'),
    ('*','港雜費','*','port_due','港杂费','container',true,false,0.980,'batch1 alias seed'),
    ('*','PORT DUE','*','port_due','港杂费','container',true,false,0.980,'batch1 alias seed'),
    ('*','THC','*','thc','码头操作费','container',true,false,0.990,'batch1 alias seed'),
    ('*','THC/柜','*','thc','码头操作费','container',true,false,0.990,'batch1 alias seed'),
    ('*','码头操作费','*','thc','码头操作费','container',true,false,0.980,'batch1 alias seed'),
    ('*','单证','*','doc','单证费','bill',true,false,0.980,'batch1 alias seed'),
    ('*','单证费','*','doc','单证费','bill',true,false,0.980,'batch1 alias seed'),
    ('*','单证费(DOC)/票','*','doc','单证费','bill',true,false,0.990,'batch1 alias seed'),
    ('*','单证/BILL','*','doc','单证费','bill',true,false,0.990,'batch1 alias seed'),
    ('*','單證','*','doc','单证费','bill',true,false,0.980,'batch1 alias seed'),
    ('*','文件费','*','doc','单证费','bill',true,false,0.950,'YML source alias'),
    ('*','DOC','*','doc','单证费','bill',true,false,0.980,'batch1 alias seed'),
    ('*','VGM','*','vgm','VGM费','container',true,false,0.990,'batch1 alias seed'),
    ('*','VGM/柜','*','vgm','VGM费','container',true,false,0.990,'batch1 alias seed'),
    ('*','VGM费','*','vgm','VGM费','container',true,false,0.990,'batch1 alias seed'),
    ('*','VGM传输费','*','vgm','VGM费','container',true,false,0.980,'batch1 alias seed'),
    ('*','设备交接','*','eir','设备交接单','container',true,false,0.970,'batch1 alias seed'),
    ('*','设备交接单','*','eir','设备交接单','container',true,false,0.980,'batch1 alias seed'),
    ('*','设备交接单/柜','*','eir','设备交接单','container',true,false,0.990,'batch1 alias seed'),
    ('*','EIR','*','eir','设备交接单','container',true,false,0.980,'batch1 alias seed'),
    ('*','设备','*','eir','设备交接单','container',true,false,0.800,'CMA ambiguous equipment fee'),
    ('*','设备/柜','*','eir','设备交接单','container',true,false,0.800,'CMA ambiguous equipment fee'),
    ('*','设备管理费/柜 (EMF)','*','eir','设备交接单','container',true,false,0.850,'MSK EMF mapped for audit review'),
    ('*','設備交接單','*','eir','设备交接单','container',true,false,0.980,'batch1 alias seed'),
    ('*','铅封','*','seal','铅封费','seal',true,false,0.980,'batch1 alias seed'),
    ('*','铅封费','*','seal','铅封费','seal',true,false,0.980,'batch1 alias seed'),
    ('*','鉛封','*','seal','铅封费','seal',true,false,0.980,'batch1 alias seed'),
    ('*','SEAL','*','seal','铅封费','seal',true,false,0.980,'batch1 alias seed'),
    ('*','安保','*','isps','港口设施保安费','container',true,false,0.970,'batch1 alias seed'),
    ('*','安保费','*','isps','港口设施保安费','container',true,false,0.970,'batch1 alias seed'),
    ('*','港口设施保安费','*','isps','港口设施保安费','container',true,false,0.980,'batch1 alias seed'),
    ('*','提箱','*','pickup','提箱费','container',true,false,0.980,'batch1 alias seed'),
    ('*','提箱费','*','pickup','提箱费','container',true,false,0.980,'batch1 alias seed'),
    ('*','提箱费/柜','*','pickup','提箱费','container',true,false,0.980,'batch1 alias seed'),
    ('*','提箱費','*','pickup','提箱费','container',true,false,0.980,'batch1 alias seed'),
    ('*','提箱费+安保费','*','pickup','提箱费','container',true,false,0.720,'combined item, review before confirmed import'),
    ('*','燃油土地','*','fuel_land','燃油土地附加费','container',true,false,0.980,'batch1 alias seed'),
    ('*','燃油土地/柜','*','fuel_land','燃油土地附加费','container',true,false,0.980,'batch1 alias seed'),
    ('*','燃油土地附加费','*','fuel_land','燃油土地附加费','container',true,false,0.980,'batch1 alias seed'),
    ('*','燃油和土地附加费','*','fuel_land','燃油土地附加费','container',true,false,0.980,'batch1 alias seed'),
    ('*','信息传输费','*','edi','信息传输费','container',true,false,0.980,'batch1 alias seed'),
    ('*','信息傳輸費','*','edi','信息传输费','container',true,false,0.980,'batch1 alias seed'),
    ('*','订舱','*','booking','订舱费','bill',true,false,0.970,'batch1 alias seed'),
    ('*','订舱费','*','booking','订舱费','bill',true,false,0.970,'batch1 alias seed'),
    ('*','电放','*','telex','电放费','bill',false,true,0.980,'batch1 alias seed'),
    ('*','电放费','*','telex','电放费','bill',false,true,0.980,'batch1 alias seed'),
    ('*','电放费/票','*','telex','电放费','bill',false,true,0.990,'batch1 alias seed'),
    ('*','电放费（如需）','*','telex','电放费','bill',false,true,0.990,'batch1 alias seed'),
    ('*','電放','*','telex','电放费','bill',false,true,0.980,'batch1 alias seed'),
    ('*','TLX','*','telex','电放费','bill',false,true,0.980,'batch1 alias seed'),
    ('*','改单费','*','amendment','改单费','bill',false,true,0.980,'batch1 alias seed'),
    ('*','改单','*','amendment','改单费','bill',false,true,0.980,'batch1 alias seed'),
    ('*','条码','*','barcode','条码/放箱服务费','container',true,false,0.970,'batch1 alias seed'),
    ('*','条形码','*','barcode','条码/放箱服务费','container',true,false,0.970,'batch1 alias seed'),
    ('*','放箱服务费(条码费）','*','barcode','条码/放箱服务费','container',true,false,0.980,'batch1 alias seed'),
    ('*','港口建设费','*','port_construction','港口建设费','container',true,false,0.980,'batch1 alias seed'),
    ('*','检疫费','*','manifest_or_other','舱单/其他发生项','container',false,true,0.700,'uncommon item, keep pending review'),
    ('*','出口服务费','*','manifest_or_other','舱单/其他发生项','bill',false,true,0.700,'uncommon item, keep pending review'),
    ('*','青岛港免费箱使','*','manifest_or_other','舱单/其他发生项','day',false,true,0.700,'free day note, not baseline amount'),
    ('*','舱单费','*','manifest_or_other','舱单/其他发生项','bill',false,true,0.850,'batch1 alias seed'),
    ('*','场站小票费','*','manifest_or_other','舱单/其他发生项','container',false,true,0.780,'station ticket fee'),
    ('*','小票费/柜','*','manifest_or_other','舱单/其他发生项','container',false,true,0.780,'station ticket fee'),
    ('*','操作费','*','manifest_or_other','舱单/其他发生项','bill',false,true,0.650,'forwarder/operation item, review required'),
    ('*','SW BILL','*','manifest_or_other','舱单/其他发生项','bill',false,true,0.650,'non-price note in source')
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
