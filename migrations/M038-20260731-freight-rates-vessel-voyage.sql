ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS vessel_name text;
ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS voyage_no text;
ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS vessel_parse_confidence text;
