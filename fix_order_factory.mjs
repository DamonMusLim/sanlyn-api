import "dotenv/config";
import { getPool } from '/opt/sanlyn-api-test/api/db.js';
const ORDER = process.argv[2] || '40-XM-1';
const pool = getPool();
const c = await pool.connect();
try {
  const before = await c.query(`SELECT factory_company_id FROM orders WHERE order_no=$1`,[ORDER]);
  console.log(`${ORDER} BEFORE factory_company_id=`, before.rows[0]?.factory_company_id);
  await c.query('BEGIN');
  const r = await c.query(
    `UPDATE orders o SET factory_company_id=sub.cid
     FROM (SELECT o2.id AS oid, (array_agg(DISTINCT comp.id))[1] AS cid, count(DISTINCT comp.id) AS n
           FROM orders o2 JOIN order_line_items oli ON oli.order_id=o2.id
                JOIN products p ON p.id=oli.product_id
                JOIN companies comp ON comp.code=p.factory_code AND comp.type='factory'
           WHERE o2.order_no=$1 GROUP BY o2.id) sub
     WHERE o.id=sub.oid AND o.factory_company_id IS NULL AND sub.n=1`,[ORDER]);
  await c.query('COMMIT');
  const after = await c.query(`SELECT factory_company_id FROM orders WHERE order_no=$1`,[ORDER]);
  console.log(`已改 ${r.rowCount} 行. AFTER factory_company_id=`, after.rows[0]?.factory_company_id);
} catch(e){ try{await c.query('ROLLBACK')}catch(_){}; console.error('ROLLBACK:',e.message); }
finally{ c.release(); process.exit(0); }
