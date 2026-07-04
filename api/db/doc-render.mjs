import { getPool, setCors } from "../db.js";

const esc = s => String(s==null?'':s).replace(/[&<>"]/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function fmtD(v){ if(!v) return ''; try{ const d=new Date(v); if(isNaN(d)) return String(v); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }catch(_){ return String(v);} }
const pick=(...a)=>{ for(const x of a){ if(x!==undefined && x!==null && x!=='') return x; } return ''; };
function checkSpec(spec, val){ const v=parseFloat(val); if(isNaN(v)) return null; spec=String(spec).replace(/\s/g,''); let m;
  if((m=spec.match(/^[≤<]=?([\d.]+)$/))) return v<=parseFloat(m[1]);
  if((m=spec.match(/^[≥>]=?([\d.]+)$/))) return v>=parseFloat(m[1]);
  if((m=spec.match(/^([\d.]+)[-~~]([\d.]+)$/))) return v>=parseFloat(m[1])&&v<=parseFloat(m[2]);
  return null; }
function typicalVal(spec){
  if(!spec) return '';
  const s=String(spec).replace(/\s/g,''); let m;
  if((m=s.match(/^[≤<]=?([\d.]+)$/))){ const mx=parseFloat(m[1]); return mx<=1?(mx*0.7).toFixed(2):mx<=10?(mx*0.75).toFixed(1):String(Math.round(mx*0.75)); }
  if((m=s.match(/^[≥>]=?([\d.]+)$/))){ const mn=parseFloat(m[1]); return mn<10?(mn*1.10).toFixed(1):String(Math.round(mn*1.08)); }
  if((m=s.match(/^([\d.]+)[-~]([\d.]+)$/))){ return ((parseFloat(m[1])+parseFloat(m[2]))/2).toFixed(2); }
  return spec;
}

async function factoryCompanyOf(pool, orderId){
  try{
    const r=await pool.query(
      `SELECT f.company_code FROM orders o
       JOIN order_line_items oli ON oli.order_id=o.id
       JOIN products p ON p.sku=oli.sku
       JOIN factories f ON f.name=p.factory_name
       WHERE (o.order_no=$1 OR o.contract_no=$1 OR o._id=$1 OR o.customer_po=$1)
         AND f.company_code IS NOT NULL LIMIT 1`,[orderId]);
    return r.rows[0]?.company_code || null;
  }catch(_){ return null; }
}

export default async function handler(req, res){
  setCors(req, res, "GET, POST, OPTIONS");
  if(req.method==='OPTIONS') return res.status(204).end();
  const pool=getPool();
  // POST: 手动保存厂检/QC 实测结果 → 写 factory_doc_results(替代/补充OCR,真人填的真值)
  if(req.method==='POST'){
    if(!req.user) return res.status(401).json({error:'unauthorized'});
    const b=req.body||{};
    const saveOrder=(b.order_no||b.id||'').toString();
    const saveKind=(b.kind||'fi').toString();
    if(!saveOrder) return res.status(400).json({error:'order_no required'});
    const results=(b.results&&typeof b.results==='object')?b.results:{};
    await pool.query(`INSERT INTO factory_doc_results(order_no,doc_kind,results,source,filled_by) VALUES($1,$2,$3::jsonb,'manual',$4) ON CONFLICT(order_no,doc_kind) DO UPDATE SET results=EXCLUDED.results, source=EXCLUDED.source, filled_at=now()`,[saveOrder,saveKind,JSON.stringify(results),(req.user.username||'manual')]);
    return res.json({success:true, order_no:saveOrder, kind:saveKind, count:Object.keys(results).length});
  }
  const q=req.query||{};
  const kind=(q.kind||'fi').toString();
  const id=(q.id||'').toString();
  if(!id) return res.status(400).send('<h1>缺少订单号 id</h1>');

  const oR=await pool.query("SELECT * FROM orders WHERE _id=$1 OR contract_no=$1 OR order_no=$1 OR customer_po=$1 LIMIT 1",[id]);
  if(!oR.rows.length) return res.status(404).send('<h1>订单未找到: '+esc(id)+'</h1>');
  const o=oR.rows[0];
  // 下单日：从 contract_no 格式 FSyyyyMMdd 提取
  const cnMatch=String(o.contract_no||"").match(/FS(\d{4})(\d{2})(\d{2})/);
  const cnDate=cnMatch?(cnMatch[1]+"-"+cnMatch[2]+"-"+cnMatch[3]):"";

  const liR=await pool.query("SELECT oli.declaration_name, oli.product_name, oli.hs_code, oli.qty_ctn, oli.nw_ctn, (SELECT factory_name FROM products WHERE sku=oli.sku AND factory_name IS NOT NULL LIMIT 1) AS factory_name, (SELECT size FROM products WHERE sku=oli.sku LIMIT 1) AS product_size FROM order_line_items oli WHERE oli.order_id=$1 ORDER BY oli.sort_order, oli.id",[o.id||o._id]);
  const lines=liR.rows||[];
  const factory=pick((lines.find(l=>l.factory_name)||{}).factory_name, o.factory, '____________________');
  const sampleName=pick((lines.find(l=>l.declaration_name)||{}).declaration_name, (lines[0]||{}).product_name, '____________');
  const hs=pick((lines.find(l=>l.hs_code)||{}).hs_code, '');
  const hs4=String(hs).replace(/\D/g,'').slice(0,4);
  const qtyCtn=lines.reduce((s,l)=>s+(Number(l.qty_ctn)||0),0) || pick(o.total_qty,o.total_ctn,'');
  const nwKg=lines.reduce((s,l)=>s+(Number(l.nw_ctn)||0)*(Number(l.qty_ctn)||0),0) || pick(o.total_net_weight,o.net_weight,'');
  const qtyWeight=(qtyCtn?qtyCtn+'箱':'')+(qtyCtn&&nwKg?'/':'')+(nwKg?Math.round(Number(nwKg))+'kg':'');
  const prodDate=fmtD(pick(o.delivery_date,o.etd))||cnDate;
  // 检验日期=实际发货日，从 shipping_plans 取 etd/atd/shipment_date
  let inspDate=prodDate;
  try{
    const idR=await pool.query("SELECT etd,atd,shipment_date FROM shipping_plans WHERE order_contract_nos=$1 OR $2=ANY(order_nos) LIMIT 1",[o.contract_no||"",o.order_no||""]);
    const idSp=idR.rows[0]||{};
    inspDate=fmtD(idSp.atd||idSp.etd||idSp.shipment_date)||prodDate;
  }catch(_){}
  const orderNo=pick(o.order_no,o.contract_no,id);
  const reportNo=pick(o.contract_no,'');
  // 产品规格：从 OLI 取第一行 product_size
  const productSpec=pick((lines[0]||{}).product_size,'');
  // 生产批号：CL/LL等客户前缀（订单号中段）+ 日期YYYYMMDD
  const orderMid=(orderNo.split('-')[1]||'').toUpperCase();

  const cc=await factoryCompanyOf(pool, id);
  let tpl=null;
  if(hs4){
    const tR=await pool.query("SELECT sample_name,items,note,source,inspector,reviewer FROM factory_doc_templates WHERE factory_company_code = ANY($1) AND hs_prefix=$2 AND doc_kind=$3 AND active ORDER BY (factory_company_code <> '*') DESC, version DESC LIMIT 1",[[cc||'__none__','*'],hs4,kind]);
    tpl=tR.rows[0]||null;
  }

  let resultsMap = {};
  try { const rr = await pool.query("SELECT results FROM factory_doc_results WHERE order_no=$1 AND doc_kind=$2 LIMIT 1",[orderNo, kind]); if(rr.rows[0] && rr.rows[0].results) resultsMap = rr.rows[0].results; } catch(_){}
  const sampleQty=pick(resultsMap['送检批量'],'2');

  const warn = tpl ? '' :
    `<div style="background:#fff3f3;border:1px solid #e11;color:#b00;padding:10px 14px;font-size:13px;margin-bottom:14px;border-radius:6px">⚠ 该工厂(${esc(cc||factory)})此品类(HS ${esc(hs4||'?')})暂无已提交的厂检模版。下方为空白人工检验单。</div>`;
  const items = (tpl && Array.isArray(tpl.items) && tpl.items.length) ? tpl.items :
    [{no:1,name:'',unit:'',spec:''},{no:2,name:'',unit:'',spec:''},{no:3,name:'',unit:'',spec:''},{no:4,name:'',unit:'',spec:''},{no:5,name:'',unit:'',spec:''}];
  const note = tpl ? pick(tpl.note,'样品检测，所检项目均符合出厂标准。') : '';
  const showSample = pick(tpl&&tpl.sample_name, sampleName);

  let batchPrefix=''; let officialName='';
  try{ const bp=await pool.query("SELECT batch_prefix, official_name FROM factories WHERE (company_code=$1 OR name=$2) LIMIT 1",[cc,factory]); batchPrefix=(bp.rows[0]&&bp.rows[0].batch_prefix)||''; officialName=(bp.rows[0]&&bp.rows[0].official_name)||''; }catch(_){}
  const factoryDisplay = officialName || factory;
  const ymd = String(prodDate||'').replace(/[^0-9]/g,'');
  const batchNo = pick(resultsMap['生产批号'], resultsMap['批号'], ymd?((orderMid||batchPrefix)+ymd):'', '');

  let sealUrl='';
  try{
    const sealCo = (kind==='qc') ? 'BABI' : cc;
    if(sealCo){
      const sr=await pool.query("SELECT url FROM customer_stamps WHERE company_code=$1 AND COALESCE(is_active,true) ORDER BY is_default DESC LIMIT 1",[sealCo]);
      let u=(sr.rows[0]&&sr.rows[0].url)||'';
      if(u) sealUrl=u.replace(/sanlyn-files\.oss-cn-[a-z0-9-]*\.aliyuncs\.com/i,'files.sanlynos.com');
    }
  }catch(_){}

  // format=json → 返回结构化数据(供可编辑模版编辑器加载)
  if((q.format||'').toString()==='json'){
    res.setHeader('Cache-Control','no-store');
    return res.json({
      kind, order_no:orderNo, report_no:reportNo, sample_name:showSample, product_spec:productSpec,
      batch_no:batchNo, prod_date:prodDate, qty_weight:qtyWeight, insp_date:inspDate, sample_qty:sampleQty,
      factory_display:factoryDisplay, factory_company:cc||'', hs4,
      note, inspector:pick(tpl&&tpl.inspector,'宫海霞'), reviewer:pick(tpl&&tpl.reviewer,'林彩云'),
      seal_url:sealUrl, has_template:!!tpl,
      ref_std:'GB/T 31410-2015《宠物用品 猫砂》/ GB/T 3838-2002《重金属限量》',
      items: items.map(it=>({ no:it.no, name:it.name, unit:it.unit, spec:it.spec, section:it.section||'', type:it.type||'', result: (resultsMap[it.name]!==undefined&&resultsMap[it.name]!==null?String(resultsMap[it.name]):'') }))
    });
  }

  // format=xlsx → 厂检/QC Excel 导出(ExcelJS)
  if((q.format||'').toString()==='xlsx'){
    try{
      const ExcelJS=(await import('exceljs')).default;
      const wb=new ExcelJS.Workbook();
      const ws=wb.addWorksheet((kind==='qc'?'QC':'FI')+' '+orderNo);
      ws.columns=[{width:6},{width:34},{width:12},{width:14},{width:14},{width:12}];
      ws.addRow([factoryDisplay]); ws.addRow([showSample+(kind==='qc'?' QC质检报告':'检验报告')]);
      ws.addRow(['参考标准', 'GB/T 31410-2015《宠物用品 猫砂》/ GB/T 3838-2002《重金属限量》']);
      ws.addRow([]);
      ws.addRow(['报告编号', reportNo]); ws.addRow(['样品/合同编号', orderNo]); ws.addRow(['产品名称', showSample]);
      ws.addRow(['规格', productSpec]); ws.addRow(['生产批号', batchNo]); ws.addRow(['生产日期', prodDate]);
      ws.addRow(['数/重量', qtyWeight]); ws.addRow(['检验日期', inspDate]); ws.addRow(['检验地点', '仓库']); ws.addRow(['送检批量(袋)', sampleQty]);
      ws.addRow([]);
      const hdr=ws.addRow(['序号','检验项目','计量单位','技术要求','检验结果','单项评价']); hdr.font={bold:true};
      items.forEach((it,i)=>{
        const rv=resultsMap[it.name]; const has=rv!==undefined&&rv!==''&&rv!==null;
        const actual=has?String(rv):''; let verdict='';
        if(has){const ok=checkSpec(it.spec,rv);verdict=ok===null?'':(ok?'合格':'超标');}
        ws.addRow([it.no,it.name,it.unit,it.spec,actual,verdict]);
      });
      ws.addRow([]); ws.addRow(['备注', note]);
      ws.addRow(['检测人员', pick(tpl&&tpl.inspector,'宫海霞'), '', '复检人员', pick(tpl&&tpl.reviewer,'林彩云')]);
      const buf=await wb.xlsx.writeBuffer();
      res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition','attachment; filename="'+encodeURIComponent((kind==='qc'?'QC质检报告_':'厂检单_')+showSample+'_'+orderNo)+'.xlsx"');
      res.setHeader('Cache-Control','no-store');
      return res.status(200).send(Buffer.from(buf));
    }catch(xe){ console.error('[doc-render] xlsx error:',xe&&xe.message); return res.status(500).json({error:'xlsx_failed',detail:xe&&xe.message}); }
  }

  // — 分节渲染 —
  // 按 section 字段分组；无 section 字段则视为单节旧格式
  const hasSections = items.some(it => it.section);
  const SECTION_BG = '#3d4f8c';

  let bodyRows = '';
  if(!hasSections){
    // 旧格式：平铺表格
    bodyRows = `<table class=t>
      <tr><th>序号</th><th>检验项目</th><th>计量单位</th><th>技术要求</th><th>检验结果</th><th>单项评价</th></tr>
      ${items.map(it=>{
        const rv=resultsMap[it.name]; const has=rv!==undefined&&rv!==''&&rv!==null;
        const actual=has?esc(rv):(kind==='qc'?'':esc(typicalVal(it.spec)));
        let verdict='&nbsp;';
        if(has){const ok=checkSpec(it.spec,rv);verdict=ok===null?'&nbsp;':(ok?'<span style="color:#16a34a;font-weight:700">合格</span>':'<span style="color:#dc2626;font-weight:700">⚠ 超标</span>');}
        else if(kind!=='qc'&&actual) verdict='<span style="color:#16a34a;font-weight:700">合格</span>';
        return `<tr><td>${esc(it.no)}</td><td>${esc(it.name)}</td><td>${esc(it.unit)}</td><td>${esc(it.spec)}</td><td>${actual||'&nbsp;'}</td><td>${verdict}</td></tr>`;
      }).join('')}
    </table>`;
  } else {
    // 新格式：按 section 分组
    const sections = [];
    const sectionMap = {};
    for(const it of items){
      const sec = it.section || '其他';
      if(!sectionMap[sec]){ sectionMap[sec]=[]; sections.push(sec); }
      sectionMap[sec].push(it);
    }

    for(const sec of sections){
      const secItems = sectionMap[sec];
      const isCheckbox = secItems[0].type === 'checkbox';

      if(isCheckbox){
        // 包装外观：检验项目 / 标准 / 合格 / 不合格
        bodyRows += `<table class=t style="margin-top:0">
          <tr><td colspan=4 style="background:${SECTION_BG};color:#fff;font-weight:700;text-align:left;padding:5px 8px;font-size:12px">${esc(sec)}</td></tr>
          <tr><th style="width:30%">检验项目 Check Item</th><th style="width:42%">标准 Standard</th><th>合格</th><th>不合格</th></tr>
          ${secItems.map(it=>{
            const rv=resultsMap[it.name];
            const checked = rv==='合格'||rv===true||rv==='pass'||rv==='ok'||rv===undefined||rv===null||rv==='';
            const failed  = rv==='不合格'||rv===false||rv==='fail';
            return `<tr><td style="text-align:left;padding-left:8px">${esc(it.name)}</td><td style="text-align:left;padding-left:8px">${esc(it.spec)}</td><td style="text-align:center">${checked?'☑':'☐'}</td><td style="text-align:center">${failed?'☑':'☐'}</td></tr>`;
          }).join('')}
        </table>`;
      } else {
        // 物理/性能/化学：标准 / 实测 / 单位 / 判定
        bodyRows += `<table class=t style="margin-top:0">
          <tr><td colspan=6 style="background:${SECTION_BG};color:#fff;font-weight:700;text-align:left;padding:5px 8px;font-size:12px">${esc(sec)}</td></tr>
          <tr><th style="width:6%">项目</th><th style="text-align:left;padding-left:8px">Item</th><th>标准 Standard</th><th>实测 Actual</th><th>单位 Unit</th><th>判定 Result</th></tr>
          ${secItems.map(it=>{
            const rv=resultsMap[it.name]; const has=rv!==undefined&&rv!==''&&rv!==null;
            const actual=has?esc(rv):(kind==='qc'?'':esc(typicalVal(it.spec)));
            let verdict='&nbsp;';
            if(has){const ok=checkSpec(it.spec,rv);verdict=ok===null?'&nbsp;':(ok?'<span style="color:#16a34a;font-weight:700">□ 合格</span>':'<span style="color:#dc2626;font-weight:700">⚠ 超标</span>');}
            else if(kind!=='qc') verdict='<span style="color:#16a34a;font-weight:700">□ 合格</span>';
            return `<tr><td>${esc(it.no)}</td><td style="text-align:left;padding-left:8px">${esc(it.name)}</td><td>${esc(it.spec)}</td><td>${actual||'&nbsp;'}</td><td>${esc(it.unit)}</td><td>${verdict}</td></tr>`;
          }).join('')}
        </table>`;
      }
    }

    // AQL 抽样判定表已移除，压缩为单页
  }

  const isQC = kind === 'qc';
  const html=`<!DOCTYPE html><html lang=zh><head><meta charset=utf-8><title>${isQC?'QC质检报告':'厂检单'} ${esc(showSample)}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'SimSun','Noto Serif SC',Arial,serif;color:#000;padding:16px;background:#f0f0f0}
.page{max-width:800px;margin:auto;background:#fff;padding:20px 28px}
.ti-en{text-align:center;font-size:15px;font-weight:700;letter-spacing:1px;margin-bottom:2px}
.ti-cn{text-align:center;font-size:13px;color:#444;margin-bottom:3px}
.std{text-align:center;font-size:10px;color:#666;border-bottom:2px solid #000;padding-bottom:6px;margin-bottom:8px}
.header-grid{display:grid;grid-template-columns:1fr auto;gap:0;border:1px solid #ccc;margin-bottom:6px;font-size:12px}
.header-left td{padding:2px 6px;border-bottom:1px solid #eee}
.header-left td:first-child{color:#555;width:90px;white-space:nowrap}
.qc-badge{background:#3d4f8c;color:#fff;font-weight:900;font-size:18px;padding:10px 16px;text-align:center;border-left:1px solid #ccc}
.qc-badge .sub{font-size:10px;font-weight:400;display:block;margin-top:4px}
.header-right{font-size:12px;border-left:1px solid #ccc}
.header-right td{padding:2px 6px;border-bottom:1px solid #eee}
.header-right td:first-child{color:#555;width:80px;white-space:nowrap}
table.t{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:0}
table.t td,table.t th{border:1px solid #999;padding:3px 4px;text-align:center}
table.t th{background:#e8e8e8;font-weight:700;font-size:11px}
.note{font-size:11px;margin:8px 0 10px;color:#333}
.sig{display:flex;justify-content:space-between;font-size:12px;margin-top:16px;position:relative;min-height:80px}
@media print{body{background:#fff;padding:0}.page{box-shadow:none}}
</style></head><body><div class=page>
${warn}
${isQC?`<div class=ti-en>QC INSPECTION REPORT · ${esc(showSample)}</div>
<div class=ti-cn>${esc(showSample)} 出厂 质检报告</div>`:`<div class=ti-en style="font-size:19px">${esc(factoryDisplay)}</div>
<div class=ti-cn>${esc(showSample)}检验报告</div>`}
<div class=std>参考标准：GB/T 31410-2015《宠物用品 猫砂》/ GB/T 3838-2002《重金属限量》</div>

<div class=header-grid>
  <table class=header-left style="border:none"><tbody>
    <tr><td>报告编号</td><td>${esc(reportNo||'&nbsp;')}</td></tr>
    <tr><td>样品/合同编号</td><td>${esc(orderNo)}</td></tr>
    <tr><td>产品名称</td><td>${esc(showSample)}</td></tr>
    <tr><td>规格</td><td>${esc(productSpec||'&nbsp;')}</td></tr>
    <tr><td>生产批号</td><td>${batchNo ? esc(batchNo) : '<span style="color:#dc2626;font-weight:700">&#9888; 待填（需工厂批次记录）</span>'}</td></tr>
    <tr><td>生产日期</td><td>${prodDate ? esc(prodDate) : '<span style="color:#dc2626;font-weight:700">&#9888; 待填（需工厂批次记录）</span>'}</td></tr>
    <tr><td>数/重量</td><td>${esc(qtyWeight||'&nbsp;')}</td></tr>
  </tbody></table>
  <div style="display:flex;flex-direction:column">
    ${isQC?`<div class=qc-badge>QC REPORT<span class=sub>质检报告单</span></div>`:''}
    <table class=header-right style="border:none;flex:1"><tbody>
      <tr><td>检验日期</td><td>${esc(inspDate||'&nbsp;')}</td></tr>
      <tr><td>检验地点</td><td>仓库</td></tr>
      <tr><td>送检批量(袋)</td><td>${esc(sampleQty)}</td></tr>
    </tbody></table>
  </div>
</div>

${bodyRows}

<div class=note>${esc(note)}</div>
<div class=sig>
  <span>检测人员：${esc(pick(tpl&&tpl.inspector,'宫海霞'))}</span>
  <span>复检人员：${esc(pick(tpl&&tpl.reviewer,'林彩云'))}</span>
  ${sealUrl?`<img src="${esc(sealUrl)}" alt="公章" onerror="this.style.display='none'" style="position:absolute;right:40px;bottom:-8px;width:110px;height:110px;opacity:.9;pointer-events:none"/>`:''}
</div>
</div></body></html>`;

  if((q.format||'').toString()==='pdf' || (q.download||'').toString()==='1'){
    try{
      const puppeteer=(await import('puppeteer')).default;
      const chromePath=process.env.CHROME_PATH||process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/google-chrome';
      const launchOpts={ headless:'new', args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-software-rasterizer'] };
      try{ const fs=await import('fs'); if(fs.existsSync(chromePath)) launchOpts.executablePath=chromePath; }catch(_){}
      const browser=await puppeteer.launch(launchOpts);
      const page=await browser.newPage();
      await page.setContent(html,{waitUntil:'networkidle0'});
      const pdfBuf=await page.pdf({ format:'A4', printBackground:true, margin:{top:'12mm',bottom:'12mm',left:'10mm',right:'10mm'} });
      await browser.close();
      const pdfName=(isQC?'QC质检报告_':'厂检单_')+esc(showSample)+'_'+orderNo+'.pdf';
      res.setHeader('Content-Type','application/pdf');
      res.setHeader('Content-Disposition',(String((req.query&&req.query.inline)||'')==='1'?'inline':'attachment')+'; filename="'+encodeURIComponent(pdfName)+'"');
      res.setHeader('Cache-Control','no-store');
      return res.status(200).send(Buffer.from(pdfBuf));
    }catch(pdfErr){
      console.error('[doc-render] pdf error:', pdfErr&&pdfErr.message);
      res.setHeader('Content-Type','application/json');
      return res.status(503).json({error:'pdf_render_unavailable', detail:pdfErr&&pdfErr.message});
    }
  }
  res.setHeader('Content-Type','text/html; charset=utf-8');
  return res.send(html);
}
