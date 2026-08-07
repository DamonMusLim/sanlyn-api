const API = '/api/db/booking-collab';
const PORTAL_UI_VERSION = "v2.0.0";
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
  const truckOk = !!(s.trucking_detail && Array.isArray(s.trucking_detail.vehicles) && s.trucking_detail.vehicles.some(v=>v.plate||v.driver_phone));
  body.innerHTML = `<div class="hero-grid">
    <div><div class="hero-name">${esc(ps.company_label || '货代协同')}</div>
      <div class="hero-bl">${esc(s.bl_no || s.hbl_no || '提单号待回传')}</div></div>
    <div class="mini-kv">
      <span>出单方式</span><span>${esc(s.release_type || '待确认')}</span>
      <span>柜量/航线</span><span>${esc([qty, route].filter(Boolean).join(' · ') || '待确认')}</span>
      <span>委托拖车</span><span><button class="btn btn-sm ${truckOk?'btn-green':'btn-ghost'}" type="button">${truckOk?'已回填':'待回填'}</button></span>
    </div></div>`;
  panel.classList.remove('hidden');
}

function fileLink(type, ref, aud){ return window._fileURL ? window._fileURL(type, ref, aud) : '#'; }
function docRow(icon, label, href, source){
  const safe = esc(href);
  return `<div class="doc-row"><span>${icon}</span><div class="doc-row-main">${esc(label)}</div>
    <span class="doc-tag">${esc(source)}</span>
    <div class="doc-actions"><a class="icon-link" href="${safe}" target="_blank" title="预览">👁</a><a class="icon-link" href="${safe}" target="_blank" download title="下载">⬇</a></div></div>`;
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
  const groups = [
    ['抬头资料', [
      ['🏢','订舱委托 / Booking Instruction', fileLink('so'), '规则自动'],
      ...(s.is_transfer ? [['🔁','内转外信息表', fileLink('transfer'), '规则自动']] : [])
    ]],
    ['本票单据', [
      ['📋','排载单 / SO', fileLink('so'), '规则自动'],
      ['🛂','报关单（海关格式·数据已填）', fileLink('customs_decl'), '规则自动'],
      ['📦','PL · SC · IV 合并版', fileLink('pack','','customs'), '规则自动']
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
    ['VGM', bjTime(raw.vgm_cutoff || s.vgm_cutoff || s.vgm_cutoff_at) || '待确认'],
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
  const map = { ocean:'海运费', trucking:'拖车费', port_charge:'港杂费', customs:'报关费' };
  const keys = ['ocean','trucking','port_charge','customs'];
  const segData = (_billSummary && _billSummary.segments) || {};
  body.innerHTML = keys.map(k=>{
    const x = segData[k] || {status:'待报', amount:{}, pending_amount:{}};
    const money = moneyMap(x.amount);
    const pending = moneyMap(x.pending_amount);
    const empty = !money && !pending;
    const summary = k === 'port_charge' ? '可编辑费目表 · 新增待我方确认' : [s.pol||'起点', s.pod||'港口'].join(' → ');
    const detail = k === 'port_charge' ? portChargeEditor() :
      `<div style="font-size:12px;color:#374151;font-weight:800;">${esc(s.pol||'起点')} → ${esc(s.pod||'港口')} → ${esc(money || pending || '未填写金额')}</div>`;
    return `<div class="bill-row" id="bill_${k}">
      <button class="bill-summary" type="button" onclick="toggleBill('${k}')"><b>${map[k]}</b><span class="desc">${esc(summary)}</span>
        <span class="bill-money ${empty?'empty':''}">${esc(money || pending || '未填写金额')}</span><span class="badge ${chipTone(x.status)}">${esc(x.status)}</span></button>
      <div class="bill-detail">${detail}</div></div>`;
  }).join('');
  $('billingSubV2').textContent = canOpen ? '海运费 / 拖车费 / 港杂费 / 报关费' : '当前链接暂无可打开账单';
}

function toggleBill(k){ document.getElementById('bill_'+k)?.classList.toggle('open'); }
function portChargeEditor(){
  return `<table class="bill-edit-table"><thead><tr><th>费目</th><th>计价单位</th><th>单价</th><th>金额</th><th></th></tr></thead>
    <tbody id="portChargeRows"></tbody></table>
    <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="addPortChargeRow()">＋ 新增费目</button>`;
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

function renderFiles(){
  // 上传按段归档显示（rec.role=supplier，文件名带段前缀）
  ['ocean','truck','customs'].forEach(seg=>{
    const mine = uploads.filter(u=>String(u.filename||'').startsWith('['+seg+']') ||
      (seg==='ocean' && !/^\[(truck|customs)\]/.test(String(u.filename||''))&& u.role!=='trucking' && u.role!=='broker' && String(u.filename||'').startsWith('[ocean]')));
    const el = $(seg === 'ocean' ? 'fl_ocean_v2' : 'fl_'+seg) || $('fl_'+seg); if(!el) return;
    el.innerHTML = uploads.filter(u=>String(u.filename||'').startsWith('['+seg+']')).map(u=>`
      <div class="file-row"><span>📄</span><span style="flex:1;font-weight:700;">${esc(String(u.filename).replace('['+seg+']',''))}</span>
      <span style="color:#047857;font-size:10px;">${esc(bjTime(u.uploaded_at))} ✓</span></div>`).join('');
  });
}

function pickFile(zone){ upZone = zone; $('fileInput').click(); }
$('fileInput').addEventListener('change', async e=>{
  for(const f of e.target.files){
    if(f.size > 8*1024*1024){ toast(f.name+' 超过 8MB'); continue; }
    const b64 = await new Promise(res=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.readAsDataURL(f); });
    try{
      const r = await fetch(`${API}/upload`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token,filename:'['+upZone+']'+(typeof _cntrZone==='string'&&_cntrZone?('['+_cntrZone+']'):'')+f.name,mime:f.type,data_base64:b64})});
      const d = await r.json();
      if(!r.ok||!d.ok){ toast(f.name+' 上传失败: '+(d.error||'')); continue; }
      uploads.push(d.file); renderFiles(); toast('✓ '+f.name+' 已上传');
      if(upZone==='customs' && window._billingToken) setTimeout(()=>toast('别忘了确认本票报关费 → 上方按钮'), 1600);
    }catch(err){ toast(f.name+' 网络错误'); }
  }
  e.target.value='';
});

/* 车队回填（复用 trucking-submit） */
function entryFor(d){
  const sP = window._sheetP || {}; const fe = sP.factory_entry || {};
  const keys = Object.keys(fe);
  if(!keys.length) return null;
  // 柜货对应订单→工厂名 含 登记厂标 即匹配；匹配不到给 default/唯一一条
  const ords = (d.cargo||[]).map(x=>x.order_no).filter(Boolean);
  const facs = (Array.isArray(sP.orders)?sP.orders:[]).filter(o=>ords.includes(o.order_no)).map(o=>o.factory||'');
  for(const k of keys){ if(facs.some(f=>f.includes(k)||k.includes(f))) return fe[k]; }
  return fe['default'] || (keys.length===1 ? fe[keys[0]] : null);
}
function cargoLine(cg){
  if(!Array.isArray(cg)||!cg.length) return '<span style="color:#b45309;">待工厂确认</span>';
  return cg.map(x=>{
    const parts=[x.name||x.order_no||'—'];
    if(x.cartons) parts.push(x.cartons+'箱');
    if(x.gw_kg) parts.push(Number(x.gw_kg).toLocaleString()+'kg');
    return esc(parts.join(' '));
  }).join(' ＋ ');
}
function quickText(i){
  const d = vehs[i]||{};
  const L=[];
  L.push(d.loading_address||'提货地见托书');
  if(gv('plate_'+i)) L.push('车号：'+gv('plate_'+i));
  if(d.trailer_plate) L.push('挂号：'+d.trailer_plate);
  if(gv('phone_'+i)) L.push('手机：'+gv('phone_'+i));
  if(gv('driver_'+i)) L.push('姓名：'+gv('driver_'+i));
  if(d.driver_id_no) L.push('证号：'+maskId(d.driver_id_no));
  if(d.cntr) L.push('箱号：'+d.cntr);
  if(d.seal_no) L.push('封号：'+d.seal_no);
  if(d.tare_kg) L.push('箱皮重：'+d.tare_kg+'kg');
  return L.join('\n');
}
function copyQuick(i){
  navigator.clipboard.writeText(quickText(i)).then(()=>toast('✓ 车'+(i+1)+' 派车信息已复制，微信直接粘贴'))
    .catch(()=>{ prompt('手动复制：', quickText(i)); });
}
function infoCell(label, val){
  return `<div style="font-size:11px;"><span style="color:#9ca3af;">${label}</span> <span style="font-weight:700;color:#111827;">${esc(val||'—')}</span></div>`;
}
function vehHtml(i, d={}){
  return `<div class="ctn-group"><div class="ctn-group-head">
    <div class="ctn-group-title" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">🚛 车 ${i+1}${((d.cargo||[]).reduce((s,x)=>s+(Number(x.gw_kg)||0),0)>25000)?`<span style="background:#fef2f2;color:#b91c1c;border:1px solid #fca5a5;border-radius:4px;padding:1px 7px;font-size:10px;font-weight:800;">⚠️超重柜>25T·订舱需备注</span>`:''}
      <span style="color:#9ca3af;font-weight:400;font-size:10px;">箱号</span>
      <input id="cntr_${i}" value="${esc(d.cntr)}" placeholder="点击填写" style="border:none;border-bottom:1.5px dashed #cbd5e1;background:transparent;font-size:12px;font-weight:800;color:#111827;width:118px;outline:none;font-family:monospace;text-transform:uppercase;">
      <span style="color:#9ca3af;font-weight:400;font-size:10px;">封号</span>
      <input id="seal_${i}" value="${esc(d.seal_no)}" placeholder="点击填写" style="border:none;border-bottom:1.5px dashed #cbd5e1;background:transparent;font-size:12px;font-weight:800;color:#111827;width:108px;outline:none;font-family:monospace;text-transform:uppercase;">
    </div>
    <div style="display:flex;gap:10px;align-items:center;">
      <span style="cursor:pointer;color:#fff;background:#1a73e8;font-size:14px;font-weight:800;padding:6px 14px;border-radius:8px;box-shadow:0 1px 2px rgba(26,115,232,.3);" onclick="openQuickFill(${i})">📋 快捷填写</span>
      <span style="cursor:pointer;color:#6b7280;font-size:11px;" onclick="copyQuick(${i})" title="复制派车信息文本">复制</span>
      ${vehs.length>1?`<span style="cursor:pointer;color:#dc2626;font-size:11px;font-weight:700;" onclick="delVeh(${i})">× 删除</span>`:''}
    </div></div>
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px 12px;background:#f9fafb;border-radius:8px;margin:8px 12px 0;padding:10px 12px;">
      <div style="grid-column:1/-1;font-size:11px;"><span style="color:#9ca3af;">提货地</span> <span style="font-weight:700;color:#111827;">${esc(d.loading_address||'—')}</span></div>
      ${infoCell('挂号', d.trailer_plate)}
      ${infoCell('证号', maskId(d.driver_id_no))}
      ${infoCell('箱皮重', d.tare_kg?d.tare_kg+'kg':'')}
      ${(c2=>{const t=String(c2||'');const ph=(t.match(/1\d{10}/)||[''])[0];const nm=t.replace(ph,'').replace(/[:：\s]+$/,'').trim();
        return infoCell('工厂联系人', nm) + (ph?`<div style="font-size:11px;"><span style="color:#9ca3af;">工厂电话</span> <a href="tel:${ph}" style="font-weight:700;color:#1a73e8;">${ph}</a></div>`:infoCell('工厂电话',''));})(d.loading_contact)}
      <div style="grid-column:1/-1;font-size:11px;"><span style="color:#9ca3af;">货品</span> <span style="font-weight:700;color:#111827;">${cargoLine(d.cargo)}</span></div>
      ${(()=>{const er=entryFor(d);if(!er)return '';
        const qr=(Array.isArray((window._sheetP||{}).collab_uploads)?window._sheetP.collab_uploads:[]).find(u=>/入厂|二维码|考试/.test(u.filename||''));
        return `<div style="grid-column:1/-1;font-size:11px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;padding:6px 10px;">
          <span style="color:#92400e;font-weight:800;">🏭 入厂要求</span>
          ${er.note?` <span style="color:#92400e;">${esc(er.note)}</span>`:''}
          ${er.contact||er.phone?` · 厂内对接 <b>${esc(er.contact||'')}</b>${er.phone?` <a href="tel:${esc(er.phone)}" style="color:#1a73e8;font-weight:700;">${esc(er.phone)}</a>`:''}`:''}
          ${er.exam_url?` · <a href="${esc(er.exam_url)}" target="_blank" style="color:#1a73e8;font-weight:700;">📝 入厂考试/扫码 ↗</a>`:''}
          ${qr&&window._fileURL?` · <a href="${window._fileURL('upload', qr.stored)}" target="_blank" style="color:#1a73e8;font-weight:700;">🔲 二维码图片</a>`:''}
        </div>`;})()}
    </div>
    <div style="padding:12px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
      <div class="form-field" style="margin:0;"><label class="form-label">车牌号 *</label>
        <input class="form-input" id="plate_${i}" value="${esc(d.plate)}" placeholder="例：闽D12345"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">司机姓名</label>
        <input class="form-input" id="driver_${i}" value="${esc(d.driver)}"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">司机电话 *</label>
        <input class="form-input" id="phone_${i}" type="tel" value="${esc(d.driver_phone)}"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">提箱时间</label>
        <input class="form-input" id="pickup_${i}" type="datetime-local" value="${esc(d.pickup_time)}"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">装柜时间 <span style="font-weight:400;color:#9ca3af;">(工厂已选则跟随，不合适打工厂电话)</span></label>
        <input class="form-input" id="loadtime_${i}" type="datetime-local" value="${esc(d.loading_time)}"></div>
      <div class="form-field" style="margin:0;"><label class="form-label">过磅重(kg) <span style="font-weight:400;color:#9ca3af;">(磅单整车重−车重，对不上会预警)</span></label>
        <input class="form-input" id="weigh_${i}" type="number" step="0.01" value="${esc(d.weigh_kg||'')}" placeholder="磅单读数"></div>
    </div>
    <div class="up-zone" style="margin:0 12px 12px;" onclick="pickFileCntr('${esc(d.cntr||('车'+(i+1)))}')">📷 本柜 装柜照 / 磅单 / EIR</div>
  </div>`;
}
// 粘贴派车文本 → 自动解析填写（标准格式正则；解析不出再人工）
let _qfIdx = 0;
function openQuickFill(i){ _qfIdx = i; $('qfText').value=''; $('qfModal').style.display='block'; $('qfText').focus(); }
function parseQuickFill(){
  const t = $('qfText').value || '';
  const pick = (re) => { const m = t.match(re); return m ? m[1].trim() : ''; };
  const got = {
    plate: pick(/车号[:：\s]*([^\s\n]+)/),
    trailer: pick(/挂号?[:：\s]*([^\s\n]+)/),
    phone: pick(/(?:手机|电话)[:：\s]*(1\d{10})/),
    name: pick(/姓名[:：\s]*([^\s\n]+)/),
    idno: pick(/证号[:：\s]*(\d{15,17}[\dXx])/),
    cntr: pick(/箱号[:：\s]*([A-Z]{4}\d{7})/i),
    seal: pick(/封号[:：\s]*([^\s\n]+)/),
    tare: pick(/箱?皮重[:：\s]*([\d.]+)/),
  };
  if(!got.plate && !got.phone){ toast('没解析出车号/电话，请检查格式'); return; }
  const i = _qfIdx;
  if(got.plate) { const el=$('plate_'+i); if(el) el.value=got.plate; }
  if(got.name)  { const el=$('driver_'+i); if(el) el.value=got.name; }
  if(got.phone) { const el=$('phone_'+i); if(el) el.value=got.phone; }
  snapV();
  const v = vehs[i]||{};
  if(got.trailer) v.trailer_plate=got.trailer;
  if(got.idno) v.driver_id_no=got.idno;
  if(got.seal && !v.seal_no) v.seal_no=got.seal;
  if(got.tare && !v.tare_kg) v.tare_kg=Number(got.tare);
  if(got.cntr && v.cntr && got.cntr.toUpperCase()!==String(v.cntr).toUpperCase()){
    toast('⚠️ 粘贴箱号 '+got.cntr+' 与本柜 '+v.cntr+' 不符，请核对！'); }
  else if(got.cntr && !v.cntr) v.cntr=got.cntr.toUpperCase();
  vehs[i]=v; renderVehs();
  $('qfModal').style.display='none';
  toast('✓ 已解析填入，确认后提交');
}
let _cntrZone = null;
function pickFileCntr(cntr){ _cntrZone = cntr; pickFile('truck'); }
// 独立"上传舱单/SO"按钮:打[SO舱单]标记,不靠文件名,上传即认成SO(客户提箱凭此) 2026-07-18
function pickFileSO(){ _cntrZone = 'SO舱单'; pickFile('ocean'); }
function snapV(){ vehs = vehs.map((v,i)=>$('plate_'+i)!==null?{...v,plate:gv('plate_'+i),driver:gv('driver_'+i),driver_phone:gv('phone_'+i),pickup_time:gv('pickup_'+i),loading_time:gv('loadtime_'+i)||v.loading_time||'',cntr:(gv('cntr_'+i)||'').toUpperCase()||v.cntr||'',seal_no:(gv('seal_'+i)||'').toUpperCase()||v.seal_no||'',weigh_kg:gv('weigh_'+i)||v.weigh_kg||''}:v); }
function renderVehs(){ $('vehGroups').innerHTML = vehs.map((v,i)=>vehHtml(i,v)).join(''); }
function addVeh(){ vehs.push({}); renderVehs(); }
function delVeh(i){ snapV(); vehs.splice(i,1); if(!vehs.length) vehs.push({}); renderVehs(); }
let _autoSaveTimer = null;
function setSaveStatus(txt, color){ const el=$('vehSaveStatus'); if(el){ el.textContent=txt; el.style.color=color||'#9ca3af'; } }
async function saveVeh(opts){
  const silent = opts && opts.silent;
  snapV();
  const vehicles = vehs.filter(v=>v.plate||v.driver_phone);
  if(!vehicles.length){ if(!silent) toast('至少一辆车需填车牌和司机电话'); return; }
  setSaveStatus('保存中…','#b45309');
  try{
    const r = await fetch(`${API}/trucking-submit`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token,vehicles,remarks:''})});
    const d = await r.json();
    if(!r.ok||!d.ok){ setSaveStatus('保存失败，请重试','#dc2626'); if(!silent) toast(d.error||'保存失败'); return; }
    setSaveStatus('已自动保存 ✓','#047857');
    if(!silent) toast('✓ 车辆信息已保存');
  }catch(e){ setSaveStatus('网络错误，未保存','#dc2626'); if(!silent) toast('网络错误'); }
}
// 协同端口：填完即存，无需手动提交（防抖 0.6s）
function autoSaveVeh(){ clearTimeout(_autoSaveTimer); _autoSaveTimer=setTimeout(()=>saveVeh({silent:true}), 600); }

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
  const isGodview = d.role === 'supplier_portal' &&
    (ps.field_profile === 'upstream_downstream' || ps.field_profile === 'shipping_booking');
  if (isGodview && window.CollabPortalGodview) {
    await window.CollabPortalGodview.render({ data:d, sheet:s, portalScope:ps, api:API, token, $, esc, fmtD, show });
    return;
  }
  // 单据链接构造（海运/报关段共用）
  const orders = Array.isArray(s.orders)?s.orders:[];
  const dlRow = (icon, label, href, extra='') =>
    `<a class="dl-btn" href="${href}" target="_blank">${icon} <span style="flex:1;">${label}</span>${extra}<span style="color:#1a73e8;">下载 ↗</span></a>`;
  const pv = (href) => `<span style="color:#059669;font-weight:700;cursor:pointer;margin-right:14px;" onclick="event.preventDefault();showPreview('${href}')">预览</span>`;
  window._fileURL = (type, ref, aud) => `${API}/file?token=${encodeURIComponent(token)}&type=${type}${ref?`&ref=${encodeURIComponent(ref)}`:''}${aud?`&aud=${aud}`:''}`;
  const fileURL = window._fileURL;

  segs = ps.segments || ['ocean','truck','customs'];
  $('topBadge').textContent = ps.company_label || '供应链端口';
  $('bannerTitle').textContent = (ps.company_label || '贵司') + ' — ' + segs.map(x=>SEG_META[x].label).join('+');
  $('bannerSub').textContent = '贵司承包：' + segs.map(x=>SEG_META[x].label).join('+') + ' ＝ ' + (ps.company_label || '贵司') + (segs.length>=3 ? ' · 一个口全干' : '');
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
      return `<span style="font-size:11px;font-weight:${cur?'800':'600'};color:${on?'#047857':cur?'#b45309':'#9ca3af'};">`
        + (on?'✅':cur?'🔶':'◯') + ' ' + x.label + (x.due&&(cur||!on)?`<span style="font-weight:400;color:#6b7280;"> ${x.due}</span>`:'') + '</span>';
    }).join('<span style="color:#d1d5db;margin:0 6px;">→</span>');
    const div = document.createElement('div');
    div.style.cssText = 'margin:10px 0 2px;padding:8px 14px;background:#fff;border:1px solid #e5e7eb;border-radius:9px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;';
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
    const upBtn = (label) => `<span style="color:#b45309;font-weight:700;cursor:pointer;margin-right:14px;font-size:12px;" onclick="event.preventDefault();_cntrZone='${label}';pickFile('ocean')">上传盖章件</span>`;
    const rows = [];
    if (s.is_transfer)
      rows.push(dlRow('🔁', '内转外信息表 <span style="font-size:10px;color:#9ca3af;">第二程</span>', fileURL('transfer'), pv(fileURL('transfer')) + upBtn('内转外')));
    const ups = Array.isArray(s.collab_uploads)?s.collab_uploads:[];
    const isLiquid = !!(s.factory_attrs && (s.factory_attrs.liquid==='yes'));
    const msds = ups.filter(u=>/msds|鉴定/i.test(u.filename||''));
    if (isLiquid && !msds.length)
      rows.push(`<div style="border:1.5px solid #fca5a5;background:#fef2f2;border-radius:8px;padding:9px 14px;margin-top:6px;font-size:12px;color:#b91c1c;font-weight:700;">🧪 本票含液体货：MSDS + 海运运输条件鉴定报告 <b>必传</b>（订舱备注需注明液体货）——从下方回传口上传</div>`);
    if (msds.length) msds.forEach(u => rows.push(dlRow('🧪', (/鉴定/.test(u.filename)?'海运鉴定报告':'MSDS')+' · '+esc(u.filename), fileURL('upload', u.stored))));
    else if (!isLiquid) rows.push(`<div style="border:1.5px dashed #e0e4ea;border-radius:8px;padding:9px 14px;margin-top:6px;font-size:12px;color:#9ca3af;">🧪 MSDS / 海运鉴定报告 · 上传后自动出现（电池/液体货需要）</div>`);
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
      sec.innerHTML = `<div style="background:#f0fdf4;border:1.5px solid #a7f3d0;border-radius:8px;padding:10px 14px;font-size:12px;color:#047857;font-weight:700;">✅ 提单号已提交：<span style="color:#1a1d23;">${esc(s.bl_no)}</span> · 客户已可查看草稿</div>`;
    } else if (blUps.length) {
      sec.innerHTML = `<div style="background:#fffbeb;border:1.5px solid #fde68a;border-radius:8px;padding:10px 14px;">
        <div style="font-size:12px;font-weight:700;color:#92400e;margin-bottom:6px;">📄 BL已上传 — 请填写提单号通知客户确认</div>
        <div style="display:flex;gap:8px;">
          <input id="blNoInput" type="text" placeholder="B/L No.（如 OOLU2345678）" style="flex:1;border:1px solid #fde68a;border-radius:6px;padding:7px 10px;font-size:12px;font-family:inherit;outline:none;" value="${esc(s.bl_no||'')}">
          <button onclick="submitBlNo()" style="padding:7px 16px;border-radius:6px;border:none;background:#d97706;color:#fff;font-size:12px;font-weight:700;cursor:pointer;">提交</button>
        </div>
      </div>`;
    } else {
      sec.innerHTML = `<div style="background:#f8fafc;border:1.5px dashed #e0e4ea;border-radius:8px;padding:9px 14px;font-size:12px;color:#9ca3af;">📄 上传BL草稿后，填写提单号即可推送给客户确认</div>`;
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
  else dl += `<div style="border:1.5px dashed #e0e4ea;border-radius:8px;padding:10px 14px;margin-top:6px;font-size:12px;color:#9ca3af;">🌿 检疫报告 · 出证后自动出现在这里</div>`;
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
    $('cdTable').innerHTML = '<div style="font-size:12px;font-weight:800;color:#374151;margin-bottom:6px;">📑 申报字段（本票汇总）</div>'
      + '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:11px;">'
      + '<tr style="background:#f9fafb;color:#6b7280;">' + ['报关品名','HS','箱数','净重kg','毛重kg','CBM','申报金额'].map(h=>`<th style="padding:6px 8px;text-align:left;border-bottom:1px solid #e5e7eb;">${h}</th>`).join('') + '</tr>'
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
    const html = '<div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 14px;margin-bottom:10px;">'
      + '<div style="font-size:12px;font-weight:800;color:#1d4ed8;margin-bottom:6px;">⚓ SO / 下单信息 <span style="font-weight:400;color:#60a5fa;font-size:10px;">排载单按此做</span>'
      + (raw.tracking?` <a href="${esc(raw.tracking)}" target="_blank" style="float:right;font-size:11px;color:#1a73e8;">📍 场站货物追踪 ↗</a>`:'') + '</div>'
      + '<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:4px 14px;">'
      + rows.map(r=>'<div style="font-size:11px;"><span style="color:#6b7280;">'+r[0]+'</span> <span style="font-weight:700;color:#111827;">'+esc(String(r[1]))+'</span></div>').join('')
      + '</div></div>';
    if ($('soInfo')) $('soInfo').innerHTML = html;
    if ($('soInfoC')) $('soInfoC').innerHTML = html;
  })();
  renderVehs();
  _billSheet = s;
  if(segs.includes('ocean')) await fetchBillSummary();
  renderBillingEntry(d.billing || {}, s);
  // 报关费·回传即确认（续页/加项由报关行自行加价，一次确认即结单）
  (function(){
    const seg = document.getElementById('seg-customs'); if(!seg) return;
    const uz = seg.querySelector('.up-zone'); if(!uz) return;
    const box = document.createElement('div');
    box.style.cssText = 'background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin:10px 0;font-size:12px;color:#92400e;display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
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
    box.style.cssText = 'background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin:0 0 12px;font-size:12px;color:#92400e;display:flex;align-items:center;gap:10px;flex-wrap:wrap;';
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
        st.style.cssText = 'font-size:12px;color:#9ca3af;text-align:right;margin-top:6px;';
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
    if(sec) sec.innerHTML=`<div style="background:#f0fdf4;border:1.5px solid #a7f3d0;border-radius:8px;padding:10px 14px;font-size:12px;color:#047857;font-weight:700;">✅ 提单号已提交：<span style="color:#1a1d23;">${esc(d.bl_no)}</span> · 客户已可查看草稿</div>`;
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
  z.addEventListener('dragover', e=>{ e.preventDefault(); z.style.background='#eff6ff'; });
  z.addEventListener('dragleave', ()=>{ z.style.background=''; });
  z.addEventListener('drop', e=>{ e.preventDefault(); z.style.background=''; ingestFiles([...e.dataTransfer.files], zone); });
});
document.addEventListener('paste', e=>{
  const fs = [...(e.clipboardData?.files||[])];
  if(!fs.length) return;
  const zone = document.getElementById('seg-customs') && !document.getElementById('seg-customs').classList.contains('hidden') ? 'customs' : 'truck';
  ingestFiles(fs, zone); toast('📎 已捕获粘贴文件，上传中…');
});
boot();
