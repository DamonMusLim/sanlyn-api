import 'dotenv/config'; import pg from 'pg';
/* finance-slip 实测：跑 skill 明文定义的 5 条自动审核规则，看能不能抓出问题
   ①金额分摊 ②候选来源 ③汇款人↔客户 ④累计超收 ⑤收款主体 */
const p=new pg.Pool({connectionString:process.env.DATABASE_URL});
const Q=async(s,a)=>{try{return (await p.query(s,a)).rows}catch(e){console.log('ERR',e.message.slice(0,150));return []}};
const norm=s=>String(s||'').toUpperCase().replace(/[^A-Z0-9一-龥]/g,'')
  .replace(/(SDNBHD|CO|LTD|LIMITED|INC|有限公司|股份|国际|物流)/g,'');
const sim=(a,b)=>{a=norm(a);b=norm(b);if(!a||!b)return 0;
  if(a.includes(b)||b.includes(a))return 1;
  let m=0;for(const ch of new Set(a))if(b.includes(ch))m++;return m/new Set(a).size};
console.log('=== 规则① 金额分摊：links 合计 ≠ 水单金额（阈值 max(¥10, 0.5%)）===');
console.table(await Q(`SELECT s.id,s.bank_reference_no ref,s.amount 水单额,
   round(COALESCE(sum(l.amount_alloc),0)::numeric,2) 分摊合计,
   round((s.amount-COALESCE(sum(l.amount_alloc),0))::numeric,2) 差额
  FROM bank_slips s LEFT JOIN bank_slip_links l ON l.slip_id=s.id
 GROUP BY s.id,s.bank_reference_no,s.amount
 HAVING abs(s.amount-COALESCE(sum(l.amount_alloc),0)) > GREATEST(10, abs(s.amount)*0.005)
 ORDER BY abs(s.amount-COALESCE(sum(l.amount_alloc),0)) DESC LIMIT 10`));
console.log('=== 规则③ 汇款人↔客户 相似度<0.65 ===');
const r3=await Q(`SELECT s.id,s.sender_name 汇款人,s.amount,
   (SELECT string_agg(DISTINCT o.customer,'/') FROM bank_slip_links l
     LEFT JOIN orders o ON o.order_no=l.order_no OR o.contract_no=l.contract_no
    WHERE l.slip_id=s.id) 候选客户
  FROM bank_slips s WHERE s.sender_name IS NOT NULL`);
const bad3=r3.filter(x=>x.候选客户&&sim(x.汇款人,x.候选客户)<0.65);
console.log(`  检查 ${r3.filter(x=>x.候选客户).length} 张有候选的 → 低相似 ${bad3.length} 张`);
console.table(bad3.slice(0,8).map(x=>({id:x.id,汇款人:String(x.汇款人).slice(0,22),客户:String(x.候选客户).slice(0,22),
  相似度:sim(x.汇款人,x.候选客户).toFixed(2)})));
console.log('=== 规则⑤ 收款主体查得到吗 ===');
console.table(await Q(`SELECT s.beneficiary_name 收款人,count(*)::int 张,
   CASE WHEN EXISTS(SELECT 1 FROM companies c WHERE c.name_cn=s.beneficiary_name OR c.name_en=s.beneficiary_name)
        THEN '✅在公司表' ELSE '🔴查不到' END 判定
  FROM bank_slips s WHERE s.beneficiary_name IS NOT NULL GROUP BY 1,3 ORDER BY 张 DESC LIMIT 10`));
console.log('=== 铁律④ 取外币不取本币(MYR)：有没有 MYR 混进来 ===');
console.table(await Q(`SELECT currency 币种,count(*)::int 张,round(sum(amount)::numeric,0) 金额 FROM bank_slips GROUP BY 1`));
console.log('=== 铁律 bankRef 唯一：有没有重复 ===');
console.table(await Q(`SELECT bank_source,bank_reference_no,count(*)::int n FROM bank_slips
  WHERE bank_reference_no IS NOT NULL GROUP BY 1,2 HAVING count(*)>1`));
await p.end();
