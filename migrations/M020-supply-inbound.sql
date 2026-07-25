CREATE TABLE IF NOT EXISTS inbound_deliveries (
  id BIGSERIAL PRIMARY KEY,
  supplier_code TEXT NOT NULL,
  factory_code TEXT NOT NULL,
  customer_code TEXT,
  material_sku TEXT NOT NULL,
  procured_by TEXT NOT NULL DEFAULT 'sanlyn' CHECK (procured_by IN ('sanlyn','factory','customer')),
  order_qty NUMERIC(14,3),
  real_qty NUMERIC(14,3),
  expected_delivery DATE,
  confirmed_delivery DATE,
  delivery_driver TEXT,
  vehicle_plate TEXT,
  express_no TEXT,
  delivery_address TEXT,
  status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','shipped','arrived','cancelled')),
  note TEXT,
  supplier_note TEXT,
  factory_note TEXT,
  customer_note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE inbound_deliveries
  ADD COLUMN IF NOT EXISTS customer_code TEXT,
  ADD COLUMN IF NOT EXISTS procured_by TEXT NOT NULL DEFAULT 'sanlyn',
  ADD COLUMN IF NOT EXISTS real_qty NUMERIC(14,3),
  ADD COLUMN IF NOT EXISTS supplier_note TEXT,
  ADD COLUMN IF NOT EXISTS factory_note TEXT,
  ADD COLUMN IF NOT EXISTS customer_note TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inbound_deliveries_procured_by_chk'
  ) THEN
    ALTER TABLE inbound_deliveries
      ADD CONSTRAINT inbound_deliveries_procured_by_chk
      CHECK (procured_by IN ('sanlyn','factory','customer')) NOT VALID;
  END IF;
END $$;

ALTER TABLE packaging_materials
  ADD COLUMN IF NOT EXISTS image_url TEXT,
  ADD COLUMN IF NOT EXISTS artwork_url TEXT,
  ADD COLUMN IF NOT EXISTS dimensions TEXT;

CREATE TABLE IF NOT EXISTS inbound_delivery_attachments (
  id BIGSERIAL PRIMARY KEY,
  delivery_id BIGINT NOT NULL REFERENCES inbound_deliveries(id) ON DELETE CASCADE,
  attachment_type TEXT NOT NULL CHECK (attachment_type IN ('image','artwork','receipt')),
  url TEXT NOT NULL,
  uploaded_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_deliveries_material_sku
  ON inbound_deliveries (material_sku);

CREATE INDEX IF NOT EXISTS idx_inbound_deliveries_factory_code
  ON inbound_deliveries (factory_code);

CREATE INDEX IF NOT EXISTS idx_inbound_deliveries_supplier_code
  ON inbound_deliveries (supplier_code);

CREATE INDEX IF NOT EXISTS idx_inbound_deliveries_customer_code
  ON inbound_deliveries (customer_code);

CREATE INDEX IF NOT EXISTS idx_inbound_attachments_delivery_id
  ON inbound_delivery_attachments (delivery_id);
