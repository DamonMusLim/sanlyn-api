export async function loadMarketTruthForCodes(pool, codes) {
  if (!codes.length) return { quotesByCode: {}, excludedByCode: {}, refByCode: {} };

  const valid = await pool.query(`
    SELECT
      id, product_code, store_name, source, source_tier, matched_title, spec_text,
      price, orig_price, monthly_sales, match_conf, captured_at, qty_g, unit_price,
      exclude_reason, is_soft_excluded
    FROM (
      SELECT
        q.*,
        row_number() OVER (
          PARTITION BY q.product_code
          ORDER BY
            CASE WHEN q.is_soft_excluded THEN 1 ELSE 0 END,
            COALESCE(q.monthly_sales, 0) DESC,
            q.captured_at DESC,
            q.id DESC
        ) AS rn
      FROM petstore_valid_quotes q
      WHERE q.product_code = ANY($1)
    ) t
    WHERE rn <= 8
    ORDER BY product_code, is_soft_excluded ASC, COALESCE(monthly_sales, 0) DESC, captured_at DESC, id DESC
  `, [codes]);

  const excluded = await pool.query(`
    SELECT
      id, product_code, store_name, source, source_tier, matched_title, spec_text,
      price, orig_price, monthly_sales, match_conf, captured_at, qty_g, unit_price,
      exclude_reason
    FROM (
      SELECT
        q.*,
        row_number() OVER (
          PARTITION BY q.product_code
          ORDER BY q.captured_at DESC, q.id DESC
        ) AS rn
      FROM petstore_market_quotes q
      WHERE q.product_code = ANY($1)
        AND q.is_comparable = false
    ) t
    WHERE rn <= 20
    ORDER BY product_code, captured_at DESC, id DESC
  `, [codes]);

  const quotesByCode = {};
  const excludedByCode = {};
  const refByCode = {};

  for (const q of valid.rows) {
    const { product_code: code, ...quote } = q;
    if (!quotesByCode[code]) quotesByCode[code] = [];
    quotesByCode[code].push(quote);

    if (!refByCode[code]) {
      refByCode[code] = {
        value: q.is_soft_excluded ? null : q.price,
        source_table: "petstore_market_quotes",
        source_id: q.id,
        store_name: q.store_name,
        spec_text: q.spec_text,
        monthly_sales: q.monthly_sales,
        captured_at: q.captured_at,
        basis: q.is_soft_excluded ? "soft_low_sales" : "valid_comparable_quote",
      };
    }
  }

  for (const q of excluded.rows) {
    const { product_code: code, ...quote } = q;
    if (!excludedByCode[code]) excludedByCode[code] = [];
    excludedByCode[code].push(quote);
  }

  return { quotesByCode, excludedByCode, refByCode };
}
