INSERT INTO freight_supplier_bills (
  supplier, supplier_type, bl_no, cost_category, amount, currency, qty, unit_price,
  rebill_status, link_plan_id, raw, created_at, updated_at, supplier_company_code,
  charge_basis, payer_company_code, sale_amount, canonical_category, currency_norm
)
SELECT
  COALESCE(cf.name_cn, cf.name_en, sp.forwarder_cn, '待补') AS supplier,
  'forwarder' AS supplier_type,
  sp.bl_no,
  '海运费' AS cost_category,
  COALESCE(sp.freight_cost, 0) AS amount,
  'USD' AS currency,
  sp.container_qty AS qty,
  CASE WHEN COALESCE(sp.container_qty, 0) > 0 THEN COALESCE(sp.freight_cost, 0) / sp.container_qty ELSE NULL END AS unit_price,
  'pending' AS rebill_status,
  sp.id AS link_plan_id,
  jsonb_build_object(
    'kind', 'freight_rate_sale',
    'shipping_plan_id', sp.id,
    'materialized_by', 'D20260629-materialize-freight-receivable'
  ) AS raw,
  NOW(),
  NOW(),
  cf.code AS supplier_company_code,
  'per_container' AS charge_basis,
  cp.code AS payer_company_code,
  sp.freight_sale_usd AS sale_amount,
  '海运费' AS canonical_category,
  'USD' AS currency_norm
FROM shipping_plans sp
JOIN companies cp ON cp.id = sp.customer_company_id
LEFT JOIN companies cf ON cf.id = sp.forwarder_company_id
WHERE COALESCE(sp.freight_sale_usd, 0) > 0
  AND NULLIF(sp.bl_no, '') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM freight_supplier_bills b
    WHERE b.bl_no = sp.bl_no
      AND b.raw->>'kind' = 'freight_rate_sale'
  );
