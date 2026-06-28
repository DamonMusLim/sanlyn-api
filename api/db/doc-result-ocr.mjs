import { getPool, setCors } from "../db.js";

const MINIMAX_URL = "https://api.minimaxi.com/anthropic/v1/messages";
const MODEL = "MiniMax-M3";

async function readBody(req){
  if(req.body!==undefined){
    if(typeof req.body==='string') return req.body?JSON.parse(req.body):{};
    if(Buffer.isBuffer(req.body)) return req.body.length?JSON.parse(req.body.toString('utf8')):{};
    if(typeof req.body==='object'&&req.body!==null) return req.body;
  }
  const chunks=[]; for await (const c of req) chunks.push(Buffer.from(c));
  const raw=Buffer.concat(chunks).toString('utf8').trim();
  return raw?JSON.parse(raw):{};
}
async function factoryCompanyOf(pool, orderId){
  try{ const r=await pool.query(
    `SELECT f.company_code FROM orders o JOIN order_line_items oli ON oli.order_id=o.id JOIN products p ON p.sku=oli.sku JOIN factories f ON f.name=p.factory_name
     WHERE (o.order_no=$1 OR o.contract_no=$1 OR o._id=$1 OR o.customer_po=$1) AND f.company_code IS NOT NULL LIMIT 1`,[orderId]);
    return r.rows[0]?.company_code || null; }catch(_){ return null; }
}
function checkSpec(spec, val){ const v=parseFloat(val); if(isNaN(v)) return null; spec=String(spec).replace(/\s/g,''); let m;
  if((m=spec.match(/^[≤<]=?([\d.]+)$/))) return v<=parseFloat(m[1]);
  if((m=spec.match(/^[≥>]=?([\d.]+)$/))) return v>=parseFloat(m[1]);
  if((m=spec.match(/^([\d.]+)[-~~]([\d.]+)$/))) return v>=parseFloat(m[1])&&v<=parseFloat(m[2]);
  return null; }

// POST { orderNo, docKind(fi|qc), fileUrl } → OCR 已填报告抽实测值 → 写 factory_doc_results(草稿,待人工"我同意"确认)
export default async function handler(req, res){
  setCors(req, res, "POST, OPTIONS");
  if(req.method==='OPTIONS') return res.status(204).end();
  if(req.method!=='POST') return res.status(405).json({error:'POST only'});
  const pool=getPool();
  let body; try{ body=await readBody(req); }catch(_){ body={}; }
  const orderNo=(body.orderNo||body.id||'').toString();
  const docKind=(body.docKind||body.kind||'fi').toString();
  const fileUrl=(body.fileUrl||body.url||'').toString();
  if(!orderNo||!fileUrl) return res.status(400).json({error:'缺少 orderNo / fileUrl', filled:{}});

  const oR=await pool.query("SELECT * FROM orders WHERE _id=$1 OR contract_no=$1 OR order_no=$1 OR customer_po=$1 LIMIT 1",[orderNo]);
  if(!oR.rows.length) return res.status(404).json({error:'订单未找到', filled:{}});
  const o=oR.rows[0];
  const liR=await pool.query("SELECT hs_code FROM order_line_items WHERE order_id=$1 AND hs_code IS NOT NULL ORDER BY sort_order,id LIMIT 1",[o.id||o._id]);
  const hs4=String((liR.rows[0]||{}).hs_code||'').replace(/\D/g,'').slice(0,4);
  const cc=await factoryCompanyOf(pool, orderNo);
  const tR=await pool.query("SELECT items FROM factory_doc_templates WHERE factory_company_code = ANY($1) AND hs_prefix=$2 AND doc_kind=$3 AND active ORDER BY (factory_company_code <> '*') DESC, version DESC LIMIT 1",[[cc||'__none__','*'],hs4,docKind]);
  const items=(tR.rows[0]&&Array.isArray(tR.rows[0].items))?tR.rows[0].items:[];
  if(!items.length) return res.status(200).json({error:'该品类无模版,无法定向抽取', filled:{}});
  const names=items.map(it=>it.name).filter(Boolean);

  const key=process.env.MINIMAX_API_KEY;
  if(!key) return res.status(200).json({error:'OCR未配置(MINIMAX_API_KEY)', filled:{}});
  let buf, isPdf;
  try{
    const fr=await fetch(fileUrl,{signal:AbortSignal.timeout(20000)});
    if(!fr.ok) return res.status(200).json({error:'下载文件失败 '+fr.status, filled:{}});
    buf=Buffer.from(await fr.arrayBuffer());
    isPdf=/\.pdf(\?|$)/i.test(fileUrl) || buf.slice(0,4).toString()==='%PDF';
  }catch(e){ return res.status(200).json({error:'下载异常 '+(e.message||''), filled:{}}); }

  const block = isPdf
    ? { type:"document", source:{type:"base64", media_type:"application/pdf", data:buf.toString("base64")} }
    : { type:"image", source:{type:"base64", media_type:/\.png(\?|$)/i.test(fileUrl)?"image/png":"image/jpeg", data:buf.toString("base64")} };
  const prompt='这是一份检验报告/质检报告。请提取每个检验项目的【检验结果】实测值(注意:是实测结果那一列,不是技术要求/标准值那一列)。只针对这些项目:'
    + names.join('、') + '。严格只返回一个JSON对象,key用上面给的项目名原文,value是该项目实测结果(数字或文字)。找不到的项目不要放进去。例:{"水分":"4.11","结团性":"3"}。不要任何解释。';
  let parsed={};
  try{
    const resp=await fetch(MINIMAX_URL,{method:"POST",headers:{Authorization:"Bearer "+key,"Content-Type":"application/json"},
      body:JSON.stringify({model:MODEL,max_tokens:3000,messages:[{role:"user",content:[block,{type:"text",text:prompt}]}]}),
      signal:AbortSignal.timeout(45000)});
    if(!resp.ok) return res.status(200).json({error:'OCR返回 '+resp.status, filled:{}});
    const data=await resp.json();
    const t=(Array.isArray(data.content)?(data.content.find(c=>c&&c.type==='text')||{}).text:'')||'';
    parsed=JSON.parse((t.match(/\{[\s\S]*\}/)||['{}'])[0]);
  }catch(e){ return res.status(200).json({error:'OCR解析失败 '+(e.message||''), filled:{}}); }

  // 绝不编造: 只保留模版里有的项目名 + OCR返回的非空值
  const filled={};
  for(const n of names){ const v=parsed[n]; if(v!==undefined&&v!==null&&String(v).trim()!=='') filled[n]=String(v).trim(); }
  if(!Object.keys(filled).length) return res.status(200).json({error:'OCR未识别出任何结果,请人工核对填写', filled:{}});

  await pool.query(`INSERT INTO factory_doc_results(order_no,doc_kind,results,source,filled_by)
    VALUES($1,$2,$3::jsonb,'OCR自动识别(MiniMax-M3,待人工确认)','ocr')
    ON CONFLICT(order_no,doc_kind) DO UPDATE SET results=EXCLUDED.results, source=EXCLUDED.source, filled_at=now()`,[orderNo,docKind,JSON.stringify(filled)]);

  const verdicts=items.map(it=>{ const v=filled[it.name]; const ok=(v!==undefined)?checkSpec(it.spec,v):null; return {name:it.name,spec:it.spec,result:v||'',verdict:ok===null?'(无法判定)':(ok?'合格':'超标')}; });
  const over=verdicts.filter(x=>x.verdict==='超标').map(x=>x.name);
  const missing=items.filter(it=>filled[it.name]===undefined||filled[it.name]===null||String(filled[it.name]).trim()==='').map(it=>it.name);
  const docTypeKey=docKind==='fi'?'factory_inspection':(docKind==='qc'?'qc_report':null);
  const allRecognized=missing.length===0;
  const allQualified=verdicts.every(x=>x.verdict==='合格');
  let autoConfirmed=false; let confirmReason='';
  if(docTypeKey&&allRecognized&&allQualified){
    const reviewedAt=new Date().toISOString();
    const reviewMeta={ reviewed:true, reviewedBy:'auto\u00b7skill\u5ba1\u6838', auto:true, basis:'OCR+\u786e\u5b9a\u6027\u5224\u5b9a\u5168\u90e8\u5408\u683c', verdicts, reviewedAt };
    const upd=await pool.query(`UPDATE document_uploads SET review_meta=$1::jsonb WHERE doc_id=$2 AND doc_type=$3 AND url=$4`,[JSON.stringify(reviewMeta),orderNo,docTypeKey,fileUrl]);
    autoConfirmed=upd.rowCount>0;
    confirmReason=autoConfirmed?'\u5168\u90e8\u9879\u76ee\u8bc6\u522b\u5b8c\u6574\u4e14\u5224\u5b9a\u5408\u683c\uff0c\u5df2\u81ea\u52a8\u786e\u8ba4':'\u5224\u5b9a\u5408\u683c\u4f46\u672a\u5339\u914d\u5230\u4e0a\u4f20\u6587\u4ef6\uff0c\u7559\u5f85\u4eba\u5de5\u786e\u8ba4';
  }else{
    const reasons=[];
    if(!docTypeKey) reasons.push('\u8be5\u7c7b\u578b\u4e0d\u81ea\u52a8\u786e\u8ba4');
    if(missing.length) reasons.push('\u672a\u8bc6\u522b\u9879: '+missing.join('\u3001'));
    if(over.length) reasons.push('\u8d85\u6807\u9879: '+over.join('\u3001'));
    if(verdicts.some(x=>x.verdict==='(无法判定)')) reasons.push('\u5b58\u5728\u65e0\u6cd5\u5224\u5b9a\u9879');
    confirmReason=reasons.join('\uff1b')||'\u672a\u6ee1\u8db3\u81ea\u52a8\u786e\u8ba4\u6761\u4ef6\uff0c\u7559\u4eba\u5de5';
  }
  return res.status(200).json({ ok:true, orderNo, docKind, filled, verdicts, over, autoConfirmed, confirmReason, note:autoConfirmed?'OCR\u5df2\u81ea\u52a8\u786e\u8ba4':'OCR\u4e3a\u8349\u7a3f,\u8bf7\u4eba\u5de5\u6838\u5bf9\u540e\u786e\u8ba4' });
}
