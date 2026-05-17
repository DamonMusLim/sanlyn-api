// One-off: insert 2 factories + assign white-label products to SANLYN + backfill supplier_company_id
// Run: cd /Users/mac/Desktop/sanlyn-api-dev && node scripts/migrate-sanlyn-brand.mjs
import 'dotenv/config';
import pg from 'pg';
import { readFileSync } from 'fs';

// Load .env.local manually
const envFile = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
for (const line of envFile.split('\n')) {
  const m = line.match(/^([A-Z_]+)=["']?([^"'\n]*)["']?$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const client = new pg.Client({
  host: process.env.PG_HOST,
  port: parseInt(process.env.PG_PORT),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: { rejectUnauthorized: false },
});

await client.connect();
console.log('Connected to', process.env.PG_HOST);

try {
  await client.query('BEGIN');

  // ── Step 1: Insert 2 new factory companies ──────────────────────────────────
  const ins = await client.query(`
    INSERT INTO customers (company_code, name_cn, name_en, role_types, short_code, country, is_active)
    VALUES
      ('CN-00066', '义乌市淘淘宠物用品有限公司', 'YIWU TAOTAO PET PRODUCTS CO., LTD',  ARRAY['Manufacturer（工厂）'], 'Taotao', 'CN', true),
      ('CN-00067', '霸州市憨贝宠物用品有限公司', 'BAZHOU HANBEI PET PRODUCTS CO., LTD', ARRAY['Manufacturer（工厂）'], 'Hanbei', 'CN', true)
    ON CONFLICT (company_code) DO NOTHING
    RETURNING company_code, name_cn, id
  `);
  console.log('Step 1 — Inserted companies:', ins.rows);

  // ── Step 2: White-label products → SANLYN brand + supplier_company_id ──────
  const u1 = await client.query(`
    UPDATE products SET brand='SANLYN',
      supplier_company_id=(SELECT id FROM customers WHERE company_code='CN-00066')
    WHERE factory_code IS NULL AND factory_name LIKE '%淘淘%'
    RETURNING id
  `);
  console.log('Step 2a — 淘淘 (CN-00066):', u1.rowCount, 'products → SANLYN');

  const u2 = await client.query(`
    UPDATE products SET brand='SANLYN',
      supplier_company_id=(SELECT id FROM customers WHERE company_code='CN-00012')
    WHERE factory_code IS NULL AND factory_name LIKE '%悦佰兔%'
    RETURNING id
  `);
  console.log('Step 2b — 悦佰兔 (CN-00012):', u2.rowCount, 'products → SANLYN');

  const u3 = await client.query(`
    UPDATE products SET brand='SANLYN',
      supplier_company_id=(SELECT id FROM customers WHERE company_code='CN-00067')
    WHERE factory_code IS NULL AND factory_name LIKE '%憨贝%'
    RETURNING id
  `);
  console.log('Step 2c — 憨贝 (CN-00067):', u3.rowCount, 'products → SANLYN');

  // ── Step 3: 中宠 orphans (NULL factory_code) → CN-00051 ─────────────────────
  const u4 = await client.query(`
    UPDATE products SET supplier_company_id=(SELECT id FROM customers WHERE company_code='CN-00051')
    WHERE supplier_company_id IS NULL AND factory_name LIKE '%中宠%'
    RETURNING id
  `);
  console.log('Step 3 — 中宠 orphans → CN-00051:', u4.rowCount);

  // ── Step 4: Backfill supplier_company_id from factory_code ─────────────────
  const u5 = await client.query(`
    UPDATE products p SET supplier_company_id = c.id
    FROM customers c
    WHERE p.supplier_company_id IS NULL
      AND p.factory_code IS NOT NULL
      AND c.company_code = CASE p.factory_code
        WHEN 'FX' THEN 'CN-00058'
        WHEN 'ZC' THEN 'CN-00051'
        WHEN 'ZS' THEN 'CN-00052'
        WHEN 'TD' THEN 'CN-00055'
        WHEN 'CA' THEN 'CN-00053'
        WHEN 'TY' THEN 'CN-00015'
        WHEN 'RC' THEN 'CN-00013'
        ELSE NULL
      END
    RETURNING id
  `);
  console.log('Step 4 — Backfilled supplier_company_id from factory_code:', u5.rowCount);

  // ── Summary ─────────────────────────────────────────────────────────────────
  const summary = await client.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(supplier_company_id) AS has_supplier,
      COUNT(*) FILTER (WHERE brand='SANLYN') AS sanlyn_brand,
      COUNT(*) FILTER (WHERE brand IS NULL OR brand='') AS no_brand
    FROM products
  `);
  console.log('Final state:', summary.rows[0]);

  await client.query('COMMIT');
  console.log('\n✅ COMMITTED');
} catch (e) {
  await client.query('ROLLBACK');
  console.error('❌ ROLLED BACK:', e.message);
  throw e;
} finally {
  await client.end();
}
