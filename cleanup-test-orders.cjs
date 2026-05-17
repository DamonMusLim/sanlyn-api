// One-off cleanup: 删除 12 条 SOA 测试单 + backfill 3 条真订单的 created_at + backfill 缺 buyer
// Usage: cd ~/Desktop/sanlyn-api-dev && node cleanup-test-orders.cjs
require('dotenv').config({ path: '.env.local' });
const { Client } = require('pg');

const c = new Client({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: false,
});

(async () => {
  await c.connect();

  // Step 1: preview
  const before = await c.query(`
    SELECT contract_no, order_no, company_name_en, total_amount, currency
    FROM orders WHERE created_at IS NULL AND (
      company_name_en = 'PETSOME GROUP'
      OR (company_name_en = 'JJ PET GROUP SDN BHD' AND total_amount::numeric <= 500)
    ) ORDER BY contract_no
  `);
  console.log('\n[Step 1] 待删测试单：', before.rows.length, '条');
  before.rows.forEach(r => console.log(' -', r.contract_no, r.order_no, r.company_name_en, r.currency, r.total_amount));

  // Step 2: delete
  const del = await c.query(`
    DELETE FROM orders WHERE created_at IS NULL AND (
      company_name_en = 'PETSOME GROUP'
      OR (company_name_en = 'JJ PET GROUP SDN BHD' AND total_amount::numeric <= 500)
    ) RETURNING order_no
  `);
  console.log('\n[Step 2] 已删除：', del.rowCount, '条');

  // Step 3: backfill created_at for real manual_import orders
  const ts = await c.query(`
    UPDATE orders SET created_at = NOW(), updated_at = NOW()
    WHERE created_at IS NULL AND raw->>'source' = 'manual_import'
    RETURNING order_no
  `);
  console.log('\n[Step 3] 时间戳回填：', ts.rowCount, '条', ts.rows.map(r => r.order_no).join(', '));

  // Step 4: backfill missing company_name_en from raw.consignee / raw.companyNameEN
  const buyer = await c.query(`
    UPDATE orders SET company_name_en = COALESCE(
      NULLIF(raw->>'companyNameEN', ''),
      NULLIF(raw->>'consignee', '')
    )
    WHERE (company_name_en IS NULL OR company_name_en = '')
      AND COALESCE(NULLIF(raw->>'companyNameEN',''), NULLIF(raw->>'consignee','')) IS NOT NULL
    RETURNING order_no, company_name_en
  `);
  console.log('\n[Step 4] Buyer 回填：', buyer.rowCount, '条');
  buyer.rows.forEach(r => console.log(' -', r.order_no, '→', r.company_name_en));

  // Step 5: final audit
  const after = await c.query(`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE created_at IS NULL) AS no_created_at,
      COUNT(*) FILTER (WHERE company_name_en IS NULL OR company_name_en = '') AS no_buyer
    FROM orders
  `);
  console.log('\n[Step 5] 最终状态：', after.rows[0]);

  await c.end();
  console.log('\n✅ Phase 1 完成');
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
