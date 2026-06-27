import pg from 'pg';
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const fixes = [
  ['cat-dry', ['CFC-01','CFF-01','CFF-05','CFF-06','CFF-07','CFF-08','CFM-01']],
  ['dog-dry', ['DFC-03','DFF-01','DFL-02','DFM-02']],
  ['cat-wet', ['SB-34','SB-35','SB-36','SB-37','TNC-55','TNC-56']],
  ['dog-wet', ['CA-14S','CD-13H','TN-14','TN-47']],
];

const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const [dc, skus] of fixes) {
    const r = await client.query(
      `UPDATE products
       SET raw = jsonb_set(jsonb_set(raw,'{display_category}',$1::jsonb),'{_display_category_pending}','false'::jsonb),
           updated_at = NOW()
       WHERE sku = ANY($2) AND active = true RETURNING sku`,
      [JSON.stringify(dc), skus]
    );
    console.log(`${dc}: ${r.rows.map(x=>x.sku).join(', ')}`);
  }
  await client.query('COMMIT');
  const remaining = await client.query(
    `SELECT COUNT(*) FROM products WHERE active=true AND raw->>'_display_category_pending'='true'`
  );
  console.log('Remaining pending:', remaining.rows[0].count);
} finally { client.release(); await pool.end(); }
