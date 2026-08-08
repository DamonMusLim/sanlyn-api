const API = '/api/db/booking-collab';
const BL_API = API + '/bl-confirmation';
const token = new URLSearchParams(location.search).get('token') || '';
const $ = id => document.getElementById(id);
const show = id => { ['stateLoading','stateForm','stateDead'].forEach(s => $(s).classList.add('hidden')); $(id).classList.remove('hidden'); };
function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200); }
function esc(v){ return v==null?'':String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function fmtD(v){
  if(!v) return '';
  try{
    return new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',day:'2-digit',month:'short',year:'numeric'}).format(new Date(v));
  }catch(e){ return ''; }
}
function fmt(d){ return d?fmtD(d):'—'; }
function fmtDT(v){ return v ? `${fmtD(v)} (GMT+8)` : '—'; }
function fmtFeedDT(v){
  if(!v) return '';
  try{
    const parts = new Intl.DateTimeFormat('en-GB',{
      timeZone:'Asia/Shanghai',day:'2-digit',month:'short',year:'numeric',
      hour:'2-digit',minute:'2-digit',hour12:false
    }).formatToParts(new Date(v)).reduce((m,p)=>{ m[p.type]=p.value; return m; },{});
    return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} (GMT+8)`;
  }catch(e){ return ''; }
}
function numText(v){
  const n = Number(v);
  if(!Number.isFinite(n) || n === 0) return '';
  return n.toLocaleString('en-US',{maximumFractionDigits:3});
}
function moneyAmount(v, cur){
  const n = Number(v);
  if(!Number.isFinite(n)) return '';
  return (cur || 'USD') + ' ' + n.toLocaleString('en-US',{maximumFractionDigits:2});
}
function uniqueList(xs){
  const seen = new Set();
  return xs.map(x=>String(x||'').trim()).filter(x=>{
    if(!x || seen.has(x)) return false;
    seen.add(x);
    return true;
  });
}
function statusEn(v){
  const t = String(v||'').trim();
  const map = {
    '\u8fdb\u6e2f':'At origin port',
    '\u5728\u9014':'In transit',
    '\u5230\u6e2f':'Arrived'
  };
  return map[t] || t;
}
function renderJourney(){
  const card = $('journeyCard'), box = $('journeyBox');
  if(!card || !box) return;
  const startRaw = sheet.portun_atd || sheet.etd;
  const endRaw = sheet.portun_ata || sheet.eta;
  if(!sheet.etd || !sheet.eta || !startRaw || !endRaw){ card.style.display='none'; return; }
  const startMs = new Date(startRaw).getTime();
  const endMs = new Date(endRaw).getTime();
  if(!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs){ card.style.display='none'; return; }
  const pct = Math.max(0, Math.min(1, (Date.now() - startMs) / (endMs - startMs)));
  const x = Math.round((84 + pct * 472) * 10) / 10;
  const labelX = Math.max(156, Math.min(484, x));
  const pol = enPart(sheet.pol) || 'Origin';
  const pod = enPart(sheet.pod) || 'Destination';
  const status = statusEn(sheet.portun_status_cn) || (pct <= 0 ? 'At origin port' : (pct >= 1 ? 'Arrived' : 'In transit'));
  const startLabel = sheet.portun_atd ? 'Actual departure' : 'Estimated departure';
  const endLabel = sheet.portun_ata ? 'Actual arrival' : 'Estimated arrival';
  const feed = fmtFeedDT(sheet.portun_synced_at);
  $('journeySub').textContent = status;
  box.innerHTML = `
    <svg class="journey-svg" viewBox="0 0 640 154" role="img" aria-label="Shipment journey from ${esc(pol)} to ${esc(pod)}">
      <line class="journey-track" x1="84" y1="70" x2="556" y2="70"></line>
      <line class="journey-done" x1="84" y1="70" x2="${x}" y2="70"></line>
      <circle class="journey-point journey-start" cx="84" cy="70" r="9"></circle>
      <circle class="journey-point" cx="556" cy="70" r="9"></circle>
      <path class="journey-now" d="M ${x} 58 L ${x+12} 70 L ${x} 82 L ${x-12} 70 Z"></path>
      <text class="journey-port" x="84" y="32" text-anchor="middle">${esc(pol)}</text>
      <text class="journey-port" x="556" y="32" text-anchor="middle">${esc(pod)}</text>
      <text class="journey-label" x="84" y="108" text-anchor="middle">${esc(startLabel)}</text>
      <text class="journey-label" x="${labelX}" y="108" text-anchor="middle">${esc(status)}</text>
      <text class="journey-label" x="556" y="108" text-anchor="middle">${esc(endLabel)}</text>
      <text class="journey-date" x="84" y="132" text-anchor="middle">${fmtD(startRaw)}</text>
      <text class="journey-date" x="556" y="132" text-anchor="middle">${fmtD(endRaw)}</text>
    </svg>
    ${feed?`<div class="journey-feed">Carrier feed · updated ${esc(feed)}</div>`:''}`;
  card.style.display = '';
}
function openBillingInvoice(){
  if(!window._billingToken) return;
  window.open('/public/invoice-confirm-preview.html?token='+encodeURIComponent(window._billingToken), '_blank', 'noopener');
}
function renderBillingEntry(billing){
  const box=$('priceBox');
  if(!box) return;
  window._billingToken = '';
  const terms = ['FOB','EXW','FCA','CIF','CNF','DDP'];
  const term = String(sheet.incoterm || sheet.trade_term || sheet.price_term || '').toUpperCase();
  const amount = billing && billing.show_amount !== false
    ? (billing.customer_amount || billing.amount || billing.freight_amount || billing.total_amount || '')
    : '';
  const currency = (billing && (billing.currency || billing.customer_currency)) || sheet.freight_currency || 'USD';
  const quoted = amount !== '' && amount != null;
  box.innerHTML = `<div class="bill"><span class="bi">USD</span><div class="bt2"><b>Ocean freight</b><span>${quoted ? 'Quoted to you' : 'Not quoted yet'}</span></div><span class="fee-value">${quoted ? esc(moneyAmount(amount, currency)) : 'Not quoted yet'}</span></div>
    <div class="bill"><span class="bi">T&C</span><div class="bt2"><b>Trade term</b><span>FOB / EXW / FCA / CIF / CNF / DDP</span></div><select id="incotermSelect" class="bdl" onchange="sheet.incoterm=this.value">${terms.map(x=>`<option value="${x}" ${term===x?'selected':''}>${x}</option>`).join('')}</select></div>`;
}

function dataPick(obj, keys){
  for(const k of keys){ if(obj && obj[k] != null && String(obj[k]).trim()) return obj[k]; }
  return '';
}
function renderCustomerInfo(){
  const box = $('customerInfoBox'), det = $('customerInfoDetails');
  if(!box || !det) return;
  const d = window._blDraft || {};
  const src = {...sheet, ...(sheet.customer_profile || {}), ...(d.customer_profile || {})};
  const fields = [
    ['Consignee name', dataPick(src, ['consignee_name','consignee','customer_en','customer'])],
    ['Address', dataPick(src, ['consignee_address','customer_address','address'])],
    ['Tax ID', dataPick(src, ['tax_id','vat_no','tin','bin'])],
    ['Contact', dataPick(src, ['contact_person','contact','customer_contact'])],
    ['TT', dataPick(src, ['tt','tt_no','clearance_tt'])],
    ['IRC', dataPick(src, ['irc','irc_no'])],
    ['TIN', dataPick(src, ['tin'])],
    ['BIN', dataPick(src, ['bin'])]
  ];
  const missing = fields.filter(x=>!x[1]).map(x=>x[0]);
  box.innerHTML = fields.map(x=>`<div class="statbox ${x[1] ? '' : 'field-missing'}"><div class="k">${esc(x[0])}</div><div class="v">${esc(x[1] || 'Missing')}</div></div>`).join('');
  const text = missing.length ? missing.length + ' fields missing' : 'Verified';
  $('customerInfoSummary').textContent = text;
  $('customerInfoBadge').textContent = text;
  $('customerInfoBadge').className = missing.length ? 'pill wait' : 'pill ok';
  det.open = !!missing.length;
  const card = $('blDraftCard');
  if(card && !window._blDraft && (missing.length || fields.some(x=>x[1]))) card.style.display = '';
}
function customerFileUrl(type, filename){
  const qs = new URLSearchParams({ token, type });
  if(filename) qs.set('filename', filename);
  return `${API}/file?${qs.toString()}`;
}
function docBill(label, sub, type, filename){
  const url = customerFileUrl(type, filename);
  return `<a class="bill" href="${url}" target="_blank"><span class="bi">DOC</span><span class="bt2"><b>${esc(label)}</b><span>${esc(sub || '')}</span></span><span class="bdl">View</span><span class="bdl">Download</span></a>`;
}
function renderCertificatesAndDownloads(){
  const certBox = $('certBox'), dl = $('downloadBox'), all = $('dlAll');
  if(all) all.href = customerFileUrl('pack');
  const rows = [];
  const downloads = [docBill('Document pack', 'PL + SC + IV', 'pack')];
  if(window._blDraft) downloads.push(docBill('Bill of Lading draft', 'Current draft for confirmation', 'bl_draft'));
  downloads.push(docBill('Non-Dangerous Goods Declaration', 'Customer copy', 'nondg'));
  const certs = Array.isArray(sheet.certificates) ? sheet.certificates : [];
  certs.forEach(c=>{
    if(!c || !(c.file_type || c.file_id || c.filename || c.number || c.status)) return;
    const name = c.name || c.cert_type || c.type || 'Certificate';
    const sub = [c.number, c.status].filter(Boolean).join(' · ');
    rows.push(docBill(name, sub || 'Available', c.file_type || 'certificate', c.filename || c.file_id || ''));
    if(c.filename || c.file_id || c.file_type) downloads.push(docBill(name, sub || 'Available', c.file_type || 'certificate', c.filename || c.file_id || ''));
  });
  if(sheet.fe_cert && (sheet.fe_cert.requested || sheet.fe_cert.status || sheet.fe_cert.number)){
    rows.push(`<div class="bill"><span class="bi">FE</span><span class="bt2"><b>FE Certificate of Origin</b><span>${esc(sheet.fe_cert.number || sheet.fe_cert.status || 'Pending')}</span></span><span class="pill wait">${sheet.fe_cert.number ? 'Ready' : 'Pending'}</span></div>`);
  }
  if(certBox) certBox.innerHTML = rows.length ? rows.join('') : '<div class="bill"><span class="bi">OK</span><span class="bt2"><b>Certificates</b><span>Not required</span></span><span class="pill ok">OK</span></div>';
  if(dl) dl.innerHTML = downloads.join('');
}

let sheet = {}, sailings = [], selIdx = -1, confirmed = false, noteTimer = null, notes = {};


function renderConfirmState(){
  if(confirmed){
    $('confirmedBanner').classList.remove('hidden');
    $('confirmedText').textContent = 'Booking confirmed';
    $('confirmedSub').textContent = (sheet.customer_submitted_at?`Confirmed at ${fmtDT(sheet.customer_submitted_at)} · `:'') + 'Sanlyn has received your confirmation.';
    $('actionBadge').textContent='Confirmed'; $('actionBadge').className='badge badge-green';
    $('confirmZone').style.display='none';
    const ct=$('cargoTable'),cc=$('cargoChevron'),cs=$('cargoSub');
    if(ct){ct.style.display='none';} if(cc){cc.textContent='▸';} if(cs){cs.textContent='Click to expand details';}
  } else {
    $('confirmedBanner').classList.add('hidden');
    $('actionBadge').textContent='Action required'; $('actionBadge').className='badge badge-amber';
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
  if(window._isAmend){
    const cz=$('confirmZone');
    if(cz && !$('amendNotice')){
      const n=document.createElement('div'); n.id='amendNotice';
      n.style.cssText='margin:0 0 10px;padding:10px 14px;background:var(--wait-soft);border:1px solid var(--line);border-left:4px solid var(--wait);border-radius:6px;font-size:12px;color:var(--wait);';
      const cnt=(sheet.customer_amend&&sheet.customer_amend.count)?Number(sheet.customer_amend.count):0;
      n.innerHTML='<b>Amendment notice</b>: You have already confirmed a sailing. Submitting again will be treated as an amendment and may incur amendment fees.'+(cnt>0?`<span style="margin-left:6px;color:var(--wait);">Amendments submitted: ${cnt}</span>`:'');
      cz.insertBefore(n,cz.firstChild);
    }
  }
  toast('You can select another sailing and confirm again.');
}

function renderSailings(){
  $('sailCount').textContent = sailings.length + ' sailings';
  if(!sailings.length){
    if (sheet.so_no || sheet.bl_no) {
      $('sailCount').textContent = 'Booked';
      $('sailBox').innerHTML = `<div style="padding:14px 16px;font-size:13px;background:var(--ok-soft);border-radius:8px;margin:0 0 4px;">
        <b>Booked</b></div>`;
    }
    return;
  }
  $('sailBox').innerHTML = sailings.map((x,i)=>`
    <div class="sail" id="sail_${i}" onclick="pick(${i})">
      <div class="sail-top">
        <div>
          <span class="sail-main">${esc(x.vessel||'—')}</span>
          ${x.is_recommended?'<span class="rec-pill">Sanlyn preferred</span>':''}
          <div class="sail-vessel">${esc(x.vessel||'')} ${esc(x.voyage||'')}</div>
        </div>
        <span class="sel-pill hidden">✓ Selected</span>
      </div>
      <div class="sail-grid">
        <div class="sail-cell"><div class="l">ETD ${esc(sheet.pol||'')}</div><div class="d">${fmt(x.etd)}</div></div>
        <div class="sail-cell"><div class="l">ETA ${esc(sheet.pod||'')}</div><div class="d">${fmt(x.eta)}</div></div>
        <div class="sail-cell"><div class="l">Cut-off</div><div class="d red">${fmt(x.cutoff_date)}</div></div>
      </div>
    </div>`).join('');
  const rec = sailings.find(x=>x.is_recommended);
  if(rec){ $('recBar').classList.remove('hidden');
    $('recBar').innerHTML = `Sanlyn preferred sailing: <b>${fmt(rec.etd)}</b>.`; }
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
    const dgBadge = o.export_mode==='daigou' ? ' <span class="pill brand" style="font-size:10px;padding:1px 7px;">DAIGOU · Buying Agent</span>' : '';
    html += `<tr><td colspan="7" style="background:var(--row);font-weight:800;font-size:11px;color:var(--brand-ink);padding:6px 10px;">ORDER ${esc((o.order_no||'').replace(/^\d+-/,''))} · ${esc(o.contract_no||'')}${dgBadge}</td></tr>`;
    its.forEach((it,i)=>{
      let bc = it.barcode;
      if(!bc){ gSeq++; bc = 'G-'+String(gSeq).padStart(4,'0'); }
      const key = it.barcode || it.sku || (o.order_no+'_'+i);
      if(saved[key]) notes[key]=saved[key];
      const feKey = it.barcode||it.sku||key;
      const feChecked = !!(window._feLines && window._feLines[feKey]);
      const nameLine = esc(it.product_name||it.description||'—') + (it.size?`<div style="font-size:10px;color:var(--faint);">${esc(it.size)}</div>`:'');
      html += `<tr>
        <td style="font-weight:700;${it.barcode?'':'color:var(--wait);'}" ${it.barcode?'':'title="Temporary code"'}>${esc(bc)}</td>
        <td>${nameLine}</td>
        <td style="font-family:monospace;">${esc(it.hs_code||'—')}</td>
        <td style="text-align:center;"><input type="checkbox" class="fe-ck" data-fekey="${esc(feKey)}" data-hs="${esc(it.hs_code||'')}" ${feChecked?'checked':''} ${sheet.is_daigou?'checked disabled':''} style="width:15px;height:15px;cursor:pointer;accent-color:var(--brand);"></td>
        <td>${esc(it.ctns||'—')}</td>
        <td>${esc(it.gw_kgs||'—')}</td>
        <td><input class="note-in ${saved[key]?'saved':''}" data-key="${esc(key)}"
          value="${esc(saved[key]||'')}" placeholder="Tell us if description, HS, or marks need changes"></td>
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
      // Link FE checkboxes by HS code.
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
    if(!r.ok||!d.ok){ alert(d.error||'FE save failed'); return; }
    window._feState = any; sheet.fe_cert = d.fe_cert;
    renderPrice(); if(window.renderFE) renderFE();
  }catch(e){}
}
// BL draft confirmation.
window._blDraft = null;
window._blChanges = {};
function timeLeft(v){
  const ms = new Date(v).getTime() - Date.now();
  if(!Number.isFinite(ms) || ms <= 0) return 'deadline passed';
  const h = Math.floor(ms / 3600000), d = Math.floor(h / 24);
  return `${d} days ${h % 24} hours left`;
}
function blStatusText(st){
  if(st === 'customer_confirmed') return 'Confirmed';
  if(st === 'revision_requested') return 'Changes requested';
  if(st === 'auto_submitted') return 'Auto-submitted';
  return 'Awaiting confirmation';
}
function blCell(label, value){ return `<div class="bl-box"><div class="bl-lbl">${esc(label)}</div>${esc(value||'—')}</div>`; }
function blRows(rows, cols){
  return rows.length ? rows.map(r=>`<tr>${cols.map(c=>`<td>${esc(r[c]||'—')}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}">—</td></tr>`;
}
function blGoodsSummary(d){
  const lines = Array.isArray(d.goods) ? d.goods : [];
  const cartons = lines.reduce((s,x)=>s+(Number(x.cartons)||0),0);
  const weight = lines.reduce((s,x)=>s+(Number(x.gross_weight_kg)||0),0);
  const cbm = lines.reduce((s,x)=>s+(Number(x.cbm)||0),0);
  const descs = uniqueList(lines.map(x=>x.description));
  const hs = uniqueList(Array.isArray(d.hs_lines) ? d.hs_lines.map(x=>x.code) : []);
  let commodity = descs.length === 1 ? descs[0] : '';
  if(!commodity && descs.some(x=>/CAT\s+LITTER/i.test(x))) commodity = 'CAT LITTER';
  if(!commodity && descs.some(x=>/\bLITTER\b/i.test(x))) commodity = 'CAT LITTER';
  commodity = commodity || 'GOODS';
  return [{
    description: `${cartons ? numText(cartons) + ' CARTONS OF ' : ''}${commodity}`.trim(),
    package: cartons ? `${numText(cartons)} CTNS` : '',
    weight: weight ? `${numText(weight)} KGS` : '',
    cbm: cbm ? `${numText(cbm)} CBM` : '',
    hs: hs.join(' / ')
  }];
}
function renderBLCountdown(){
  const d = window._blDraft;
  const el = $('blCountdown');
  if(el && d) el.textContent = `Please confirm before ${fmtDT(d.deadline_at)} — ${timeLeft(d.deadline_at)}`;
}
window.loadBLDraft = async function(){
  try{
    const r = await fetch(`${BL_API}?token=${encodeURIComponent(token)}`);
    const d = await r.json();
    if(r.ok && d.ok){ window._blDraft = d.draft; renderBLDraft(); }
  }catch(e){}
  if(window.renderCustomerInfo) renderCustomerInfo();
  if(window.renderCertificatesAndDownloads) renderCertificatesAndDownloads();
};
window.renderBLDraft = function(){
  const card = $('blDraftCard'), d = window._blDraft;
  if(!card || !d || !d.deadline_at){ if(card) card.style.display='none'; return; }
  card.style.display = '';
  const locked = ['customer_confirmed','revision_requested','auto_submitted'].includes(d.status);
  const goods = blGoodsSummary(d);
  const cntrs = (d.containers||[]).map(x=>({container:x.container_no,type:x.type,seal:x.seal_no}));
  $('blDraftBox').innerHTML = `
    <div class="bl-alert">
      <div id="blCountdown" style="font-weight:900;"></div>
      <div>If we do not receive your reply before the deadline, this draft will be submitted as shown. Any later change may incur amendment fees.</div>
      <div style="margin-top:4px;font-weight:800;">Status: ${esc(blStatusText(d.status))} · Draft version ${esc(d.version)}</div>
    </div>
    <div class="bl-doc">
      <div class="bl-grid">
        ${blCell('Shipper', d.shipper)}
        ${blCell('Consignee', d.consignee)}
        ${blCell('Notify Party', d.notify)}
        ${blCell('Vessel / Voyage', d.vessel_voyage)}
        ${blCell('Port of Loading', d.pol)}
        ${blCell('Port of Discharge', d.pod)}
      </div>
      <div class="bl-lbl">Description of Goods</div>
      <table class="bl-table"><thead><tr><th>Description</th><th>Package</th><th>Gross Weight</th><th>Measurement</th><th>H.S. Code</th></tr></thead><tbody>${blRows(goods,['description','package','weight','cbm','hs'])}</tbody></table>
      <div class="muted" style="font-size:11px;margin-top:6px;">Itemised breakdown: see Cargo Description above.</div>
      <div class="bl-lbl" style="margin-top:10px;">Container & Seal</div>
      <table class="bl-table"><thead><tr><th>Container No.</th><th>Type</th><th>Seal No.</th></tr></thead><tbody>${blRows(cntrs,['container','type','seal'])}</tbody></table>
    </div>
    <div class="bl-actions">
      <button class="btn btn-green" id="blOkBtn" onclick="submitBLConfirm()" ${locked?'disabled':''}>Confirm — ready to submit</button>
      <button class="btn btn-outline" onclick="openBLChanges()" ${locked?'disabled':''}>Request changes</button>
    </div>`;
  renderBLCountdown();
  clearInterval(window._blTimer);
  window._blTimer = setInterval(renderBLCountdown, 60000);
};
window.submitBLConfirm = async function(){
  const btn = $('blOkBtn'); if(btn) btn.disabled = true;
  try{
    const r = await fetch(BL_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action:'confirm'})});
    const d = await r.json();
    if(!r.ok||!d.ok){ alert(d.error||'Submit failed'); if(btn) btn.disabled=false; return; }
    window._blDraft = d.draft; renderBLDraft();
  }catch(e){ alert('Network error'); if(btn) btn.disabled=false; }
};
window.toggleBLChange = function(id){
  const row = $(id); if(row) row.classList.toggle('open');
};
function changeRow(id, title, summary, body){
  return `<div class="chg-row" id="${id}"><button class="chg-sum" onclick="toggleBLChange('${id}')"><span>${esc(title)}</span><span class="muted">${esc(summary||'—')}</span></button><div class="chg-body">${body}</div></div>`;
}
window.openBLChanges = function(){
  const d = window._blDraft || {};
  const hs = (d.hs_lines||[]).map((x,i)=>`<div style="display:grid;grid-template-columns:1fr 1fr auto;gap:6px;margin-top:6px;"><input value="${esc(x.sku)}" data-hs-sku="${i}"><input value="${esc(x.code)}" data-hs-code="${i}"><button class="btn btn-outline" style="padding:6px 10px;" onclick="this.parentNode.remove()">Remove</button></div>`).join('');
  const clr = (d.clearance_fields||[]).map((x,i)=>`<label style="display:block;margin-top:8px;"><span class="bl-lbl">${esc(x.label)}</span><input data-clearance="${i}" data-clearance-label="${esc(x.label)}" value="${esc(x.value)}"></label>`).join('') || '<div class="muted">No destination-specific clearance fields are required for this shipment.</div>';
  $('blChangeRows').innerHTML =
    '<div class="sec-sub" style="margin-top:10px;font-weight:800;">Provided by you — we cannot verify</div>' +
    changeRow('chgConsignee','Consignee / Notify', [d.consignee,d.notify].filter(Boolean).join(' / '), `<textarea id="chgConsigneeText" rows="4">${esc(`Consignee:\n${d.consignee||''}\n\nNotify:\n${d.notify||''}`)}</textarea>`) +
    changeRow('chgHs','H.S. Code', (d.hs_lines||[]).map(x=>x.code).filter(Boolean).join(' & '), `<div id="hsRows">${hs}</div><button class="btn btn-outline" style="margin-top:8px;padding:7px 12px;" onclick="addHSLine()">Add H.S. Code</button><label style="display:block;margin-top:8px;"><select id="hsShow"><option value="yes" ${d.hs_show_on_bl!==false?'selected':''}>show on B/L</option><option value="no" ${d.hs_show_on_bl===false?'selected':''}>do not show on B/L</option></select></label><div class="muted" style="margin-top:8px;">Our China export declaration uses a separate code. A different code here does not affect shipment.</div>`) +
    changeRow('chgClearance','Clearance documents','Blank fields stay blank', `${clr}<div class="muted" style="margin-top:8px;">Blank fields will be submitted as blank. Adding them later may incur amendment fees.</div>`) +
    '<div class="sec-sub" style="margin-top:14px;font-weight:800;">Our data — tell us if anything looks wrong</div>' +
    changeRow('chgGoods','Goods / quantity / weight / measurement','Comment only', '<textarea id="chgGoodsText" rows="3" placeholder="Tell us what looks wrong."></textarea>') +
    changeRow('chgCntr','Container & seal','As per terminal record', '<div class="muted">As per the terminal record / carrier feed. Not amendable.</div><textarea id="chgCntrText" rows="3" placeholder="Tell us what looks wrong."></textarea>') +
    changeRow('chgSchedule','Schedule','As per carrier feed', '<div class="muted">As per the terminal record / carrier feed. Not amendable.</div><textarea id="chgScheduleText" rows="3" placeholder="Tell us what looks wrong."></textarea>');
  $('blChangeModal').classList.remove('hidden');
};
window.closeBLChanges = function(){ $('blChangeModal').classList.add('hidden'); };
window.addHSLine = function(){
  const div = document.createElement('div');
  div.style.cssText='display:grid;grid-template-columns:1fr 1fr auto;gap:6px;margin-top:6px;';
  div.innerHTML='<input placeholder="SKU / item"><input placeholder="H.S. Code"><button class="btn btn-outline" style="padding:6px 10px;" onclick="this.parentNode.remove()">Remove</button>';
  $('hsRows').appendChild(div);
};
window.submitBLChanges = async function(){
  const btn = $('blChgSubmitBtn'); if(btn) btn.disabled = true;
  const hs = [...$('hsRows').children].map(r=>({sku:(r.children[0]||{}).value||'',code:(r.children[1]||{}).value||''})).filter(x=>x.sku||x.code);
  const clearance = {}; document.querySelectorAll('[data-clearance]').forEach(x=>{ clearance[x.dataset.clearanceLabel]=x.value; });
  const changes = {
    consignee_notify: ($('chgConsigneeText')||{}).value || '',
    hs_lines: hs, hs_show_on_bl: ($('hsShow')||{}).value !== 'no',
    clearance_docs: clearance,
    goods_comment: ($('chgGoodsText')||{}).value || '',
    container_comment: ($('chgCntrText')||{}).value || '',
    schedule_comment: ($('chgScheduleText')||{}).value || '',
  };
  try{
    const r = await fetch(BL_API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action:'request_changes',changes})});
    const d = await r.json();
    if(!r.ok||!d.ok){ alert(d.error||'Submit failed'); if(btn) btn.disabled=false; return; }
    closeBLChanges(); window._blDraft = d.draft; renderBLDraft();
  }catch(e){ alert('Network error'); if(btn) btn.disabled=false; }
};
