function clean(value) {
  return value == null ? "" : String(value).trim();
}

function firstRow(result) {
  return result && Array.isArray(result.rows) ? result.rows[0] || null : null;
}

function canonicalShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    code: row.code || null,
    name_cn: row.name_cn || null,
    name_en: row.name_en || null,
    type: row.type || null,
  };
}

export async function resolveCompany(pool, keyOrName) {
  const key = clean(keyOrName);
  if (!key) return null;

  const byCode = firstRow(await pool.query(
    `SELECT id, code, name_cn, name_en, type
       FROM companies
      WHERE UPPER(BTRIM(code)) = UPPER(BTRIM($1))
        AND (active IS NOT FALSE)
      ORDER BY id
      LIMIT 1`,
    [key]
  ));
  if (byCode) return canonicalShape(byCode);

  const byExactName = firstRow(await pool.query(
    `SELECT id, code, name_cn, name_en, type
       FROM companies
      WHERE (BTRIM(COALESCE(name_cn, '')) = BTRIM($1)
          OR BTRIM(COALESCE(name_en, '')) = BTRIM($1))
        AND (active IS NOT FALSE)
      ORDER BY (NULLIF(BTRIM(COALESCE(code, '')), '') IS NULL), id
      LIMIT 1`,
    [key]
  ));
  if (byExactName) return canonicalShape(byExactName);

  const byFuzzyName = firstRow(await pool.query(
    `SELECT id, code, name_cn, name_en, type
       FROM companies
      WHERE (name_cn ILIKE '%' || $1 || '%'
          OR name_en ILIKE '%' || $1 || '%')
        AND (active IS NOT FALSE)
      ORDER BY (NULLIF(BTRIM(COALESCE(code, '')), '') IS NULL),
               length(COALESCE(name_cn, name_en, '')),
               id
      LIMIT 1`,
    [key]
  ));
  return canonicalShape(byFuzzyName);
}

export async function resolveCustomerCanonical(pool, planCustomerCompanyId) {
  const id = Number(planCustomerCompanyId);
  if (!Number.isInteger(id) || id <= 0) return null;

  const source = firstRow(await pool.query(
    `SELECT id, code, name_cn, name_en, type
       FROM companies
      WHERE id = $1
        AND (active IS NOT FALSE)
      LIMIT 1`,
    [id]
  ));
  if (!source) return null;

  const names = [clean(source.name_cn), clean(source.name_en)].filter(Boolean);
  if (!names.length) return canonicalShape(source);

  const canonical = firstRow(await pool.query(
    `SELECT id, code, name_cn, name_en, type
       FROM companies
      WHERE (active IS NOT FALSE)
        AND NULLIF(BTRIM(COALESCE(code, '')), '') IS NOT NULL
        AND (
          BTRIM(COALESCE(name_cn, '')) = ANY($1::text[])
          OR BTRIM(COALESCE(name_en, '')) = ANY($1::text[])
        )
      ORDER BY (type = 'customer') DESC, id
      LIMIT 1`,
    [names]
  ));
  return canonicalShape(canonical || source);
}
