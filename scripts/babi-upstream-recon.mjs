/**
 * babi-upstream-recon.mjs  v2.0
 * Daily cron (08:30) — upstream chain integrity scan for all active orders
 */
import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function run() {
  const client = await pool.connect();
  const issues = [];
  const redIssues = [];

  try {
    const now = new Date().toISOString().slice(0,19).replace('T',' ');
    console.log(`\n[${now}] BABI Upstream Recon v2.0`);
    console.log('─────────────────────────────────────────────');

    // 1. Missing factoryCode check
    const missing = (await client.query(`
      SELECT id, order_no, company_code,
        raw->>'_factory_pending' as pending,
        raw->>'_factory_notes' as notes
      FROM orders
      WHERE (raw->>'factoryCode') IS NULL
        AND (raw->>'_archived_at') IS NULL
        AND deleted_at IS NULL
      ORDER BY order_no NULLS LAST
    `)).rows;

    const trulyMissing = missing.filter(r => r.pending !== 'true');
    const pendingOcr = missing.filter(r => r.pending === 'true');

    if (trulyMissing.length > 0) {
      console.log(`\nMISSING factoryCode (not pending): ${trulyMissing.length} orders`);
      trulyMissing.forEach(r => console.log(`   ${(r.order_no||'(no order_no)').padEnd(30)} ${r.company_code}`));
      redIssues.push(`${trulyMissing.length} orders missing factoryCode`);
    }
    if (pendingOcr.length > 0) {
      console.log(`\nPending OCR: ${pendingOcr.length} orders`);
      pendingOcr.forEach(r => console.log(`   ${(r.order_no||'(no order_no)').padEnd(30)} ${(r.notes||'').slice(0,60)}`));
      issues.push(`${pendingOcr.length} orders pending OCR`);
    }

    // 2. Orphan factoryCode check
    const allFactoryCodes = (await client.query(`
      SELECT DISTINCT raw->>'factoryCode' AS fc, COUNT(*) AS cnt
      FROM orders WHERE deleted_at IS NULL AND raw->>'factoryCode' IS NOT NULL
      GROUP BY 1
    `)).rows;
    const customerCodes = new Set(
      (await client.query('SELECT company_code FROM customers')).rows.map(r => r.company_code)
    );
    const orphaned = allFactoryCodes.filter(r => r.fc && !customerCodes.has(r.fc));
    if (orphaned.length > 0) {
      console.log(`\nfactoryCode NOT in customers: ${orphaned.length}`);
      orphaned.forEach(r => console.log(`   "${r.fc}" (${r.cnt} orders)`));
      redIssues.push(`${orphaned.length} orphaned factoryCode(s)`);
    } else {
      console.log('\nAll factoryCodes valid in customers table');
    }

    // 3. FPO link check
    const fpoExists = (await client.query(`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='factory_orders') as e`)).rows[0].e;
    if (fpoExists) {
      const noFpo = (await client.query(`
        SELECT COUNT(*) as cnt FROM orders o
        WHERE o.deleted_at IS NULL AND o.raw->>'factoryCode' IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM factory_orders fo WHERE fo.customer_order_contract_nos @> to_jsonb(o.contract_no))
      `)).rows[0];
      if (parseInt(noFpo.cnt) > 0) {
        issues.push(`${noFpo.cnt} orders missing FPO link`);
        console.log(`\nOrders with factoryCode but no FPO: ${noFpo.cnt}`);
      }
    } else {
      console.log('\nfactory_orders table not found (FPO check skipped)');
    }

    // 4. Orphan BL check
    const spExists = (await client.query(`SELECT EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='shipping_plans') as e`)).rows[0].e;
    if (spExists) {
      const orphanBl = (await client.query(`
        SELECT COUNT(*) as cnt FROM orders o
        WHERE o.deleted_at IS NULL AND o.raw->>'blNo' IS NOT NULL AND o.raw->>'blNo' != ''
          AND NOT EXISTS (SELECT 1 FROM shipping_plans sp WHERE sp.bl_no = o.raw->>'blNo')
      `)).rows[0];
      if (parseInt(orphanBl.cnt) > 0) {
        issues.push(`${orphanBl.cnt} orphan BL references`);
        console.log(`\nOrphan BL (no shipping_plan): ${orphanBl.cnt}`);
      }
    }

    // 5. Coverage summary
    const cov = (await client.query(`
      SELECT COUNT(*) as total,
        SUM(CASE WHEN raw->>'factoryCode' IS NOT NULL AND raw->>'factoryCode' != '' THEN 1 ELSE 0 END) as has_factory,
        SUM(CASE WHEN raw->>'_factory_pending' = 'true' THEN 1 ELSE 0 END) as pending_ocr
      FROM orders WHERE deleted_at IS NULL
    `)).rows[0];
    const pct = Math.round(parseInt(cov.has_factory) / parseInt(cov.total) * 100);
    console.log(`\nFactory Coverage: ${cov.has_factory}/${cov.total} (${pct}%) | Pending OCR: ${cov.pending_ocr}`);

    // 6. WeChat push
    const allIssues = [...redIssues, ...issues];
    if (allIssues.length > 0) {
      const sev = redIssues.length > 0 ? 'RED' : 'YELLOW';
      const msg = `[Sanlyn上游${sev}] ${now.slice(0,10)} 工厂覆盖${pct}% (${cov.has_factory}/${cov.total}). ${allIssues.slice(0,2).join('; ')}`;
      try {
        const { execSync } = await import('child_process');
        execSync(`/Users/mac/bin/wechat-push "${msg.replace(/"/g, '\\"')}"`, { timeout: 10000 });
        console.log('WeChat push sent');
      } catch (e) {
        console.log(`WeChat push failed: ${e.message}`);
      }
    } else {
      console.log('No issues - upstream chain clean');
    }

  } finally {
    client.release();
    await pool.end();
  }
}
run().catch(e => { console.error(e.message); process.exit(1); });
