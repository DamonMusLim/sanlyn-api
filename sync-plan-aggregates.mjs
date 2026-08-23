#!/usr/bin/env node
// 海运plan聚合缓存守护:OLI=SSOT,plan的gross_weight_kg/total_cartons/total_cbm是缓存。
// 安全子集自动从OLI填空(COALESCE只填NULL,不覆盖;只动单订单或GW已对的票;多订单歧义跳过)。
// DRY=1 只看不改。每日跑,填了就ntfy。
import pkg from '/opt/sanlyn-api-test/node_modules/pg/lib/index.js';
const {Pool}=pkg;
const pool=new Pool({host:'127.0.0.1',port:5432,database:'sanlyn_db',user:'sanlyn_admin',password:process.env.PG_PASSWORD});
const DRY=process.env.DRY==='1';
const Q=async(s,p=[])=>(await pool.query(s,p)).rows;
const rows=await Q(`
  WITH mo AS(
    SELECT DISTINCT sp.id pid,o.id oid FROM shipping_plans sp
    JOIN LATERAL unnest(COALESCE(sp.order_nos,'{}')) x(o2) ON true JOIN orders o ON o.order_no=x.o2
    WHERE sp.status IS DISTINCT FROM 'cancelled'
    UNION
    SELECT DISTINCT sp.id,o.id FROM shipping_plans sp
    JOIN LATERAL unnest(COALESCE(sp.contract_nos,ARRAY[sp.contract_no])) x(c2) ON true JOIN orders o ON o.contract_no=x.c2
    WHERE sp.status IS DISTINCT FROM 'cancelled'),
  oli AS(SELECT pid,ROUND(SUM(COALESCE(l.gw_ctn,0)*COALESCE(l.qty_ctn,0)),2) gw,SUM(COALESCE(l.qty_ctn,0))::int q,
         ROUND(SUM(COALESCE(l.cbm_ctn,0)*COALESCE(l.qty_ctn,0)),3) cbm,COUNT(DISTINCT mo.oid) norders
         FROM mo JOIN order_line_items l ON l.order_id=mo.oid GROUP BY pid)
  SELECT sp.id,sp.shipment_no,COALESCE(sp.container_qty,1) cq,
         sp.gross_weight_kg::numeric sg,sp.total_cartons sc,sp.total_cbm::numeric scbm,
         oli.gw,oli.q,oli.cbm,oli.norders
  FROM shipping_plans sp JOIN oli ON oli.pid=sp.id
  WHERE sp.source_system IS DISTINCT FROM 'freight_agency' AND oli.gw>0
    AND (sp.gross_weight_kg IS NULL OR sp.total_cartons IS NULL OR sp.total_cbm IS NULL)`);
let filled=0,skipped=[];
for(const r of rows){
  const q=Number(r.q);
  const cq=Number(r.cq);
  const norders=Number(r.norders);
  const perCtr=q/Math.max(cq,1);
  const gwAgrees = r.sg!=null && Math.abs(Number(r.sg)-Number(r.gw))/Number(r.gw)<0.01;
  const safe = perCtr<=2600 && (norders===1 || (gwAgrees && perCtr>=100)); // 单订单无挂接歧义不设下限(代购小票),下限仅多订单佐证;与booking-collab.js写路径同口径
  if(!safe){ skipped.push(`#${r.id} ${r.shipment_no}(${norders}单,每柜${perCtr.toFixed(0)}箱)`); continue; }
  if(!DRY){
    await Q(`UPDATE shipping_plans SET gross_weight_kg=COALESCE(gross_weight_kg,$2),total_cartons=COALESCE(total_cartons,$3),total_cbm=COALESCE(total_cbm,$4),updated_at=now() WHERE id=$1`,[r.id,r.gw,q,r.cbm]);
  }
  console.log(`${DRY?'[DRY]':'✅'} #${r.id} ${r.shipment_no} 填空 GW${r.gw}/箱${q}/CBM${r.cbm}`);
  filled++;
}
console.log(`\n${DRY?'[DRY] 将填':'已填'} ${filled} 票; 跳过(歧义,留DQ19告警) ${skipped.length}: ${skipped.join(' | ')}`);
if(!DRY && filled>0){ try{ await fetch('https://ntfy.sh/sanlyn-damon-alert',{method:'POST',headers:{Title:'plan聚合守护'},body:`自动填${filled}票海运聚合缓存`}); }catch(_){} }
await pool.end();process.exit(0);
