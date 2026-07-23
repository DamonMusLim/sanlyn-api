const API = '/api/db/booking-collab';
const token = new URLSearchParams(location.search).get('token') || '';
const $ = id => document.getElementById(id);
const show = id => { ['stateLoading','stateForm','stateDead'].forEach(s => $(s).classList.add('hidden')); $(id).classList.remove('hidden'); };
function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200); }
function esc(v){ return v==null?'':String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function fmtD(v){ if(!v) return ''; try{ return new Date(v).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}); }catch(e){ return String(v).slice(0,10); } }
function fmt(d){ return d?fmtD(d):'—'; }
function openBillingInvoice(){
  if(!window._billingToken) return;
  window.open('/public/invoice-confirm-preview.html?token='+encodeURIComponent(window._billingToken), '_blank', 'noopener');
}
function renderBillingEntry(billing){
  const box=$('priceBox');
  if(!box) return;
  const canOpen=!!(billing&&billing.token&&billing.show_amount!==false);
  window._billingToken=canOpen?billing.token:'';
  box.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:#f8fafc;border:1px solid #e0e4ea;border-radius:8px;padding:10px 12px;">'
    +'<div><div style="font-size:13px;font-weight:800;color:#1a1d23;">费用 / 账单：'+(canOpen?'本票港杂/费用账单':'暂无')+'</div>'
    +'<div style="font-size:11px;color:#6b7280;margin-top:2px;">'+(canOpen?esc(billing.segment||'按当前权限展示'):'当前链接暂无可打开账单')+'</div></div>'
    +(canOpen?'<button class="btn" style="padding:7px 12px;font-size:12px;background:#1a73e8;color:#fff;" onclick="openBillingInvoice()">打开账单 / 开票</button>':'')+'</div>';
}

let sheet = {}, sailings = [], selIdx = -1, confirmed = false, noteTimer = null, notes = {};


function renderConfirmState(){
  // 谁定了就显示：已确认横幅 + 锁定选中卡
  if(confirmed){
    const x = sailings[selIdx] || sheet.customer_selected_sailing || {};
    $('confirmedBanner').classList.remove('hidden');
    $('confirmedText').textContent = `已确认订舱：${x.carrier||''} ${x.vessel||''} · ETD ${fmt(x.etd)}`;
    $('confirmedSub').textContent = (sheet.customer_submitted_at?`确认时间 ${String(sheet.customer_submitted_at).replace('T',' ').slice(0,16)} · `:'') + 'Sanlyn 已收到，舱位锁定中';
    $('actionBadge').textContent='已确认'; $('actionBadge').className='badge badge-green';
    $('confirmZone').style.display='none';
    // 确认后折叠货物明细
    const ct=$('cargoTable'),cc=$('cargoChevron'),cs=$('cargoSub');
    if(ct){ct.style.display='none';} if(cc){cc.textContent='▸';} if(cs){cs.textContent='点击展开明细';}
  } else {
    $('confirmedBanner').classList.add('hidden');
    $('actionBadge').textContent='需要您确认'; $('actionBadge').className='badge badge-amber';
    // hide confirm button if ship is already booked on Sanlyn side
    const _booked = !!(sheet.so_no || sheet.bl_no);
    $('confirmZone').style.display = _booked ? 'none' : 'block';
  }
}

function pick(i){
  if(confirmed) return;
  selIdx=i;
  sailings.forEach((_,k)=>{
    const el=$('sail_'+k);
    el.classList.toggle('selected',k===i);
    el.querySelector('.sel-pill').classList.toggle('hidden',k!==i);
  });
}
function reopen(){
  confirmed=false; window._isAmend = !!sheet.customer_submitted; renderConfirmState();
  // 已确认过再改 = 改单：明示可能产生改单费（以船司账单为准）
  if(window._isAmend){
    const cz=$('confirmZone');
    if(cz && !$('amendNotice')){
      const n=document.createElement('div'); n.id='amendNotice';
      n.style.cssText='margin:0 0 10px;padding:10px 14px;background:#fffbeb;border:1px solid #fde68a;border-left:4px solid #f59e0b;border-radius:6px;font-size:12px;color:#92400e;';
      const cnt=(sheet.customer_amend&&sheet.customer_amend.count)?Number(sheet.customer_amend.count):0;
      n.innerHTML='⚠️ <b>改单提醒 Amendment</b>：您已确认过船期，再次提交将视为<b>改单</b>，船公司可能收取改单费（以实际账单为准）。'+(cnt>0?`<span style="margin-left:6px;color:#b45309;">本票已改单 ${cnt} 次</span>`:'');
      cz.insertBefore(n,cz.firstChild);
    }
  }
  toast('可重新选择航班，选好后再次确认');
}

function renderSailings(){
  $('sailCount').textContent = sailings.length + ' 个班次';
  if(!sailings.length){
    if (sheet.so_no || sheet.bl_no) {
      $('sailCount').textContent = '已订舱';
      const seg = [sheet.carrier_code, sheet.vessel, sheet.voyage].filter(Boolean).join(' · ');
      $('sailBox').innerHTML = `<div style="padding:14px 16px;font-size:13px;background:#f0fdf4;border-radius:8px;margin:0 0 4px;">
        ✅ <b>已订舱：${esc(seg||'—')}</b>${sheet.etd?` · ETD ${fmt(sheet.etd)}`:''}</div>`;
    }
    return;
  }
  $('sailBox').innerHTML = sailings.map((x,i)=>`
    <div class="sail" id="sail_${i}" onclick="pick(${i})">
      <div class="sail-top">
        <span style="font-size:18px;">🚢</span>
        <div>
          <span class="sail-carrier">${esc(x.carrier||'—')}</span>
          ${x.is_recommended?'<span class="rec-pill">Sanlyn 推荐</span>':''}
          <div class="sail-vessel">${esc(x.vessel||'')} ${esc(x.voyage||'')}</div>
        </div>
        <span class="sel-pill hidden">✓ Selected</span>
      </div>
      <div class="sail-grid">
        <div class="sail-cell"><div class="l">ETD ${esc(sheet.pol||'')}</div><div class="d">${fmt(x.etd)}</div></div>
        <div class="sail-cell"><div class="l">ETA ${esc(sheet.pod||'')}</div><div class="d">${fmt(x.eta)}</div></div>
        <div class="sail-cell"><div class="l">截关 Cut-off</div><div class="d red">${fmt(x.cutoff_date)}</div></div>
        <div class="sail-cell"><div class="l">运费 / ${esc(sheet.container_type||'柜')}</div><div class="d green">${x.rate_usd?('USD '+Number(x.rate_usd).toLocaleString()):'—'}</div></div>
      </div>
    </div>`).join('');
  const rec = sailings.find(x=>x.is_recommended);
  if(rec){ $('recBar').classList.remove('hidden');
    $('recBar').innerHTML = `Sanlyn 推荐 <b>${esc(rec.carrier)} ${fmt(rec.etd)}</b> — 综合船期与价格最优。报价 48 小时内有效。`; }
}

function saveNotes(){
  clearTimeout(noteTimer);
  noteTimer = setTimeout(async ()=>{
    try{
      const r = await fetch(`${API}/customer-notes`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token,notes})});
      if(r.ok){ const d=$('syncDot'); d.classList.remove('hidden'); setTimeout(()=>d.classList.add('hidden'),2000); }
    }catch(e){}
  }, 800);
}

function renderCargo(){
  const orders = Array.isArray(sheet.orders)?sheet.orders:[];
  if(!orders.some(o=>(o.items||[]).length)) return;
  $('cargoCard').style.display='block';
  const saved = sheet.customer_item_notes || {};
  let gSeq = 0, html = '';
  orders.forEach(o=>{
    const its = o.items||[];
    if(!its.length) return;
    const dgBadge = o.export_mode==='daigou' ? ' <span style="background:#f3e8ff;color:#7c3aed;border:1px solid #ddd6fe;border-radius:4px;padding:1px 7px;font-size:10px;">DAIGOU · Buying Agent</span>' : '';
    const liveC = Array.isArray(sheet.containers_live)?sheet.containers_live:[];
    const myC = liveC.filter(x=>(x.cargo||[]).some(g=>g.order_no===o.order_no));
    const cntrTag = myC.length
      ? myC.map(x=>`<span style="color:#475569;font-weight:600;">　柜 ${esc(x.container_no||'')}${x.seal_no?' · 封 '+esc(x.seal_no):''}${x.container_type?' · '+esc(x.container_type):''}</span>`).join('')
      : ' <span style="color:#9ca3af;font-weight:400;font-size:10px;">　柜待装柜绑定</span>';
    html += `<tr><td colspan="7" style="background:#f1f5f9;font-weight:800;font-size:11px;color:#334155;padding:6px 10px;">ORDER ${esc((o.order_no||'').replace(/^\d+-/,''))}　·　${esc(o.contract_no||'')}${dgBadge}${cntrTag}</td></tr>`;
    its.forEach((it,i)=>{
      let bc = it.barcode;
      if(!bc){ gSeq++; bc = 'G-'+String(gSeq).padStart(4,'0'); }
      const key = it.barcode || it.sku || (o.order_no+'_'+i);
      if(saved[key]) notes[key]=saved[key];
      const feKey = it.barcode||it.sku||key;
      const feChecked = !!(window._feLines && window._feLines[feKey]);
      const nameLine = esc(it.product_name||it.description||'—') + (it.size?`<div style="font-size:10px;color:#9ca3af;">${esc(it.size)}</div>`:'');
      html += `<tr>
        <td style="font-weight:700;${it.barcode?'':'color:#b45309;'}" ${it.barcode?'':'title="无条形码·代购特殊条码"'}>${esc(bc)}</td>
        <td>${nameLine}</td>
        <td style="font-family:monospace;">${esc(it.hs_code||'—')}</td>
        <td style="text-align:center;"><input type="checkbox" class="fe-ck" data-fekey="${esc(feKey)}" data-hs="${esc(it.hs_code||'')}" ${feChecked?'checked':''} ${sheet.is_daigou?'checked disabled':''} style="width:15px;height:15px;cursor:pointer;accent-color:#1a73e8;"></td>
        <td>${esc(it.ctns||'—')}</td>
        <td>${esc(it.gw_kgs||'—')}</td>
        <td><input class="note-in ${saved[key]?'saved':''}" data-key="${esc(key)}"
          value="${esc(saved[key]||'')}" placeholder="如需改品名/HS/标签请说明"></td>
      </tr>`;
    });
  });
  $('cargoBody').innerHTML = html;
  document.querySelectorAll('.note-in').forEach(inp=>{
    inp.addEventListener('input',()=>{ notes[inp.dataset.key]=inp.value; saveNotes(); });
  });
  document.querySelectorAll('.fe-ck').forEach(ck=>{
    ck.addEventListener('change',()=>{
      window._feLines = window._feLines || {};
      const hs = ck.dataset.hs;
      // 同 HS 联动：一票 FE 按品类报，勾一行=同 HS 全勾
      const group = hs ? [...document.querySelectorAll(`.fe-ck[data-hs="${hs}"]`)] : [ck];
      group.forEach(x=>{ if(!x.disabled){ x.checked = ck.checked; } window._feLines[x.dataset.fekey] = ck.checked; });
      clearTimeout(window._feTimer);
      window._feTimer = setTimeout(saveFELines, 600);
    });
  });
}
async function saveFELines(){
  const lines = window._feLines || {};
  const any = Object.values(lines).some(Boolean);
  try{
    const r = await fetch(`${API}/customer-notes`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token, fe_request: any, fe_lines: any ? lines : null})});
    const d = await r.json();
    if(!r.ok||!d.ok){ alert(d.error||'FE 保存失败'); return; }
    window._feState = any; sheet.fe_cert = d.fe_cert;
    renderPrice(); if(window.renderFE) renderFE();
  }catch(e){}
}
// ── BL 草稿确认 ──────────────────────────────────────────────────────
window._blFields = [];
window.addBLField = function(){
  const idx = window._blFields.length;
  window._blFields.push({k:'',v:''});
  const row = document.createElement('div');
  row.id = `blf_${idx}`;
  row.style.cssText = 'display:flex;gap:6px;margin-top:6px;';
  row.innerHTML = `<input placeholder="字段名" style="flex:1;border:1px solid #e0e4ea;border-radius:6px;padding:5px 8px;font-size:12px;" oninput="window._blFields[${idx}].k=this.value">
    <input placeholder="内容" style="flex:2;border:1px solid #e0e4ea;border-radius:6px;padding:5px 8px;font-size:12px;" oninput="window._blFields[${idx}].v=this.value">
    <button onclick="document.getElementById('blf_${idx}').remove();window._blFields[${idx}]={k:'',v:''}" style="background:none;border:none;color:#9ca3af;font-size:14px;cursor:pointer;">✕</button>`;
  const holder = $('blChangeFields');   // 2026-07-23 判空：该容器当前 HTML 里不存在
  if (holder) holder.appendChild(row);
};
window.submitBLConfirm = async function(isOk){
  const btn = $(isOk ? 'blOkBtn' : 'blChgSubmitBtn');
  if(btn) btn.disabled = true;
  const payload = {token, bl_draft_status: isOk ? 'confirmed' : 'change_requested'};
  if(!isOk){
    payload.bl_draft_note = ($('blChangeNote')||{}).value || '';
    payload.bl_draft_fields = window._blFields.filter(f=>f.k||f.v);
  }
  try{
    const r = await fetch(`${API}/customer-notes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const d = await r.json();
    if(!r.ok||!d.ok){ alert(d.error||'提交失败'); if(btn) btn.disabled=false; return; }
    sheet.bl_draft_status = payload.bl_draft_status;
    sheet.bl_draft_confirmed_at = new Date().toISOString();
    renderBLDraft();
  }catch(e){ alert('网络错误'); if(btn) btn.disabled=false; }
};
// 电放确认（BL确认后 release_type=电放 时出现）
window.confirmTelex = async function(){
  const btn = $('telexBtn');
  if(btn) btn.disabled = true;
  try{
    const r = await fetch(`${API}/confirm-telex`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})});
    const d = await r.json();
    if(!r.ok||!d.ok){ alert(d.error||'操作失败'); if(btn) btn.disabled=false; return; }
    sheet.telex_released_at = d.telex_released_at || new Date().toISOString();
    renderBLDraft();
  }catch(e){ alert('网络错误'); if(btn) btn.disabled=false; }
};
// 保存邮寄地址
window.saveMailingAddress = async function(){
  const val = ($('mailingInput')||{}).value||'';
  if(!val.trim()){ alert('请填写邮寄地址'); return; }
  const btn = $('mailingBtn');
  if(btn) btn.disabled = true;
  try{
    const r = await fetch(`${API}/customer-notes`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token, mailing_address: val})});
    const d = await r.json();
    if(!r.ok||!d.ok){ alert(d.error||'保存失败'); if(btn) btn.disabled=false; return; }
    sheet.mailing_address = val;
    renderBLDraft();
  }catch(e){ alert('网络错误'); if(btn) btn.disabled=false; }
};
window.renderBLDraft = function(){
  const card = $('blDraftCard');
  if(!card) return;
  // BL草稿文件：supplier_portal上传，排除非危/电放保函/MSDS/SO等非BL文档
  const uploads = (Array.isArray(sheet.collab_uploads) ? sheet.collab_uploads : [])
    .filter(u => u && u.role === 'supplier_portal'
      && !/非危|nondg|telex|电放保函|msds|鉴定|排载|\bso\b|入货/i.test(u.filename||''));
  // 货代已上传BL草稿即显示（bl_no 可以之后补）
  if(!uploads.length){ card.style.display='none'; return; }
  card.style.display = '';
  const st = sheet.bl_no ? sheet.bl_draft_status : null;
  const rel = sheet.release_type || '';
  const statusHtml = !sheet.bl_no
    ? `<span style="background:#f3f4f6;color:#6b7280;border-radius:20px;padding:3px 12px;font-size:11px;font-weight:800;">📄 待出单号</span>`
    : !st
    ? `<span style="background:#fef9c3;color:#a16207;border-radius:20px;padding:3px 12px;font-size:11px;font-weight:800;">⏳ 待确认</span>`
    : st==='confirmed'
    ? `<span style="background:#dcfce7;color:#15803d;border-radius:20px;padding:3px 12px;font-size:11px;font-weight:800;">✓ 已确认</span>`
    : `<span style="background:#fee2e2;color:#b91c1c;border-radius:20px;padding:3px 12px;font-size:11px;font-weight:800;">✏️ 修改中</span>`;
  function _filePreviewHtml(u){
    const url = `${API}/file?token=${encodeURIComponent(token)}&type=upload&filename=${encodeURIComponent(u.filename)}`;
    const isImg = /^image\//i.test(u.mime||'');
    const isPdf = (u.mime||'').includes('pdf') || /\.pdf$/i.test(u.filename||'');
    if(isImg) return `<img src="${url}" alt="${esc(u.filename)}" style="width:100%;border-radius:8px;display:block;margin-bottom:8px;" loading="lazy">`;
    if(isPdf) return `<iframe src="${url}" style="width:100%;height:480px;border:none;border-radius:8px;display:block;margin-bottom:8px;" title="${esc(u.filename)}"></iframe>`;
    return `<a href="${url}" target="_blank" style="display:flex;align-items:center;gap:8px;border:1px solid #e0e4ea;border-radius:8px;padding:8px 12px;margin-bottom:6px;text-decoration:none;color:#111827;font-size:12px;">📄 <span style="flex:1;">${esc(u.filename)}</span><span style="color:#1a73e8;font-size:11px;">下载 ↗</span></a>`;
  }
  const uploadsHtml = uploads.length
    ? uploads.map(u => _filePreviewHtml(u)).join('')
    : `<div style="color:#9ca3af;font-size:12px;text-align:center;padding:20px 0;">货代尚未上传 BL 草稿</div>`;
  let actionsHtml = '';
  if(!st && sheet.bl_no){
    actionsHtml = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;">
        <button id="blOkBtn" onclick="submitBLConfirm(true)" style="flex:1;padding:10px 0;border-radius:8px;border:none;background:#059669;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">✅ 确认无误 Confirm BL</button>
        <button onclick="const f=$('blChangeForm');f.style.display=f.style.display==='none'?'':'none'" style="flex:1;padding:10px 0;border-radius:8px;border:1.5px solid #d97706;background:#fff;color:#d97706;font-size:13px;font-weight:700;cursor:pointer;">✏️ 有误 / 需修改</button>
      </div>
      <div id="blChangeForm" style="display:none;margin-top:10px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px;">
        <div style="font-size:12px;font-weight:700;color:#92400e;margin-bottom:6px;">请填写需要修改的内容：</div>
        <textarea id="blChangeNote" rows="3" placeholder="总体说明（如：收货人地址有误）" style="width:100%;border:1px solid #fde68a;border-radius:6px;padding:8px;font-size:12px;font-family:inherit;outline:none;resize:vertical;"></textarea>
        <div id="blChangeFields"></div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
          <button onclick="addBLField()" style="background:none;border:1.5px dashed #d97706;border-radius:6px;padding:4px 12px;font-size:12px;color:#d97706;cursor:pointer;">＋ 添加字段</button>
          <button id="blChgSubmitBtn" onclick="submitBLConfirm(false)" style="padding:8px 20px;border-radius:8px;border:none;background:#d97706;color:#fff;font-size:12px;font-weight:700;cursor:pointer;">提交修改请求</button>
        </div>
      </div>`;
  } else if(st==='confirmed'){
    const ts = sheet.bl_draft_confirmed_at ? ` · ${fmt(sheet.bl_draft_confirmed_at)}` : '';
    // 电放：确认BL后显示电放确认按钮
    let postConfirm = '';
    if(rel==='电放'){
      postConfirm = sheet.telex_released_at
        ? `<div style="margin-top:8px;background:#f0fdf4;border:1.5px solid #a7f3d0;border-radius:8px;padding:8px 12px;font-size:12px;color:#047857;font-weight:700;">⚡ 电放已确认 ${fmt(sheet.telex_released_at)}</div>`
        : `<button id="telexBtn" onclick="confirmTelex()" style="width:100%;margin-top:8px;padding:10px 0;border-radius:8px;border:none;background:#7c3aed;color:#fff;font-size:13px;font-weight:700;cursor:pointer;">⚡ 确认电放放单 Surrender BL</button>`;
    }
    // 正本：显示邮寄地址表单
    if(rel==='正本'){
      postConfirm = sheet.mailing_address
        ? `<div style="margin-top:8px;background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:8px;padding:8px 12px;font-size:12px;color:#1d4ed8;">📮 邮寄地址：${esc(sheet.mailing_address)}</div>`
        : `<div style="margin-top:8px;background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:10px 12px;">
            <div style="font-size:12px;font-weight:700;color:#1d4ed8;margin-bottom:6px;">📮 正本提单 — 请提供邮寄地址</div>
            <textarea id="mailingInput" rows="3" placeholder="收件人 / 公司名 / 地址 / 电话" style="width:100%;border:1px solid #bfdbfe;border-radius:6px;padding:7px;font-size:12px;font-family:inherit;outline:none;resize:vertical;"></textarea>
            <button id="mailingBtn" onclick="saveMailingAddress()" style="margin-top:6px;padding:7px 20px;border-radius:8px;border:none;background:#1d4ed8;color:#fff;font-size:12px;font-weight:700;cursor:pointer;">保存地址</button>
          </div>`;
    }
    actionsHtml = `<div style="margin-top:10px;background:#f0fdf4;border:1.5px solid #a7f3d0;border-radius:8px;padding:10px 14px;font-size:12px;color:#047857;font-weight:700;">✅ 您已确认此提单草稿${ts}</div>${postConfirm}`;
  } else {
    const ts = sheet.bl_draft_confirmed_at ? ` · ${fmt(sheet.bl_draft_confirmed_at)}` : '';
    actionsHtml = `<div style="margin-top:10px;background:#fef2f2;border:1.5px solid #fca5a5;border-radius:8px;padding:10px 14px;font-size:12px;color:#b91c1c;font-weight:700;">✏️ 您的修改请求已提交${ts}，Sanlyn 将与您确认</div>`;
  }
  $('blDraftBox').innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
      <div style="font-size:12px;color:#6b7280;">${sheet.bl_no ? `BL No. <b style="color:#1a1d23;">${esc(sheet.bl_no)}</b>` : '<span style="color:#9ca3af;">提单号待货代填写</span>'}</div>
      ${statusHtml}
    </div>
    ${uploadsHtml}
    ${actionsHtml}`;
};
