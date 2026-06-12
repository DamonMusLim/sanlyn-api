// api/db/migrate-sanlyn-brand.js
// POST /api/db/migrate-sanlyn-brand
// One-off: insert 2 factories + assign white-label products to SANLYN brand
// + backfill supplier_company_id from factory_code.
//
// Idempotent: INSERT uses ON CONFLICT DO NOTHING; UPDATEs only touch rows
// that are still missing brand/supplier_company_id.

import { getPool, setCors } from '../db.js';

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const pool = getPool();
  const client = await pool.connect();
  const log = {};

  try {
    await client.query('BEGIN');

    // Step 1: Insert 2 new factory companies
    const ins = await client.query(`
      INSERT INTO customers (company_code, name_cn, name_en, role_types, short_code, country, is_active)
      VALUES
        ('CN-00066', '义乌市淘淘宠物用品有限公司', 'YIWU TAOTAO PET PRODUCTS CO., LTD',  ARRAY['Manufacturer（工厂）'], 'Taotao', 'CN', true),
        ('CN-00067', '霸州市憨贝宠物用品有限公司', 'BAZHOU HANBEI PET PRODUCTS CO., LTD', ARRAY['Manufacturer（工厂）'], 'Hanbei', 'CN', true)
      ON CONFLICT (company_code) DO NOTHING
      RETURNING company_code, name_cn
    `);
    log.step1_companies_inserted = ins.rows;

    // Step 2a: 淘淘 white-label → SANLYN @ CN-00066
    const u1 = await client.query(`
      UPDATE products SET brand='SANLYN',
        supplier_company_id=(SELECT id FROM customers WHERE company_code='CN-00066')
      WHERE factory_code IS NULL AND factory_name LIKE '%淘淘%'
        AND (brand IS NULL OR brand='' OR supplier_company_id IS NULL)
    `);
    log.step2a_taotao_sanlyn = u1.rowCount;

    // Step 2b: 悦佰兔 white-label → SANLYN @ CN-00012
    const u2 = await client.query(`
      UPDATE products SET brand='SANLYN',
        supplier_company_id=(SELECT id FROM customers WHERE company_code='CN-00012')
      WHERE factory_code IS NULL AND factory_name LIKE '%悦佰兔%'
        AND (brand IS NULL OR brand='' OR supplier_company_id IS NULL)
    `);
    log.step2b_yuebaitu_sanlyn = u2.rowCount;

    // Step 2c: 憨贝 white-label → SANLYN @ CN-00067
    const u3 = await client.query(`
      UPDATE products SET brand='SANLYN',
        supplier_company_id=(SELECT id FROM customers WHERE company_code='CN-00067')
      WHERE factory_code IS NULL AND factory_name LIKE '%憨贝%'
        AND (brand IS NULL OR brand='' OR supplier_company_id IS NULL)
    `);
    log.step2c_hanbei_sanlyn = u3.rowCount;

    // Step 3: 中宠 NULL-factory-code orphans → CN-00051
    const u4 = await client.query(`
      UPDATE products SET supplier_company_id=(SELECT id FROM customers WHERE company_code='CN-00051')
      WHERE supplier_company_id IS NULL AND factory_name LIKE '%中宠%'
    `);
    log.step3_zhongchong_orphans = u4.rowCount;

    // Step 4: Backfill supplier_company_id from factory_code mapping
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
    `);
    log.step4_backfill_from_factory_code = u5.rowCount;

    // Summary
    const summary = await client.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(supplier_company_id)::int AS has_supplier,
        (COUNT(*) FILTER (WHERE brand='SANLYN'))::int AS sanlyn_brand,
        (COUNT(*) FILTER (WHERE brand IS NULL OR brand=''))::int AS no_brand
      FROM products
    `);
    log.final = summary.rows[0];

    await client.query('COMMIT');
    return res.status(200).json({ success: true, log });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[migrate-sanlyn-brand]', e);
    return res.status(500).json({ success: false, error: e.message, log });
  } finally {
    client.release();
  }
}
