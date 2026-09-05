-- Fill missing field_definitions.label_cn from reviewed HGJ blueprint mappings.
-- Review only; safe to run inside outer transaction preview.
-- Only updates label_cn IS NULL and never overwrites existing Chinese labels.

WITH module_map(module_cn, module_key) AS (
  VALUES
    ('费用明细', 'freight_supplier_bills'),
    ('账单管理', 'freight_bills'),
    ('开票记录', 'finance_invoices_in'),
    ('收付管理', 'finance_payments'),
    ('核销管理', 'finance_settlement_links'),
    ('海运出口', 'shipping_plans'),
    ('待接单', 'orders'),
    ('报关信息', 'customs_declarations'),
    ('箱货信息', 'containers'),
    ('客户列表', 'companies'),
    ('供应商列表', 'companies'),
    ('往来公司审核', 'companies'),
    ('单票报价', 'service_rates'),
    ('费用模板', 'local_charges')
),
mapped_labels AS (
  SELECT
    h.mapped_module_key AS module_key,
    h.mapped_field_key AS field_key,
    h.col_label_cn AS label_cn,
    min(h.col_order) AS first_col_order,
    count(*) AS source_count
  FROM hgj_blueprint_columns h
  JOIN module_map mm
    ON mm.module_cn = h.module_cn
   AND mm.module_key = h.mapped_module_key
  WHERE h.mapped_module_key IS NOT NULL
    AND h.mapped_field_key IS NOT NULL
    AND h.col_label_cn IS NOT NULL
  GROUP BY h.mapped_module_key, h.mapped_field_key, h.col_label_cn
),
ranked AS (
  SELECT
    ml.*,
    row_number() OVER (
      PARTITION BY ml.module_key, ml.field_key
      ORDER BY ml.source_count DESC, ml.first_col_order, ml.label_cn
    ) AS rn
  FROM mapped_labels ml
)
UPDATE field_definitions fd
SET label_cn = r.label_cn
FROM ranked r
WHERE r.rn = 1
  AND fd.module_key = r.module_key
  AND fd.field_key = r.field_key
  AND fd.label_cn IS NULL;
