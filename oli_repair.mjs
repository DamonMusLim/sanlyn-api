import "dotenv/config";
import { getPool } from '/opt/sanlyn-api-test/api/db.js';
const pool = getPool();
const c = await pool.connect();
try {
  await c.query('BEGIN');
  // 1. relink OLI: 仅SKU唯一匹配活跃产品的
  const r1 = await c.query(
    `UPDATE order_line_items oli SET product_id=sub.pid
     FROM (SELECT oli2.id AS oid, (array_agg(p.id))[1] AS pid
           FROM order_line_items oli2 JOIN products p ON p.sku=oli2.sku AND p.active=true
           WHERE oli2.product_id IS NULL AND oli2.sku IS NOT NULL AND btrim(oli2.sku)<>''
           GROUP BY oli2.id HAVING count(*)=1) sub
     WHERE oli.id=sub.oid`);
  // 2. 订单工厂回填:OLI派生单工厂、当前NULL的
  const r2 = await c.query(
    `UPDATE orders o SET factory_company_id=sub.cid
     FROM (SELECT o2.id AS oid, (array_agg(DISTINCT comp.id))[1] AS cid
           FROM orders o2 JOIN order_line_items oli ON oli.order_id=o2.id
                JOIN products p ON p.id=oli.product_id
                JOIN companies comp ON comp.code=p.factory_code AND comp.type='factory'
           WHERE o2.factory_company_id IS NULL
           GROUP BY o2.id HAVING count(DISTINCT comp.id)=1) sub
     WHERE o.id=sub.oid`);
  await c.query('COMMIT');
  console.log(`relink OLI: ${r1.rowCount} 行; 回填订单工厂: ${r2.rowCount} 单`);
  const v = await c.query(`SELECT count(*) FILTER (WHERE product_id IS NOT NULL) linked, count(*) total FROM order_line_items WHERE sku IS NOT NULL AND btrim(sku)<>''`);
  console.log('OLI挂产品率:', v.rows[0].linked + '/' + v.rows[0].total);
} catch(e){ try{await c.query('ROLLBACK')}catch(_){}; console.error('ROLLBACK:', e.message); }
finally{ c.release(); process.exit(0); }
