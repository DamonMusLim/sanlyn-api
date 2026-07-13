// rebate_gaps.mjs — 退税缺料检测节点(每日cron)。scope=2026 1-6月。写 tasks 给 agent。
// agent 照 next_action 补;补不到(如货代要不到PDF)→escalate Damon。
// public.tasks 约束(2026-07-13修,参照 amount_divergence_scan.mjs):
//   status∈{open,doing,done,cancelled}; level是对象类别(order/doc/..)非紧急度→紧急度写 priority(p0/p1);
//   ⚠ 库是 SQL_ASCII: varchar(n)=n字节,汉字≈3字节!截断必须按字节(fitBytes),JS slice按字符会超长。
//   id varchar(32)→报关单号(18位)截尾部保唯一(头部关区码大量重复),厂名按字节截头部。
// 自动收口: 缺料补齐后→cancelled+[自动核销]标记(带标记可复活); done/人工cancelled=永不复活; doing=只刷内容不动状态。
import { readFileSync } from "fs";
const env = readFileSync("/opt/sanlyn-api-test/.env","utf-8");
for (const line of env.split("\n")){const [k,...vs]=line.split("=");if(k&&!k.startsWith("#"))process.env[k.trim()]=vs.join("=").trim();}
const { getPool } = await import("/opt/sanlyn-api-test/api/db.js");
const pool = getPool();
const SCOPE = `fer.export_date >= '2026-01-01' AND fer.export_date < '2026-07-01'`;
const ESC = " | agent:照此补,补不到→问Damon";
const AUTO_MARK = "[自动核销:缺料已补齐";

// SQL_ASCII库: 按字节截断且不切断多字节字符
const fitBytes = (s, max) => { s = String(s ?? ""); let out = "", n = 0; for (const ch of s) { const b = Buffer.byteLength(ch); if (n + b > max) break; out += ch; n += b; } return out; };
// tasks.id varchar(32字节)。数字单号保尾部(slice(-n)对短串原样返回);厂名按字节保头部,kind用短码ne多留厂名辨识度
const idNum = (kind, no) => { const p = `rebate-gap-${kind}-`; return p + String(no ?? "").slice(-(32 - p.length)); };
const idName = (kind, name) => fitBytes(`rebate-gap-${kind}-${name}`, 32);
const activeIds = [];

async function upsertTask(id, title, orderNo, priority, action){
  title = fitBytes(title, 200);
  orderNo = orderNo ? fitBytes(orderNo, 64) : null;
  activeIds.push(id);
  try {
    const ex = await pool.query(`SELECT id, status, next_action FROM tasks WHERE id=$1 LIMIT 1`,[id]);
    if (ex.rows.length){
      const status = ex.rows[0].status;
      const autoClosed = status === "cancelled" && String(ex.rows[0].next_action||"").includes(AUTO_MARK);
      if (status === "done" || (status === "cancelled" && !autoClosed)) return "skip"; // 人工终态永不复活
      await pool.query(`UPDATE tasks SET title=$2, related_order_no=$3, next_action=$4, domain='退税',
          priority=$5, task_type='REBATE_GAP', assigned_to='agent',
          status=CASE WHEN status='cancelled' THEN 'open' ELSE status END, updated_at=NOW()
        WHERE id=$1`,[id,title,orderNo,action+ESC,priority]);
      return autoClosed ? "revive" : "upd";
    }
    await pool.query(`INSERT INTO tasks(id,title,task_type,priority,status,related_order_no,next_action,domain,assigned_to,created_at,updated_at)
      VALUES($1,$2,'REBATE_GAP',$3,'open',$4,$5,'退税','agent',NOW(),NOW())`,[id,title,priority,orderNo,action+ESC]);
    return "new";
  } catch(e){ console.log(`${id} upsert failed:`, e.message); return "err"; }
}

// 本轮未检出的 open 任务=缺料已补齐,自动核销(仅在全部检测器无异常时调用,防漏扫误销)
async function autoResolve(){
  const today = new Date().toISOString().slice(0,10);
  try {
    const res = await pool.query(`UPDATE tasks SET status='cancelled',
        next_action=COALESCE(next_action,'') || $2, updated_at=NOW()
      WHERE id LIKE 'rebate-gap-%' AND status='open' AND NOT (id = ANY($1::text[]))`,
      [activeIds, `\n${AUTO_MARK} ${today}]`]);
    return res.rowCount || 0;
  } catch(e){ console.log("auto resolve failed:", e.message); return 0; }
}

const counts = {new:0,upd:0,revive:0,skip:0,err:0,resolved:0}; const cnt={};
const tally=(k,rr)=>{ if(rr!=="skip"&&rr!=="err")cnt[k]=(cnt[k]||0)+1; counts[rr]=(counts[rr]||0)+1; };
const portWho=p=>{p=(p||'').toLowerCase(); if(/天津|tianjin|xingang/.test(p))return'天津货代(惠禾等;内转外=中远海)'; if(/青岛|qingdao/.test(p))return'青岛货代(中远海/万汇)'; if(/厦门|xiamen/.test(p))return'厦门货代(中远海/万汇)'; return'对应货代';};

let scanOk = true;
try {
  // 1. 缺报关单OCR (带货代/BL,让agent照BL催)
  for(const r of (await pool.query(`SELECT fer.customs_no, fer.contract_no,
    (SELECT STRING_AGG(DISTINCT o.order_no,',') FROM orders o WHERE o.contract_no=fer.contract_no) AS order_nos,
    (SELECT STRING_AGG(DISTINCT o.pol,',') FROM orders o WHERE o.contract_no=fer.contract_no) AS pol,
    (SELECT STRING_AGG(DISTINCT o.bl_no,',') FROM orders o WHERE o.contract_no=fer.contract_no AND o.bl_no IS NOT NULL) AS bl
    FROM finance_export_rebates fer WHERE (fer.raw IS NULL OR fer.raw='{}'::jsonb) AND ${SCOPE}`)).rows){
    const ord=(r.order_nos||r.contract_no||'').split(',')[0];
    tally('缺报关单OCR', await upsertTask(idNum('ocr',r.customs_no),`退税缺料: 报关单 ${r.customs_no} 未OCR镜像`,ord,'p1',`找${portWho(r.pol)}按BL[${r.bl||'?'}]要报关单PDF→上传→自动OCR(BL=唯一真值)`));
  }
  // 2. 无进项票绑定
  for(const r of (await pool.query(`SELECT fer.customs_no, fer.contract_no,
    (SELECT STRING_AGG(DISTINCT o.order_no,',') FROM orders o WHERE o.contract_no=fer.contract_no) AS order_nos,
    (SELECT STRING_AGG(DISTINCT c.name_cn,'、') FROM orders o JOIN companies c ON c.id=o.factory_company_id WHERE o.contract_no=fer.contract_no) AS factory
    FROM finance_export_rebates fer WHERE NOT EXISTS(SELECT 1 FROM finance_invoices_in fi WHERE fer.customs_no = ANY(COALESCE(fi.customs_nos,'{}'))) AND ${SCOPE}`)).rows){
    const ord=(r.order_nos||r.contract_no||'').split(',')[0];
    tally('缺进项票', await upsertTask(idNum('inv',r.customs_no),`退税缺料: 报关单 ${r.customs_no}${r.factory?'('+r.factory+')':''} 无进项票绑定`,ord,'p1',`退税页「绑票」绑${r.factory||'该工厂'}的进项票;无票→「链接」催工厂开票上传`));
  }
  // 3. 倒挂
  for(const r of (await pool.query(`SELECT fer.customs_no,(fer.raw->>'total_amount')::numeric d,
    (SELECT STRING_AGG(DISTINCT o.order_no,',') FROM orders o WHERE o.contract_no=fer.contract_no) AS order_nos,
    (SELECT SUM(fi.amount_ex_tax) FROM finance_invoices_in fi WHERE fer.customs_no=ANY(COALESCE(fi.customs_nos,'{}'))) AS ie
    FROM finance_export_rebates fer WHERE fer.raw->>'total_amount' IS NOT NULL AND ${SCOPE}
    AND (SELECT SUM(fi.amount_ex_tax) FROM finance_invoices_in fi WHERE fer.customs_no=ANY(COALESCE(fi.customs_nos,'{}'))) > (fer.raw->>'total_amount')::numeric*1.05`)).rows){
    const ord=(r.order_nos||'').split(',')[0];
    tally('倒挂', await upsertTask(idNum('inv-high',r.customs_no),`退税倒挂: ${r.customs_no} 发票¥${Math.round(r.ie)}>报关¥${Math.round(r.d)}`,ord,'p0','发票价不得超报关价;让工厂红冲/重开'));
  }
  // 4. 缺出口(工厂有进项票无出口)
  for(const r of (await pool.query(`SELECT c.name_cn f,COUNT(*)::int n,SUM(fi.amount_incl_tax)::numeric t FROM finance_invoices_in fi JOIN companies c ON c.id=fi.factory_id WHERE fi.factory_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM orders o JOIN finance_export_rebates fer ON fer.contract_no=o.contract_no WHERE o.factory_company_id=fi.factory_id) GROUP BY c.name_cn HAVING SUM(fi.amount_incl_tax)>5000`)).rows){
    tally('缺出口', await upsertTask(idName('ne',r.f),`退税缺出口: ${r.f} 进项票${r.n}张¥${Math.round(r.t)}无出口报关单`,null,'p1','查货是否出口/订单是否挂该工厂/公司是否重复(如中宠);补建或合并'));
  }
} catch(e){ scanOk=false; console.log("scan failed:", e.message); }

if (scanOk) counts.resolved = await autoResolve();

console.log(`=== 退税缺料检测(2026 1-6月) ${new Date().toISOString().slice(0,16)} ===`);
console.log(`写tasks给agent: 新增${counts.new} 更新${counts.upd} 复活${counts.revive} 核销${counts.resolved} 跳过${counts.skip} 错误${counts.err}`);
console.log("各类缺料:", JSON.stringify(cnt), "| 总:", Object.values(cnt).reduce((a,b)=>a+b,0));
await pool.end().catch(()=>{});
process.exit(counts.err ? 1 : 0);
