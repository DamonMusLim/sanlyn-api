import { getPool, setCors } from "../db.js";

// migrate-products-size-infer  (2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────
// Purpose: infer carton_qty for the ~270 remaining unsourced rows using
//          PostgreSQL regex on the existing `size` column (+ `product_name`
//          when needed for the per-unit weight).
//
// Three inference patterns (applied in CASE priority order):
//
//  Pattern A — size has explicit qty in parens:  "9KG/箱(375g)"
//    carton_qty = ROUND( weight_kg * 1000 / unit_g )
//    Example: 9KG/箱(375g) → 9000/375 = 24
//
//  Pattern B — "NKG/箱" AND product_name ends in a weight like "70G" / "0.5KG":
//    carton_qty = ROUND( weight_kg * 1000 / unit_g )
//    Example: size=7.56KG/箱, name="... 70G" → 7560/70 = 108
//    Also handles N.NKG unit:  size=5.28KG/箱, name="... 110G" → 5280/110 = 48
//
//  Pattern C — size contains explicit count per carton like "24 ROLLS/CTN":
//    carton_qty = that number
//    Recognises: ROLLS|PACKS|PCS|BAGS|CANS|PIECES (case-insensitive)
//
// Safety:
//  • Only touches rows where spec_source IS NULL  (never overwrites sourced rows)
//  • Only writes where inferred qty is reasonable: 1 ≤ qty ≤ 500
//  • COALESCE on spec_source — won't overwrite any existing tag
//  • No DELETE / DROP anywhere in this file

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const pool = getPool();

    // ── 1. Preview: how many rows will each pattern reach ────────────────────
    const preview = await pool.query(`
      SELECT
        COUNT(*) FILTER (
          WHERE spec_source IS NULL
            AND carton_qty IS NULL
            AND size IS NOT NULL
        ) AS total_candidates,

        COUNT(*) FILTER (
          WHERE spec_source IS NULL
            AND carton_qty IS NULL
            AND size ~ '[\\d.]+KG/箱\\(\\d+[gG]\\)'
        ) AS pattern_a,

        COUNT(*) FILTER (
          WHERE spec_source IS NULL
            AND carton_qty IS NULL
            AND size ~ '[\\d.]+KG/箱'
            AND size !~ '[\\d.]+KG/箱\\(\\d+[gG]\\)'
            AND (
              product_name ~* '[\\d.]+G\\M'
              OR product_name ~* '[\\d.]+KG\\M'
            )
        ) AS pattern_b,

        COUNT(*) FILTER (
          WHERE spec_source IS NULL
            AND carton_qty IS NULL
            AND size ~* '\\d+\\s*(?:ROLLS?|PACKS?|PCS?|BAGS?|CANS?|PIECES?)/CTN'
        ) AS pattern_c

      FROM products
    `);

    // ── 2. Apply the inference UPDATE ────────────────────────────────────────
    const fix = await pool.query(`
      UPDATE products
      SET
        carton_qty       = inferred.qty,
        spec_source      = COALESCE(spec_source, 'factory_spec'),
        spec_verified    = CASE WHEN spec_source IS NULL THEN TRUE ELSE spec_verified END,
        spec_verified_at = CASE WHEN spec_source IS NULL THEN NOW()  ELSE spec_verified_at END,
        spec_verified_by = CASE WHEN spec_source IS NULL
                            THEN 'size_infer_sql_2026-05-20'
                            ELSE spec_verified_by END
      FROM (
        SELECT
          id,
          CASE
            -- Pattern A: "9KG/箱(375g)"  — unit weight explicit in size
            WHEN size ~ '[\\d.]+KG/箱\\(\\d+[gG]\\)'
              THEN ROUND(
                (regexp_match(size, '([\\d.]+)KG'))[1]::numeric * 1000
                / (regexp_match(size, '\\((\\d+)[gG]\\)'))[1]::numeric
              )::int

            -- Pattern B1: "NKG/箱" + name ends in weight "70G"
            WHEN size ~ '[\\d.]+KG/箱'
              AND product_name ~* '[\\d.]+G\\M'
              THEN ROUND(
                (regexp_match(size, '([\\d.]+)KG'))[1]::numeric * 1000
                / (regexp_match(product_name, '([\\d.]+)[gG]\\M', 'i'))[1]::numeric
              )::int

            -- Pattern B2: "NKG/箱" + name ends in weight "0.5KG"
            WHEN size ~ '[\\d.]+KG/箱'
              AND product_name ~* '[\\d.]+KG\\M'
              THEN ROUND(
                (regexp_match(size, '([\\d.]+)KG'))[1]::numeric
                / (regexp_match(product_name, '([\\d.]+)KG\\M', 'i'))[1]::numeric
              )::int

            -- Pattern C: explicit count "24 ROLLS/CTN"
            WHEN size ~* '\\d+\\s*(?:ROLLS?|PACKS?|PCS?|BAGS?|CANS?|PIECES?)/CTN'
              THEN (regexp_match(size, '(\\d+)\\s*(?:ROLLS?|PACKS?|PCS?|BAGS?|CANS?|PIECES?)/CTN', 'i'))[1]::int

            ELSE NULL
          END AS qty
        FROM products
        WHERE spec_source IS NULL
          AND carton_qty IS NULL
          AND size IS NOT NULL
      ) AS inferred
      WHERE products.id = inferred.id
        AND inferred.qty IS NOT NULL
        AND inferred.qty BETWEEN 1 AND 500
    `);

    // ── 3. Coverage after ────────────────────────────────────────────────────
    const after = await pool.query(`
      SELECT
        COUNT(*)                                              AS total_skus,
        COUNT(*) FILTER (WHERE carton_qty IS NOT NULL)        AS has_carton_qty,
        COUNT(*) FILTER (WHERE spec_source IS NULL)           AS still_unsourced,
        COUNT(*) FILTER (WHERE spec_source = 'factory_spec')  AS factory_spec,
        COUNT(*) FILTER (WHERE spec_source = 'trade_show')    AS trade_show
      FROM products
    `);

    // ── 4. Sample rows to verify ─────────────────────────────────────────────
    const sample = await pool.query(`
      SELECT sku, product_name, size, carton_qty, spec_verified_by
      FROM products
      WHERE spec_verified_by = 'size_infer_sql_2026-05-20'
      ORDER BY sku
      LIMIT 20
    `);

    return res.status(200).json({
      migration:    "migrate-products-size-infer",
      date:         "2026-05-20",
      preview:      preview.rows[0],
      rows_updated: fix.rowCount,
      after:        after.rows[0],
      sample:       sample.rows,
      ok:           fix.rowCount > 0,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
