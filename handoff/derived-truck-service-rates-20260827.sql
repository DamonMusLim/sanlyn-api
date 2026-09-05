-- 从 freight_supplier_bills 历史账单倒推拖车历史成交价。
-- 人工执行前建议外层包 BEGIN/ROLLBACK 空跑；本文件不自带 COMMIT，避免被部署自动执行。
-- 规则：一条账单一行，不聚合、不平均；同 bill_id 已导入则跳过。

WITH src AS (
  SELECT
    b.id,
    b.bl_no,
    b.bill_month,
    b.supplier,
    b.supplier_company_code,
    b.amount,
    b.currency,
    c.id AS executor_company_id,
    sp.pol,
    cb.container_type
  FROM freight_supplier_bills b
  LEFT JOIN companies c ON c.code = b.supplier_company_code
  LEFT JOIN LATERAL (
    SELECT sp0.id, sp0.pol
      FROM shipping_plans sp0
     WHERE NULLIF(BTRIM(b.bl_no), '') IS NOT NULL
       AND (sp0.bl_no = b.bl_no OR sp0.hbl_no = b.bl_no)
     ORDER BY sp0.updated_at DESC NULLS LAST, sp0.id DESC
     LIMIT 1
  ) sp ON TRUE
  LEFT JOIN LATERAL (
    SELECT CASE
             WHEN COUNT(DISTINCT NULLIF(BTRIM(cb0.container_type), '')) = 1
             THEN MAX(NULLIF(BTRIM(cb0.container_type), ''))
             ELSE NULL
           END AS container_type
      FROM container_bookings cb0
     WHERE (sp.id IS NOT NULL AND cb0.shipping_plan_id = sp.id)
        OR (sp.id IS NULL AND NULLIF(BTRIM(b.bl_no), '') IS NOT NULL AND cb0.bl_no = b.bl_no)
  ) cb ON TRUE
  WHERE b.cost_category = '拖车费'
    AND COALESCE(b.supplier, '') NOT IN ('洋宝宝', '录入表单')
),
inserted AS (
  INSERT INTO service_rates (
    service,
    price_side,
    executor_company_id,
    rate,
    currency,
    pol,
    container_type,
    valid_from,
    valid_to,
    unit,
    source,
    raw,
    is_active
  )
  SELECT
    'truck',
    'cost',
    src.executor_company_id,
    src.amount,
    src.currency,
    src.pol,
    src.container_type,
    NULL,
    NULL,
    'per_bill',
    'derived_from_bills',
    jsonb_build_object(
      'from', 'freight_supplier_bills',
      'bill_id', src.id::text,
      'bl_no', src.bl_no,
      'bill_month', src.bill_month,
      'supplier_raw', src.supplier,
      'supplier_company_code', src.supplier_company_code,
      'cost_category', '拖车费',
      'amount', src.amount,
      'currency', src.currency
    ),
    TRUE
  FROM src
  WHERE NOT EXISTS (
    SELECT 1
      FROM service_rates existing
     WHERE existing.source = 'derived_from_bills'
       AND existing.raw->>'bill_id' = src.id::text
  )
  RETURNING executor_company_id
)
SELECT
  (SELECT COUNT(*) FROM src)::int AS source_rows,
  (SELECT COUNT(*) FROM inserted)::int AS inserted_rows,
  (SELECT COUNT(*) FROM src WHERE executor_company_id IS NULL)::int AS company_unmatched_source_rows,
  (SELECT COUNT(*) FROM src WHERE pol IS NOT NULL)::int AS with_pol_source_rows,
  (SELECT COUNT(*) FROM src WHERE container_type IS NOT NULL)::int AS with_container_type_source_rows;
