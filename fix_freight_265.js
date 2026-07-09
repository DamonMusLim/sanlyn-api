const { Pool } = require('pg');
const pool = new Pool({
  user: 'sanlyn_admin',
  password: 'Snlnb7f92c74d6fbaa8b97b0379b',
  database: 'sanlyn_db',
  host: '127.0.0.1',
  port: 5432
});
async function run() {
  const client = await pool.connect();
  try {
    // dry run first
    const before = await client.query();
    console.log('BEFORE:', JSON.stringify(before.rows, null, 2));

    await client.query('BEGIN');
    // update freight_supplier_bills
    const r1 = await client.query(
      
    );
    console.log('bills updated:', r1.rows);

    // update shipping_plans.freight_cost
    const r2 = await client.query(
      
    );
    console.log('plan updated:', r2.rows);

    await client.query('COMMIT');
    console.log('DONE');
  } catch(e) {
    await client.query('ROLLBACK');
    console.error('ERROR:', e.message);
  } finally {
    client.release();
    pool.end();
  }
}
run();
