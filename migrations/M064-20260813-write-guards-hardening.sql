-- M064: 写入闸加固(codex回审) — 留痕失败绝不中断业务写入(EXCEPTION兜底) 2026-08-13
CREATE OR REPLACE FUNCTION trg_oli_subtotal_guard() RETURNS trigger AS $fn$
DECLARE calc numeric;
BEGIN
  IF NEW.qty_ctn IS NOT NULL AND NEW.factory_price IS NOT NULL THEN
    calc := ROUND(NEW.qty_ctn * NEW.factory_price, 2);
    IF NEW.factory_subtotal IS DISTINCT FROM calc THEN
      BEGIN
        INSERT INTO data_guard_log(table_name, row_key, field, old_value, new_value, reason, created_at)
        VALUES ('order_line_items', COALESCE(NEW.id::text,'new'), 'factory_subtotal',
                NEW.factory_subtotal::text, calc::text, 'subtotal_autocalc', now());
      EXCEPTION WHEN OTHERS THEN NULL; -- 留痕失败不拦业务
      END;
      NEW.factory_subtotal := calc;
    END IF;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_orders_zero_amount_guard() RETURNS trigger AS $fn$
BEGIN
  IF NEW.customer_amount = 0 AND COALESCE(NEW.total_amount,0) > 0 THEN
    BEGIN
      INSERT INTO data_guard_log(table_name, row_key, field, old_value, new_value, reason, created_at)
      VALUES ('orders', COALESCE(NEW.order_no, NEW.id::text), 'customer_amount', '0', NULL, 'zero_to_null', now());
    EXCEPTION WHEN OTHERS THEN NULL;
    END;
    NEW.customer_amount := NULL;
  END IF;
  RETURN NEW;
END $fn$ LANGUAGE plpgsql;
