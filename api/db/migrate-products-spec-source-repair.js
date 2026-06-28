import { getPool, setCors } from "../db.js";

// migrate-products-spec-source-repair (2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────
// One-shot repair: the original migration's rescue_pack_spec step was missing
// AND spec_source IS NULL, so it overwrote 51 trade_show rows with 'raw_migration'.
//
// Fix: re-stamp spec_source = 'trade_show' for all rows whose
//      raw->>'source' = '2025长城展 更新后版本.xlsx'  (unconditional — the
//      exhibition spreadsheet is a known authoritative source).
//
// Also fixes the migration file going forward (guard added).
// Safe to re-run (idempotent — same rows, same value).

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  try {
    const pool = getPool();

    // 1. Count before
    const before = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE spec_source = 'trade_show')    AS trade_show,
        COUNT(*) FILTER (WHERE spec_source = 'raw_migration') AS raw_migration
      FROM products
      WHERE raw->>'source' = '2025长城展 更新后版本.xlsx'
    `);

    // 2. Repair: re-stamp the 51 clobbered rows
    const fix = await pool.query(`
      UPDATE products
      SET    spec_source = 'trade_show'
      WHERE  raw->>'source' = '2025长城展 更新后版本.xlsx'
        AND  spec_source != 'trade_show'
    `);

    // 3. Count after
    const after = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE spec_source = 'trade_show')    AS trade_show,
        COUNT(*) FILTER (WHERE spec_source = 'raw_migration') AS raw_migration,
        COUNT(*) FILTER (WHERE spec_source IS NULL)           AS unsourced,
        COUNT(*)                                              AS total_skus
      FROM products
    `);

    return res.status(200).json({
      repair: "migrate-products-spec-source-repair",
      date: "2026-05-20",
      before: before.rows[0],
      rows_repaired: fix.rowCount,
      after: after.rows[0],
      ok: Number(after.rows[0].trade_show) === 56,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
