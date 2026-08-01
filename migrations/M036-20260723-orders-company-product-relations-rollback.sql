-- M036 rollback skeleton for a human-approved apply.
-- Prefer restoring from the pg_dump taken immediately before apply.
-- This script only removes M036 metadata/schema additions and nulls columns
-- whose values were introduced by M036 where that can be done without
-- recovering overwritten state. Because M036 backfills are fill-empty only,
-- exact old non-null values should be restored from backup/audit if needed.

BEGIN;

DELETE FROM field_lookups
WHERE lookup_key IN (
  'orders.seller.name_cn',
  'orders.seller.name_en',
  'orders.seller.tax_id',
  'orders.seller.address',
  'orders.buyer.name_cn',
  'orders.buyer.name_en',
  'orders.buyer.tax_id',
  'orders.buyer.address',
  'orders.factory.name_cn',
  'orders.factory.name_en',
  'orders.factory.tax_id',
  'orders.factory.address'
);

DELETE FROM field_relations
WHERE relation_key IN (
  'orders.seller_company_id__companies.id',
  'orders.buyer_company_id__companies.id',
  'orders.customer_company_id__companies.id',
  'orders.issuing_company_id__companies.id',
  'orders.operating_company_id__companies.id',
  'orders.owner_company_id__companies.id',
  'orders.factory_company_id__companies.id',
  'orders.supplier_company_id__companies.id',
  'orders.trader_company_id__companies.id',
  'orders.id__order_line_items.order_id',
  'order_line_items.product_id__products.id',
  'order_line_items.sku__products.sku'
);

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_seller_company_id_fkey;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_buyer_company_id_fkey;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_customer_company_id_fkey;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_issuing_company_id_fkey;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_operating_company_id_fkey;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_owner_company_id_fkey;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_factory_company_id_fkey;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_supplier_company_id_fkey;
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_trader_company_id_fkey;
ALTER TABLE seller_profiles DROP CONSTRAINT IF EXISTS seller_profiles_company_id_fkey;

DROP INDEX IF EXISTS idx_orders_seller_company_id;
DROP INDEX IF EXISTS idx_orders_buyer_company_id;
DROP INDEX IF EXISTS idx_orders_customer_company_id;
DROP INDEX IF EXISTS idx_orders_issuing_company_id;
DROP INDEX IF EXISTS idx_orders_factory_company_id;
DROP INDEX IF EXISTS idx_orders_supplier_company_id;
DROP INDEX IF EXISTS idx_orders_trader_company_id;
DROP INDEX IF EXISTS idx_seller_profiles_company_id;

-- Only drop columns after confirming no later code depends on them.
-- ALTER TABLE orders DROP COLUMN IF EXISTS seller_company_id;
-- ALTER TABLE orders DROP COLUMN IF EXISTS buyer_company_id;
-- ALTER TABLE orders DROP COLUMN IF EXISTS customer_company_id;
-- ALTER TABLE orders DROP COLUMN IF EXISTS issuing_company_id;
-- ALTER TABLE orders DROP COLUMN IF EXISTS operating_company_id;
-- ALTER TABLE orders DROP COLUMN IF EXISTS owner_company_id;
-- ALTER TABLE orders DROP COLUMN IF EXISTS supplier_company_id;
-- ALTER TABLE orders DROP COLUMN IF EXISTS supplier_role_at_hop;
-- ALTER TABLE orders DROP COLUMN IF EXISTS trader_company_id;
-- ALTER TABLE seller_profiles DROP COLUMN IF EXISTS company_id;
-- ALTER TABLE partner_relationships DROP COLUMN IF EXISTS role_at_hop;

ROLLBACK;
