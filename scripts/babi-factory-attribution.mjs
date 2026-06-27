/**
 * babi-factory-attribution.mjs
 * Stage 2: Backfill raw.factoryCode (standardized company_code) for all 94 orders
 *
 * Rules:
 *  - Only writes raw.factoryCode; never modifies raw.factoryCompanyCode or other fields
 *  - Skips archived orders (_archived_at set)
 *  - Skips if factoryCode already matches target (idempotent)
 *  - Confidence < 0.85 → staging only (no DB write)
 *  - VEN-DS (徐州大之圣) → NOT in customers table, flagged for manual creation
 */
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const APPLY = process.argv.includes('--apply');
const DRY = !APPLY;

// ── Vendor code → standard company_code ──────────────────────────────────────
const FCC_MAP = {
  'td':         { code: 'CN-00055', name: 'FUJIAN TEDDY PET FOOD CO., LTD',        conf: 0.98 },
  'ca':         { code: 'CN-00053', name: 'LIAONING CHONGAI TECHNOLOGY CO., LTD',   conf: 0.98 },
  'zc-oem':     { code: 'CN-00051', name: 'YANTAI CHINA PET FOODS CO., LTD',        conf: 0.98 },
  'zc-brand':   { code: 'CN-00051', name: 'YANTAI CHINA PET FOODS CO., LTD',        conf: 0.95 },
  'VEN-LL':     { code: 'CN-00052', name: 'LIANYUNGANG ZHONGSHA PET SUPPLIES',      conf: 0.98 },
  'CN-00061':   { code: 'CN-00061', name: 'HENGAN INTERNATIONAL TRADING CO., LTD',  conf: 1.00 },
};

// Factory name substring → standard company_code (for null-fcc orders)
const NAME_MAP = [
  { match: '广州润聪',   code: 'CN-00013', name: 'GUANGZHOU RUNCONG E-COMMERCE CO., LTD', conf: 0.97 },
  { match: '霸州市天缘', code: 'CN-00015', name: 'BAZHOU TIANYUAN PLASTIC STAMPING',       conf: 0.97 },
];

// Known VEN-DS factory — not in customers table, needs manual creation
const UNKNOWN_FACTORIES = [
  { vendorCode: 'VEN-DS', nameCN: '徐州大之圣宠物有限公司', note: 'Needs new company_code (CN-006xx). Affects DG-prefix orders.' },
];

async function run() {
  const client = await pool.connect();
  try {
    const rows = (await client.query(`
      SELECT id, order_no, company_code,
        raw->>'factoryCode' AS existing_fc,
        raw->>'factoryCompanyCode' AS fcc,
        raw->>'factory' AS factory_name,
        raw->>'_archived_at' AS archived
      FROM orders
      ORDER BY order_no NULLS LAST
    `)).rows;

    const plan   = [];  // { id, order_no, company_code, targetCode, targetName, source, conf }
    const staging= [];  // confidence < 0.85
    const blocked= [];  // VEN-DS or no info

    for (const r of rows) {
      // Skip archived
      if (r.archived) {
        console.log(`  SKIP archived: ${r.order_no} (${r.id})`);
        continue;
      }
      // Skip if already set and matches
      const fcc  = r.fcc || '';
      const fn   = r.factory_name || '';
      let mapped = null;

      // 1. Try FCC_MAP
      if (fcc && FCC_MAP[fcc]) {
        mapped = { ...FCC_MAP[fcc], source: `fcc=${fcc}` };
      }
      // 2. VEN-DS — blocked
      else if (fcc === 'VEN-DS') {
        blocked.push({ ...r, reason: 'VEN-DS not in customers table — needs factory creation' });
        continue;
      }
      // 3. Factory name match
      else if (!fcc && fn) {
        for (const nm of NAME_MAP) {
          if (fn.includes(nm.match)) {
            mapped = { code: nm.code, name: nm.name, conf: nm.conf, source: `factory_name="${fn}"` };
            break;
          }
        }
      }

      if (!mapped) {
        // No match — check if it's a known staging case
        const sku = ''; // could extract from raw but not in this query
        blocked.push({ ...r, reason: `No factory attribution possible (fcc=${fcc||'null'}, factory_name="${fn}")` });
        continue;
      }

      if (mapped.conf < 0.85) {
        staging.push({ ...r, ...mapped });
        continue;
      }

      // Already correct — skip silently
      if (r.existing_fc === mapped.code) {
        console.log(`  OK  ${r.order_no||r.id}: factoryCode=${mapped.code} already set`);
        continue;
      }

      plan.push({
        id: r.id,
        order_no: r.order_no,
        company_code: r.company_code,
        targetCode: mapped.code,
        targetName: mapped.name,
        source: mapped.source,
        conf: mapped.conf,
      });
    }

    // ── Report ────────────────────────────────────────────────────────────────
    console.log('\n══════════════════════════════════════════════════════════');
    console.log(' BABI Orders Factory Attribution — Stage 2 Report');
    console.log(`  Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
    console.log('══════════════════════════════════════════════════════════');

    // Group plan by target
    const byTarget = {};
    for (const p of plan) {
      if (!byTarget[p.targetCode]) byTarget[p.targetCode] = [];
      byTarget[p.targetCode].push(p);
    }
    console.log(`\n✅ Will write factoryCode to ${plan.length} orders:`);
    for (const [code, items] of Object.entries(byTarget).sort()) {
      const name = items[0].targetName;
      console.log(`   ${code}  ${name}  (${items.length} orders)`);
      items.forEach(p => console.log(`       ${(p.order_no||'[no order_no]').padEnd(30)} ${p.company_code}  conf=${p.conf}  via ${p.source}`));
    }

    if (staging.length) {
      console.log(`\n⚠️  STAGING (conf <0.85, not written): ${staging.length} orders`);
      staging.forEach(s => console.log(`   ${(s.order_no||s.id).toString().padEnd(25)} → ${s.code} (conf=${s.conf}) via ${s.source}`));
    }

    if (blocked.length) {
      console.log(`\n🚫 BLOCKED (no attribution): ${blocked.length} orders`);
      blocked.forEach(b => console.log(`   ${(b.order_no||b.id).toString().padEnd(25)} | ${b.reason}`));
    }

    console.log(`\n⚠️  UNKNOWN FACTORIES (need manual creation): ${UNKNOWN_FACTORIES.length}`);
    UNKNOWN_FACTORIES.forEach(f => console.log(`   VendorCode: ${f.vendorCode}  Name: ${f.nameCN}  → ${f.note}`));

    // ── Role mismatch note ────────────────────────────────────────────────────
    console.log('\n📋 DATA QUALITY NOTE:');
    console.log('   All factory companies in customers table have role=\'buyer\' (not \'supplier\'/\'factory\').');
    console.log('   Recommended: UPDATE customers SET role=\'supplier\' WHERE company_code IN');
    console.log('   (\'CN-00051\',\'CN-00052\',\'CN-00053\',\'CN-00055\',\'CN-00015\',\'CN-00013\') — Damon to confirm.');

    if (DRY) { console.log('\n  Dry-run done. Pass --apply to write.'); return; }

    // ── Apply ─────────────────────────────────────────────────────────────────
    console.log('\nApplying...');
    await client.query('BEGIN');
    let written = 0;
    for (const p of plan) {
      await client.query(
        `UPDATE orders SET raw = jsonb_set(COALESCE(raw,'{}'),'{factoryCode}',$1::jsonb), updated_at=NOW() WHERE id=$2`,
        [JSON.stringify(p.targetCode), p.id]
      );
      written++;
    }
    await client.query('COMMIT');
    console.log(`\n✅ Written: ${written} orders`);

    // Verify
    const verify = (await client.query(
      `SELECT raw->>'factoryCode' AS fc, COUNT(*) FROM orders WHERE raw->>'factoryCode' IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`
    )).rows;
    console.log('\n=== Final factoryCode distribution ===');
    verify.forEach(r => console.log(`  ${(r.fc||'NULL').padEnd(14)} ${r.count}`));

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
