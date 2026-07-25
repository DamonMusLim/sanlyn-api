BEGIN;

-- Phase 1 schema foundation only:
-- - add relation/ownership columns as nullable
-- - add company_relations
-- - create Shanghai Xiangwei as an external logistics partner shell record
-- - refresh active_freight_supplier_bills with the existing columns preserved,
--   appending direction/counterparty_company_code/ownership_scope at the end

CREATE TABLE IF NOT EXISTS company_relations (
  id BIGSERIAL PRIMARY KEY,
  from_company_id BIGINT NOT NULL REFERENCES companies(id),
  to_company_id BIGINT NOT NULL REFERENCES companies(id),
  relation TEXT NOT NULL CHECK (relation IN ('supplier','customer','logistics_partner')),
  status TEXT NOT NULL DEFAULT 'active',
  effective_from DATE,
  effective_to DATE,
  notes TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (from_company_id, to_company_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_company_relations_to_relation
  ON company_relations (to_company_id, relation);

ALTER TABLE shipping_plans
  ADD COLUMN IF NOT EXISTS trade_owner_company_id BIGINT REFERENCES companies(id),
  ADD COLUMN IF NOT EXISTS trade_owner_kind TEXT CHECK (trade_owner_kind IN ('internal','external')),
  ADD COLUMN IF NOT EXISTS logistics_provider_company_id BIGINT REFERENCES companies(id),
  ADD COLUMN IF NOT EXISTS logistics_provider_kind TEXT CHECK (logistics_provider_kind IN ('internal','external'));

ALTER TABLE freight_supplier_bills
  ADD COLUMN IF NOT EXISTS direction TEXT CHECK (direction IN ('receivable','payable','both')),
  ADD COLUMN IF NOT EXISTS counterparty_company_code TEXT,
  ADD COLUMN IF NOT EXISTS ownership_scope TEXT CHECK (ownership_scope IN ('trade','logistics','shared'));

-- External logistics partner shell record. Full legal name and tax_id are pending operations confirmation.
-- Code follows imported external company convention such as CN-00028 (Wanhui) and CN-00033 (COSCO logistics).
INSERT INTO companies (code, name_cn, name_en, type, country, tax_id, notes)
VALUES (
  'CN-00080',
  '上海祥威',
  'Shanghai Xiangwei',
  'forwarder',
  'CN',
  NULL,
  '外部物流方(logistics_partner); 全称与tax_id待上线补齐'
)
ON CONFLICT (code) DO NOTHING;

CREATE OR REPLACE VIEW active_freight_supplier_bills AS
  SELECT
    id,
    supplier,
    supplier_type,
    bill_month,
    bill_file,
    bl_no,
    container_no,
    cost_category,
    amount,
    currency,
    qty,
    unit_price,
    pair_id,
    rebill_status,
    incoterm,
    link_plan_id,
    link_agency_id,
    reconciled,
    reconcile_note,
    source_row,
    raw,
    created_at,
    updated_at,
    supplier_company_code,
    charge_basis,
    is_standard,
    remarks,
    detention_days,
    payer_company_code,
    sale_amount,
    canonical_category,
    currency_norm,
    govern_flag,
    rebill_to_type,
    rebill_to_name,
    rebill_dn_no,
    rebill_finance_slip_id,
    confirmed_at,
    confirmed_by,
    ap_status,
    ap_paid_amount,
    ap_paid_at,
    ar_status,
    ar_paid_amount,
    ar_paid_at,
    payment_note,
    payment_updated_by,
    payment_updated_at,
    fob_scope,
    direction,
    counterparty_company_code,
    ownership_scope
  FROM freight_supplier_bills
  WHERE COALESCE(rebill_status, ''::text) <> 'voided'::text;

COMMIT;
