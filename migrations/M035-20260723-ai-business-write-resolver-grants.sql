-- M035: M2b resolver incremental grants. Run as database owner/superuser.
-- Existing role sanlyn_ai_resolver is reused; this file does not recreate it.

CREATE TABLE IF NOT EXISTS ai_business_write_audit (
  id bigserial PRIMARY KEY,
  action text NOT NULL,
  target_table text NOT NULL,
  target_pk text NOT NULL,
  old_payload jsonb NOT NULL,
  new_payload jsonb NOT NULL,
  source_payload jsonb,
  verify_sql_hash text NOT NULL,
  rollback_payload jsonb NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  actor text NOT NULL DEFAULT 'business-write-resolver',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE ai_business_write_audit ADD COLUMN IF NOT EXISTS source_payload jsonb;
ALTER TABLE ai_business_write_audit ADD COLUMN IF NOT EXISTS actor text NOT NULL DEFAULT 'business-write-resolver';

GRANT INSERT, SELECT ON ai_business_write_audit TO sanlyn_ai_resolver;
GRANT USAGE, SELECT ON SEQUENCE ai_business_write_audit_id_seq TO sanlyn_ai_resolver;

GRANT SELECT (id, order_id, sku, product_id) ON order_line_items TO sanlyn_ai_resolver;
GRANT UPDATE (product_id) ON order_line_items TO sanlyn_ai_resolver;

GRANT SELECT (id, sku, factory_code) ON products TO sanlyn_ai_resolver;
GRANT SELECT (id, code) ON companies TO sanlyn_ai_resolver;

DO $$
DECLARE
  factory_col text;
  order_id_col text;
  plan_select_cols text;
BEGIN
  SELECT string_agg(format('%I', column_name), ', ') INTO plan_select_cols
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='shipping_plans'
    AND column_name IN ('id','order_nos','contract_no','order_contract_nos','bl_no','hbl_no','mbl_no',
                        'so_no','booking_no','forwarder_booking_no','raw','updated_at');

  IF plan_select_cols IS NULL OR position('order_nos' in plan_select_cols)=0 THEN
    RAISE EXCEPTION 'shipping_plans required columns not found';
  END IF;

  EXECUTE format('GRANT SELECT (%s) ON shipping_plans TO sanlyn_ai_resolver', plan_select_cols);
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='shipping_plans' AND column_name='updated_at'
  ) THEN
    GRANT UPDATE (order_nos, updated_at) ON shipping_plans TO sanlyn_ai_resolver;
  ELSE
    GRANT UPDATE (order_nos) ON shipping_plans TO sanlyn_ai_resolver;
  END IF;

  SELECT column_name INTO factory_col
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='orders'
    AND column_name IN ('factory_company_id','factory_code')
  ORDER BY CASE column_name WHEN 'factory_company_id' THEN 0 ELSE 1 END
  LIMIT 1;

  IF factory_col IS NULL THEN
    RAISE EXCEPTION 'orders factory association column not found';
  END IF;

  SELECT column_name INTO order_id_col
  FROM information_schema.columns
  WHERE table_schema='public' AND table_name='orders'
    AND column_name IN ('id','_id')
  ORDER BY CASE column_name WHEN 'id' THEN 0 ELSE 1 END
  LIMIT 1;

  EXECUTE format('GRANT SELECT (%I, order_no, contract_no, %I) ON orders TO sanlyn_ai_resolver',
                 order_id_col, factory_col);
  EXECUTE format('GRANT UPDATE (%I) ON orders TO sanlyn_ai_resolver', factory_col);
END $$;

-- Privilege self-check: run these as sanlyn_ai_resolver. Every statement below must fail.
-- UPDATE orders SET total_amount = total_amount WHERE id = (SELECT id FROM orders LIMIT 1);
-- UPDATE orders SET status = status WHERE id = (SELECT id FROM orders LIMIT 1);
-- UPDATE order_line_items SET subtotal = subtotal WHERE id = (SELECT id FROM order_line_items LIMIT 1);
-- DELETE FROM order_line_items WHERE id = (SELECT id FROM order_line_items LIMIT 1);
-- TRUNCATE shipping_plans;
-- CREATE TABLE ai_resolver_should_not_create(id int);
