-- ════════════════════════════════════════════════════════════════════════
-- 021_customers_currency_backup.sql  —  ROLLBACK SNAPSHOT (2026-05-22)
-- Captures customers.currency BEFORE the buyer→CNY backfill (script 022).
-- To revert the currency整改, run these UPDATEs.
-- Only the role_type='customer' rows that were flipped are listed.
-- ════════════════════════════════════════════════════════════════════════
UPDATE customers SET currency='USD' WHERE company_code='CN-00004';
UPDATE customers SET currency='USD' WHERE company_code='CN-00005';
UPDATE customers SET currency='USD' WHERE company_code='CN-00031';
UPDATE customers SET currency='USD' WHERE company_code='CN-00032';
UPDATE customers SET currency='USD' WHERE company_code='CN-00036';
UPDATE customers SET currency='USD' WHERE company_code='CN-00037';
UPDATE customers SET currency='USD' WHERE company_code='CN-00038';
UPDATE customers SET currency='USD' WHERE company_code='CN-00040';
UPDATE customers SET currency='USD' WHERE company_code='CN-00041';
UPDATE customers SET currency='USD' WHERE company_code='CN-00042';
UPDATE customers SET currency='USD' WHERE company_code='CN-00043';
UPDATE customers SET currency='USD' WHERE company_code='CN-00044';
UPDATE customers SET currency='USD' WHERE company_code='CN-00045';
UPDATE customers SET currency='USD' WHERE company_code='CN-00046';
UPDATE customers SET currency='USD' WHERE company_code='CN-00047';
UPDATE customers SET currency='USD' WHERE company_code='CN-00049';
UPDATE customers SET currency='USD' WHERE company_code='CN-00050';
-- (CN-00039 DIBAQ and CN-00048 HARMONIOUS were already CNY — not touched.)
