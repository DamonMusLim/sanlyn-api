/**
 * stage1-doc-match.mjs  — Stage 1 L1 regex反查
 * Matches order identifiers (order_no, bl_no, contract_no, customer_po)
 * against manifest_v2.json filenames, writes raw._doc_matches_L1 to orders.
 */
import { readFileSync } from 'fs';
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');

const MANIFEST_PATH = '/tmp/manifest_v2.json';

async function run() {
  // Load manifest (array or object)
  let manifest;
  try {
    const raw = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    manifest = Array.isArray(raw) ? raw : Object.values(raw);
  } catch(e) {
    console.error('STOP: manifest_v2.json read failed:', e.message);
    process.exit(1);
  }
  console.log(`Manifest loaded: ${manifest.length} entries`);

  const client = await pool.connect();
  try {
    const orders = (await client.query(`
      SELECT id, order_no, contract_no,
        raw->>'blNo' AS bl_no,
        raw->>'customerPo' AS customer_po
      FROM orders
      WHERE order_no IS NOT NULL
      ORDER BY order_no
    `)).rows;

    let matched = 0, total_matches = 0;
    const writes = [];

    for (const o of orders) {
      // Build candidate ID list (dedup, min 5 chars)
      const ids = [...new Set([
        o.order_no, o.contract_no, o.bl_no, o.customer_po
      ].filter(x => x && x.trim().length >= 5).map(x => x.trim().toUpperCase()))];

      if (!ids.length) continue;

      const hits = [];
      for (const entry of manifest) {
        const fn = (entry.filename || entry.src_path?.split('/').pop() || '').toUpperCase();
        if (!fn) continue;
        for (const id of ids) {
          if (fn.includes(id)) {
            hits.push({
              filename: entry.filename,
              category: entry.category || entry.doc_kind_guess || 'unknown',
              oss_key: entry.oss_key || null,
              matched_on: id,
            });
            break; // one match per entry is enough
          }
        }
      }

      if (hits.length > 0) {
        matched++;
        total_matches += hits.length;
        writes.push({ id: o.id, order_no: o.order_no, hits });
      }
    }

    // Report
    console.log(`\n=== Stage 1 L1 Doc Match ===`);
    console.log(`Orders scanned:  ${orders.length}`);
    console.log(`Orders matched:  ${matched}  (${Math.round(matched/orders.length*100)}%)`);
    console.log(`Total file hits: ${total_matches}`);
    console.log(`\nTop matches:`);
    writes.slice(0,20).forEach(w => {
      console.log(`  ${(w.order_no||w.id).toString().padEnd(30)} → ${w.hits.length} file(s)`);
      w.hits.forEach(h => console.log(`      [${h.category}] ${h.filename} (via ${h.matched_on})`));
    });

    if (!APPLY) { console.log('\nDry-run. Pass --apply to write.'); return; }

    // Write to DB
    console.log('\nApplying _doc_matches_L1...');
    await client.query('BEGIN');
    for (const w of writes) {
      await client.query(
        `UPDATE orders SET raw = jsonb_set(COALESCE(raw,'{}'),'{_doc_matches_L1}',$1::jsonb), updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(w.hits), w.id]
      );
    }
    await client.query('COMMIT');
    console.log(`✅ Written _doc_matches_L1 to ${writes.length} orders`);

  } catch(e) {
    await client.query('ROLLBACK').catch(()=>{});
    console.error('ERROR:', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}
run();
