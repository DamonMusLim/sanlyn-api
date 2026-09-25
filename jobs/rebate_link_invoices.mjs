import 'dotenv/config'; import pg from 'pg';
const p=new pg.Pool({connectionString:process.env.DATABASE_URL});
const WRITE=process.argv.includes('--write');
const c=await p.connect();
const K=new Map();
try{
 (await c.query(`SELECT DISTINCT ON (v.variant) v.variant, COALESCE(m.name_cn,co.name_cn) canon
   FROM companies co CROSS JOIN LATERAL (VALUES (co.name_cn),(co.factory_name)) v(variant)
   LEFT JOIN companies m ON m.code=co.merged_into_code WHERE COALESCE(v.variant,'')<>''
   ORDER BY v.variant,(co.merged_into_code IS NULL) DESC,(co.code NOT LIKE 'DEPRECATED%') DESC,co.id`))
   .rows.forEach(r=>K.set(r.variant,r.canon));
 const kn=s=>K.get(s)||s;
 await c.query('BEGIN');
 const gaps=(await c.query(`SELECT f.customs_no cn,f.factory_name fac,f.expected_amount yk,
    r.export_date::date ed,r.contract_no ct,
    COALESCE((SELECT sum(i.amount_incl_tax) FROM invoice_customs_links l JOIN finance_invoices_in i ON i.id=l.invoice_id
      WHERE l.customs_no=f.customs_no AND i.seller_name=f.factory_name AND l.link_status='active'
        AND COALESCE(i.review_status,'') NOT IN ('void','red_ink','suspect_dup')),0) yj
   FROM factory_invoice_expected_amounts f JOIN finance_export_rebates r ON r.customs_no=f.customs_no
  WHERE f.status='ready' AND f.expected_amount>0`)).rows;
 const inv=(await c.query(`SELECT i.id,i.invoice_no no,i.seller_name sn,i.amount_incl_tax amt,i.issue_date::date d,
    i.contract_nos ct,(SELECT count(*)::int FROM invoice_customs_links l WHERE l.invoice_id=i.id AND l.link_status='active') linked,
    (SELECT code FROM companies WHERE name_cn=i.seller_name AND type='factory' LIMIT 1) fcode
   FROM finance_invoices_in i
  WHERE EXISTS(SELECT 1 FROM companies cc WHERE cc.name_cn=i.seller_name AND cc.type='factory')
    AND i.amount_incl_tax IS NOT NULL`)).rows;
 const used=new Set(); const doit=[],hold=[];
 for(const g of gaps.filter(x=>Number(x.yk)-Number(x.yj)>1)){
   const gap=+(Number(g.yk)-Number(g.yj)).toFixed(2);
   const same=inv.filter(v=>!used.has(v.id)&&kn(v.sn)===kn(g.fac));
   const c1=same.filter(v=>Array.isArray(v.ct)&&g.ct&&v.ct.some(x=>x&&(x===g.ct||g.ct.includes(x))));
   const okDate=v=>g.ed&&v.d&&((new Date(v.d)-new Date(g.ed))/864e5)>=-60&&((new Date(v.d)-new Date(g.ed))/864e5)<=120;
   const c3=same.filter(v=>Math.abs(Number(v.amt)-gap)<0.01&&okDate(v));
   const pick=c1.length===1?['①合同号',c1[0]]:c3.length===1?['③金额+时间线',c3[0]]:null;
   if(!pick) continue;
   const v=pick[1];
   const clean = v.linked===0 && Math.abs(Number(v.amt)-gap)<0.01;
   (clean?doit:hold).push({cn:g.cn,fac:kn(g.fac),fcode:v.fcode,gap,no:v.no,id:v.id,amt:Number(v.amt),
     d:String(v.d).slice(0,10),ed:String(g.ed).slice(0,10),by:pick[0],linked:v.linked});
   used.add(v.id);
 }
 console.log('=== 干净可自动挂（唯一命中 + 未挂别处 + 金额=缺口）:'+doit.length+' ===');
 console.table(doit.map(x=>({报关单:x.cn,工厂:x.fac.slice(0,12),金额:x.amt,发票:x.no,开票:x.d,出口:x.ed,依据:x.by})));
 console.log('=== 暂缓（需人判）:'+hold.length+' ===');
 console.table(hold.map(x=>({报关单:x.cn,工厂:x.fac.slice(0,12),缺口:x.gap,发票额:x.amt,发票:x.no,
   原因:x.linked>0?'已挂别处→需改挂':'金额≠缺口→需分摊'})));
 for(const x of doit){
   await c.query(`INSERT INTO invoice_customs_links(invoice_id,invoice_no,customs_no,factory_code,allocated_amount,link_status,reason,created_by)
     VALUES($1,$2,$3,$4,$5,'active',$6,'finance-rebate/three-doc')
     ON CONFLICT (invoice_id,customs_no) DO UPDATE SET link_status='active',allocated_amount=EXCLUDED.allocated_amount,
       reason=EXCLUDED.reason`,[x.id,x.no,x.cn,x.fcode,x.amt,'three_doc_'+(x.by.includes('合同')?'contract':'amount_date')]);
   await c.query(`UPDATE finance_invoices_in SET customs_nos=(SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(customs_nos,'{}'::text[])||ARRAY[$2::text]))),
     updated_at=now() WHERE id=$1`,[x.id,x.cn]);
   await c.query(`UPDATE finance_invoice_claim_queue SET status='resolved',claimed_customs_no=$2,
     claimed_by='finance-rebate/three-doc',claimed_at=now(),updated_at=now() WHERE invoice_id=$1`,[x.id,x.cn]);
 }
 console.log(`\n已挂 ${doit.length} 条，金额 ¥${doit.reduce((t,x)=>t+x.amt,0).toFixed(2)}`);
 console.log('队列剩余:',JSON.stringify((await c.query(`SELECT count(*)::int n,round(sum(amount_incl_tax)::numeric,0) amt
   FROM finance_invoice_claim_queue WHERE status='open'`)).rows[0]));
 if(WRITE){await c.query('COMMIT');console.log('✅ 已提交')}else{await c.query('ROLLBACK');console.log('⛔ DRY-RUN')}
}catch(e){await c.query('ROLLBACK');console.log('❌',e.message.slice(0,300))}
finally{c.release();await p.end()}
