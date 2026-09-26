BEGIN;

DO $$
BEGIN
  IF to_regclass('public.customers') IS NULL THEN
    RAISE EXCEPTION 'missing view public.customers';
  END IF;

  IF to_regclass('public.customers_legacy_20260803') IS NULL THEN
    RAISE EXCEPTION 'missing table public.customers_legacy_20260803';
  END IF;

  IF to_regclass('public.migration_customer_map_20260803') IS NULL THEN
    RAISE EXCEPTION 'missing table public.migration_customer_map_20260803';
  END IF;

  IF EXISTS (
    SELECT company_code
    FROM public.customers_legacy_20260803
    WHERE company_code IS NOT NULL
    GROUP BY company_code
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'customers_legacy_20260803.company_code has duplicates';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.bak_customers_legacy_20260803_before_iot_20260812 AS
SELECT *, now() AS backup_created_at
FROM public.customers_legacy_20260803;

CREATE TABLE IF NOT EXISTS public.bak_migration_customer_map_20260803_before_iot_20260812 AS
SELECT *, now() AS backup_created_at
FROM public.migration_customer_map_20260803;

CREATE TABLE IF NOT EXISTS public.bak_customers_viewdef_before_iot_20260812 AS
SELECT
  pg_get_viewdef('public.customers'::regclass, true) AS view_ddl,
  now() AS backup_created_at;

DROP TRIGGER IF EXISTS trg_customers_instead_of_write ON public.customers;
DROP FUNCTION IF EXISTS public.customers_instead_of_write();

CREATE OR REPLACE FUNCTION public.customers_instead_of_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  set_list text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION '新客户请先在公司主数据(companies)建档，再挂客户档'
      USING ERRCODE = 'check_violation';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_code IS NULL THEN
      RAISE EXCEPTION 'company_code 为空，无法定位客户记录'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.id IS DISTINCT FROM OLD.id THEN
      RAISE EXCEPTION 'customers.id is read-only'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.legacy_customer_id IS DISTINCT FROM OLD.legacy_customer_id THEN
      RAISE EXCEPTION 'customers.legacy_customer_id is read-only'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.company_code IS DISTINCT FROM OLD.company_code THEN
      RAISE EXCEPTION 'company_code 是定位键，禁止在客户视图层修改；请通过公司主数据(companies)流程处理'
        USING ERRCODE = 'check_violation';
    END IF;

    SELECT string_agg(
      CASE
        WHEN v.column_name = 'updated_at' THEN
          format(
            '%1$I = CASE WHEN ($1).%1$I IS DISTINCT FROM ($2).%1$I AND ($1).%1$I IS NOT NULL THEN ($1).%1$I ELSE now() END',
            v.column_name
          )
        ELSE
          format('%1$I = ($1).%1$I', v.column_name)
      END,
      E',\n      '
      ORDER BY v.ordinal_position
    )
    INTO set_list
    FROM information_schema.columns v
    JOIN information_schema.columns l
      ON l.table_schema = 'public'
     AND l.table_name = 'customers_legacy_20260803'
     AND l.column_name = v.column_name
    WHERE v.table_schema = 'public'
      AND v.table_name = 'customers'
      AND v.column_name NOT IN ('id', 'legacy_customer_id', 'company_code', 'is_active');

    IF set_list IS NULL THEN
      RAISE EXCEPTION 'no writable intersection columns between customers view and legacy table';
    END IF;

    EXECUTE format(
      'UPDATE public.customers_legacy_20260803
       SET %s
       WHERE company_code = ($1).company_code',
      set_list
    )
    USING NEW, OLD;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'legacy customer not found for company_code=%', NEW.company_code;
    END IF;

    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF OLD.company_code IS NULL THEN
      RAISE EXCEPTION 'company_code 为空，无法定位客户记录'
        USING ERRCODE = 'check_violation';
    END IF;

    UPDATE public.customers_legacy_20260803
    SET is_active = false,
        updated_at = now()
    WHERE company_code = OLD.company_code;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'legacy customer not found for company_code=%', OLD.company_code;
    END IF;

    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_customers_instead_of_write
INSTEAD OF INSERT OR UPDATE OR DELETE ON public.customers
FOR EACH ROW
EXECUTE FUNCTION public.customers_instead_of_write();

COMMIT;
