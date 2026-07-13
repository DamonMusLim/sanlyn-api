async function boot(){
  if(!token){ show('stateDead'); return; }
  const r = await fetch(`${API}/validate?token=${encodeURIComponent(token)}`);
  const d = await r.json().catch(()=>({}));
  if(!d.valid || d.role!=='customer_booking'){ show('stateDead'); return; }
  sheet = d.booking_sheet || {};
  window._billing = d.billing || {};
  window.__fp = d.factory_progress || null;
  sailings = Array.isArray(sheet.sailings)?sheet.sailings:[];
  confirmed = !!sheet.customer_submitted;

  $('shipSub').textContent = [sheet.shipment_no, (sheet.pol&&sheet.pod)?`${sheet.pol} → ${sheet.pod}`:null,
    sheet.etd?('ETD '+fmt(sheet.etd)):null].filter(Boolean).join(' · ');
  const orders = Array.isArray(sheet.orders)?sheet.orders:[];
  const orderNos = orders.map(o=>o.order_no).filter(Boolean).join(' / ');
  const items = orders.flatMap(o=>o.items||[]);
  const ctns = sheet.total_cartons || items.reduce((s,x)=>s+(Number(x.ctns)||0),0) || null;
  const gw = sheet.gross_weight_kg || items.reduce((s,x)=>s+(Number(x.gw_kgs)||0),0) || null;
  const kvs = [
    ['订单 Orders', orderNos||'—', ''],
    ['工厂备货 Factory Ready', (()=>{
      const fp = window.__fp;
      if(fp && fp.total > 1){
        const done = fp.submitted >= fp.total;
        return (done?'已确认 ':'备货中 ') + fp.submitted + '/' + fp.total
          + (done?(' — '+fmt(sheet.factory_cargo_ready)):'');
      }
      return sheet.factory_submitted?('已确认 Confirmed — '+fmt(sheet.factory_cargo_ready)):'待工厂确认';
    })(), (window.__fp ? (window.__fp.submitted>=window.__fp.total?'green':'') : (sheet.factory_submitted?'green':''))],
    ['货物 Cargo', [ctns?ctns.toLocaleString()+' CTNS':null, gw?Number(gw).toLocaleString()+' KGS':null,
      sheet.total_cbm?Number(sheet.total_cbm)+' CBM':null].filter(Boolean).join(' · ')||'—',''],
    ['柜型 Container', (sheet.container_type||'—')+(sheet.container_qty?' × '+sheet.container_qty:''),''],
    ['条款 Incoterms', sheet.freight_term||'—',''],
  ];
  $('kvBox').innerHTML = kvs.map(k=>`<div class="kv"><span class="k">${k[0]}</span><span class="v ${k[2]}">${esc(k[1])}</span></div>`).join('');

  window._feLines = (sheet.fe_cert && sheet.fe_cert.lines) || {};
  renderCargo();
  // 条款选择（选了即存，customer-notes 端点已支持 freight_term）
  window.renderTT = function(){
    const TT = ['FOB','EXW','FCA','CIF','DDP','CNF/CFR'];
    const cur = sheet.freight_term || '';
    const curLabel = (cur==='CNF'||cur==='CFR') ? 'CNF/CFR' : cur;
    if (cur && !window._ttExpand) {
      $('ttRowC').innerHTML = `<div style="display:flex;align-items:center;gap:8px;">
        <div style="padding:5px 13px;border:1.5px solid #1a73e8;border-radius:8px;font-size:12px;font-weight:700;color:#1a73e8;background:#eff6ff;">${curLabel}</div>
        <span style="font-size:11px;color:#9ca3af;cursor:pointer;" onclick="window._ttExpand=true;renderTT();">✎ 改条款</span></div>`;
      return;
    }
    $('ttRowC').innerHTML = TT.map(t=>`<div class="tt-chip${(curLabel===t)?' on':''}" data-tt="${t}"
      style="padding:5px 13px;border:1.5px solid ${(curLabel===t)?'#1a73e8':'#e0e4ea'};border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;${(curLabel===t)?'color:#1a73e8;background:#eff6ff;':''}">${t}</div>`).join('');
    document.querySelectorAll('.tt-chip').forEach(ch=>ch.addEventListener('click', async ()=>{
      const v = ch.dataset.tt==='CNF/CFR'?'CNF':ch.dataset.tt;
      try{ await fetch(`${API}/customer-notes`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token,freight_term:v})}); sheet.freight_term=v; window._ttExpand=false; renderTT(); renderPrice(); }catch(e){}
    }));
  };
  renderTT();
  // 费用区：只提供账单入口，金额由账单页按 Lens 展示
  window.renderPrice = function(){
    const rows = [];
    if (sheet.so_no || sheet.bl_no) {
      const seg = [sheet.carrier_code, sheet.vessel, sheet.voyage].filter(Boolean).join(' · ');
      rows.push(`<div style="display:flex;justify-content:space-between;padding:3px 0;font-size:11px;background:#f0fdf4;border-radius:6px;padding:6px 10px;margin-bottom:4px;">
        <span>⛴️ 已订航班 <b>${esc(seg||'—')}</b>${sheet.etd?` · ETD ${fmt(sheet.etd)}`:''}</span>
        <span style="color:#047857;font-weight:700;">✓ 已订舱 <span style="color:#1a73e8;font-weight:600;cursor:pointer;margin-left:8px;" onclick="window.toggleSail&&toggleSail()">改航班 ▾</span></span></div>`);
    }
    renderBillingEntry(window._billing||{});
    if(rows.length) $('priceBox').insertAdjacentHTML('afterbegin', rows.join(''));
  };
  renderPrice();
  renderBLDraft();
  // 海运随附文件（非危险品声明 + 电放保函）
  (function(){
    const card = $('shippingDocsCard');
    const box = $('shippingDocsBox');
    if(!card||!box) return;
    const items = [];
    const dlLink = (icon, label, url) =>
      `<a href="${url}" target="_blank" style="display:flex;align-items:center;gap:10px;border:1.5px solid #e0e4ea;border-radius:10px;padding:11px 14px;text-decoration:none;color:#111827;font-size:13px;font-weight:700;">${icon} <span style="flex:1;">${label}</span><span style="color:#1a73e8;font-size:12px;">下载 ↗</span></a>`;
    items.push(dlLink('🛡️', '非危险品声明 / Non-Dangerous Goods Declaration', `${API}/file?token=${encodeURIComponent(token)}&type=nondg`));
    if((sheet.release_type||'')==='电放')
      items.push(dlLink('📠', '电放保函 / Telex Release Letter', `${API}/file?token=${encodeURIComponent(token)}&type=telex`));
    // uploaded signed copies from forwarder
    const signedUps = (Array.isArray(sheet.collab_uploads)?sheet.collab_uploads:[])
      .filter(u => u && /非危|nondg|telex|电放保函/i.test(u.filename||''));
    signedUps.forEach(u => {
      const url = `${API}/file?token=${encodeURIComponent(token)}&type=upload&filename=${encodeURIComponent(u.filename||'')}`;
      items.push(dlLink('📎', '盖章件 · '+esc(u.filename), url));
    });
    box.innerHTML = items.join('');
    card.style.display = '';
  })();
  // 柜明细（柜号/封号/柜型/车牌——无司机隐私）
  (function(){
    const live = [];
    if(!live.length) return;
    $('cntrCard').style.display='block';
    $('cntrCount').textContent = live.length+' 柜';
    $('cntrBox').innerHTML = live.map((x,i)=>{
      const ordersX = Array.isArray(sheet.orders)?sheet.orders:[];
      const pos = (x.cargo||[]).map(g=>{
        const po = String(g.order_no||'').replace(/^\d+-/,'');
        const od = ordersX.find(o=>o.order_no===g.order_no);
        return po + (od&&od.export_mode==='daigou' ? ' <span style="color:#7c3aed;font-size:10px;">DAIGOU</span>' : '');
      }).filter(Boolean).join('+');
      return `
      <div style="display:grid;grid-template-columns:1.4fr 1.1fr 0.7fr 1fr;gap:6px 12px;border:1px solid #f0f2f5;border-radius:8px;padding:7px 12px;margin-top:6px;font-size:11px;">
        <div><span style="color:#9ca3af;">柜${i+1}</span> <b>${esc(x.container_no||'—')}</b>${pos?` <span style="color:#1d4ed8;font-weight:700;">· ${esc(pos)}</span>`:''}</div>
        <div><span style="color:#9ca3af;">封号</span> <b>${esc(x.seal_no||'—')}</b></div>
        <div><b>${esc(x.container_type||'—')}</b></div>
        <div style="color:#9ca3af;">${pos?'':'PO 待装柜绑定'}</div>
      </div>`;}).join('');
  })();
  // FE 原产地证（代购单必办自动开通）
  window._feState = (sheet.fe_cert && sheet.fe_cert.requested) ? true : false;
  window.renderFE = function(){
    const btn = $('feBtn');
    if (sheet.is_daigou) $('feMust').classList.remove('hidden');
    if (window._feState) {
      btn.textContent = sheet.is_daigou ? '✓ 已开通（必办）' : '✓ 已申请 · 点击取消';
      btn.style.background = '#ecfdf5'; btn.style.borderColor = '#a7f3d0'; btn.style.color = '#047857';
      if (sheet.is_daigou) { btn.style.cursor = 'default'; btn.onclick = null; }
    } else {
      btn.textContent = '申请 FE'; btn.style.background = '#fff'; btn.style.borderColor = '#1a73e8'; btn.style.color = '#1a73e8';
    }
  };
  window.toggleFE = async function(){
    const want = !window._feState;
    // 与行勾联动：开=全行勾上，关=全清
    document.querySelectorAll('.fe-ck').forEach(ck=>{ if(!ck.disabled) ck.checked = want; window._feLines = window._feLines||{}; window._feLines[ck.dataset.fekey]=want; });
    if (document.querySelectorAll('.fe-ck').length) { await saveFELines(); return; }
    try{
      const r = await fetch(`${API}/customer-notes`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token, fe_request: want})});
      const d = await r.json();
      if(!r.ok||!d.ok){ alert(d.error||'操作失败'); return; }
      window._feState = want; sheet.fe_cert = d.fe_cert;
      renderPrice(); renderFE();
    }catch(e){ alert('网络错误'); }
  };
  renderFE();
  // 代购单：未开通则自动开通（必办）
  if (sheet.is_daigou && !window._feState) { window.toggleFE(); }
  // 客户资料合并版下载
  (function(){
    const orders0 = Array.isArray(sheet.orders)?sheet.orders:[];
    const f = (orders0.find(o=>o.order_no)||{}).order_no;
    $('dlPack').href = `${API}/file?token=${encodeURIComponent(token)}&type=pack&aud=customer`;
  })();
  // 已选班次置顶
  (function(){
    if(!sheet.customer_selected_sailing) return;
    const cs = typeof sheet.customer_selected_sailing==='string'?(()=>{try{return JSON.parse(sheet.customer_selected_sailing)}catch(e){return null}})():sheet.customer_selected_sailing;
    if(!cs||!cs.vessel) return;
    const bar = document.createElement('div');
    bar.style.cssText='background:#eff6ff;border:1.5px solid #bfdbfe;border-radius:10px;padding:10px 16px;margin-bottom:12px;font-size:13px;';
    bar.innerHTML = `⛴️ <b>已选班次：</b>${esc(cs.vessel)} ${esc(cs.voyage||'')} · ETD ${fmt(cs.etd)} <span style="color:#9ca3af;font-size:11px;margin-left:8px;">改其他航线将产生改舱/退仓费</span>`;
    const shell = document.querySelector('.shell');
    shell.insertBefore(bar, shell.firstChild.nextSibling);
  })();
  renderSailings();
  // 已确认过：预选她定的船
  if(confirmed && sheet.customer_selected_sailing){
    const cs = typeof sheet.customer_selected_sailing==='string'?JSON.parse(sheet.customer_selected_sailing):sheet.customer_selected_sailing;
    const idx = sailings.findIndex(x=>x.vessel===cs.vessel&&String(x.etd)===String(cs.etd));
    if(idx>=0){ selIdx=idx; setTimeout(()=>{ const el=$('sail_'+idx); if(el){el.classList.add('selected');el.querySelector('.sel-pill').classList.remove('hidden');} },0); }
    sheet.customer_selected_sailing = cs;
  }
  // 航班卡并入条款&费用卡：已订舱默认收起，「改航班」展开
  (function(){
    const sailCard = $('sailBox') && $('sailBox').closest('.card');
    const cz = $('confirmZone');
    if (!sailCard || !$('sailMerge')) return;
    $('sailMerge').appendChild(sailCard);
    if (cz) $('sailMerge').appendChild(cz);
    sailCard.style.margin = '0';
    const booked = !!(sheet.so_no || sheet.bl_no);
    window.toggleSail = function(){
      const on = sailCard.style.display === 'none';
      sailCard.style.display = on ? '' : 'none';
      if (cz) cz.style.display = on ? '' : 'none';
    };
    if (booked) { sailCard.style.display = 'none'; if (cz) cz.style.display = 'none'; }
  })();
  renderConfirmState();
  show('stateForm');
  if (d.is_admin) { const af = $('adminFinanceCard'); if(af) af.style.display=''; }
}

async function confirmBooking(){
  if(selIdx<0){ toast('请先点选一个航班'); return; }
  const x = sailings[selIdx];
  const amendTip = window._isAmend ? '\n⚠️ 本次为改单，船公司可能收取改单费（以账单为准）。' : '';
  if(!confirm(`确认订舱：${x.carrier} ${x.vessel||''} · ETD ${fmt(x.etd)}？\n确认后 Sanlyn 将锁定舱位。${amendTip}`)) return;
  $('btnConfirm').disabled = true;
  try{
    const r = await fetch(`${API}/customer-submit`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token,selected_sailing:x,reference_no:null,remarks:null})});
    const d = await r.json();
    $('btnConfirm').disabled = false;
    if(!r.ok||!d.ok){ toast(d.error||'提交失败'); return; }
    if(window._isAmend){
      sheet.customer_amend = { count: ((sheet.customer_amend&&Number(sheet.customer_amend.count))||0) + 1 };
      window._isAmend = false;
      const n=$('amendNotice'); if(n) n.remove();
    }
    confirmed = true; sheet.customer_submitted = true;
    sheet.customer_submitted_at = new Date().toISOString();
    renderConfirmState();
    window.scrollTo({top:0,behavior:'smooth'});
  }catch(e){ $('btnConfirm').disabled=false; toast('网络错误，请重试'); }
}

boot();
