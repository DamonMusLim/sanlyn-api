function enPart(v){
  const t = String(v == null ? "" : v).trim();
  if (!t) return "";
  const m = t.match(/[A-Za-z][A-Za-z0-9 ,.'()\/-]{2,}/);
  return m ? m[0].trim() : t;
}
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

  $('shipSub').textContent = [sheet.shipment_no, (sheet.pol&&sheet.pod)?`${enPart(sheet.pol)} → ${enPart(sheet.pod)}`:null,
    sheet.etd?('ETD '+fmt(sheet.etd)):null].filter(Boolean).join(' · ');
  const orders = Array.isArray(sheet.orders)?sheet.orders:[];
  const orderNos = orders.map(o=>o.order_no).filter(Boolean).join(' / ');
  const items = orders.flatMap(o=>o.items||[]);
  const ctns = sheet.total_cartons || items.reduce((s,x)=>s+(Number(x.ctns)||0),0) || null;
  const gw = sheet.gross_weight_kg || items.reduce((s,x)=>s+(Number(x.gw_kgs)||0),0) || null;
  const kvs = [
    ['Orders', orderNos||'—', ''],
    ['Factory Ready', (()=>{
      const fp = window.__fp;
      if(fp && fp.total > 1){
        const done = fp.submitted >= fp.total;
        return (done?'Confirmed ':'In progress ') + fp.submitted + '/' + fp.total
          + (done?(' — '+fmt(sheet.factory_cargo_ready)):'');
      }
      return sheet.factory_submitted?('Confirmed — '+fmt(sheet.factory_cargo_ready)):'Pending factory confirmation';
    })(), (window.__fp ? (window.__fp.submitted>=window.__fp.total?'green':'') : (sheet.factory_submitted?'green':''))],
    ['Cargo', [ctns?ctns.toLocaleString()+' CTNS':null, gw?Number(gw).toLocaleString()+' KGS':null,
      sheet.total_cbm?(Math.round(Number(sheet.total_cbm)*1000)/1000)+' CBM':null].filter(Boolean).join(' · ')||'—',''],
    ['Container', (sheet.container_type||'—')+(sheet.container_qty?' × '+sheet.container_qty:''),''],
  ];
  $('kvBox').innerHTML = kvs.map(k=>`<div class="kv"><span class="k">${k[0]}</span><span class="v ${k[2]}">${esc(k[1])}</span></div>`).join('');

  window._feLines = (sheet.fe_cert && sheet.fe_cert.lines) || {};
  renderCargo();
  if(window.renderJourney) window.renderJourney();
  window.renderTT = function(){
    $('ttRowC').innerHTML = '';
  };
  renderTT();
  window.renderPrice = function(){
    const rows = [];
    if (sheet.so_no || sheet.bl_no) {
      rows.push(`<div class="bill"><span class="pill ok">Booked</span><span style="flex:1;"></span><button class="bdl" onclick="window.toggleSail&&toggleSail()">Change sailing</button></div>`);
    }
    renderBillingEntry(window._billing||{});
    if(rows.length) $('priceBox').insertAdjacentHTML('afterbegin', rows.join(''));
  };
  renderPrice();
  if(window.loadBLDraft) window.loadBLDraft();
  (function(){
    const live = [];
    if(!live.length) return;
    $('cntrCard').style.display='block';
    $('cntrCount').textContent = live.length+' containers';
    $('cntrBox').innerHTML = live.map((x,i)=>{
      const ordersX = Array.isArray(sheet.orders)?sheet.orders:[];
      const pos = (x.cargo||[]).map(g=>{
        const po = String(g.order_no||'').replace(/^\d+-/,'');
        const od = ordersX.find(o=>o.order_no===g.order_no);
        return po + (od&&od.export_mode==='daigou' ? ' <span class="pill brand" style="font-size:10px;">DAIGOU</span>' : '');
      }).filter(Boolean).join('+');
      return `
      <div style="display:grid;grid-template-columns:1.4fr 1.1fr 0.7fr 1fr;gap:6px 12px;border:1px solid var(--line);border-radius:8px;padding:7px 12px;margin-top:6px;font-size:11px;">
        <div><span style="color:var(--faint);">Container ${i+1}</span> <b>${esc(x.container_no||'—')}</b>${pos?` <span style="color:var(--brand-ink);font-weight:700;">· ${esc(pos)}</span>`:''}</div>
        <div><span style="color:var(--faint);">Seal</span> <b>${esc(x.seal_no||'—')}</b></div>
        <div><b>${esc(x.container_type||'—')}</b></div>
        <div style="color:var(--faint);">${pos?'':'PO pending'}</div>
      </div>`;}).join('');
  })();
  window._feState = (sheet.fe_cert && sheet.fe_cert.requested) ? true : false;
  window.renderFE = function(){
    const btn = $('feBtn');
    const must = $('feMust');
    if (sheet.is_daigou && must) must.classList.remove('hidden');
    if (!btn) return;
    if (window._feState) {
      btn.textContent = sheet.is_daigou ? 'Enabled (required)' : 'Requested · click to cancel';
      btn.style.background = 'var(--ok-soft)'; btn.style.borderColor = 'var(--ok)'; btn.style.color = 'var(--ok)';
      if (sheet.is_daigou) { btn.style.cursor = 'default'; btn.onclick = null; }
    } else {
      btn.textContent = 'Request FE'; btn.style.background = 'var(--card)'; btn.style.borderColor = 'var(--brand)'; btn.style.color = 'var(--brand)';
    }
  };
  window.toggleFE = async function(){
    const want = !window._feState;
    document.querySelectorAll('.fe-ck').forEach(ck=>{ if(!ck.disabled) ck.checked = want; window._feLines = window._feLines||{}; window._feLines[ck.dataset.fekey]=want; });
    if (document.querySelectorAll('.fe-ck').length) { await saveFELines(); return; }
    try{
      const r = await fetch(`${API}/customer-notes`,{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token, fe_request: want})});
      const d = await r.json();
      if(!r.ok||!d.ok){ alert(d.error||'Operation failed'); return; }
      window._feState = want; sheet.fe_cert = d.fe_cert;
      renderPrice(); renderFE();
    }catch(e){ alert('Network error'); }
  };
  renderFE();
  if (sheet.is_daigou && !window._feState) { window.toggleFE(); }
  (function(){
    const orders0 = Array.isArray(sheet.orders)?sheet.orders:[];
    const f = (orders0.find(o=>o.order_no)||{}).order_no;
    $('dlPack').href = `${API}/file?token=${encodeURIComponent(token)}&type=pack&aud=customer`;
  })();
  (function(){
    if(!sheet.customer_selected_sailing) return;
    const cs = typeof sheet.customer_selected_sailing==='string'?(()=>{try{return JSON.parse(sheet.customer_selected_sailing)}catch(e){return null}})():sheet.customer_selected_sailing;
    if(!cs||!cs.vessel) return;
    const bar = document.createElement('div');
    bar.style.cssText='background:var(--brand-soft);border:1.5px solid var(--line);border-radius:10px;padding:10px 16px;margin-bottom:12px;font-size:13px;';
    bar.innerHTML = `<b>Selected sailing saved.</b> <span style="color:var(--faint);font-size:11px;margin-left:8px;">Changing to another sailing may incur amendment fees.</span>`;
    const shell = document.querySelector('.shell');
    shell.insertBefore(bar, shell.firstChild.nextSibling);
  })();
  renderSailings();
  if(window.renderCustomerInfo) renderCustomerInfo();
  if(window.renderCertificatesAndDownloads) renderCertificatesAndDownloads();
  if(confirmed && sheet.customer_selected_sailing){
    const cs = typeof sheet.customer_selected_sailing==='string'?JSON.parse(sheet.customer_selected_sailing):sheet.customer_selected_sailing;
    const idx = sailings.findIndex(x=>x.vessel===cs.vessel&&String(x.etd)===String(cs.etd));
    if(idx>=0){ selIdx=idx; setTimeout(()=>{ const el=$('sail_'+idx); if(el){el.classList.add('selected');el.querySelector('.sel-pill').classList.remove('hidden');} },0); }
    sheet.customer_selected_sailing = cs;
  }
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
  if(selIdx<0){ toast('Please select a sailing first.'); return; }
  const x = sailings[selIdx];
  const amendTip = window._isAmend ? '\nThis is an amendment and may incur amendment fees.' : '';
  if(!confirm(`Confirm booking: ${x.vessel||''} · ETD ${fmt(x.etd)}?\nSanlyn will lock this sailing after your confirmation.${amendTip}`)) return;
  $('btnConfirm').disabled = true;
  try{
    const r = await fetch(`${API}/customer-submit`,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({token,selected_sailing:x,reference_no:null,remarks:null})});
    const d = await r.json();
    $('btnConfirm').disabled = false;
    if(!r.ok||!d.ok){ toast(d.error||'Submit failed'); return; }
    if(window._isAmend){
      sheet.customer_amend = { count: ((sheet.customer_amend&&Number(sheet.customer_amend.count))||0) + 1 };
      window._isAmend = false;
      const n=$('amendNotice'); if(n) n.remove();
    }
    confirmed = true; sheet.customer_submitted = true;
    sheet.customer_submitted_at = new Date().toISOString();
    renderConfirmState();
    window.scrollTo({top:0,behavior:'smooth'});
  }catch(e){ $('btnConfirm').disabled=false; toast('Network error. Please try again.'); }
}

boot();
