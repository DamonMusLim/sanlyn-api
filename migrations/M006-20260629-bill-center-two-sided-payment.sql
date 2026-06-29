ALTER TABLE freight_supplier_bills ADD COLUMN IF NOT EXISTS ap_status text DEFAULT 'unpaid';
ALTER TABLE freight_supplier_bills ADD COLUMN IF NOT EXISTS ap_paid_amount numeric DEFAULT 0;
ALTER TABLE freight_supplier_bills ADD COLUMN IF NOT EXISTS ap_paid_at timestamptz;
ALTER TABLE freight_supplier_bills ADD COLUMN IF NOT EXISTS ar_status text DEFAULT 'unpaid';
ALTER TABLE freight_supplier_bills ADD COLUMN IF NOT EXISTS ar_paid_amount numeric DEFAULT 0;
ALTER TABLE freight_supplier_bills ADD COLUMN IF NOT EXISTS ar_paid_at timestamptz;
ALTER TABLE freight_supplier_bills ADD COLUMN IF NOT EXISTS payment_note text;
ALTER TABLE freight_supplier_bills ADD COLUMN IF NOT EXISTS payment_updated_by text;
ALTER TABLE freight_supplier_bills ADD COLUMN IF NOT EXISTS payment_updated_at timestamptz;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fsb_ap_status_chk') THEN
    ALTER TABLE freight_supplier_bills ADD CONSTRAINT fsb_ap_status_chk CHECK (ap_status IN ('unpaid','partial','paid'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='fsb_ar_status_chk') THEN
    ALTER TABLE freight_supplier_bills ADD CONSTRAINT fsb_ar_status_chk CHECK (ar_status IN ('unpaid','partial','paid'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_fsb_supplier_ap ON freight_supplier_bills (supplier_company_code, ap_status, bl_no);
CREATE INDEX IF NOT EXISTS idx_fsb_payer_ar ON freight_supplier_bills (payer_company_code, ar_status, bl_no);
CREATE INDEX IF NOT EXISTS idx_fsb_bl ON freight_supplier_bills (bl_no);
CREATE INDEX IF NOT EXISTS idx_magic_bill_scope ON magic_links (recipient_role, ((meta->>'bill_scope')), expires_at);
