ALTER TABLE slip_uploads
  ADD COLUMN IF NOT EXISTS customer_selected_shipments TEXT[];
