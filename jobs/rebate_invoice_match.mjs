import 'dotenv/config'; import pg from 'pg';
/* finance-rebate · 进项票↔报关单 三单交叉匹配（skill 铁律，不靠金额猜）
   ① 发票 contract_nos / remark 含合同号或PO → 直接定位
   ② 报关单第一法定单位 NW(KG) 与发票数量精确比对（±1%）
   ③ 金额近似，限同工厂 + 时间线合理（天缘那次翻车就是缺这条）
   ⛔ 三单交叉不成立 = STOP 不挂 */
const p=new pg.Pool({connectionString:process.env.DATABASE_URL});
const Q=async(s,a)=>{try{return (await p.query(s,a)).rows}catch(e){console.log('ERR',e.message.slice(0,150));return []}};
const alias=new Map((await Q(`SELECT DISTINCT ON (v.variant) v.variant, COALESCE(m.name_cn,co.name_cn) canon
  FROM companies co CROSS JOIN LATERAL (VALUES (co.name_cn),(co.factory_name)) v(variant)
  LEFT JOIN companies m ON m.code=co.merged_into_code WHERE COALESCE(v.variant,'')<>''
  ORDER BY v.variant,(co.merged_into_code IS NULL) DESC,(co.code NOT LIKE 'DEPRECATED%') DESC,co.id`))
  .map(r=>[r.variant,r.canon]));
const K=s=>alias.get(s)||s;
// 缺口：报关单 × 工厂
const gaps=await Q(`SELECT f.customs_no cn, f.factory_name fac, f.expected_amount yk,
   r.export_date::date ed, r.contract_no ct,
   COALESCE((SELECT sum(i.amount_incl_tax) FROM invoice_customs_links l JOIN finance_invoices_in i ON i.id=l.invoice_id
     WHERE l.customs_no=f.customs_no AND i.seller_name=f.factory_name AND l.link_status='active'
       AND COALESCE(i.review_status,'') NOT IN ('void','red_ink','suspect_dup')),0) yj,
   (SELECT round(sum(ci.net_weight_kg),2) FROM customs_declaration_items ci
     JOIN customs_declarations cd ON cd.id=ci.declaration_id JOIN companies co ON co.id=ci.factory_company_id
    WHERE cd.declaration_no=f.customs_no AND ci.deleted_at IS NULL AND co.name_cn=f.factory_name) nw
  FROM factory_invoice_expected_amounts f
  JOIN finance_export_rebates r ON r.customs_no=f.customs_no
 WHERE f.status='ready' AND f.expected_amount>0`);
// 候选票：待认领队列 + 已挂但可能挂错的
const inv=await Q(`SELECT i.id,i.invoice_no no,i.seller_name sn,i.amount_ex_tax ex,i.amount_incl_tax amt,
   i.issue_date::date d, i.contract_nos ct, i.remark, i.line_items::text li,
   (SELECT count(*)::int FROM invoice_customs_links l WHERE l.invoice_id=i.id AND l.link_status='active') linked
  FROM finance_invoices_in i
 WHERE EXISTS(SELECT 1 FROM companies c WHERE c.name_cn=i.seller_name AND c.type='factory')
   AND i.amount_incl_tax IS NOT NULL`);
console.log('缺口条目',gaps.length,'| 工厂进项票',inv.length);
const kgOf=(v)=>{ let L=[];try{L=JSON.parse(v.li)}catch{} let kg=0;
  for(const l of (Array.isArray(L)?L:[])){ const u=String(l.unit||''); const q=Number(l.qty);
    if(!isFinite(q))continue; if(/千克|kg|KG/.test(u)) kg+=q; } return kg||null; };
const used=new Set(); const hit=[],multi=[],none=[];
for(const g of gaps.filter(x=>Number(x.yk)-Number(x.yj)>1)){
  const gap=Number(g.yk)-Number(g.yj);
  const same=inv.filter(v=>!used.has(v.id)&&K(v.sn)===K(g.fac));
  // ① 合同号
  let c1=same.filter(v=>Array.isArray(v.ct)&&g.ct&&v.ct.some(x=>x&&(x===g.ct||g.ct.includes(x))));
  // ② NW(KG) ±1%
  let c2=same.filter(v=>{const k=kgOf(v); return g.nw&&k&&Math.abs(k-Number(g.nw))<=Number(g.nw)*0.01});
  // ③ 金额 + 时间线（开票日在出口日 -60~+120 天内）
  const okDate=(v)=>{ if(!g.ed||!v.d) return false; const dd=(new Date(v.d)-new Date(g.ed))/864e5; return dd>=-60&&dd<=120 };
  let c3=same.filter(v=>Math.abs(Number(v.amt)-gap)<0.01&&okDate(v));
  const pick=(c1.length===1?['①合同号',c1]:c2.length===1?['②净重KG',c2]:c3.length===1?['③金额+时间线',c3]:null);
  if(pick){ used.add(pick[1][0].id);
    hit.push({报关单:g.cn,工厂:K(g.fac).slice(0,12),缺口:gap.toFixed(2),发票:pick[1][0].no,
      发票额:pick[1][0].amt,开票日:String(pick[1][0].d).slice(0,10),出口日:String(g.ed).slice(0,10),依据:pick[0],
      已挂别处:pick[1][0].linked>0?'⚠️是':''});
  } else if(c1.length+c2.length+c3.length>0){
    multi.push({报关单:g.cn,工厂:K(g.fac).slice(0,12),缺口:gap.toFixed(2),
      候选:`①${c1.length} ②${c2.length} ③${c3.length}`});
  } else none.push({报关单:g.cn,工厂:K(g.fac).slice(0,12),缺口:gap.toFixed(2),报关净重:g.nw});
}
console.log('\n✅ 三单交叉唯一命中:'+hit.length);
console.table(hit);
console.log('⚠️ 多候选需人判:'+multi.length); console.table(multi);
console.log('🔴 找不到票（真缺）:'+none.length); console.table(none.slice(0,20));
console.log(`\n命中缺口 ¥${hit.reduce((t,x)=>t+Number(x.缺口),0).toFixed(2)} | 真缺 ¥${none.reduce((t,x)=>t+Number(x.缺口),0).toFixed(2)}`);
console.log('⛔ dry-run：一条都没挂');
await p.end();
