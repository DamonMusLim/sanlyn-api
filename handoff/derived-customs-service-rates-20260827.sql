-- 从 freight_supplier_bills 历史账单倒推报关历史成交价。
-- 人工执行前建议外层包事务空跑；本文件不自带事务提交，避免被部署自动执行。
-- 规则：一条账单一行，不聚合、不平均；同 bill_id 已导入则跳过。
-- amount 原样写入 rate；0 元是明确不收费，必须原样导入，不当空值处理。
-- customs_port 只取关联 shipping_plans.pol：先按 link_plan_id，缺失时按 bl_no/hbl_no；不按供应商或名称猜。

WITH src AS (
  SELECT
    b.id,
    b.bl_no,
    b.bill_month,
    b.supplier,
    b.supplier_company_code,
    b.link_plan_id,
    b.amount,
    b.currency,
    c.id AS executor_company_id,
    sp.pol AS customs_port
  FROM freight_supplier_bills b
  LEFT JOIN companies c ON c.code = b.supplier_company_code
  LEFT JOIN LATERAL (
    SELECT sp0.pol
      FROM shipping_plans sp0
     WHERE (
             NULLIF(BTRIM(b.link_plan_id), '') IS NOT NULL
             AND (sp0._id = b.link_plan_id OR sp0.id::text = b.link_plan_id)
           )
        OR (
             NULLIF(BTRIM(b.link_plan_id), '') IS NULL
             AND NULLIF(BTRIM(b.bl_no), '') IS NOT NULL
             AND (sp0.bl_no = b.bl_no OR sp0.hbl_no = b.bl_no)
           )
     ORDER BY sp0.updated_at DESC NULLS LAST, sp0.id DESC
     LIMIT 1
  ) sp ON TRUE
  WHERE b.cost_category = '报关费'
),
inserted AS (
  INSERT INTO service_rates (
    service,
    price_side,
    executor_company_id,
    rate,
    currency,
    customs_port,
    valid_from,
    valid_to,
    unit,
    source,
    raw,
    is_active
  )
  SELECT
    'customs',
    'cost',
    src.executor_company_id,
    src.amount,
    src.currency,
    src.customs_port,
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
      'cost_category', '报关费'
    ),
    TRUE
  FROM src
  WHERE NOT EXISTS (
    SELECT 1
      FROM service_rates existing
     WHERE existing.source = 'derived_from_bills'
       AND existing.raw->>'bill_id' = src.id::text
  )
  RETURNING executor_company_id, customs_port, rate
)
SELECT
  (SELECT COUNT(*) FROM src)::int AS source_rows,
  (SELECT COUNT(*) FROM inserted)::int AS inserted_rows,
  (SELECT COUNT(*) FROM src WHERE executor_company_id IS NULL)::int AS company_unmatched_source_rows,
  (SELECT COUNT(*) FROM src WHERE customs_port IS NOT NULL)::int AS with_customs_port_source_rows,
  (SELECT COUNT(*) FROM src WHERE amount = 0)::int AS zero_amount_source_rows,
  (SELECT COUNT(*) FROM src WHERE amount IS NULL)::int AS null_amount_source_rows;
