BEGIN;

-- Phase 2a data-only backfill. No amount columns are updated.
-- Rollback source: this script snapshots touched rows into backfill_decouple_fields_0725_backup.

CREATE TABLE IF NOT EXISTS backfill_decouple_fields_0725_backup (
  target_table text NOT NULL,
  target_id text NOT NULL,
  before_row jsonb NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (target_table, target_id)
);

WITH our_export_plans AS (
  SELECT DISTINCT sp.id
    FROM shipping_plans sp
   WHERE EXISTS (
     SELECT 1
       FROM orders o
      WHERE o.seller_company_id = 37
        AND (
          o.shipping_plan_id = sp.id
          OR o.order_no = ANY(COALESCE(sp.order_nos, ARRAY[]::text[]))
          OR o.contract_no = ANY(COALESCE(sp.contract_nos, ARRAY[]::text[]))
          OR (sp.contract_no IS NOT NULL AND o.contract_no = sp.contract_no)
        )
   )
), affected_plans AS (
  SELECT sp.*
    FROM shipping_plans sp
    JOIN our_export_plans p ON p.id = sp.id
   WHERE sp.trade_owner_company_id IS NULL
      OR sp.trade_owner_kind IS NULL
      OR (sp.id <> 461 AND (
        sp.logistics_provider_company_id IS NULL
        OR sp.logistics_provider_kind IS NULL
      ))
      OR sp.id = 461
)
INSERT INTO backfill_decouple_fields_0725_backup (target_table, target_id, before_row)
SELECT 'shipping_plans', id::text, to_jsonb(affected_plans)
  FROM affected_plans
ON CONFLICT (target_table, target_id) DO NOTHING;

WITH our_export_plans AS (
  SELECT DISTINCT sp.id
    FROM shipping_plans sp
   WHERE EXISTS (
     SELECT 1
       FROM orders o
      WHERE o.seller_company_id = 37
        AND (
          o.shipping_plan_id = sp.id
          OR o.order_no = ANY(COALESCE(sp.order_nos, ARRAY[]::text[]))
          OR o.contract_no = ANY(COALESCE(sp.contract_nos, ARRAY[]::text[]))
          OR (sp.contract_no IS NOT NULL AND o.contract_no = sp.contract_no)
        )
   )
)
UPDATE shipping_plans sp
   SET trade_owner_company_id = COALESCE(sp.trade_owner_company_id, 37),
       trade_owner_kind = COALESCE(sp.trade_owner_kind, 'internal')
  FROM our_export_plans p
 WHERE sp.id = p.id
   AND (sp.trade_owner_company_id IS NULL OR sp.trade_owner_kind IS NULL);

WITH our_export_plans AS (
  SELECT DISTINCT sp.id
    FROM shipping_plans sp
   WHERE sp.id <> 461
     AND EXISTS (
       SELECT 1
         FROM orders o
        WHERE o.seller_company_id = 37
          AND (
            o.shipping_plan_id = sp.id
            OR o.order_no = ANY(COALESCE(sp.order_nos, ARRAY[]::text[]))
            OR o.contract_no = ANY(COALESCE(sp.contract_nos, ARRAY[]::text[]))
            OR (sp.contract_no IS NOT NULL AND o.contract_no = sp.contract_no)
          )
     )
)
UPDATE shipping_plans sp
   SET logistics_provider_company_id = COALESCE(sp.logistics_provider_company_id, 38),
       logistics_provider_kind = COALESCE(sp.logistics_provider_kind, 'internal')
  FROM our_export_plans p
 WHERE sp.id = p.id
   AND (sp.logistics_provider_company_id IS NULL OR sp.logistics_provider_kind IS NULL);

UPDATE shipping_plans
   SET trade_owner_company_id = COALESCE(trade_owner_company_id, 37),
       trade_owner_kind = COALESCE(trade_owner_kind, 'internal'),
       logistics_provider_company_id = 4246,
       logistics_provider_kind = 'external'
 WHERE id = 461
   AND (
     trade_owner_company_id IS NULL
     OR trade_owner_kind IS NULL
     OR logistics_provider_company_id IS DISTINCT FROM 4246
     OR logistics_provider_kind IS DISTINCT FROM 'external'
   );

WITH target_ocean_freight AS (
  SELECT sp.id AS plan_id, sp.bl_no, v.buyer_code
    FROM (VALUES
      (410::bigint, 'CN-00037'::text),
      (392::bigint, 'CN-00040'::text),
      (383::bigint, 'CN-00048'::text)
    ) AS v(plan_id, buyer_code)
    JOIN shipping_plans sp ON sp.id = v.plan_id
   WHERE NULLIF(BTRIM(sp.bl_no), '') IS NOT NULL
), affected_bills AS (
  SELECT b.*
    FROM freight_supplier_bills b
    JOIN target_ocean_freight t ON t.bl_no = b.bl_no
   WHERE UPPER(COALESCE(NULLIF(b.currency_norm, ''), NULLIF(b.currency, ''))) = 'USD'
     AND COALESCE(b.sale_amount, 0) > 0
     AND COALESCE(b.rebill_status, '') <> 'voided'
     AND (
       COALESCE(b.cost_category, '') ~* '海运|ocean|freight'
       OR COALESCE(b.canonical_category, '') ~* '海运|ocean|freight'
       OR b.raw->>'kind' = 'freight_rate_sale'
     )
)
INSERT INTO backfill_decouple_fields_0725_backup (target_table, target_id, before_row)
SELECT 'freight_supplier_bills', id::text, to_jsonb(affected_bills)
  FROM affected_bills
ON CONFLICT (target_table, target_id) DO NOTHING;

WITH target_ocean_freight AS (
  SELECT sp.id AS plan_id, sp.bl_no, v.buyer_code
    FROM (VALUES
      (410::bigint, 'CN-00037'::text),
      (392::bigint, 'CN-00040'::text),
      (383::bigint, 'CN-00048'::text)
    ) AS v(plan_id, buyer_code)
    JOIN shipping_plans sp ON sp.id = v.plan_id
   WHERE NULLIF(BTRIM(sp.bl_no), '') IS NOT NULL
)
UPDATE freight_supplier_bills b
   SET direction = 'receivable',
       ownership_scope = 'logistics',
       counterparty_company_code = t.buyer_code,
       payer_company_code = t.buyer_code
  FROM target_ocean_freight t
 WHERE b.bl_no = t.bl_no
   AND UPPER(COALESCE(NULLIF(b.currency_norm, ''), NULLIF(b.currency, ''))) = 'USD'
   AND COALESCE(b.sale_amount, 0) > 0
   AND COALESCE(b.rebill_status, '') <> 'voided'
   AND (
     COALESCE(b.cost_category, '') ~* '海运|ocean|freight'
     OR COALESCE(b.canonical_category, '') ~* '海运|ocean|freight'
     OR b.raw->>'kind' = 'freight_rate_sale'
   )
   AND (
     b.direction IS DISTINCT FROM 'receivable'
     OR b.ownership_scope IS DISTINCT FROM 'logistics'
     OR b.counterparty_company_code IS DISTINCT FROM t.buyer_code
     OR b.payer_company_code IS DISTINCT FROM t.buyer_code
   );

-- [Claude 审:删除本地CNY行 direction=payable 批量标注] payer_company_code 语义=应收方(谁付我们),
-- 标 payable 方向存疑且涉2000+行; 且巴匕本地费是否入我方AR未定。留到 Phase 2b lens 口径确定后再处理。

WITH target_ocean_freight AS (
  SELECT sp.id AS plan_id, sp.bl_no
    FROM shipping_plans sp
   WHERE sp.id IN (410, 392, 383)
)
SELECT 'ocean_freight_check' AS check_name,
       t.plan_id,
       b.bl_no,
       b.currency,
       b.currency_norm,
       b.direction,
       b.ownership_scope,
       b.counterparty_company_code,
       b.payer_company_code,
       b.sale_amount
  FROM target_ocean_freight t
  JOIN freight_supplier_bills b ON b.bl_no = t.bl_no
 WHERE UPPER(COALESCE(NULLIF(b.currency_norm, ''), NULLIF(b.currency, ''))) = 'USD'
   AND COALESCE(b.sale_amount, 0) > 0
 ORDER BY t.plan_id, b.id;

SELECT 'plan461_check' AS check_name,
       sp.id,
       sp.trade_owner_company_id,
       sp.trade_owner_kind,
       sp.logistics_provider_company_id,
       sp.logistics_provider_kind,
       c.code AS logistics_provider_code,
       COALESCE(c.name_cn, c.name_en) AS logistics_provider_name
  FROM shipping_plans sp
  LEFT JOIN companies c ON c.id = sp.logistics_provider_company_id
 WHERE sp.id = 461;

COMMIT;
