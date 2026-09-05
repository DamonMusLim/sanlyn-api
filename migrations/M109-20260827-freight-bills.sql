-- M109: freight bill headers and bill items.
-- No transaction terminator; run inside caller-managed BEGIN/ROLLBACK for dry-run.

CREATE TABLE IF NOT EXISTS freight_bills (
  id BIGSERIAL PRIMARY KEY,
  bill_no TEXT NOT NULL UNIQUE CHECK (bill_no ~ '^BI[0-9]{12}$'),
  direction TEXT NOT NULL CHECK (direction IN ('AR', 'AP')),
  settlement_company_code TEXT NOT NULL REFERENCES companies(code),
  invoice_head_code TEXT,
  currency TEXT NOT NULL,
  total_amount NUMERIC NOT NULL CHECK (total_amount >= 0),
  invoiced_amount NUMERIC NOT NULL DEFAULT 0,
  verified_amount NUMERIC NOT NULL DEFAULT 0,
  bill_date DATE NOT NULL DEFAULT CURRENT_DATE,
  remarks TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'void')),
  CHECK (invoiced_amount >= 0 AND verified_amount >= 0),
  CHECK (invoiced_amount <= total_amount),
  CHECK (verified_amount <= total_amount)
);

CREATE TABLE IF NOT EXISTS freight_bill_items (
  id BIGSERIAL PRIMARY KEY,
  bill_id BIGINT NOT NULL REFERENCES freight_bills(id) ON DELETE CASCADE,
  fee_id UUID NOT NULL REFERENCES freight_supplier_bills(id),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bill_id, fee_id)
);

CREATE INDEX IF NOT EXISTS idx_freight_bills_filters
  ON freight_bills (direction, settlement_company_code, status, bill_date);

CREATE INDEX IF NOT EXISTS idx_freight_bill_items_bill
  ON freight_bill_items (bill_id);

CREATE INDEX IF NOT EXISTS idx_freight_bill_items_fee
  ON freight_bill_items (fee_id);

CREATE OR REPLACE FUNCTION freight_bill_items_one_active_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status TEXT;
  conflict_bill_no TEXT;
BEGIN
  SELECT status INTO parent_status
    FROM freight_bills
   WHERE id = NEW.bill_id;

  IF parent_status IS DISTINCT FROM 'void' THEN
    PERFORM 1
      FROM freight_supplier_bills
     WHERE id = NEW.fee_id
     FOR UPDATE;

    SELECT b.bill_no INTO conflict_bill_no
      FROM freight_bill_items i
      JOIN freight_bills b ON b.id = i.bill_id
     WHERE i.fee_id = NEW.fee_id
       AND i.id IS DISTINCT FROM NEW.id
       AND b.status <> 'void'
     LIMIT 1;

    IF conflict_bill_no IS NOT NULL THEN
      RAISE EXCEPTION 'fee % already belongs to active freight bill %', NEW.fee_id, conflict_bill_no
        USING ERRCODE = '23505';
    END IF;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_freight_bill_items_one_active ON freight_bill_items;
CREATE TRIGGER trg_freight_bill_items_one_active
BEFORE INSERT OR UPDATE OF bill_id, fee_id ON freight_bill_items
FOR EACH ROW EXECUTE FUNCTION freight_bill_items_one_active_guard();

CREATE OR REPLACE FUNCTION freight_bills_status_reactivate_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  duplicate_fee UUID;
BEGIN
  IF NEW.status <> 'void' AND OLD.status = 'void' THEN
    SELECT i.fee_id INTO duplicate_fee
      FROM freight_bill_items i
      JOIN freight_bill_items other_i ON other_i.fee_id = i.fee_id
      JOIN freight_bills other_b ON other_b.id = other_i.bill_id
     WHERE i.bill_id = NEW.id
       AND other_i.bill_id <> NEW.id
       AND other_b.status <> 'void'
     LIMIT 1;

    IF duplicate_fee IS NOT NULL THEN
      RAISE EXCEPTION 'cannot reactivate bill %, fee % is already on another active bill', NEW.bill_no, duplicate_fee
        USING ERRCODE = '23505';
    END IF;
  END IF;

  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_freight_bills_status_reactivate ON freight_bills;
CREATE TRIGGER trg_freight_bills_status_reactivate
BEFORE UPDATE OF status ON freight_bills
FOR EACH ROW EXECUTE FUNCTION freight_bills_status_reactivate_guard();

CREATE OR REPLACE VIEW v_freight_bill_fee_status AS
WITH active_items AS (
  SELECT i.*, b.status
    FROM freight_bill_items i
    JOIN freight_bills b ON b.id = i.bill_id
   WHERE b.status <> 'void'
)
SELECT
  f.id AS fee_id,
  f.bl_no,
  f.cost_category,
  f.direction AS fee_direction,
  f.supplier_company_code,
  f.payer_company_code,
  f.currency,
  CASE
    WHEN fbi.bill_id IS NULL THEN '账单未建立'
    WHEN COALESCE(b.invoiced_amount, 0) = 0 AND COALESCE(b.verified_amount, 0) = 0 THEN '未核销未开票'
    WHEN b.invoiced_amount >= b.total_amount AND COALESCE(b.verified_amount, 0) = 0 THEN '已开票未核销'
    WHEN COALESCE(b.invoiced_amount, 0) = 0 AND b.verified_amount >= b.total_amount THEN '已核销未开票'
    WHEN b.invoiced_amount >= b.total_amount AND b.verified_amount > 0 AND b.verified_amount < b.total_amount THEN '已开票部分核销'
    WHEN b.invoiced_amount > 0 AND b.invoiced_amount < b.total_amount AND COALESCE(b.verified_amount, 0) = 0 THEN '部分开票未核销'
    WHEN COALESCE(b.invoiced_amount, 0) = 0 AND b.verified_amount > 0 AND b.verified_amount < b.total_amount THEN '部分核销未开票'
    WHEN b.invoiced_amount >= b.total_amount AND b.verified_amount >= b.total_amount THEN '已完成'
    ELSE '已开票部分核销'
  END AS derived_fee_status,
  b.id AS bill_id,
  b.bill_no,
  b.direction AS bill_direction,
  b.settlement_company_code,
  b.invoice_head_code,
  b.total_amount,
  b.invoiced_amount,
  b.verified_amount,
  b.bill_date,
  b.status AS bill_status
FROM freight_supplier_bills f
LEFT JOIN active_items fbi ON fbi.fee_id = f.id
LEFT JOIN freight_bills b ON b.id = fbi.bill_id;

COMMENT ON VIEW v_freight_bill_fee_status IS
  'Derived freight fee status; freight_supplier_bills.fee_status remains untouched.';
