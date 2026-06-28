-- ══════════════════════════════════════════════════════════════════
-- DEPRECATED FIELD RENAME PLAN — shipping_plans
-- Generated: 2026-05-09
-- Status: DO NOT EXECUTE until:
--   1. contract_no backfill is complete (128 → target <20 manual)
--   2. Logistics scoping in api/db/shipping.js is updated to JOIN companies
--      (forwarder_cn / customs_cn are currently used by role="logistics" scoping)
--   3. AdminPanel.jsx and customer portal code is updated to not reference these columns
-- ══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- 1. customer → _deprecated_customer
-- ─────────────────────────────────────────────────────────────────
-- Impact       : 56 rows have non-null values (33% of 169)
-- Frontend refs: app/components/src/screens/admin/AdminPanel.jsx:1800
--                  shipping_plans column list includes "customer"
--                app/components/src/screens/admin/AdminPanel.jsx:2229
--                  customer column special render
--                app/components/src/screens/admin/ConfigCenter/matrixData.js:157
--                  m.shipping.customer = true
-- Replace with : JOIN orders ON orders.contract_no = shipping_plans.contract_no → orders.customer
-- Pre-condition: contract_no backfill ≥ 95% complete
--
ALTER TABLE shipping_plans RENAME COLUMN customer TO _deprecated_customer;
-- Rollback:
-- ALTER TABLE shipping_plans RENAME COLUMN _deprecated_customer TO customer;

-- ─────────────────────────────────────────────────────────────────
-- 2. forwarder_cn → _deprecated_forwarder_cn
-- ─────────────────────────────────────────────────────────────────
-- Impact       : 42 rows have non-null values (25% of 169)
-- Frontend refs: app/components/src/screens/freight/LogisticsFinanceTab.jsx:86
--                  p.forwarder_cn used in forwarder display
-- API refs     : api/db/shipping.js — logistics role scoping uses forwarder_cn ILIKE
-- Replace with : JOIN companies ON companies.name_cn ILIKE shipping_plans.forwarder_cn
--                WHERE companies.role = 'forwarder'
-- Pre-condition: Update logistics scoping in shipping.js to use companies JOIN
--
ALTER TABLE shipping_plans RENAME COLUMN forwarder_cn TO _deprecated_forwarder_cn;
-- Rollback:
-- ALTER TABLE shipping_plans RENAME COLUMN _deprecated_forwarder_cn TO forwarder_cn;

-- ─────────────────────────────────────────────────────────────────
-- 3. customs_cn → _deprecated_customs_cn
-- ─────────────────────────────────────────────────────────────────
-- Impact       : 6 rows have non-null values (4% of 169)
-- Frontend refs: app/components/src/screens/customer/CustomerLogistics.jsx:177
--                  uses customs_cn to detect full-service customer
-- API refs     : api/db/shipping.js — logistics role scoping uses customs_cn ILIKE
-- Replace with : JOIN companies WHERE role = 'customs'
-- Pre-condition: Update logistics scoping + CustomerLogistics.jsx
--
ALTER TABLE shipping_plans RENAME COLUMN customs_cn TO _deprecated_customs_cn;
-- Rollback:
-- ALTER TABLE shipping_plans RENAME COLUMN _deprecated_customs_cn TO customs_cn;

-- ─────────────────────────────────────────────────────────────────
-- 4. trucking_cn → _deprecated_trucking_cn
-- ─────────────────────────────────────────────────────────────────
-- Impact       : 1 row has non-null value (<1% of 169)
-- Frontend refs: api/db/shipping.js — logistics role scoping uses trucking_cn ILIKE
-- Replace with : JOIN trucking_rates ON vendor_cn
-- Pre-condition: Update logistics scoping in shipping.js
-- NOTE         : Lowest risk, can be renamed first after scoping update
--
ALTER TABLE shipping_plans RENAME COLUMN trucking_cn TO _deprecated_trucking_cn;
-- Rollback:
-- ALTER TABLE shipping_plans RENAME COLUMN _deprecated_trucking_cn TO trucking_cn;

-- ─────────────────────────────────────────────────────────────────
-- 5. cargo_description → _deprecated_cargo_description
-- ─────────────────────────────────────────────────────────────────
-- Impact       : 12 rows have non-null values (7% of 169)
-- Frontend refs: No direct column reference found in admin modules
-- Replace with : JOIN orders.cargo_description or products.description
-- Pre-condition: Verify no API/portal code reads this column directly
--
ALTER TABLE shipping_plans RENAME COLUMN cargo_description TO _deprecated_cargo_description;
-- Rollback:
-- ALTER TABLE shipping_plans RENAME COLUMN _deprecated_cargo_description TO cargo_description;

-- ─────────────────────────────────────────────────────────────────
-- 6. shipper → _deprecated_shipper
-- ─────────────────────────────────────────────────────────────────
-- Impact       : 13 rows have non-null values (8% of 169)
-- Frontend refs: No direct column reference found in admin modules
-- Replace with : JOIN factories or companies WHERE role = 'shipper'
-- Pre-condition: Verify no doc generation code reads this column
--
ALTER TABLE shipping_plans RENAME COLUMN shipper TO _deprecated_shipper;
-- Rollback:
-- ALTER TABLE shipping_plans RENAME COLUMN _deprecated_shipper TO shipper;

-- ─────────────────────────────────────────────────────────────────
-- 7. product_notes → _deprecated_product_notes
-- ─────────────────────────────────────────────────────────────────
-- Impact       : 3 rows have non-null values (2% of 169)
-- Frontend refs: No direct column reference found in admin modules
-- Replace with : JOIN orders.product_notes
-- Pre-condition: Lowest risk; can be done early
--
ALTER TABLE shipping_plans RENAME COLUMN product_notes TO _deprecated_product_notes;
-- Rollback:
-- ALTER TABLE shipping_plans RENAME COLUMN _deprecated_product_notes TO product_notes;

-- ══════════════════════════════════════════════════════════════════
-- RECOMMENDED EXECUTION ORDER (from lowest to highest risk):
-- 1. product_notes    (2% impact, no frontend refs)
-- 2. trucking_cn      (1% impact, only logistics scoping)
-- 3. cargo_description (7% impact, no frontend refs)
-- 4. shipper          (8% impact, no frontend refs)
-- 5. customs_cn       (4% impact, CustomerLogistics.jsx + logistics scoping)
-- 6. forwarder_cn     (25% impact, LogisticsFinanceTab.jsx + logistics scoping)
-- 7. customer         (33% impact, AdminPanel.jsx + matrixData.js)
-- ══════════════════════════════════════════════════════════════════
