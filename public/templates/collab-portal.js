const API = '/api/db/booking-collab';
const PORTAL_UI_VERSION = "v2.1.0";
// 证件脱敏（2026-08-08）：Damon 铁律「证件仅存后4位」。
// 库里历史数据有 4 条存了完整 18 位身份证，前端一律只渲染后 4 位，
// 不依赖库里存的是什么——防御在渲染层，历史脏数据也漏不出去。
function maskId(v){
  const t = String(v == null ? '' : v).trim();
  if (!t) return '';
  return t.length <= 4 ? t : '****' + t.slice(-4);
}
const token = new URLSearchParams(location.search).get('token') || '';
const $ = id => document.getElementById(id);
const show = id => { ['stateLoading','stateForm','stateDead'].forEach(s => $(s).classList.add('hidden')); $(id).classList.remove('hidden'); };
function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); }
function gv(id){ return ($(id)?.value||'').trim(); }
function esc(v){ return v==null?'':String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function fmtD(v){ if(!v) return ''; try{ return new Date(v).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}); }catch(e){ return ''; } }
function bjTime(v){ if(v==null||v==="")return ""; try{ return new Date(v).toLocaleString("sv-SE",{timeZone:"Asia/Shanghai"}).slice(0,16); }catch(e){ return ""; } }  // PG日期→北京时间;绝不切ISO串

const SEG_META = { ocean:{icon:'🚢',label:'海运'}, truck:{icon:'🚛',label:'车队'}, customs:{icon:'🛂',label:'报关'}, factory:{icon:'🏭',label:'工厂'} };
let segs = [], curSeg = null, uploads = [], vehs = [{}], upZone = 'ocean', _billSummary = null, _billSheet = null;
function moneyMap(v){
  if(!v || typeof v !== 'object') return '';
  return Object.entries(v).filter(([,n])=>Number(n)>0).map(([c,n])=>c+' '+Number(n).toLocaleString()).join(' / ');
}
function chipTone(status){
  return status === '已定' ? 'badge-green' : status === '待确认' ? 'badge-amber' : 'badge-red';
}
function unitLabel(basis, qty){
  if(basis === 'per_container') return '每柜 × '+(qty || (_billSheet && _billSheet.container_qty) || 1);
  return '整票 × 1';
}
function releaseMeta(v){
  const t = String(v || '').trim();
  if(t === 'SWB') return { badge:'SWB 海运单 · 保函已备', doc:'SWB 保函', show:true, hi:true };
  if(t === '电放') return { badge:'电放 TELEX RELEASE', doc:'电放保函', show:true, hi:false };
  if(t === '正本') return { badge:'正本提单 3/3', doc:'', show:false, hi:false };
  return { badge:'出单方式未定', doc:'', show:false, hi:false, empty:true };
}

function goSeg(s, el){
  curSeg = s;
  document.querySelectorAll('.seg-tab').forEach(t=>t.classList.remove('active'));
  if(el) el.classList.add('active');
  ['ocean','truck','customs'].forEach(k=>{
    const node = $('seg-'+k); if(!node) return;
    node.classList.toggle('hidden', k !== s || (k === 'ocean' && !document.body.classList.contains('ui-v1')));
  });
}

function openBillingInvoice(){
  if (!window._billingToken) return;
  window.open('/public/invoice-confirm-preview.html?token=' + encodeURIComponent(window._billingToken), '_blank', 'noopener');
}

async function fetchBillSummary(){
  try{
    const r = await fetch(`${API}/collab-bill-summary?token=${encodeURIComponent(token)}`);
    const d = await r.json().catch(()=>({}));
    if(r.ok && d.ok) _billSummary = d;
  }catch(e){}
}

function renderHero(s, ps){
  const panel = $('portalHero'), body = $('portalHeroBody'); if(!panel || !body) return;
  const route = [s.pol, s.pod].filter(Boolean).join(' → ');
  const qty = [s.container_type, s.container_qty ? '× '+s.container_qty : ''].filter(Boolean).join(' ');
  const rel = releaseMeta(s.release_type);
  const truckOk = !!(s.trucking_detail && Array.isArray(s.trucking_detail.vehicles) && s.trucking_detail.vehicles.some(v=>v.plate||v.driver_phone));
  body.innerHTML = `<div class="hero-grid">
    <div><div class="hero-name">${esc(ps.company_label || '货代协同')}</div>
      <div class="hero-bl">${esc(s.bl_no || s.hbl_no || '提单号待回传')}</div>
      <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
        <button class="btn btn-ghost btn-sm" type="button" onclick="openCompanyCard()">🏢 公司资料 / 联系人</button>
        <button class="btn btn-blue btn-sm" type="button" onclick="jumpTo('so')">📤 上传资料</button>
      </div></div>
    <div class="mini-kv">
      <span>出单方式</span><span style="${rel.empty?'color:var(--ink3);':''}">${esc(rel.badge)}</span>
      <span>柜量/航线</span><span>${esc([qty, route].filter(Boolean).join(' · ') || '待确认')}</span>
      <span>委托拖车</span><span><button class="btn btn-sm ${truckOk?'btn-green':'btn-ghost'}" type="button">${truckOk?'已回填':'待回填'}</button></span>
    </div></div>`;
  panel.classList.remove('hidden');
}

function fileLink(type, ref, aud){ return window._fileURL ? window._fileURL(type, ref, aud) : '#'; }
function docRow(icon, label, href, source){
  const safe = esc(href);
  // 状态标签(我方已备/贵司提请)合并进「预览」按钮，不再单列 tag；下载独立（Damon 0812 图2）
  const preview = source
    ? `<a class="doc-btn" style="background:var(--goodbg);color:var(--good);border-color:color-mix(in srgb,var(--good) 40%,var(--line));" href="${safe}" target="_blank">${esc(source)} · 预览</a>`
    : `<a class="doc-btn" href="${safe}" target="_blank">👁 预览</a>`;
  return `<div class="doc-row"><span>${icon}</span><div class="doc-row-main">${esc(label)}</div>
    <div class="doc-actions">${preview}<a class="doc-btn" href="${safe}" target="_blank" download>⬇ 下载</a></div></div>`;
}
function requirementDocs(s){
  const cr = s.carrier_requirements || s.requirements || s.carrier_docs_required || null;
  if(!cr) return [];
  const text = Array.isArray(cr) ? cr.join(' ') : typeof cr === 'object' ? JSON.stringify(cr) : String(cr);
  const rows = [];
  if(/MSDS|鉴定|液体|电池|危/i.test(text)) rows.push(['🧪','MSDS / 海运运输条件鉴定报告', fileLink('pack','','customs')]);
  if(/检疫|植检|动检|CIQ|quarantine/i.test(text)) rows.push(['🌿','检疫报告 / CIQ', fileLink('quarantine')]);
  if(/熏蒸|木|IPPC|fumigation/i.test(text)) rows.push(['🌲','熏蒸 / 木质包装证明', fileLink('pack','','customs')]);
  return rows;
}
function renderOurDocs(s){
  if(!segs.includes('ocean')) return;
  const panel = $('ourDocsPanel'), body = $('ourDocsBody'); if(!panel || !body) return;
  $('dlPackAll').href = fileLink('pack', '', 'customs');
  const rel = releaseMeta(s.release_type);
  const releaseRows = rel.show
    ? [[rel.hi?'🟢':'📠', rel.doc, fileLink('telex'), rel.hi?'我方已备':'']]
    : [];
  const groups = [
    ['抬头资料', [
      ['🏢','订舱委托 / Booking Instruction', fileLink('so'), ''],
      ...releaseRows,
      ...(s.is_transfer ? [['🔁','内转外信息表', fileLink('transfer'), '']] : [])
    ]],
    // 货代/船东只需订舱委托 / SO / 保函；不看客户的 PL·SC·IV 合并版 和 报关单
    ['本票单据', [
      ['📋','排载单 / SO', fileLink('so'), ''],
      ['📄','提单样单 / 补料（可改 Excel）', fileLink('bl_sample'), '客户可改']
    ]]
  ];
  const certs = requirementDocs(s).map(x => [x[0], x[1], x[2], '贵司提请']);
  if(certs.length) groups.push(['货物证书', certs]);
  body.innerHTML = groups.map(([title, rows]) => `<div class="doc-group">
    <div class="doc-group-title">${esc(title)}</div>
    <div class="doc-list ${rows.length>1?'two-col':''}">${rows.map(r=>docRow(r[0],r[1],r[2],r[3])).join('')}</div>
  </div>`).join('');
  panel.classList.remove('hidden');
}

function renderUploadsPanel(){
  if(!segs.includes('ocean')) return;
  $('uploadPanel')?.classList.remove('hidden');
}

function renderDeadlines(s){
  if(!segs.includes('ocean')) return;
  const raw = s.so_info || s.raw || {};
  const grid = $('deadlineGrid'), panel = $('deadlinePanel'); if(!grid || !panel) return;
  const rows = [
    ['进场', raw.cutoff_port || raw.port_cutoff || s.port_cutoff_date || '待确认'],
    ['截VGM', bjTime(raw.vgm_cutoff || s.vgm_cutoff || s.vgm_cutoff_at) || '待确认'],   // 是截VGM时间(deadline)，非VGM重量
    ['SI', bjTime(raw.doc_cutoff || s.doc_cutoff || s.si_cutoff_date || s.doc_cutoff_at) || '待确认'],
    ['预计开船', fmtD(s.etd) || '待确认']
  ];
  grid.innerHTML = rows.map(r=>`<div class="deadline-cell"><div>${esc(r[0])}</div><div>${esc(r[1])}</div></div>`).join('');
  panel.classList.remove('hidden');
}

function renderBillingEntry(billing, s){
  const card = $('billingCardV2');
  const body = $('billingBodyV2');
  if (!card || !body) return;
  const canOpen = !!(billing && billing.token && billing.show_amount !== false);
  window._billingToken = canOpen ? billing.token : '';
  if(!segs.includes('ocean')) return;
  card.classList.remove('hidden');
  // 港杂费并进海运费（海运+港杂 一个模块）；报关费不给货代（我方内填）。只剩 海运 / 拖车 两行。
  const map = { ocean:'海运费', trucking:'拖车费' };
  const keys = ['ocean','trucking'];
  const segData = (_billSummary && _billSummary.segments) || {};
  const confirmBtn = k => `<div style="text-align:right;margin-top:10px;"><button class="btn ${isBillConfirmed(k)?'btn-ghost':'btn-blue'} btn-sm bill-confirm-btn" ${isBillConfirmed(k)?'disabled':''} onclick="confirmBill('${k}')">${isBillConfirmed(k)?'✓ 已确认':'单独确认'}</button></div>`;
  body.innerHTML = keys.map(k=>{
    const x = segData[k] || {status:'待报', amount:{}, pending_amount:{}};
    const money = moneyMap(x.amount);
    const pending = moneyMap(x.pending_amount);
    const empty = !money && !pending;
    // 海运行：摘要带港杂状态；明细=海运 + 港杂费编辑器
    let summary, detail;
    if(k === 'ocean'){
      const pc = segData.port_charge || {status:'待贵司填', amount:{}};
      const pcMoney = moneyMap(pc.amount);
      summary = [s.pol||'起点', s.pod||'港口'].join(' → ') + ' · 港杂 ' + (pcMoney || (pc.status||'待填'));
      detail = `<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <div style="font-size:12px;color:var(--ink2);font-weight:800;">🔒 海运费：${esc(s.pol||'起点')} → ${esc(s.pod||'港口')} → ${esc(money || pending || '未填写金额')}</div>
          <span class="badge badge-blue" style="font-size:10px;">已锁价 · 只读</span></div>
        <div style="font-size:10px;color:var(--ink3);margin-top:3px;">海运费以报价中心已报价为准，此处不可改；如有异议请联系我方。</div>
        <div style="margin-top:12px;border-top:1px dashed var(--line);padding-top:10px;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;"><span style="font-size:12px;font-weight:800;color:var(--ink2);">⚓ 港杂费</span><span class="badge ${chipTone(pc.status)}">${esc(pc.status||'待贵司填')}</span></div>
          ${portChargeEditor()}
        </div>${confirmBtn('ocean')}`;
    } else {
      summary = '装柜/拖车信息 + 工厂装箱照片 · 点开查看';
      detail = truckContainerModule(s) + truckExtraFeeEditor() + confirmBtn('trucking');
    }
    return `<div class="bill-row" id="bill_${k}">
      <button class="bill-summary" type="button" onclick="toggleBill('${k}')"><b>${map[k]}</b><span class="desc">${esc(summary)}</span>
        <span class="bill-money ${empty?'empty':''}">${esc(money || pending || '未填写金额')}</span><span class="badge ${chipTone(x.status)}">${esc(x.status)}</span></button>
      <div class="bill-detail">${detail}</div></div>`;
  }).join('');
  ['ocean','trucking'].forEach(k=>{ if(isBillConfirmed(k)) markBillUI(k); });
  $('billingSubV2').textContent = '海运+港杂 / 拖车 · 一键全确认或逐行确认';
}

// 顶部提醒：算出「还差什么」，写进 banner，并生成可点击跳转的待办弹窗（Damon 0812）
function computeTodos(s){
  const items = [];
  const ups = Array.isArray(s.collab_uploads)?s.collab_uploads:[];
  const hasSO = ups.some(u=>/(^|[^A-Z])S\/?O([^A-Z]|$)|入货|排载|配舱|舱单|订舱确认|manifest|放箱/i.test(u.filename||''));
  if(!hasSO) items.push({label:'SO 订舱确认未上传', target:'so'});
  const hasBL = !!s.bl_no || ups.some(u=>/\bBL\b|提单/i.test(u.filename||''));
  if(!hasBL) items.push({label:'提单 B/L 未上传', target:'bl'});
  const seg = (_billSummary && _billSummary.segments) || {};
  const filled = x => !!(x && (x.status==='已录入' || x.status==='已确认'
    || (x.reported_by && x.reported_by.length)
    || (x.amount && Object.values(x.amount).some(n=>Number(n)>0))));
  if(!filled(seg.port_charge)) items.push({label:'港杂费待填', target:'port'});   // 报关费由我方内部填，不催货代
  if(!allBillsConfirmed()) items.push({label:'账单未确认', target:'bill'});
  return items;
}
function renderReminder(s){
  const sub = $('bannerSub'), badge = $('bannerBadge');
  if(!sub) return;
  const items = computeTodos(s);
  window._todos = items;
  if(items.length){
    sub.innerHTML = '还差：' + items.map(t=>esc(t.label)).join(' · ') + ' <span style="color:var(--accent);text-decoration:underline;white-space:nowrap;">查看待办 ›</span>';
    if(badge){ badge.textContent = '需补齐 ' + items.length + ' 项'; badge.className = 'badge badge-red'; }
  } else {
    sub.textContent = '资料已齐全，感谢配合';
    if(badge){ badge.textContent = '已齐全'; badge.className = 'badge badge-green'; }
  }
  // banner 整块可点开弹窗
  const bannerCard = badge ? badge.closest('.card') : null;
  if(bannerCard){ bannerCard.style.cursor='pointer'; bannerCard.onclick = openTodoPopup; }
  buildTodoPopup(items);
  // 一打开就能看到：本次加载若有待办，自动弹一次
  if(items.length && !window._todoShown){ window._todoShown = true; setTimeout(openTodoPopup, 350); }
}
const TODO_HINT = { so:'去「请贵司上传」上传承运人订舱确认/BL', bl:'去「请贵司上传」上传提单 B/L', port:'去「费用与对账」填港杂费', bill:'去「费用与对账」一键确认账单' };
function buildTodoPopup(items){
  let m = document.getElementById('todoModal');
  if(!m){
    m = document.createElement('div');
    m.id='todoModal';
    m.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:997;';
    m.onclick=function(){ this.style.display='none'; };
    document.body.appendChild(m);
  }
  const rows = items.length
    ? items.map((it,i)=>`<button type="button" onclick="jumpTo('${it.target}')" style="display:flex;align-items:center;gap:13px;width:100%;text-align:left;border:1.5px solid color-mix(in srgb,var(--warn) 40%,var(--line));background:var(--surface)beb;border-radius:11px;padding:16px 16px;margin-bottom:11px;cursor:pointer;font-family:inherit;">
        <span style="width:30px;height:30px;border-radius:50%;background:var(--warn);color:#fff;font-size:15px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0;">${i+1}</span>
        <span style="flex:1;"><span style="font-size:15px;font-weight:800;color:var(--warn);">${esc(it.label)}</span><br><span style="font-size:12px;color:var(--warn);">${esc(TODO_HINT[it.target]||'')}</span></span>
        <span style="color:var(--accent);font-weight:900;font-size:18px;">›</span></button>`).join('')
    : `<div style="text-align:center;padding:26px;color:var(--good);font-weight:800;font-size:15px;">✅ 资料已齐全，感谢配合</div>`;
  m.innerHTML = `<div style="position:absolute;left:50%;top:8%;transform:translateX(-50%);width:min(600px,94vw);background:var(--surface);border-radius:16px;padding:24px;box-shadow:0 12px 48px rgba(0,0,0,.28);" onclick="event.stopPropagation()">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
      <div style="font-size:18px;font-weight:900;color:var(--ink);">📋 待办清单${items.length?'（'+items.length+'项）':''}</div>
      <span style="cursor:pointer;color:var(--ink3);font-weight:800;font-size:18px;padding:4px 8px;" onclick="document.getElementById('todoModal').style.display='none'">✕</span></div>
    <div style="font-size:13px;color:var(--ink3);margin-bottom:16px;">点任意一项，直接跳到要填 / 要传的地方 👇</div>
    ${rows}</div>`;
}
function openTodoPopup(){ const m=document.getElementById('todoModal'); if(m) m.style.display='block'; }
function jumpTo(target){
  const m=document.getElementById('todoModal'); if(m) m.style.display='none';
  const idMap = { so:'uploadPanel', bl:'uploadPanel', port:'billingCardV2', bill:'billingCardV2' };
  const el = document.getElementById(idMap[target]||target);
  if(target==='port' || target==='bill'){ document.getElementById('bill_ocean')?.classList.add('open'); }
  if(el){
    el.scrollIntoView({behavior:'smooth', block:'center'});
    const prev = el.style.boxShadow;
    el.style.transition='box-shadow .25s'; el.style.boxShadow='0 0 0 3px var(--warn)';
    setTimeout(()=>{ el.style.boxShadow=prev||''; }, 1700);
  }
}
// 图2 公司资料/联系人卡片（复用同一套弹窗风格，不另造模板；数据来自 companies 真源）
function openCompanyCard(){
  const p = window._companyProfile || {};
  const label = (window._sheetP && window._sheetP.company_label) || (document.querySelector('.hero-name')?.textContent) || '公司资料';
  const kv = (k,v)=>`<div style="display:grid;grid-template-columns:88px 1fr;gap:6px 12px;padding:7px 0;border-bottom:1px solid var(--line);">
    <span style="color:var(--ink3);font-weight:700;">${esc(k)}</span><span style="color:${v?'var(--ink)':'var(--ink3)'};font-weight:700;overflow-wrap:anywhere;">${v?esc(v):'—'}</span></div>`;
  const hasAny = p && (p.code||p.name_cn||p.contact_phone||p.address);
  let m = document.getElementById('companyModal');
  if(!m){ m=document.createElement('div'); m.id='companyModal';
    m.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:997;';
    m.onclick=function(){ this.style.display='none'; }; document.body.appendChild(m); }
  const body = hasAny ? `
    <div style="font-size:12px;font-weight:900;color:var(--ink2);margin:4px 0 4px;">🏢 公司资料</div>
    ${kv('公司名称', p.name_cn || label)}
    ${kv('英文名', p.name_en)}
    ${kv('简称', p.short_name)}
    ${kv('统一编码', p.code)}
    ${kv('法定代表人', p.legal_representative)}
    ${kv('地址', p.address)}
    <div style="font-size:12px;font-weight:900;color:var(--ink2);margin:14px 0 4px;">📇 联系人</div>
    ${kv('联系人', p.contact_name)}
    ${kv('电话', p.contact_phone)}
    ${kv('邮箱', p.contact_email)}
    <div style="font-size:10px;color:var(--ink3);margin-top:10px;">资料以我方 companies 主数据为准；如需更正请联系我方。</div>`
    : `<div style="text-align:center;padding:24px;color:var(--ink3);">暂无该公司档案资料<br><span style="font-size:11px;color:var(--ink3);">（company_label=${esc(label)} 在 companies 未匹配到）</span></div>`;
  m.innerHTML = `<div style="position:absolute;left:50%;top:8%;transform:translateX(-50%);width:min(520px,94vw);background:var(--surface);border-radius:16px;padding:22px;box-shadow:0 12px 48px rgba(0,0,0,.28);max-height:84vh;overflow:auto;" onclick="event.stopPropagation()">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
      <div style="font-size:17px;font-weight:900;color:var(--ink);overflow-wrap:anywhere;">${esc(label)}</div>
      <span style="cursor:pointer;color:var(--ink3);font-weight:800;font-size:18px;padding:2px 6px;" onclick="document.getElementById('companyModal').style.display='none'">✕</span></div>
    ${body}
    <div style="text-align:right;margin-top:16px;"><button class="btn btn-blue btn-sm" onclick="document.getElementById('companyModal').style.display='none';jumpTo('so')">📤 去上传资料</button></div>
  </div>`;
  m.style.display='block';
}
// 账单确认：本机记录（正式以系统确认为准）——一键全确认 + 每行单独确认
function billKey(k){ return 'collab_bill_checked_'+token+'_'+k; }
function isBillConfirmed(k){ return !!localStorage.getItem(billKey(k)); }
function allBillsConfirmed(){ return ['ocean','trucking'].every(isBillConfirmed); }
function markBillUI(k){
  const row=document.getElementById('bill_'+k); if(!row) return;
  row.querySelectorAll('.bill-confirm-btn').forEach(btn=>{ btn.textContent='✓ 已确认'; btn.disabled=true; btn.classList.remove('btn-blue'); btn.classList.add('btn-ghost'); });
}
function confirmBill(k){
  const label={ocean:'海运费 + 港杂费', trucking:'拖车费'}[k]||k;
  if(!confirm('确认「'+label+'」金额与柜数无误？确认后如需改价请走提报，待我方确认。')) return;
  localStorage.setItem(billKey(k), new Date().toISOString());
  markBillUI(k); toast('已确认 '+label+'（本机记录，正式以系统确认为准）');
  if(window._sheetP) renderReminder(window._sheetP);
}
function confirmAllBills(){
  if(!confirm('一键确认本票全部费用（海运+港杂 / 拖车）金额与柜数无误？')) return;
  ['ocean','trucking'].forEach(k=>{ localStorage.setItem(billKey(k), new Date().toISOString()); markBillUI(k); });
  toast('已一键确认全部费用（本机记录，正式以系统确认为准）');
  if(window._sheetP) renderReminder(window._sheetP);
}
function toggleBill(k){ document.getElementById('bill_'+k)?.classList.toggle('open'); }
function portChargeEditor(){
  return `<table class="bill-edit-table"><thead><tr><th>费目</th><th>计价单位</th><th>单价</th><th>金额</th><th></th></tr></thead>
    <tbody id="portChargeRows"></tbody></table>
    <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-ghost btn-sm" onclick="addPortChargeRow()">＋ 新增费目</button>
      <button class="btn btn-blue btn-sm" onclick="openPortChargePaste()">📋 快速填写 / 粘贴导入</button>
    </div>`;
}
// 港杂费·快速填写：粘贴一段费目文本，自动拆行填入费目+金额（货代再选计价单位后逐条提报）
function openPortChargePaste(){
  let m = document.getElementById('pcPasteModal');
  if(!m){
    m = document.createElement('div');
    m.id = 'pcPasteModal';
    m.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:998;';
    m.onclick = function(){ this.style.display='none'; };
    m.innerHTML = `<div style="position:absolute;left:50%;top:15%;transform:translateX(-50%);width:min(520px,92vw);background:var(--surface);border-radius:12px;padding:18px;" onclick="event.stopPropagation()">
      <div style="font-size:14px;font-weight:800;margin-bottom:8px;">📋 港杂费 · 粘贴导入</div>
      <div style="font-size:11px;color:var(--ink3);margin-bottom:8px;">每行一个费目，如「THC 港杂费 1200」「铅封费 50」。自动识别费目名+金额，导入后请选计价单位再逐条提报。</div>
      <textarea id="pcPasteText" style="width:100%;height:150px;border:1.5px solid var(--line);border-radius:8px;padding:10px;font-size:13px;box-sizing:border-box;" placeholder="THC 1200&#10;单证费 350&#10;铅封费 50"></textarea>
      <div style="display:flex;gap:10px;margin-top:10px;justify-content:flex-end;">
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('pcPasteModal').style.display='none'">取消</button>
        <button class="btn btn-green btn-sm" onclick="parsePortChargePaste()">✓ 解析导入</button>
      </div></div>`;
    document.body.appendChild(m);
  }
  const ta = document.getElementById('pcPasteText'); if(ta) ta.value='';
  m.style.display = 'block';
}
function parsePortChargePaste(){
  const t = (document.getElementById('pcPasteText')||{}).value || '';
  const lines = t.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
  let n = 0;
  lines.forEach(line=>{
    const nums = line.match(/\d+(?:\.\d+)?/g) || [];
    if(!nums.length) return;                              // 无金额的行跳过
    const amount = nums[nums.length-1];
    let name = line.replace(/[\s\d.,×xX*\/元]*$/,'').trim();   // 去掉行尾金额/单位
    if(!name) name = line.replace(/[\d.,×xX*]/g,'').trim() || '港杂费目';
    addPortChargeRow();
    const tb = document.getElementById('portChargeRows');
    const tr = tb && tb.lastElementChild; if(!tr) return;
    const ins = tr.querySelectorAll('input');
    if(ins[0]) ins[0].value = name;      // 费目
    if(ins[2]) ins[2].value = amount;    // 金额
    n++;
  });
  const m = document.getElementById('pcPasteModal'); if(m) m.style.display='none';
  toast(n ? ('已导入 '+n+' 行，请选计价单位后逐条提报') : '未识别到费目/金额');
}
// 拖车·新增费用（超时费 / 滞港费等），每笔可选付款方（我方 / 工厂 / 货代）。
// 货代 token 后端只准提报 port_charge 费段，这里作为「待我方确认」提报，付款方随 reason 带上供我方归口。
function truckExtraFeeEditor(){
  return `<div style="border:1px dashed var(--line);border-radius:8px;padding:10px 12px;margin-top:12px;">
    <div style="font-size:11px;color:var(--ink3);font-weight:800;margin-bottom:6px;">其他费用（超时费 / 滞港费等 · 提报待我方确认）</div>
    <div id="truckExtraRows"></div>
    <button class="btn btn-ghost btn-sm" onclick="addTruckFeeRow()">＋ 新增费用</button>
  </div>`;
}
function addTruckFeeRow(){
  const tb = document.getElementById('truckExtraRows'); if(!tb) return;
  const id = 'tkf_' + (tb.children.length + 1) + '_' + token.slice(0,4);
  tb.insertAdjacentHTML('beforeend', `<div id="${id}" style="border:1px solid var(--line);border-radius:8px;padding:8px;margin-bottom:8px;">
    <div style="display:grid;grid-template-columns:1fr 84px 92px auto;gap:6px;align-items:center;">
      <input placeholder="费目 如 超时费" style="border:1px solid var(--line);border-radius:6px;padding:6px;font-size:11px;font-family:inherit;">
      <input type="number" min="0" step="0.01" placeholder="金额" style="border:1px solid var(--line);border-radius:6px;padding:6px;font-size:11px;font-family:inherit;">
      <select style="border:1px solid var(--line);border-radius:6px;padding:6px;font-size:11px;font-family:inherit;"><option value="">付款方</option><option value="我方">我方</option><option value="工厂">工厂</option><option value="货代">货代</option></select>
      <button class="btn btn-blue btn-sm" onclick="submitTruckFee('${id}')">提报</button>
    </div>
    <input class="tkf-note" placeholder="备注（如 超时2天 / 压夜费 / 车队要求）" style="width:100%;border:1px solid var(--line);border-radius:6px;padding:6px;font-size:11px;font-family:inherit;margin-top:6px;">
  </div>`);
}
async function submitTruckFee(id){
  const tr = document.getElementById(id); if(!tr) return;
  const ins = tr.querySelectorAll('input'), sel = tr.querySelector('select');
  const cost = (ins[0]?.value||'').trim(), amount = ins[1]?.value||'', payer = sel?.value||'';
  const note = (tr.querySelector('.tkf-note')?.value||'').trim();
  if(!cost || !amount || !payer){ toast('费目、金额、付款方必填'); return; }
  try{
    const r = await fetch(`${API}/collab-bill-submit`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token, action:'add', cost_category:cost, charge_basis:'per_bl', currency:'CNY', unit_price:amount, amount, reason:'拖车其他费用·付款方:'+payer+(note?'·备注:'+note:'')})});
    const d = await r.json().catch(()=>({}));
    if(!r.ok || !d.ok) throw new Error(d.error || '提报失败');
    toast('已提报「'+cost+'·'+payer+'付」，待我方确认');
    tr.querySelectorAll('input,select,button').forEach(x=>x.disabled=true);
  }catch(e){ toast(e.message || '提报失败'); }
}
// 拖车费·嵌入工厂装柜整个模块：柜号 + 拖车信息 + gw/cbm/ctn/vgm + 工厂装箱照片（默认随账单行收起）
function truckContainerModule(s){
  const det = (Array.isArray(s.containers_detail) && s.containers_detail.length)
    ? s.containers_detail
    : (Array.isArray(s.containers_live) ? s.containers_live : []);
  if(!det.length) return `<div style="font-size:12px;color:var(--ink2);font-weight:800;">${esc(s.pol||'起点')} → ${esc(s.pod||'港口')} · 装柜/拖车信息暂无</div>`;
  const live = Array.isArray(s.containers_live) ? s.containers_live : [];
  const liveByNo = {}; live.forEach(c=>{ if(c.container_no) liveByNo[c.container_no]=c; });
  const fileU = window._fileURL || (()=>'#');
  return det.map(c=>{
    const lv = liveByNo[c.container_no] || c;
    const cargo = Array.isArray(lv.cargo) ? lv.cargo : [];
    const ctn = cargo.reduce((a,x)=>a+Number(x.cartons||x.ctns||0),0) || Number(c.cartons||0) || '';
    const cbm = c.cbm || c.cbm_m3 || lv.cbm || (det.length===1 ? (s.total_cbm||'') : '');   // 单柜票兜底用本票总CBM
    const gw  = c.cargo_weight_kg || c.gw_kg || (cargo[0]&&cargo[0].gw_kg) || '';
    const vgm = c.vgm_weight_kg || '';
    const num = v => v==='' ? '—' : Number(v).toLocaleString();
    const metrics = [['毛重 GW', gw===''?'—':num(gw)+' kg'], ['CBM', cbm===''?'—':Number(cbm).toFixed(3)], ['箱数 CTN', ctn===''?'—':ctn], ['VGM', vgm===''?'—':num(vgm)+' kg']];
    const info = [['车牌', c.plate||lv.plate], ['司机', c.driver_name||lv.driver_name], ['电话', c.driver_phone||lv.driver_phone]].filter(r=>r[1]);
    const photos = Array.isArray(c.pickup_photos) ? c.pickup_photos : [];
    const photoHtml = photos.length
      ? `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">`+photos.map(p=>{ const u=fileU('upload',p.stored); return `<a href="${esc(u)}" target="_blank"><img src="${esc(u)}" loading="lazy" style="width:64px;height:64px;object-fit:cover;border:1px solid var(--line);border-radius:6px;"></a>`; }).join('')+`</div>`
      : `<div style="font-size:11px;color:var(--ink3);margin-top:6px;">暂无装箱照片</div>`;
    return `<div class="ctn-group" style="margin-bottom:8px;">
      <div class="ctn-group-head"><span class="ctn-group-title">🚛 ${esc(c.container_no||'柜号待定')}${c.container_type?' · '+esc(c.container_type):''}${c.seal_no?' · 封 '+esc(c.seal_no):''}</span></div>
      <div style="padding:8px 12px;">
        ${info.length?`<div style="display:flex;gap:14px;flex-wrap:wrap;font-size:11px;margin-bottom:8px;">${info.map(r=>`<span style="color:var(--ink3);">${esc(r[0])} <b style="color:var(--ink);">${esc(String(r[1]))}</b></span>`).join('')}</div>`:''}
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;">${metrics.map(m=>`<div style="border:1px solid var(--line);border-radius:6px;padding:6px;background:var(--surface2);"><div style="font-size:10px;color:var(--ink3);font-weight:800;">${esc(m[0])}</div><div style="font-size:12px;color:var(--ink);font-weight:900;">${esc(String(m[1]))}</div></div>`).join('')}</div>
        <div style="font-size:11px;color:var(--ink3);font-weight:800;margin-top:8px;">工厂装箱照片</div>
        ${photoHtml}
      </div></div>`;
  }).join('');
}
function addPortChargeRow(){
  const tb = $('portChargeRows'); if(!tb) return;
  const id = 'pcr_' + Date.now().toString(36);
  tb.insertAdjacentHTML('beforeend', `<tr id="${id}">
    <td><input placeholder="港杂费目"></td>
    <td><select><option value="">请选择</option><option value="per_container">每柜 × ${esc((_billSheet&&_billSheet.container_qty)||1)}</option><option value="per_bl">整票 × 1</option></select></td>
    <td><input type="number" min="0" step="0.01" placeholder="不预填"></td>
    <td><input type="number" min="0" step="0.01" placeholder="必填金额"></td>
    <td><button class="btn btn-blue btn-sm" onclick="submitPortCharge('${id}')">提报</button></td></tr>`);
}
async function submitPortCharge(id){
  const tr = document.getElementById(id), ins = tr ? tr.querySelectorAll('input') : [], sel = tr ? tr.querySelector('select') : null;
  const cost = (ins[0]?.value || '').trim(), basis = sel?.value || '', unit = ins[1]?.value || '', amount = ins[2]?.value || '';
  if(!cost || !basis || !amount){ toast('费目、计价单位、金额必填'); return; }
  try{
    const r = await fetch(`${API}/collab-bill-submit`, {method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token, action:'add', cost_category:cost, charge_basis:basis, currency:'CNY', unit_price:unit || amount, amount, reason:'协同页提报港杂费'})});
    const d = await r.json().catch(()=>({}));
    if(!r.ok || !d.ok) throw new Error(d.error || '提报失败');
    toast('已提报，待我方确认');
    tr.querySelectorAll('input,select,button').forEach(x=>x.disabled=true);
  }catch(e){ toast(e.message || '提报失败'); }
}
function startBillConfirm(){
  const o = (_billSummary && _billSummary.segments) || {}, ocean = moneyMap(o.ocean && o.ocean.amount) || '未填写金额', truck = moneyMap(o.trucking && o.trucking.amount) || '未填写金额';
  const ok = confirm('本次确认范围：海运费 '+ocean+'；拖车费 '+truck+'。港杂费不在本次确认范围。');
  if(!ok) return;
  const ok2 = confirm('请确认：已核对金额与柜数无误。确认后如需改价，请走账单改价/提报，待我方确认。');
  if(ok2){ localStorage.setItem('collab_bill_checked_'+token, new Date().toISOString()); toast('已记录本机确认；正式账单仍以系统确认为准'); }
}

async function boot(){
  const foot = $('uiVersionFoot');
  if(foot) foot.textContent = `UI ${PORTAL_UI_VERSION} · 2026-08-07`;
  if(!token){ show('stateDead'); return; }
  const r = await fetch(`${API}/validate?token=${encodeURIComponent(token)}`);
  const d = await r.json().catch(()=>({}));
  if(!d.valid || d.role!=='supplier_portal'){ show('stateDead'); return; }
  const s = d.booking_sheet || {};
  const ps = d.portal_scope || {};
  if (d.dispatched_at) s.dispatched_at = d.dispatched_at;   // 委托/接单时间戳（后端 magic_links.created_at）
  window._sheetP = s;
  window._companyProfile = ps.company_profile || null;   // 图2 公司资料/联系人卡片
  const isGodview = d.role === 'supplier_portal' &&
    (ps.field_profile === 'upstream_downstream' || ps.field_profile === 'shipping_booking');
  if (isGodview && window.CollabPortalGodview) {
    await window.CollabPortalGodview.render({ data:d, sheet:s, portalScope:ps, api:API, token, $, esc, fmtD, show });
    return;
  }
  // 单据链接构造（海运/报关段共用）
  const orders = Array.isArray(s.orders)?s.orders:[];
  const dlRow = (icon, label, href, extra='') =>
    `<a class="dl-btn" href="${href}" target="_blank">${icon} <span style="flex:1;">${label}</span>${extra}<span style="color:var(--accent);">下载 ↗</span></a>`;
  const pv = (href) => `<span style="color:var(--good);font-weight:700;cursor:pointer;margin-right:14px;" onclick="event.preventDefault();showPreview('${href}')">预览</span>`;
  window._fileURL = (type, ref, aud) => `${API}/file?token=${encodeURIComponent(token)}&type=${type}${ref?`&ref=${encodeURIComponent(ref)}`:''}${aud?`&aud=${aud}`:''}`;
  const fileURL = window._fileURL;

  segs = ps.segments || ['ocean','truck','customs'];
  $('topBadge').textContent = ps.company_label || '供应链端口';
  $('bannerTitle').textContent = '请填写资料';
  $('bannerSub').textContent = '正在检查待办事项…';   // 由 renderReminder() 覆盖为「还差什么」
  renderHero(s, ps);
  const chips=[];
  // 航线只给海运方(货代)看；纯车队/报关方不需要知道 POL→POD
  if((s.pol||s.pod) && segs.includes('ocean')) chips.push(`<div class="chip"><span>航线 </span><b>${esc(s.pol||'—')} → ${esc(s.pod||'—')}</b></div>`);
  if(s.container_type) chips.push(`<div class="chip"><span>柜型 </span><b>${esc(s.container_type)}${s.container_qty?' × '+s.container_qty:''}</b></div>`);
  if(s.factory_cargo_ready) chips.push(`<div class="chip"><span>货好 </span><b>${fmtD(s.factory_cargo_ready)}</b></div>`);
  if(s.etd) chips.push(`<div class="chip"><span>ETD </span><b>${fmtD(s.etd)}</b></div>`);
  if($('chips')) $('chips').innerHTML = chips.join('');
  // 阶段进度：现在到哪步、谁该干活
  (function(){
    const ups0 = Array.isArray(s.collab_uploads)?s.collab_uploads:[];
    const live0 = Array.isArray(s.containers_live)?s.containers_live:[];
    const soX = s.so_info||{};
    const declared = ups0.some(u=>/报关单|放行/i.test(u.filename||''));
    const stages = [
      { label:'订舱', done: !!(s.so_no||s.bl_no) },
      { label:'提柜/装柜', done: live0.some(x=>x.plate||x.trailer_plate) },
      { label:'截单/VGM', done: false, due: bjTime(soX.doc_cutoff) },   // 2026-08-06 修:原来 slice ISO 串早8小时
      { label:'报关放行', done: declared },
      { label:'开船', done: false, due: s.etd?('ETD '+fmtD(s.etd)):'' },
    ];
    let curIdx = stages.findIndex(x=>!x.done); if(curIdx<0) curIdx = stages.length-1;
    const bar = stages.map((x,i)=>{
      const on = x.done, cur = i===curIdx;
      return `<span style="font-size:11px;font-weight:${cur?'800':'600'};color:${on?'var(--good)':cur?'var(--warn)':'var(--ink3)'};">`
        + (on?'✅':cur?'🔶':'◯') + ' ' + x.label + (x.due&&(cur||!on)?`<span style="font-weight:400;color:var(--ink3);"> ${x.due}</span>`:'') + '</span>';
    }).join('<span style="color:#d1d5db;margin:0 6px;">→</span>');
    const div = document.createElement('div');
    div.style.cssText = 'margin:10px 0 2px;padding:8px 14px;background:var(--surface);border:1px solid var(--line);border-radius:9px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;';
    div.innerHTML = bar;
    if($('chips')) $('chips').parentNode.insertBefore(div, $('chips').nextSibling);
  })();
  // 段 tab
  $('segTabs').innerHTML = segs.map((x,i)=>
    `<div class="seg-tab ${i===0?'active':''}" onclick="goSeg('${x}',this)">${SEG_META[x].icon} ${SEG_META[x].label}</div>`).join('');
  goSeg(segs[0], document.querySelector('.seg-tab'));
  // 海运下载
  if($('dlSO')) $('dlSO').href = `${API}/file?token=${encodeURIComponent(token)}&type=so`;
  renderUploadsPanel();
  renderOurDocs(s);
  renderDeadlines(s);
  (function(){
    const box = document.getElementById('oceanDocs');
    if (!box) return;
    const upBtn = (label) => `<span style="color:var(--warn);font-weight:700;cursor:pointer;margin-right:14px;font-size:12px;" onclick="event.preventDefault();_cntrZone='${label}';pickFile('ocean')">上传盖章件</span>`;
    const rows = [];
    if (s.is_transfer)
      rows.push(dlRow('🔁', '内转外信息表 <span style="font-size:10px;color:var(--ink3);">第二程</span>', fileURL('transfer'), pv(fileURL('transfer')) + upBtn('内转外')));
    const ups = Array.isArray(s.collab_uploads)?s.collab_uploads:[];
    const isLiquid = !!(s.factory_attrs && (s.factory_attrs.liquid==='yes'));
    const msds = ups.filter(u=>/msds|鉴定/i.test(u.filename||''));
    if (isLiquid && !msds.length)
      rows.push(`<div style="border:1.5px solid color-mix(in srgb,var(--bad) 40%,var(--line));background:var(--badbg);border-radius:8px;padding:9px 14px;margin-top:6px;font-size:12px;color:var(--bad);font-weight:700;">🧪 本票含液体货：MSDS + 海运运输条件鉴定报告 <b>必传</b>（订舱备注需注明液体货）——从下方回传口上传</div>`);
    if (msds.length) msds.forEach(u => rows.push(dlRow('🧪', (/鉴定/.test(u.filename)?'海运鉴定报告':'MSDS')+' · '+esc(u.filename), fileURL('upload', u.stored))));
    else if (!isLiquid) rows.push(`<div style="border:1.5px dashed var(--line);border-radius:8px;padding:9px 14px;margin-top:6px;font-size:12px;color:var(--ink3);">🧪 MSDS / 海运鉴定报告 · 上传后自动出现（电池/液体货需要）</div>`);
    box.innerHTML = rows.join('');
  })();
  // （单据链接构造已上移至 boot 顶部）
  const upsAll = Array.isArray(s.collab_uploads)?s.collab_uploads:[];
  const soUps = upsAll.filter(u=>/(^|[^A-Z])S\/?O([^A-Z]|$)|入货|排载|配舱|舱单|订舱确认|manifest|放箱/i.test(u.filename||''));
  const blUps = upsAll.filter(u=>/\bBL\b|提单/i.test(u.filename||''));
  let dl = '';
  // 排载单/SO 真下载（系统数据生成，报关行排载单按此做）
  dl += dlRow('📋', '排载单 / SO（订舱确认书 · 提箱凭此）', fileURL('so'), pv(fileURL('so')));
  if (soUps.length) soUps.forEach(u => { dl += dlRow('📋', '舱单 / SO · '+esc(u.filename), fileURL('upload', u.stored), pv(fileURL('upload', u.stored))); });
  if (blUps.length) blUps.forEach(u => { dl += dlRow('📄', 'BL · '+esc(u.filename), fileURL('upload', u.stored), pv(fileURL('upload', u.stored))); });
  // BL number entry section
  (function(){
    const sec = $('blNoSection_v2') || $('blNoSection');
    if (!sec) return;
    if (s.bl_no) {
      sec.innerHTML = '';   // 去掉绿色「提单号已提交 · 客户已可查看草稿」条（Damon：没必要）
    } else if (blUps.length) {
      sec.innerHTML = `<div style="background:var(--surface)beb;border:1.5px solid color-mix(in srgb,var(--warn) 40%,var(--line));border-radius:8px;padding:10px 14px;">
        <div style="font-size:12px;font-weight:700;color:var(--warn);margin-bottom:6px;">📄 BL已上传 — 请填写提单号通知客户确认</div>
        <div style="display:flex;gap:8px;">
          <input id="blNoInput" type="text" placeholder="B/L No.（如 OOLU2345678）" style="flex:1;border:1px solid color-mix(in srgb,var(--warn) 40%,var(--line));border-radius:6px;padding:7px 10px;font-size:12px;font-family:inherit;outline:none;" value="${esc(s.bl_no||'')}">
          <button onclick="submitBlNo()" style="padding:7px 16px;border-radius:6px;border:none;background:var(--warn);color:#fff;font-size:12px;font-weight:700;cursor:pointer;">提交</button>
        </div>
      </div>`;
    } else {
      sec.innerHTML = `<div style="background:var(--surface2);border:1.5px dashed var(--line);border-radius:8px;padding:9px 14px;font-size:12px;color:var(--ink3);">📄 上传BL草稿后，填写提单号即可推送给客户确认</div>`;
    }
  })();
  dl += dlRow('🛂', '报关单（海关格式·数据已填）', fileURL('customs_decl'), pv(fileURL('customs_decl')));
  dl += dlRow('📋', 'PL·SC·IV 合并版', fileURL('pack', '', 'customs'), pv(fileURL('pack', '', 'customs')));
  const quar = (Array.isArray(s.collab_uploads)?s.collab_uploads:[]).filter(u=>/检疫|植检|动检|兽医|quarantine/i.test(u.filename||''));
  if (Array.isArray(s.quarantine_docs) && s.quarantine_docs.length) {   // 真源 document_uploads，一票多份全列(拼柜每单一张CIQ)
    const n = s.quarantine_docs.length;
    s.quarantine_docs.forEach((q, i) => {
      const label = n > 1 ? `检疫报告 ${i+1}/${n}（CIQ / 植检）` : '检疫报告（CIQ / 植检 · 出证件）';
      dl += dlRow('🌿', label, fileURL('quarantine', q.ref), pv(fileURL('quarantine', q.ref)));
    });
  }
  else if (s.has_quarantine) dl += dlRow('🌿', '检疫报告（CIQ / 植检 · 出证件）', fileURL('quarantine'), pv(fileURL('quarantine')));  // 兼容旧字段
  else if (quar.length) quar.forEach(u => { dl += dlRow('🌿', '检疫报告 · '+esc(u.filename), fileURL('upload', u.stored), pv(fileURL('upload', u.stored))); });
  else dl += `<div style="border:1.5px dashed var(--line);border-radius:8px;padding:10px 14px;margin-top:6px;font-size:12px;color:var(--ink3);">🌿 检疫报告 · 出证后自动出现在这里</div>`;
  $('dlBox').innerHTML = dl;
  // 申报字段表（直接带过来，免开文件）：品名/HS/箱数/净毛/CBM/申报金额 — 来自订单明细真值
  (function(){
    const agg = new Map();
    orders.forEach(o => (o.items||[]).forEach(it => {
      const key = (it.description||'')+'|'+(it.hs_code||'');
      const a = agg.get(key) || { name: it.description||'—', hs: it.hs_code||'', ctns:0, nw:0, gw:0, cbm:0, amt:0 };
      a.ctns += Number(it.ctns||0); a.nw += Number(it.nw_kgs||0); a.gw += Number(it.gw_kgs||0);
      a.cbm += Number(it.cbm||0); a.amt += Number(it.declare_amount||0);
      agg.set(key, a);
    }));
    const rows = [...agg.values()].filter(a => a.name !== '—' || a.ctns);
    if (!rows.length) { $('cdTable').innerHTML=''; return; }
    const fmt = n => n ? Number(n.toFixed(2)).toLocaleString() : '—';
    $('cdTable').innerHTML = '<div style="font-size:12px;font-weight:800;color:var(--ink2);margin-bottom:6px;">📑 申报字段（本票汇总）</div>'
      + '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:11px;">'
      + '<tr style="background:var(--surface2);color:var(--ink3);">' + ['报关品名','HS','箱数','净重kg','毛重kg','CBM','申报金额'].map(h=>`<th style="padding:6px 8px;text-align:left;border-bottom:1px solid var(--line);">${h}</th>`).join('') + '</tr>'
      + rows.map(a=>`<tr><td style="padding:6px 8px;font-weight:700;">${esc(a.name)}</td><td style="padding:6px 8px;">${esc(a.hs)}</td><td style="padding:6px 8px;">${a.ctns||'—'}</td><td style="padding:6px 8px;">${fmt(a.nw)}</td><td style="padding:6px 8px;">${fmt(a.gw)}</td><td style="padding:6px 8px;">${a.cbm?a.cbm.toFixed(3):'—'}</td><td style="padding:6px 8px;font-weight:700;">${fmt(a.amt)}</td></tr>`).join('')
      + '</table></div>';
  })();
  // 已有数据回显
  uploads = Array.isArray(s.collab_uploads)?s.collab_uploads:[];
  renderFiles();
  const td = s.trucking_detail || {};
  if(Array.isArray(td.vehicles)&&td.vehicles.length) vehs = td.vehicles.map(v=>({...v,plate:v.plate||'',driver:v.driver||'',driver_phone:v.driver_phone||'',pickup_time:v.pickup_time||''}));
  // SO/下单信息块（车队+报关行都要：厦门口岸信息多，他们要自己做排载单）
  (function(){
    const raw = s.so_info||s.raw||{}; const so = s.so_no || (raw.so_source||'').replace(/^入货通知/,'') || s.bl_no || '';
    const rows=[];
    if(so) rows.push(['SO/入货通知', so]);
    if(s.vessel||raw.vessel) rows.push(['船名航次', (s.vessel||'')+' '+(s.voyage||'')]);
    if(raw.ship_agent) rows.push(['船代', raw.ship_agent]);
    if(raw.terminal) rows.push(['场站', raw.terminal + (raw.terminal_tel?' · '+raw.terminal_tel:'')]);
    if(raw.cutoff_port) rows.push(['截港', raw.cutoff_port]);
    if(raw.doc_cutoff) rows.push(['截单', raw.doc_cutoff]);
    if(raw.vgm_cutoff) rows.push(['截VGM', raw.vgm_cutoff]);
    if(raw.free_days) rows.push(['免箱期', raw.free_days]);
    if(raw.telex_note) rows.push(['电放', raw.telex_note]);
    if(raw.split_note) rows.push(['分票', raw.split_note]);
    if(raw.vgm_note) rows.push(['VGM', raw.vgm_note]);
    if(raw.truck_req) rows.push(['🚛要求', raw.truck_req]);
    if(s.etd) rows.push(['预计开船 ETD', fmtD(s.etd)]);
    if(s.eta) rows.push(['预计到港 ETA', fmtD(s.eta)]);
    if(s.dispatched_at){ let _dt; try{ _dt=new Date(s.dispatched_at).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).slice(0,16); }catch(e){ _dt=String(s.dispatched_at).replace('T',' ').slice(0,16); } rows.push(['接单时间', _dt]); }
    if(!rows.length) return;
    const html = '<div style="background:var(--surface2);border:1px solid color-mix(in srgb,var(--accent) 40%,var(--line));border-radius:8px;padding:10px 14px;margin-bottom:10px;">'
      + '<div style="font-size:12px;font-weight:800;color:var(--accent);margin-bottom:6px;">⚓ SO / 下单信息 <span style="font-weight:400;color:var(--accent2);font-size:10px;">排载单按此做</span>'
      + (raw.tracking?` <a href="${esc(raw.tracking)}" target="_blank" style="float:right;font-size:11px;color:var(--accent);">📍 场站货物追踪 ↗</a>`:'') + '</div>'
      + '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px 14px;">'
      + rows.map(r=>'<div style="font-size:11px;"><span style="color:var(--ink3);">'+r[0]+'</span> <span style="font-weight:700;color:var(--ink);">'+esc(String(r[1]))+'</span></div>').join('')
      + '</div></div>';
    if ($('soInfo')) $('soInfo').innerHTML = html;
    if ($('soInfoC')) $('soInfoC').innerHTML = html;
  })();
  renderVehs();
  _billSheet = s;
  if(segs.includes('ocean')) await fetchBillSummary();
  renderBillingEntry(d.billing || {}, s);
  renderReminder(s);   // 账单摘要就绪后，顶部提醒「还差什么」
  // 报关费·回传即确认（续页/加项由报关行自行加价，一次确认即结单）
  (function(){
    const seg = document.getElementById('seg-customs'); if(!seg) return;
    const uz = seg.querySelector('.up-zone'); if(!uz) return;
    const box = document.createElement('div');
    box.style.cssText = 'background:var(--surface)beb;border:1px solid color-mix(in srgb,var(--warn) 40%,var(--line));border-radius:8px;padding:10px 14px;margin:10px 0;font-size:12px;color:var(--warn);display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
    box.innerHTML = '💴 <b>本票报关费</b>请在回传后确认（续页 / 加项自行加价）· 确认即结单'
      + '<button class="btn btn-blue btn-sm" style="margin-left:auto;" onclick="openBillingInvoice()">确认报关费 →</button>';
    uz.parentNode.insertBefore(box, uz);
  })();
  // 车队费·装货完成后确认价格（拖车费 / 续页加价，一次确认即结单）
  (function(){
    if (!(Array.isArray(segs) && segs.includes('truck'))) return;
    if (!window._billingToken) return;                      // 无可开账单则不显示
    const seg = document.getElementById('seg-truck'); if(!seg) return;
    if (seg.querySelector('#truckFeeConfirm')) return;
    const box = document.createElement('div');
    box.id = 'truckFeeConfirm';
    box.style.cssText = 'background:var(--surface)beb;border:1px solid color-mix(in srgb,var(--warn) 40%,var(--line));border-radius:8px;padding:10px 14px;margin:0 0 12px;font-size:12px;color:var(--warn);display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
    box.innerHTML = '💴 <b>本票拖车费</b>请在装货完成后确认（续页 / 加项自行加价）· 确认即结单'
      + '<button class="btn btn-blue btn-sm" style="margin-left:auto;" onclick="openBillingInvoice()">确认价格 →</button>';
    const vg = document.getElementById('vehGroups');
    if (vg && vg.parentNode) vg.parentNode.insertBefore(box, vg);
    else seg.insertBefore(box, seg.firstChild);
  })();
  // 车辆信息：填完即自动保存（协同端口，去掉手动「提交」按钮）
  (function(){
    const btn = $('btnVeh');
    if (btn) {
      btn.style.display = 'none';
      if (!$('vehSaveStatus')) {
        const st = document.createElement('div');
        st.id = 'vehSaveStatus';
        st.style.cssText = 'font-size:12px;color:var(--ink3);text-align:right;margin-top:6px;';
        st.textContent = '填完车牌 / 司机电话即自动保存';
        btn.parentNode.insertBefore(st, btn.nextSibling);
      }
    }
    const grp = $('vehGroups');
    if (grp && !grp._autoSaveWired) {
      grp._autoSaveWired = true;
      grp.addEventListener('focusout', (e) => {
        if (e.target && e.target.tagName === 'INPUT') autoSaveVeh();
      });
    }
  })();
  show('stateForm');
}

function showPreview(href){ $('pvFrame').src = href; $('pvModal').style.display='block'; }
// 回传框支持 拖拽 + 粘贴截图
async function submitBlNo(){
  const val = ($('blNoInput')||{}).value||'';
  if(!val.trim()){toast('请输入提单号');return;}
  const btn = document.querySelector('#blNoSection_v2 button') || document.querySelector('#blNoSection button');
  if(btn){btn.disabled=true;btn.textContent='提交中…';}
  try{
    const r = await fetch(`${API}/update-bl-no`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token, bl_no: val.trim()})});
    const d = await r.json();
    if(!d.ok) throw new Error(d.error||'失败');
    if(window._sheetP) window._sheetP.bl_no = d.bl_no;
    const sec=$('blNoSection_v2') || $('blNoSection');
    if(sec) sec.innerHTML='';   // 去掉绿色「提单号已提交」条，仅保留 toast 反馈
    toast('✓ 提单号已提交，客户可确认');
  }catch(e){toast('提交失败：'+e.message);if(btn){btn.disabled=false;btn.textContent='提交';}}
}

async function ingestFiles(list, zone){
  for(const f of list){ await uploadOne(f, zone); }
}
async function uploadOne(f, zone){
  try{
    const b64 = await new Promise((ok,no)=>{ const r=new FileReader(); r.onload=()=>ok(r.result); r.onerror=no; r.readAsDataURL(f); });
    const r = await fetch(`${API}/upload`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token,filename:'['+zone+']'+(f.name||'pasted.png'),mime:f.type,data_base64:b64})});
    const d = await r.json();
    if(!r.ok||!d.ok){ toast((f.name||'文件')+' 上传失败: '+(d.error||'')); return; }
    uploads.push(d.file); renderFiles(); toast('✓ '+(f.name||'截图')+' 已上传');
  }catch(e){ toast('网络错误'); }
}
document.querySelectorAll('.up-zone').forEach(z=>{
  const zone = (z.getAttribute('onclick')||'').includes('truck') ? 'truck' : 'customs';
  z.addEventListener('dragover', e=>{ e.preventDefault(); z.style.background='var(--surface2)'; });
  z.addEventListener('dragleave', ()=>{ z.style.background=''; });
  z.addEventListener('drop', e=>{ e.preventDefault(); z.style.background=''; ingestFiles([...e.dataTransfer.files], zone); });
});
document.addEventListener('paste', e=>{
  const fs = [...(e.clipboardData?.files||[])];
  if(!fs.length) return;
  const zone = document.getElementById('seg-customs') && !document.getElementById('seg-customs').classList.contains('hidden') ? 'customs' : 'truck';
  ingestFiles(fs, zone); toast('📎 已捕获粘贴文件，上传中…');
});
window.CollabPortalBoot = boot;
