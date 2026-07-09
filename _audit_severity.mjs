import "dotenv/config";
import { getPool } from "./api/db/db.js";
const pool = getPool();
const c = await pool.connect();
const fill = async (table, fkCol, txtCol) => {
  try {
    const r = (await c.query(`SELECT COUNT(*) total, COUNT(NULLIF(TRIM(COALESCE(${fkCol}::text,'')),'')) hasfk, COUNT(NULLIF(TRIM(COALESCE(${txtCol},'')),'')) hastxt, COUNT(DISTINCT ${txtCol}) distincttxt FROM ${table}`)).rows[0];
    const pct = r.total>0 ? Math.round(r.hasfk/r.total*100) : 0;
    console.log(`  ${table}.${fkCol.padEnd(20)} 填充${pct}% (${r.hasfk}/${r.total}) | 自由文本${txtCol}: ${r.hastxt}行/${r.distincttxt}种不同拼写`);
  } catch(e){ console.log(`  ${table}.${fkCol} ERR ${e.message.slice(0,50)}`); }
};
console.log("=== 核心表 FK空置率 + 文本碎片度 ===");
await fill('shipping_plans','customer_company_id','customer');
await fill('shipping_plans','forwarder_company_id','forwarder_cn');
await fill('shipping_plans','factory_company_id','customer_cn');
await fill('shipping_plans','trucking_company_id','trucking_cn');
await fill('orders','customer_company_id','customer');
await fill('orders','factory_company_id','factory');
await fill('orders','seller_company_id','issuing_company');
await fill('products','factory_code','factory_name');
await fill('products','supplier_company_id','factory_name');
await fill('finance_payments','company_code','customer');
await fill('freight_rates','local_charge_code','forwarder');
// freight_rates forwarder 完全没FK, 看碎片
const fr = (await c.query("SELECT COUNT(*) total, COUNT(DISTINCT forwarder) d FROM freight_rates")).rows[0];
console.log(`\n  freight_rates: ${fr.total}行 forwarder有${fr.d}种不同拼写(完全无FK绑companies)`);
await pool.end();
