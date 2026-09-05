-- M108: fee tax rules with effective periods.
-- Rules are defaults for future entry only; historical freight_supplier_bills.tax_rate
-- and tax_amount remain invoice facts and are not backfilled here.

CREATE TABLE IF NOT EXISTS fee_tax_rules (
  id BIGSERIAL PRIMARY KEY,
  cost_category TEXT NOT NULL,
  default_tax_rate NUMERIC NOT NULL CHECK (default_tax_rate >= 0),
  invoice_type TEXT,
  effective_from DATE NOT NULL,
  effective_to DATE,
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  UNIQUE (cost_category, invoice_type, effective_from)
);

COMMENT ON TABLE fee_tax_rules IS
  'Default invoice tax rules by fee category and effective period. Historical bill tax fields remain facts.';
COMMENT ON COLUMN fee_tax_rules.cost_category IS
  'Matches freight_supplier_bills.cost_category or a manually confirmed category group.';
COMMENT ON COLUMN fee_tax_rules.default_tax_rate IS
  'Default tax rate for future entry; do not use to rewrite historical freight_supplier_bills rows.';
COMMENT ON COLUMN fee_tax_rules.invoice_type IS
  'Invoice type text. No CHECK until an existing canonical enum is confirmed.';
COMMENT ON COLUMN fee_tax_rules.effective_to IS
  'NULL means effective until superseded.';

CREATE INDEX IF NOT EXISTS idx_fee_tax_rules_category_period
  ON fee_tax_rules (cost_category, effective_from, effective_to);
