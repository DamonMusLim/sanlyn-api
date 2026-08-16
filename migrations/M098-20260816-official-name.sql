ALTER TABLE product_master
  ADD COLUMN IF NOT EXISTS official_name text;

ALTER TABLE product_master
  ADD COLUMN IF NOT EXISTS official_name_src text;

INSERT INTO product_field_default_ownership
  (field_name, owner, accept_source_updates, sensitivity, notes)
VALUES
  ('official_name', 'ours', false, 'normal', 'official product name extracted from package OCR text'),
  ('official_name_src', 'ours', false, 'normal', 'source evidence for official_name extraction')
ON CONFLICT DO NOTHING;
