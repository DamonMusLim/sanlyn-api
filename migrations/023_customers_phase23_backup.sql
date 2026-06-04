-- ════════════════════════════════════════════════════════════════════════
-- 023_customers_phase23_backup.sql  —  ROLLBACK SNAPSHOT (2026-05-22)
-- Reverts the Phase 2/3 cleanup (script 024).
-- ════════════════════════════════════════════════════════════════════════
UPDATE customers SET is_active=true WHERE company_code='CN-00009';
UPDATE customers SET is_active=true WHERE company_code='CN-00063';
UPDATE customers SET is_active=true WHERE company_code='CN-00065';
UPDATE customers SET country='中国' WHERE company_code='CN-00043';
UPDATE customers SET country='中国' WHERE company_code='CN-00045';
