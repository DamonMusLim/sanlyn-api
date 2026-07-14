ALTER TABLE customs_declaration_items ADD COLUMN IF NOT EXISTS fob_usd NUMERIC(14,2);
ALTER TABLE customs_declaration_items ADD COLUMN IF NOT EXISTS fob_usd_source TEXT;
ALTER TABLE customs_declaration_items ADD COLUMN IF NOT EXISTS source_system TEXT;
ALTER TABLE customs_declaration_items ADD COLUMN IF NOT EXISTS raw JSONB;
ALTER TABLE customs_declarations ADD COLUMN IF NOT EXISTS source_system TEXT;
ALTER TABLE customs_declarations ADD COLUMN IF NOT EXISTS raw JSONB;
ALTER TABLE customs_declarations ADD COLUMN IF NOT EXISTS rebate_period TEXT;
ALTER TABLE customs_declarations ADD COLUMN IF NOT EXISTS rebate_batch TEXT;

DO $$
DECLARE
  dupes TEXT;
BEGIN
  SELECT string_agg(declaration_no || ':' || cnt, ', ' ORDER BY declaration_no)
    INTO dupes
    FROM (
      SELECT declaration_no, COUNT(*) AS cnt
        FROM customs_declarations
       WHERE declaration_no IS NOT NULL
       GROUP BY declaration_no
      HAVING COUNT(*) > 1
    ) d;

  IF dupes IS NOT NULL THEN
    RAISE EXCEPTION 'duplicate customs_declarations.declaration_no found before unique index: %', dupes;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_customs_declarations_no ON customs_declarations(declaration_no);
CREATE INDEX IF NOT EXISTS idx_customs_declarations_rebate_batch ON customs_declarations(rebate_period, rebate_batch);
