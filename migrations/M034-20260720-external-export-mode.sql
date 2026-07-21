ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS client_mode VARCHAR(16) NOT NULL DEFAULT 'internal';

ALTER TABLE companies
  DROP CONSTRAINT IF EXISTS companies_client_mode_check;

ALTER TABLE companies
  ADD CONSTRAINT companies_client_mode_check
  CHECK (client_mode IN ('internal','external','daigou'));

ALTER TABLE orders
  ALTER COLUMN export_mode TYPE VARCHAR(16);

ALTER TABLE orders
  ALTER COLUMN export_mode SET DEFAULT 'direct';

ALTER TABLE orders
  DROP CONSTRAINT IF EXISTS orders_export_mode_check;

ALTER TABLE orders
  ADD CONSTRAINT orders_export_mode_check
  CHECK (export_mode IN ('direct','daigou','external'));

ALTER TABLE order_line_items
  ADD COLUMN IF NOT EXISTS is_external_temp BOOLEAN DEFAULT FALSE;

UPDATE companies
   SET client_mode = 'external'
 WHERE code = 'CN-00077';

UPDATE orders
   SET export_mode = 'external'
 WHERE order_no = 'TLN-TRK-20260701'
    OR contract_no = 'TLN-TRK-20260701';
