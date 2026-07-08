// rebate_gaps.mjs — 退税缺料检测节点(每日cron)。scope=2026 1-6月。写 tasks 给 agent。
// agent 照 next_action 补;补不到(如货代要不到PDF)→escalate Damon。
import { readFileSync } from "fs";
const env = readFileSync("/opt/sanlyn-api-test/.env","utf-8");
for (const line of env.split("\n")){const [k,...vs]=line.split("=");if(k&&!k.startsWith("#"))process.env[k.trim()]=vs.join("=").trim();}
const { getPool } = await import("/opt/sanlyn-api-test/api/db.js");
const pool = getPool();
const SCOPE = `fer.export_date >= '2026-01-01' AND fer.export_date < '2026-07-01'`;
const ESC = " | agent:照此补,补不到→问Damon";

async function upsertTask(id, title, orderNo, level, action){
  const ex = await pool.query(`SELECT id, status FROM tasks WHERE id=$1 LIMIT 1`,[id]);
  if(ex.rows.length){
    if(['done','closed','resolved','已完成','已处理'].includes(ex.rows[0].status)) return 'done';
    await pool.query(`UPDATE tasks SET title=$2, related_order_no=$3, next_action=$4, domain='退税', level=$5, assigned_to='agent', updated_at=NOW() WHERE id=$1`,[id,title,orderNo,action+ESC,level]);
    return 'upd';
  }
  await pool.query(`INSERT INTO tasks(id,title,task_type,level,status,related_order_no,next_action,domain,assigned_to,created_at,updated_at)
    VALUES($1,$2,'REBATE_GAP',$3,'open',$4,$5,'退税','agent',NOW(),NOW())`,[id,title,level,orderNo,action+ESC])
    .catch(async()=>{ await pool.query(`INSERT INTO tasks(id,title,status,related_order_no,domain,created_at,updated_at) VALUES($1,$2,'open',$3,'退税',NOW(),NOW())`,[id,title,orderNo]).catch(()=>{}); });
  return 'new';
}
let nNew=0,nUpd=0; const cnt={};
const tally=(k,rr)=>{ if(rr!=='done')cnt[k]=(cnt[k]||0)+1; if(rr==='new')nNew++;else if(rr==='upd')nUpd++; };
const portWho=p=>{p=(p||'').toLowerCase(); if(/天津|tianjin|xingang/.test(p))return'天津货代(惠禾等;内转外=中远海)'; if(/青岛|qingdao/.test(p))return'青岛货代(中远海/万汇)'; if(/厦门|xiamen/.test(p))return'厦门货代(中远海/万汇)'; return'对应货代';};

// 1. 缺报关单OCR (带货代/BL,让agent照BL催)
for(const r of (await pool.query(`SELECT fer.customs_no, fer.contract_no,
  (SELECT STRING_AGG(DISTINCT o.order_no,',') FROM orders o WHERE o.contract_no=fer.contract_no) AS order_nos,
  (SELECT STRING_AGG(DISTINCT o.pol,',') FROM orders o WHERE o.contract_no=fer.contract_no) AS pol,
  (SELECT STRING_AGG(DISTINCT o.bl_no,',') FROM orders o WHERE o.contract_no=fer.contract_no AND o.bl_no IS NOT NULL) AS bl
  FROM finance_export_rebates fer WHERE (fer.raw IS NULL OR fer.raw='{}'::jsonb) AND ${SCOPE}`)).rows){
  const ord=(r.order_nos||r.contract_no||'').split(',')[0];
  tally('缺报关单OCR', await upsertTask(`rebate-gap-ocr-${r.customs_no}`,`退税缺料: 报关单 ${r.customs_no} 未OCR镜像`,ord,'P1',`找${portWho(r.pol)}按BL[${r.bl||'?'}]要报关单PDF→上传→自动OCR(BL=唯一真值)`));
}
// 2. 无进项票绑定
for(const r of (await pool.query(`SELECT fer.customs_no, fer.contract_no,
  (SELECT STRING_AGG(DISTINCT o.order_no,',') FROM orders o WHERE o.contract_no=fer.contract_no) AS order_nos,
  (SELECT STRING_AGG(DISTINCT c.name_cn,'、') FROM orders o JOIN companies c ON c.id=o.factory_company_id WHERE o.contract_no=fer.contract_no) AS factory
  FROM finance_export_rebates fer WHERE NOT EXISTS(SELECT 1 FROM finance_invoices_in fi WHERE fer.customs_no = ANY(COALESCE(fi.customs_nos,'{}'))) AND ${SCOPE}`)).rows){
  const ord=(r.order_nos||r.contract_no||'').split(',')[0];
  tally('缺进项票', await upsertTask(`rebate-gap-inv-${r.customs_no}`,`退税缺料: 报关单 ${r.customs_no}${r.factory?'('+r.factory+')':''} 无进项票绑定`,ord,'P1',`退税页「绑票」绑${r.factory||'该工厂'}的进项票;无票→「链接」催工厂开票上传`));
}
// 3. 倒挂
for(const r of (await pool.query(`SELECT fer.customs_no,(fer.raw->>'total_amount')::numeric d,
  (SELECT STRING_AGG(DISTINCT o.order_no,',') FROM orders o WHERE o.contract_no=fer.contract_no) AS order_nos,
  (SELECT SUM(fi.amount_ex_tax) FROM finance_invoices_in fi WHERE fer.customs_no=ANY(COALESCE(fi.customs_nos,'{}'))) AS ie
  FROM finance_export_rebates fer WHERE fer.raw->>'total_amount' IS NOT NULL AND ${SCOPE}
  AND (SELECT SUM(fi.amount_ex_tax) FROM finance_invoices_in fi WHERE fer.customs_no=ANY(COALESCE(fi.customs_nos,'{}'))) > (fer.raw->>'total_amount')::numeric*1.05`)).rows){
  const ord=(r.order_nos||'').split(',')[0];
  tally('倒挂', await upsertTask(`rebate-gap-inv-high-${r.customs_no}`,`退税倒挂: ${r.customs_no} 发票¥${Math.round(r.ie)}>报关¥${Math.round(r.d)}`,ord,'P0','发票价不得超报关价;让工厂红冲/重开'));
}
// 4. 缺出口(工厂有进项票无出口)
for(const r of (await pool.query(`SELECT c.name_cn f,COUNT(*)::int n,SUM(fi.amount_incl_tax)::numeric t FROM finance_invoices_in fi JOIN companies c ON c.id=fi.factory_id WHERE fi.factory_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM orders o JOIN finance_export_rebates fer ON fer.contract_no=o.contract_no WHERE o.factory_company_id=fi.factory_id) GROUP BY c.name_cn HAVING SUM(fi.amount_incl_tax)>5000`)).rows){
  tally('缺出口', await upsertTask(`rebate-gap-noexport-${r.f}`,`退税缺出口: ${r.f} 进项票${r.n}张¥${Math.round(r.t)}无出口报关单`,null,'P1','查货是否出口/订单是否挂该工厂/公司是否重复(如中宠);补建或合并'));
}

console.log(`=== 退税缺料检测(2026 1-6月) ${new Date().toISOString().slice(0,16)} ===`);
console.log(`写tasks给agent: 新增${nNew} 更新${nUpd}`);
console.log("各类缺料:", JSON.stringify(cnt), "| 总:", Object.values(cnt).reduce((a,b)=>a+b,0));
process.exit(0);
