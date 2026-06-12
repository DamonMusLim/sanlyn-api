import { getPool, setCors } from "../db.js";

// migrate-products-spec-source  (2026-05-20)
// ─────────────────────────────────────────────────────────────────────────────
// Purpose: establish products as the single source of truth for spec / logistics
//          data by adding provenance columns and backfilling known sources.
//
// Step 1 – ADD 4 provenance columns (idempotent, ADD IF NOT EXISTS):
//   spec_source      VARCHAR(40)  – who/what wrote the data
//                    values: 'packing_list'|'factory_spec'|'trade_show'|'bl'|
//                            'manual'|'ai_prefill'|'jdy_import'|'raw_migration'
//   spec_verified    BOOLEAN      – Sanlyn staff confirmed against real doc
//   spec_verified_at TIMESTAMPTZ  – when verified
//   spec_verified_by VARCHAR(100) – who verified (user_name / account)
//
// Step 2 – Backfill source = 'trade_show' for the 56 rows from 2025 Canton Fair
//   spreadsheet (raw->>'source' = '2025长城展 更新后版本.xlsx')
//   ONLY if spec_source IS NULL (never overwrite already-tagged rows).
//
// Step 3 – Rescue 51 rows: copy raw->>'pack_spec' → spec where spec IS NULL
//   Marks rescued rows spec_source = 'raw_migration' so they can be re-verified
//   against real docs later.
//
// Safety contract:
//   • All ALTER TABLE use IF NOT EXISTS  → idempotent, safe to re-run
//   • All UPDATE use WHERE … IS NULL    → never overwrites existing data
//   • No DELETE / DROP / TRUNCATE anywhere in this file
//   • products_old_backup and nb_products are NOT touched

const ALTER_STMTS = [
  `ALTER TABLE products
     ADD COLUMN IF NOT EXISTS spec_source      VARCHAR(40)   DEFAULT NULL`,
  `ALTER TABLE products
     ADD COLUMN IF NOT EXISTS spec_verified    BOOLEAN       DEFAULT FALSE`,
  `ALTER TABLE products
     ADD COLUMN IF NOT EXISTS spec_verified_at TIMESTAMPTZ   DEFAULT NULL`,
  `ALTER TABLE products
     ADD COLUMN IF NOT EXISTS spec_verified_by VARCHAR(100)  DEFAULT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_prod_spec_source ON products(spec_source)`,
  `CREATE INDEX IF NOT EXISTS idx_prod_spec_verified ON products(spec_verified)`,
];

// Each data-write returns rowCount for the verification report.
const DATA_STMTS = [
  {
    label: "backfill_trade_show",
    description: "Mark Canton Fair 2025 rows as spec_source='trade_show'",
    sql: `UPDATE products
          SET    spec_source = 'trade_show'
          WHERE  raw->>'source' = '2025长城展 更新后版本.xlsx'
            AND  spec_source IS NULL`,
    expect: 56,
  },
  {
    label: "rescue_pack_spec",
    description: "Copy raw.pack_spec → spec for rows where spec IS NULL and no source yet tagged",
    // IMPORTANT: AND spec_source IS NULL — never overwrite a row that was already
    // tagged by a prior step (e.g. trade_show). Without this guard the second UPDATE
    // would clobber the first one's tags on rows where both conditions apply.
    sql: `UPDATE products
          SET    spec        = raw->>'pack_spec',
                 spec_source = 'raw_migration'
          WHERE  spec IS NULL
            AND  raw->>'pack_spec' IS NOT NULL
            AND  spec_source IS NULL`,
    expect: 0, // 0 after repair run; first run was 51 (now fixed in prod by repair SQL)
  },
];

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST only" });
  }

  try {
    const pool = getPool();
    const log  = [];

    // ── Step 1: schema changes ──────────────────────────────────────────────
    for (const sql of ALTER_STMTS) {
      await pool.query(sql);
      log.push({ step: "schema", status: "ok", sql: sql.replace(/\s+/g, " ").trim().slice(0, 90) });
    }

    // ── Step 2 + 3: data backfill ───────────────────────────────────────────
    const data_results = [];
    for (const stmt of DATA_STMTS) {
      const r = await pool.query(stmt.sql);
      const affected = r.rowCount;
      const match    = affected === stmt.expect;
      data_results.push({
        label:       stmt.label,
        description: stmt.description,
        rows_affected: affected,
        expected:    stmt.expect,
        match:       match,
        status:      match ? "ok" : "unexpected_count",
      });
      log.push({
        step:    "data",
        label:   stmt.label,
        status:  match ? "ok" : "warn",
        rows_affected: affected,
        expected: stmt.expect,
      });
    }

    // ── Verification counts ─────────────────────────────────────────────────
    const verify = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE spec_source = 'trade_show')   AS trade_show,
        COUNT(*) FILTER (WHERE spec_source = 'raw_migration') AS raw_migration,
        COUNT(*) FILTER (WHERE spec_verified = TRUE)          AS verified,
        COUNT(*) FILTER (WHERE spec_source IS NOT NULL)       AS total_sourced,
        COUNT(*) AS total_skus
      FROM products
    `);

    const ok = data_results.every(r => r.match);

    return res.status(ok ? 200 : 207).json({
      migration: "migrate-products-spec-source",
      date:      "2026-05-20",
      ok,
      schema_steps: ALTER_STMTS.length,
      data_results,
      verification: verify.rows[0],
      log,
    });

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}
