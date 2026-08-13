-- M063: 写入闸触发器 (只纠不拦 + data_guard_log 留痕; 224w教训:绝不阻断写入) 2026-08-13
CREATE OR REPLACE FUNCTION trg_oli_subtotal_guard() RETURNS trigger AS $fn$
DECLARE calc numeric;
BEGIN
  IF NEW.qty_ctn IS NOT NULL AND NEW.factory_price IS NOT NULL THEN
    calc := ROUND(NEW.qty_ctn * NEW.factory_price, 2);
    IF NEW.factory_subtotal IS DISTINCT FROM calc THEN
      INSERT INTO data_guard_log(table_name, row_key, field, old_value, new_value, reason, created_at)
      VALUES ('order_line_items', COALESCE(NEW.id::text,'new'), 'factory_subtotal',
              NEW.factory_subtotal::text, calc::text, 'subtotal_autocalc', now());
      NEW.factory_subtotal := calc;
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS oli_subtotal_guard ON order_line_items;
CREATE TRIGGER oli_subtotal_guard BEFORE INSERT OR UPDATE ON order_line_items
FOR EACH ROW EXECUTE FUNCTION trg_oli_subtotal_guard();

CREATE OR REPLACE FUNCTION trg_orders_zero_amount_guard() RETURNS trigger AS $fn$
BEGIN
  IF NEW.customer_amount = 0 AND COALESCE(NEW.total_amount,0) > 0 THEN
    INSERT INTO data_guard_log(table_name, row_key, field, old_value, new_value, reason, created_at)
    VALUES ('orders', COALESCE(NEW.order_no, NEW.id::text), 'customer_amount', '0', NULL, 'zero_to_null', now());
    NEW.customer_amount := NULL;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS orders_zero_amount_guard ON orders;
CREATE TRIGGER orders_zero_amount_guard BEFORE INSERT OR UPDATE ON orders
FOR EACH ROW EXECUTE FUNCTION trg_orders_zero_amount_guard();
