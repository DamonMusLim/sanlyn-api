CREATE TABLE IF NOT EXISTS inbound_deliveries (
  id BIGSERIAL PRIMARY KEY,
  supplier_code TEXT NOT NULL,
  factory_code TEXT NOT NULL,
  material_sku TEXT NOT NULL,
  order_qty NUMERIC(14,3),
  expected_arrival DATE,
  delivery_address TEXT,
  status TEXT NOT NULL DEFAULT 'ordered' CHECK (status IN ('ordered','shipped','arrived','cancelled')),
  note TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inbound_deliveries_supplier_code
  ON inbound_deliveries (supplier_code);

CREATE INDEX IF NOT EXISTS idx_inbound_deliveries_factory_code
  ON inbound_deliveries (factory_code);
