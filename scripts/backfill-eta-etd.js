// backfill-eta-etd.js — one-time sync: copy eta/etd from shipping_plans → orders.raw
//
// Targets orders that have raw.blNo (BL already ingested) but are missing
// raw.eta or raw.etd. Joins via shipping_plans.bl_no.
//
// Usage:
//   node scripts/backfill-eta-etd.js [--dry-run]
//
// Dry-run prints what would be updated without writing anything.
import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const DRY_RUN = process.argv.includes('--dry-run');
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  // Find orders with a BL number but missing eta or etd in raw
  const { rows: candidates } = await pool.query(`
    SELECT o.id, o.order_no, o.raw->>'blNo' AS bl_no,
           o.raw->>'eta' AS raw_eta,
           o.raw->>'etd' AS raw_etd,
           sp.eta        AS sp_eta,
           sp.etd        AS sp_etd
    FROM   orders o
    JOIN   shipping_plans sp ON sp.bl_no = o.raw->>'blNo'
    WHERE  o.raw->>'blNo' IS NOT NULL
      AND  o.raw->>'blNo' <> ''
      AND  (o.raw->>'eta' IS NULL OR o.raw->>'etd' IS NULL)
    ORDER  BY o.order_no
  `);

  console.log(`Found ${candidates.length} orders to backfill`);
  if (candidates.length === 0) { await pool.end(); return; }

  let updated = 0;
  for (const row of candidates) {
    const patch = {};
    if (!row.raw_etd && row.sp_etd) patch.etd = row.sp_etd.toISOString
      ? row.sp_etd.toISOString().slice(0, 10)
      : String(row.sp_etd).slice(0, 10);
    if (!row.raw_eta && row.sp_eta) patch.eta = row.sp_eta.toISOString
      ? row.sp_eta.toISOString().slice(0, 10)
      : String(row.sp_eta).slice(0, 10);

    if (Object.keys(patch).length === 0) continue;

    console.log(`  ${row.order_no} (BL: ${row.bl_no}) → patch:`, patch);

    if (!DRY_RUN) {
      await pool.query(
        `UPDATE orders SET raw = raw || $1::jsonb WHERE id = $2`,
        [JSON.stringify(patch), row.id]
      );
      updated++;
    }
  }

  console.log(DRY_RUN ? `[DRY RUN] would update ${candidates.length} orders` : `Updated ${updated} orders`);
  await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
