-- Handoff only. Do not run until Hanlong duplicate active tax_id is resolved.
-- Requirement: companies.tax_id cannot duplicate among active companies.
-- Inactive merged trace rows may keep duplicate tax_id, so the unique index is partial.

-- 1) Precheck: must return zero rows before creating the unique index.
SELECT
  NULLIF(btrim(tax_id), '') AS tax_id,
  count(*) AS active_company_count,
  jsonb_agg(
    jsonb_build_object(
      'id', id,
      'code', code,
      'name_cn', name_cn,
      'type', type,
      'active', active,
      'merged_into_code', merged_into_code
    )
    ORDER BY code
  ) AS active_companies
FROM companies
WHERE active IS TRUE
  AND NULLIF(btrim(tax_id), '') IS NOT NULL
GROUP BY NULLIF(btrim(tax_id), '')
HAVING count(*) > 1
ORDER BY active_company_count DESC, tax_id;

-- 2) Run only after the precheck returns zero rows.
CREATE UNIQUE INDEX IF NOT EXISTS companies_active_tax_id_uidx
  ON companies (tax_id)
  WHERE active IS TRUE
    AND NULLIF(btrim(tax_id), '') IS NOT NULL;
