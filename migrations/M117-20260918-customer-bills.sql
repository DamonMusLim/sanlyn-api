CREATE TABLE IF NOT EXISTS customer_bills (
  id BIGSERIAL PRIMARY KEY,
  plan_id BIGINT,
  bl_no TEXT,
  payer_company_code TEXT,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('fob_invoice','fob_portcharge','exw_invoice')),
  seq INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','confirmed','void')),
  doc_no TEXT,
  issue_date DATE,
  fx_rate NUMERIC,
  total_usd NUMERIC,
  total_cny NUMERIC,
  line_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  fingerprint TEXT,
  legacy BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ,
  sent_by TEXT,
  magic_link_id BIGINT,
  confirmed_at TIMESTAMPTZ,
  confirmed_by_name TEXT,
  confirmed_ip TEXT,
  voided_at TIMESTAMPTZ,
  voided_by TEXT,
  void_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_customer_bills_active_scope
  ON customer_bills (bl_no, payer_company_code, doc_type, seq)
  WHERE status <> 'void';

CREATE INDEX IF NOT EXISTS idx_customer_bills_plan ON customer_bills(plan_id);
CREATE INDEX IF NOT EXISTS idx_customer_bills_magic_link ON customer_bills(magic_link_id);

CREATE TABLE IF NOT EXISTS customer_bill_events (
  id BIGSERIAL PRIMARY KEY,
  bill_id BIGINT NOT NULL REFERENCES customer_bills(id) ON DELETE CASCADE,
  event TEXT NOT NULL CHECK (event IN ('created','price_changed','sent','viewed','commented','confirmed','voided','legacy_registered')),
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('staff','customer','system')),
  actor TEXT,
  note TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_bill_events_bill ON customer_bill_events(bill_id, created_at);

ALTER TABLE freight_supplier_bills
  ADD COLUMN IF NOT EXISTS customer_bill_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_fsb_customer_bill_id
  ON freight_supplier_bills(customer_bill_id);

ALTER TABLE freight_supplier_bills
  DROP CONSTRAINT IF EXISTS fk_fsb_customer_bill;

ALTER TABLE freight_supplier_bills
  ADD CONSTRAINT fk_fsb_customer_bill
  FOREIGN KEY (customer_bill_id) REFERENCES customer_bills(id);

CREATE OR REPLACE FUNCTION guard_customer_bill_locked_fsb()
RETURNS trigger AS $$
DECLARE
  locked_status TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    SELECT status INTO locked_status FROM customer_bills WHERE id = OLD.customer_bill_id;
    IF locked_status = 'confirmed' THEN
      RAISE EXCEPTION 'customer_bill_locked';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD.customer_bill_id IS NOT NULL THEN
    SELECT status INTO locked_status FROM customer_bills WHERE id = OLD.customer_bill_id;
    IF locked_status = 'confirmed' AND (
      OLD.amount IS DISTINCT FROM NEW.amount OR
      OLD.sale_amount IS DISTINCT FROM NEW.sale_amount OR
      OLD.qty IS DISTINCT FROM NEW.qty OR
      OLD.unit_price IS DISTINCT FROM NEW.unit_price OR
      OLD.currency IS DISTINCT FROM NEW.currency OR
      OLD.payer_company_code IS DISTINCT FROM NEW.payer_company_code OR
      OLD.rebill_status IS DISTINCT FROM NEW.rebill_status
    ) THEN
      RAISE EXCEPTION 'customer_bill_locked';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_customer_bill_locked_fsb ON freight_supplier_bills;
CREATE TRIGGER trg_guard_customer_bill_locked_fsb
  BEFORE UPDATE OR DELETE ON freight_supplier_bills
  FOR EACH ROW EXECUTE FUNCTION guard_customer_bill_locked_fsb();
