ALTER TABLE product_master
  ADD COLUMN IF NOT EXISTS image_urls text[],
  ADD COLUMN IF NOT EXISTS image_ocr_text text;

INSERT INTO product_field_default_ownership
  (field_name, owner, accept_source_updates, sensitivity)
VALUES
  ('image_urls', 'ours', false, 'normal'),
  ('image_ocr_text', 'ours', false, 'normal')
ON CONFLICT (field_name) DO NOTHING;

CREATE TABLE IF NOT EXISTS petstore_sku_sync_conflicts (
  id bigserial PRIMARY KEY,
  product_code text NOT NULL,
  field text NOT NULL,
  tencent_value text,
  mini_value text,
  resolution text NOT NULL CHECK (
    resolution IN ('keep_tencent', 'prefer_mini', 'needs_damon', 'resolved')
  ),
  resolved_value text,
  resolved_by text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS petstore_sku_sync_conflicts_product_field_uidx
  ON petstore_sku_sync_conflicts (product_code, field);
