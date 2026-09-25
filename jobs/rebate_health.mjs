import 'dotenv/config'; import pg from 'pg';
/* 体检：只跑 skill 里明文写着的检查项，不自创
   finance-rebate: 税率体检/倒挂/实退口径/逐项工厂待分/21位号/提单组
   data-guard:     单位空、千克≠净重、三个队列、data_guard_log */
const p=new pg.Pool({connectionString:process.env.DATABASE_URL});
const Q=async(s,a)=>{try{return (await p.query(s,a)).rows}catch(e){return [{ERR:e.message.slice(0,150)}]}};
let bad=0; const R=(n,rows,note='')=>{const k=rows.length&&!rows[0].ERR?rows.length:(rows[0]?.ERR?-1:0);
  console.log(`\n${k>0?'🔴':k<0?'⚠️':'✅'} ${n}: ${k<0?rows[0].ERR:k+' 条'}${note?' — '+note:''}`);
  if(k>0) console.table(rows.slice(0,8)); if(k>0) bad+=k;};

R('①税率非法(应恒空，多HS档NULL豁免)', await Q(`SELECT customs_no,rebate_rate FROM finance_export_rebates
  WHERE customs_no ~ '^[0-9]{18}$' AND rebate_rate IS NOT NULL AND rebate_rate NOT IN (0.09,0.13)`));

R('②倒挂：采购不含税 > 报关额', await Q(`
 SELECT f.customs_no, f.factory_name, f.expected_amount 报关口径应开,
   round(COALESCE((SELECT sum(i.amount_ex_tax) FROM invoice_customs_links l
     JOIN finance_invoices_in i ON i.id=l.invoice_id
    WHERE l.customs_no=f.customs_no AND i.seller_name=f.factory_name AND l.link_status='active'),0)::numeric,2) 进项不含税
  FROM factory_invoice_expected_amounts f WHERE f.status='ready'
  AND COALESCE((SELECT sum(i.amount_ex_tax) FROM invoice_customs_links l
     JOIN finance_invoices_in i ON i.id=l.invoice_id
    WHERE l.customs_no=f.customs_no AND i.seller_name=f.factory_name AND l.link_status='active'),0) > f.expected_amount + 1`));

R('③开票超报关（铁律：绝不能超）', await Q(`
 SELECT f.customs_no, f.factory_name, f.expected_amount 应开,
   round(COALESCE((SELECT sum(i.amount_incl_tax) FROM invoice_customs_links l
     JOIN finance_invoices_in i ON i.id=l.invoice_id
    WHERE l.customs_no=f.customs_no AND i.seller_name=f.factory_name AND l.link_status='active'
      AND COALESCE(i.review_status,'') NOT IN ('void','red_ink','suspect_dup')),0)::numeric,2) 已开
  FROM factory_invoice_expected_amounts f WHERE f.status='ready'
  AND COALESCE((SELECT sum(i.amount_incl_tax) FROM invoice_customs_links l
     JOIN finance_invoices_in i ON i.id=l.invoice_id
    WHERE l.customs_no=f.customs_no AND i.seller_name=f.factory_name AND l.link_status='active'
      AND COALESCE(i.review_status,'') NOT IN ('void','red_ink','suspect_dup')),0) > f.expected_amount + 1`));

R('④逐项工厂待分（未固化）', await Q(`SELECT cd.declaration_no,ci.sort_order,ci.declaration_name_cn,ci.declaration_amount
  FROM customs_declaration_items ci JOIN customs_declarations cd ON cd.id=ci.declaration_id
 WHERE ci.deleted_at IS NULL AND ci.factory_company_id IS NULL AND cd.declaration_no ~ '^[0-9]{18}$'`));

R('⑤单位为空', await Q(`SELECT cd.declaration_no,ci.sort_order,ci.declaration_name_cn,ci.qty
  FROM customs_declaration_items ci JOIN customs_declarations cd ON cd.id=ci.declaration_id
 WHERE ci.deleted_at IS NULL AND COALESCE(ci.unit,'')=''`));

R('⑥单位=千克但数量≠净重', await Q(`SELECT cd.declaration_no,ci.sort_order,ci.qty,ci.net_weight_kg
  FROM customs_declaration_items ci JOIN customs_declarations cd ON cd.id=ci.declaration_id
 WHERE ci.deleted_at IS NULL AND ci.unit='千克' AND ci.net_weight_kg IS NOT NULL
   AND abs(ci.qty-ci.net_weight_kg)>0.5`));

R('⑦非18位报关单号混进金额表', await Q(`SELECT 'fiea' t,customs_no FROM factory_invoice_expected_amounts
  WHERE customs_no !~ '^[0-9]{18}$' UNION ALL SELECT 'cis',customs_no FROM customs_invoice_status
  WHERE customs_no !~ '^[0-9]{18}$'`));

R('⑧同报关单+同法人重复行（中宠那类）', await Q(`
 WITH alias AS (SELECT DISTINCT ON (v.variant) v.variant, COALESCE(m.name_cn,co.name_cn) canon
   FROM companies co CROSS JOIN LATERAL (VALUES (co.name_cn),(co.factory_name)) v(variant)
   LEFT JOIN companies m ON m.code=co.merged_into_code WHERE COALESCE(v.variant,'')<>''
   ORDER BY v.variant,(co.merged_into_code IS NULL) DESC,(co.code NOT LIKE 'DEPRECATED%') DESC,co.id)
 SELECT f.customs_no, COALESCE(a.canon,f.factory_name) 法人, count(*)::int 行数
  FROM factory_invoice_expected_amounts f LEFT JOIN alias a ON a.variant=f.factory_name
 WHERE f.status='ready' GROUP BY 1,2 HAVING count(*)>1`));

R('⑨发票号重复', await Q(`SELECT invoice_no,count(*)::int n FROM finance_invoices_in
  WHERE invoice_no NOT LIKE 'OCR_PENDING%' GROUP BY 1 HAVING count(*)>1`));

R('⑩已退税但无到账日', await Q(`SELECT customs_no,rebate_received,rebate_date FROM finance_export_rebates
  WHERE rebate_lifecycle_status='已退税' AND rebate_date IS NULL`));

console.log('\n=== 队列 ===');
console.table(await Q(`SELECT '进项票待认领' 队列,count(*)::int 条,round(sum(amount_incl_tax)::numeric,0) 金额
  FROM finance_invoice_claim_queue WHERE status='open'`));
console.log('data_guard_log 近 1 天:',JSON.stringify(await Q(`SELECT count(*)::int n FROM data_guard_log
  WHERE created_at > now()-interval '1 day'`)));
console.log(`\n${bad===0?'✅ 全部通过':'🔴 共 '+bad+' 条待处理'}`);
await p.end();
