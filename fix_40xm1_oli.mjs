import "dotenv/config";
import { getPool } from '/opt/sanlyn-api-test/api/db.js';
const pool = getPool();
const client = await pool.connect();
try {
  const chk = await client.query(
    `SELECT oli.id, oli.sku, oli.product_id, p.id AS pid,
            count(p.id) OVER (PARTITION BY oli.sku) AS dup
     FROM order_line_items oli LEFT JOIN products p ON p.sku=oli.sku
     WHERE oli.order_id=1220 ORDER BY oli.sku`);
  console.log('BEFORE (40-XM-1 OLI):');
  chk.rows.forEach(r => console.log(`  ${r.sku}: oli_pid=${r.product_id} -> prod=${r.pid} dup=${r.dup}`));
  const bad = chk.rows.filter(r => r.product_id === null && (r.pid === null || Number(r.dup) > 1));
  if (bad.length) { console.log('STOP: 有歧义/无匹配,不改:', bad.map(b=>b.sku)); process.exit(1); }
  await client.query('BEGIN');
  const upd = await client.query(
    `UPDATE order_line_items oli SET product_id=p.id
     FROM products p WHERE oli.order_id=1220 AND oli.product_id IS NULL AND p.sku=oli.sku`);
  await client.query('COMMIT');
  const after = await client.query(
    `SELECT count(*) FILTER (WHERE product_id IS NOT NULL) AS linked, count(*) AS total
     FROM order_line_items WHERE order_id=1220`);
  console.log(`已relink ${upd.rowCount} 行. AFTER: linked=${after.rows[0].linked}/${after.rows[0].total}`);
} catch(e) { try{await client.query('ROLLBACK')}catch(_){}; console.error('ROLLBACK:', e.message); }
finally { client.release(); process.exit(0); }
