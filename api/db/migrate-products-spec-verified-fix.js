import { getPool, setCors } from "../db.js";

// migrate-products-spec-verified-fix (2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────
// Bug: COALESCE(spec_verified, TRUE) in migration 003 always returns FALSE
//      because the column DEFAULT is FALSE, not NULL.
//      Result: all 231 factory_spec rows show spec_verified=FALSE after writein.
//
// Fix: directly SET spec_verified = TRUE for all rows where:
//   spec_source = 'factory_spec'  (written by factory-confirmed Excel)
//   spec_verified = FALSE          (not yet flipped)
//
// Also stamps spec_verified_at = NOW() for audit trail.
// Safe to re-run (idempotent — WHERE spec_verified = FALSE skips already-fixed rows).

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const pool = getPool();

    // 1. Count before
    const before = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE spec_source = 'factory_spec' AND spec_verified = TRUE)  AS factory_verified,
        COUNT(*) FILTER (WHERE spec_source = 'factory_spec' AND spec_verified = FALSE) AS factory_unverified
      FROM products
    `);

    // 2. Fix: stamp spec_verified = TRUE for all factory_spec rows
    const fix = await pool.query(`
      UPDATE products
      SET    spec_verified    = TRUE,
             spec_verified_at = COALESCE(spec_verified_at, NOW())
      WHERE  spec_source  = 'factory_spec'
        AND  spec_verified = FALSE
    `);

    // 3. Full coverage after
    const after = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE spec_verified = TRUE)                    AS total_verified,
        COUNT(*) FILTER (WHERE spec_source = 'factory_spec')            AS factory_spec,
        COUNT(*) FILTER (WHERE spec_source = 'trade_show')              AS trade_show,
        COUNT(*) FILTER (WHERE spec_source = 'raw_migration')           AS raw_migration,
        COUNT(*) FILTER (WHERE spec_source IS NULL)                     AS unsourced,
        COUNT(*)                                                         AS total_skus
      FROM products
    `);

    const row = after.rows[0];

    return res.status(200).json({
      fix:           "migrate-products-spec-verified-fix",
      date:          "2026-05-20",
      before:        before.rows[0],
      rows_fixed:    fix.rowCount,
      after:         row,
      ok:            Number(row.total_verified) > 0,
      coverage: {
        factory_spec_pct:  pct(row.factory_spec, row.total_skus),
        trade_show_pct:    pct(row.trade_show,   row.total_skus),
        unsourced_pct:     pct(row.unsourced,    row.total_skus),
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

function pct(n, total) {
  return (Number(n) / Number(total) * 100).toFixed(1) + "%";
}
