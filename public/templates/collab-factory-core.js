const API = '/api/db/booking-collab';
const token = new URLSearchParams(location.search).get('token') || '';
const $ = id => document.getElementById(id);
const states = ['stateLoading','stateForm','stateDone','stateDead'];
const show = id => { states.forEach(s=>$(s).classList.add('hidden')); $(id).classList.remove('hidden'); };
function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2800); }
function gv(id){ return ($(id)?.value||'').trim(); }
function gn(id){ const v=parseFloat($(id)?.value); return isNaN(v)?null:v; }
function gi(id){ const v=parseInt($(id)?.value); return isNaN(v)?null:v; }
function esc(v){ return v==null?'':String(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;'); }
function fmtD(v){ if(!v) return ''; try{ return new Date(v).toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'}); }catch(e){ return String(v).slice(0,10); } }
function imgLightbox(url,isVideo){ const img=$('lbImg'),vid=$('lbVid'); if(isVideo){ img.style.display='none'; vid.src=url; vid.style.display='block'; } else { vid.style.display='none'; vid.removeAttribute('src'); img.src=url; img.style.display='block'; } $('lightbox').style.display='flex'; }
function openBillingInvoice(){
  if(!window._billingToken) return;
  window.open('/public/invoice-confirm-preview.html?token='+encodeURIComponent(window._billingToken), '_blank', 'noopener');
}
function renderMissingPrompt(summary){
  const list = (summary && Array.isArray(summary.missing_for_role)) ? summary.missing_for_role : [];
  const old = document.getElementById('missingPrompt'); if(old) old.remove();
  if(!list.length) return;
  const box = document.createElement('div');
  box.id = 'missingPrompt';
  box.style.cssText = 'margin-bottom:14px;padding:10px 14px;background:#fffbeb;border:1.5px solid #fbbf24;border-radius:8px;color:#92400e;font-size:12px;font-weight:700;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap;';
  box.innerHTML = '<span>待填</span>' + list.map(x=>'<span style="background:#fff7ed;border:1px solid #fed7aa;border-radius:999px;padding:2px 9px;">'+esc(x.label||x.field)+'</span>').join('');
  const shell = document.querySelector('.shell-narrow');
  if(shell) shell.insertBefore(box, shell.firstChild);
}
function isFactorySelf(v){ return ['factory','self'].includes(arrangeVal(v)); }
function factorySelfHandled(){ return isFactorySelf(sel.trk)||isFactorySelf(sel.cus); }
function filterFactoryBillingLines(lines){
  if(!Array.isArray(lines)) return lines;
  if(!factorySelfHandled()) return lines;
  return lines.filter(line=>{
    const text=String((line&&line.name)||(line&&line.item_name)||(line&&line.cost_category)||(line&&line.category)||'');
    return !/拖车|truck|trucking|报关|申报|customs|declaration/i.test(text);
  });
}
function renderBillingEntry(billing){
  const body=$('billingBody');
  if(!body) return;
  window._lastBilling=billing||{};
  const canOpen=!!(billing&&billing.token&&billing.show_amount!==false);
  const visibleLines=filterFactoryBillingLines((billing&&billing.lines)||(billing&&billing.bill_lines));
  if(billing&&Array.isArray(visibleLines)){ billing.lines=visibleLines; billing.bill_lines=visibleLines; }
  const selfHandled=factorySelfHandled();
  const billTitle=canOpen?(selfHandled?'本票港杂':'本票港杂/费用账单'):'暂无';
  const billHint=canOpen?(selfHandled?'工厂自理拖车/报关：本账单仅展示本票港杂':esc(billing.segment||'按当前权限展示')):'当前链接暂无可打开账单';
  window._billingToken=canOpen?billing.token:'';
  body.innerHTML='<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;background:#f8fafc;border:1px solid #e0e4ea;border-radius:8px;padding:10px 12px;">'
    +'<div><div style="font-size:13px;font-weight:800;color:#1a1d23;">费用 / 账单：'+billTitle+'</div>'
    +'<div style="font-size:11px;color:#6b7280;margin-top:2px;">'+billHint+'</div></div>'
    +(canOpen?'<button class="btn btn-blue btn-sm" onclick="openBillingInvoice()">打开账单 / 开票</button>':'')+'</div>';
}
function arrangeVal(v){ return v==='self'?'factory':v; }
function trkLabel(v){ const m={agent:'代拖',babi:'巴匕拖',factory:'自拖'}; return m[arrangeVal(v)]||''; }
function cusLabel(v){ const m={agent:'代报',babi:'巴匕报',factory:'自报'}; return m[arrangeVal(v)]||''; }

let sel = { ct:null, cgt:'普通货物', tt:null, trk:null, cus:null, bat:'no', wood:'no', fum:null };
let locked = { tt:false, trk:false, cus:false };
let editMode=false, groups=[], lineSeq=0, SCOPE=null, factoryProfileAddress=null;
window._uploadedPhotos={};  // groupKey -> [{url,filename,type}]
window._confirmedKeys=new Set();
window._collapsedKeys=new Set();
window._pendingConfirmKey=null;
window._pendingCargoEdit=null;

function collapseStep(n,summary){ const c=$('step'+n); c.classList.add('done'); c.classList.remove('required','alert'); $('sn'+n).classList.add('done'); $('sum'+n).textContent='✓ '+summary; const b=$('badge'+n); if(b) b.style.display='none'; }
function reopenStep(n){ $('step'+n).classList.remove('done'); $('sn'+n).classList.remove('done'); const b=$('badge'+n); if(b) b.style.display=''; }
function toggleStep(n){ if($('step'+n).classList.contains('done')) reopenStep(n); }
let t1,t3;
function checkStep1(immediate){
  clearTimeout(t1); if((!window._loading&&!gv('cargo_ready_date'))||!sel.ct||!sel.tt) return;
  if((sel.tt==='FOB'||sel.tt==='EXW')&&(!sel.trk||!sel.cus)) return;
  const fn=()=>{ let s=(window._loading?'装柜中':gv('cargo_ready_date'))+' · '+sel.ct+' · '+sel.tt; if(sel.tt==='FOB'||sel.tt==='EXW') s+=' · '+trkLabel(sel.trk)+cusLabel(sel.cus); collapseStep(1,s); };
  if(immediate) fn(); else t1=setTimeout(fn,600);
}
function checkStep3(immediate){
  clearTimeout(t3); if(sel.cgt!=='普通货物'||sel.bat==='yes'||(sel.wood==='yes'&&sel.fum!=='yes')) return;
  const fn=()=>{ let s='普通货物 · '+(sel.bat==='no'?'无电池液体':'')+' · '+(sel.wood==='no'?'无木包装':'木包装已熏蒸'); collapseStep(3,s.replace(' ·  · ',' · ')); };
  if(immediate) fn(); else t3=setTimeout(fn,600);
}
function bindTog(rowId,attr,key,onChange){
  $(rowId).addEventListener('click',e=>{ const el=e.target.closest('[data-'+attr+']'); if(!el) return; sel[key]=el.dataset[attr]; [...$(rowId).querySelectorAll('[data-'+attr+']')].forEach(t=>{ t.classList.remove('on-blue','on-green','on-red'); if(t===el) t.classList.add(attr==='cgt'?(el.dataset[attr]==='普通货物'?'on-green':el.dataset[attr]==='危险品'?'on-red':'on-blue'):'on-blue'); }); if(onChange) onChange(); });
}
bindTog('ctRow','ct','ct',()=>checkStep1());
bindTog('cgtRow','cgt','cgt',()=>checkStep3());
function bindSel(rowId,attr,key,cb){
  $(rowId).addEventListener('click',e=>{ const el=e.target.closest('[data-'+attr+']'); if(!el) return; if(locked[key]){ locked[key]=false; toast('此项对方已选过，您的修改提交后生效'); } sel[key]=el.dataset[attr]; [...$(rowId).querySelectorAll('[data-'+attr+']')].forEach(t=>{ t.classList.remove('on-blue','on-green','on-red'); if(t===el) t.classList.add('on-blue'); }); if(cb) cb(sel[key]); });
}
bindSel('ttRow','tt','tt',v=>{ $('fobSub').style.display=(v==='FOB'||v==='EXW')?'block':'none'; checkStep1(); schedTT(); });
bindSel('trkRow','trk','trk',()=>{selfNote();checkStep1();schedTT();});
bindSel('cusRow','cus','cus',()=>{selfNote();checkStep1();schedTT();});
let ttT; function schedTT(){ clearTimeout(ttT); ttT=setTimeout(collapseTradeTerms,500); }
function collapseTradeTerms(){ if(!sel.tt) return; if((sel.tt==='FOB'||sel.tt==='EXW')&&(!sel.trk||!sel.cus)) return; let s=sel.tt; if(sel.tt==='FOB'||sel.tt==='EXW') s+=' · '+trkLabel(sel.trk)+' · '+cusLabel(sel.cus); if($('ttSummaryText')) $('ttSummaryText').textContent=s; if($('ttEdit')) $('ttEdit').classList.add('hidden'); if($('ttSummary')) $('ttSummary').classList.remove('hidden'); }
function expandTradeTerms(){ if($('ttEdit'))$('ttEdit').classList.remove('hidden'); if($('ttSummary'))$('ttSummary').classList.add('hidden'); }
bindSel('batRow','bat','bat',v=>{ $('msdsNote').style.display=v==='yes'?'block':'none'; checkStep3(); });
bindSel('woodRow','wood','wood',v=>{ $('fumWrap').style.display=v==='yes'?'flex':'none'; if(v==='no'){sel.fum=null;$('fumNote').style.display='none';} checkStep3(); });
bindSel('fumRow','fum','fum',v=>{ $('fumNote').style.display=v==='no'?'block':'none'; checkStep3(); });
function selfNote(){
  const p=[];
  if(sel.trk==='babi') p.push('巴匕安排拖车请提供：车牌/进港预约/磅单');
  if(sel.cus==='babi') p.push('巴匕安排报关请提供：报关单/装箱单/发票');
  $('selfNote').textContent=p.join('　·　');
  $('selfNote').style.display=p.length?'block':'none';
  const st=$('arrangeStatus');
  if(st){
    const badge=t=>'<span class="badge badge-green">'+t+'：自理·已确认</span>';
    const bits=[];
    if(isFactorySelf(sel.trk)) bits.push(badge('车队'));
    if(isFactorySelf(sel.cus)) bits.push(badge('报关方'));
    st.innerHTML=bits.join('');
    st.style.display=bits.length?'flex':'none';
  }
  if(window._lastBilling) renderBillingEntry(window._lastBilling);
}
function preset(rowId,attr,val,cls){ const el=$(rowId).querySelector('[data-'+attr+'="'+val+'"]'); if(el) el.classList.add(cls||'on-blue'); }
function setTog(rowId,attr,val){ if(!val) return; const el=$(rowId).querySelector('[data-'+attr+'="'+val+'"]'); if(el) el.click(); }

function groupIsDG(seq){ return false; }
function groupShowWeights(g){ return groupIsDG(g.seq) || !(g.lines||[]).some(l=>Number(l.data&&l.data.nw_kg)>0 || Number(l.data&&l.data.gw_kg)>0); }
function numVal(v){ if(v==null||v==='') return 0; const n=Number(v); return isNaN(n)?0:n; }
function fmtCargoNum(v,digits){
  if(v==null||v==='') return '—';
  const n=Number(v);
  if(isNaN(n)) return esc(v);
  const opt=digits==null?{maximumFractionDigits:3}:{minimumFractionDigits:0,maximumFractionDigits:digits};
  return n.toLocaleString(undefined,opt);
}
function lineHtml(id,d={},sp,showWeights,gi_,li_){
  const txt=v=>v?esc(v):'<span style="color:#cbd5e1;">—</span>';
  return '<tr id="line_'+id+'">'+
    '<td class="td-name">'+(d.cargo_name?esc(d.cargo_name):'<span style="color:#cbd5e1;">未填写</span>')+'</td>'+
    '<td>'+txt(d.sku)+'</td>'+
    '<td>'+txt(d.barcode)+'</td>'+
    '<td>'+txt(d.size)+'</td>'+
    '<td class="td-num"><span class="cargo-val">'+fmtCargoNum(d.pkg_qty,0)+'</span></td>'+
    (showWeights?'<td class="td-num"><span class="cargo-val">'+fmtCargoNum(d.nw_kg,2)+'</span></td><td class="td-num"><span class="cargo-val">'+fmtCargoNum(d.gw_kg,2)+'</span></td><td class="td-num"><span class="cargo-val">'+fmtCargoNum(d.cbm_m3,3)+'</span></td>':'')+
    '<td class="td-act"><button type="button" class="btn btn-ghost btn-sm" style="padding:4px 7px;margin-right:4px;" onclick="openCargoEditModal('+gi_+','+li_+')">✏️ 改</button><span style="cursor:pointer;color:#dc2626;font-weight:800;" onclick="delLine('+id+')">×</span></td></tr>';
}
function addCtn(linesData,seq,factory){ const g={lines:[],seq:seq||(groups.length?Math.max(...groups.map(x=>x.seq))+1:1),factory:factory||null,key:'g'+(window._gkCounter=(window._gkCounter||0)+1)}; groups.push(g); if(window._doneSeqs&&window._doneSeqs.has(g.seq)){ window._confirmedKeys.add(g.key); window._collapsedKeys.add(g.key); } (linesData&&linesData.length?linesData:[{}]).forEach(d=>g.lines.push({id:lineSeq++,data:d})); renderGroups(); }
function addLine(gi_){ groups[gi_].lines.push({id:lineSeq++,data:{}}); renderGroups(); }
function delLine(id){ snapshot(); groups.forEach(g=>{ g.lines=g.lines.filter(l=>l.id!==id); }); groups=groups.filter(g=>g.lines.length); if(!groups.length) addCtn(); else renderGroups(); }
function delCtn(gi_){ snapshot(); groups.splice(gi_,1); if(!groups.length) addCtn(); else renderGroups(); }
function snapshot(){ groups.forEach(g=>g.lines.forEach(l=>{ l.data=l.data||{}; })); }

function openCargoEditModal(gi_,li_){
  const g=groups[gi_], l=g&&g.lines&&g.lines[li_]; if(!l) return;
  const d=l.data||{};
  const showWeights=groupShowWeights(g);
  window._pendingCargoEdit={gi:gi_,li:li_,showWeights:showWeights};
  const editVal=v=>v==null?'':v;
  const fld=(label,id,type,val,step)=>'<div class="form-field"><label class="form-label">'+label+'</label><input class="form-input" id="'+id+'" '+(type?'type="'+type+'"':'')+(step?' step="'+step+'"':'')+' value="'+esc(val)+'"></div>';
  const ro=(label,val)=>'<div class="form-field"><label class="form-label">'+label+'</label><input class="form-input" value="'+esc(val||'—')+'" disabled></div>';
  $('cargoEditBody').innerHTML=
    fld('品名','ce_cargo_name','text',editVal(d.cargo_name))+
    '<div class="grid2">'+
    ro('货号',d.sku)+
    ro('条码',d.barcode)+
    ro('规格',d.size)+
    fld('箱数','ce_pkg_qty','number',editVal(d.pkg_qty),'1')+
    (showWeights?fld('NW kg','ce_nw_kg','number',editVal(d.nw_kg),'0.01')+fld('GW kg','ce_gw_kg','number',editVal(d.gw_kg),'0.01')+fld('CBM','ce_cbm_m3','number',editVal(d.cbm_m3),'0.001'):'')+
    '</div>'+
    '<div style="display:flex;gap:10px;margin-top:14px;"><button class="btn btn-ghost" style="flex:1;" onclick="closeCargoEditModal()">取消</button><button class="btn btn-blue" style="flex:2;" onclick="requestCargoEditConfirm()">保存修改</button></div>';
  const m=$('cargoEditModal'); m.classList.remove('hidden'); m.style.display='flex';
}
function closeCargoEditModal(){ const m=$('cargoEditModal'); if(m){ m.classList.add('hidden'); m.style.display=''; } }
function requestCargoEditConfirm(){ const m=$('cargoConfirmModal'); if(m){ m.classList.remove('hidden'); m.style.display='flex'; } }
function closeCargoConfirmModal(){ const m=$('cargoConfirmModal'); if(m){ m.classList.add('hidden'); m.style.display=''; } }
function commitCargoEdit(){
  const p=window._pendingCargoEdit, g=p&&groups[p.gi], l=g&&g.lines&&g.lines[p.li]; if(!l) return;
  const d=l.data||{};
  d.cargo_name=gv('ce_cargo_name');
  d.pkg_qty=gi('ce_pkg_qty');
  if(p.showWeights){
    d.nw_kg=gn('ce_nw_kg');
    d.gw_kg=gn('ce_gw_kg');
    d.cbm_m3=gn('ce_cbm_m3');
  }
  delete d.price; delete d.price_type; delete d.tax_points;
  l.data=d;
  closeCargoConfirmModal();
  closeCargoEditModal();
  window._pendingCargoEdit=null;
  renderGroups();
  recalc();
}

function buildPhotoGrid(key,seq){
  const local=window._uploadedPhotos[key]||[];
  const cd=(window._cntrDetailBySeq&&window._cntrDetailBySeq[seq])||{};
  const mkUrl=r=>(typeof r==='string')?r:(API+'/file?token='+encodeURIComponent(token)+'&type=upload&ref='+encodeURIComponent(r.stored||''));
  const existing=[
    ...(cd.pickup_photos||[]).map(r=>({url:mkUrl(r),type:'image'})),
    ...(cd.pickup_videos||[]).map(r=>({url:mkUrl(r),type:'video'})),
  ];
  const all=[...existing,...local];
  const cells=all.map((p,i)=>{
    const isVid=p.type==='video';
    return '<div class="photo-cell" onclick="imgLightbox(\''+esc(p.url)+'\','+(isVid?'true':'false')+')">'+
      (isVid?'<video src="'+esc(p.url)+'" muted preload="metadata"></video><div class="play-ov">▶</div>':'<img src="'+esc(p.url)+'" alt="" loading="lazy">')+
      '<div class="del-btn" onclick="event.stopPropagation();removePhoto(\''+key+'\','+seq+','+i+')">×</div></div>';
  });
  cells.push('<div class="photo-cell add" onclick="pickPhoto(\''+key+'\','+seq+')" title="添加图片/视频"><div style="text-align:center;color:#94a3b8;font-size:9px;line-height:1.15;"><div style="font-size:18px;">＋</div>图/视频</div></div>');
  return '<div class="photo-grid">'+cells.join('')+'</div>';
}
function removePhoto(key,seq,idx){
  const cd=(window._cntrDetailBySeq&&window._cntrDetailBySeq[seq])||{};
  const existing=(cd.pickup_photos||[]);
  if(idx<existing.length){ toast('已上传文件请联系 Sanlyn 删除'); return; }
  const localIdx=idx-existing.length;
  window._uploadedPhotos[key]=(window._uploadedPhotos[key]||[]).filter((_,i)=>i!==localIdx);
  renderGroups();
}

function renderGroups(){
  const facColorPalette=['#1d4ed8','#059669','#b45309','#7c3aed','#b91c1c','#0891b2'];
  const allFacs=[...new Set(groups.map(g=>g.factory).filter(Boolean))];
  $('ctnGroups').innerHTML = groups.map((g,gi_)=>{
    const cd=(window._cntrDetailBySeq&&window._cntrDetailBySeq[g.seq])||{};
    const ci=window._cntrBySeq&&window._cntrBySeq[g.seq];
    const showWeights=groupShowWeights(g);
    const facLabel=g.factory||'';
    const facColorIdx=facLabel?allFacs.indexOf(facLabel):-1;
    const facColor=facColorIdx>=0?facColorPalette[facColorIdx%facColorPalette.length]:'#374151';
    const confirmed=window._confirmedKeys.has(g.key);
    const collapsed=confirmed&&window._collapsedKeys.has(g.key);
    const hasMedia=((window._uploadedPhotos[g.key]||[]).length>0)||((cd.pickup_photos||[]).length>0);
    const statusText=confirmed?'✅ 已完成':hasMedia?'🔄 装柜中':'⏳ 待装柜';
    const statusColor=confirmed?'#059669':hasMedia?'#0891b2':'#6b7280';
    const myOrds=g.factory&&!SCOPE ? (window._ordersArr||[]).filter(o=>(o.factory||o.supplier_name||o.factory_name)===g.factory).map(o=>o.order_no) : (window._ordersArr||[]).map(o=>o.order_no);
    const cg=(ci&&ci.cargo||[]).filter(x=>x.order_no&&(!myOrds.length||myOrds.includes(x.order_no)));
    const plate=[esc(cd.plate||cd.truck_plate),esc(cd.trailer_plate)].filter(Boolean).join('/');
    const driverLink=cd.driver_phone?'<a href="tel:'+esc(cd.driver_phone)+'" style="color:#1a73e8;font-weight:700;">'+esc(cd.driver_name||cd.driver_phone)+'</a>':esc(cd.driver_name||'—');
    // 司机车牌信息（车牌/司机/柜号/封铅/皮重）— 替代原柜汇总行
    const chip=(label,val)=>'<span style="background:#fff;border:1px solid #cbd5e1;border-radius:5px;padding:3px 8px;font-size:10.5px;"><span style="color:#94a3b8;">'+label+'</span> '+val+'</span>';
    const chips=[];
    if(plate) chips.push(chip('车牌','<b>'+plate+'</b>'));
    if(cd.driver_name||cd.driver_phone) chips.push(chip('司机',driverLink));
    if(cd.container_no) chips.push(chip('柜号','<b>'+esc(cd.container_no)+'</b>'));
    if(cd.seal_no) chips.push(chip('封铅','<b>'+esc(cd.seal_no)+'</b>'));
    if(cd.tare_weight_kg!=null) chips.push(chip('皮重','<b>'+esc(cd.tare_weight_kg)+'kg</b>'));
    // 折叠态也带货物合计(图2那行:箱数/NW/GW/CBM)
    const _gt=(g.lines||[]).reduce((a,l)=>{const d=(l&&l.data)||{};a.q+=Number(d.pkg_qty)||0;a.nw+=Number(d.nw_kg)||0;a.gw+=Number(d.gw_kg)||0;a.cbm+=Number(d.cbm_m3)||0;return a;},{q:0,nw:0,gw:0,cbm:0});
    const _fmtN=n=>n?Number(n).toLocaleString(undefined,{maximumFractionDigits:3}):'—';
    const collapsedTotal='<div style="display:flex;flex-wrap:wrap;gap:12px;padding:6px 14px;background:#f0fdf4;font-size:12px;color:#15803d;font-weight:800;"><span style="color:#94a3b8;font-weight:700;">合计</span><span>'+_fmtN(_gt.q)+' 箱</span><span>NW '+_fmtN(_gt.nw)+'</span><span>GW '+_fmtN(_gt.gw)+'</span><span>'+_fmtN(_gt.cbm)+' CBM</span></div>';
    const localVgm=window._vgmVals&&Object.prototype.hasOwnProperty.call(window._vgmVals,g.key)?window._vgmVals[g.key]:'';
    const vgmVal=localVgm!==''?localVgm:(cd.vgm_weight_kg!=null?cd.vgm_weight_kg:((cd.cargo_weight_kg!=null&&cd.tare_weight_kg!=null)?Number(cd.cargo_weight_kg)+Number(cd.tare_weight_kg):''));
    const addressFix=factoryProfileAddress
      ? '<button type="button" onclick="event.stopPropagation();openAddressModal()" style="border:none;background:transparent;color:#1a73e8;font-size:10.5px;font-weight:700;cursor:pointer;padding:0 2px;">地址有误?</button>'
      : '<span style="font-size:10.5px;color:#cbd5e1;">请用工厂专属链接修改地址</span>';
    const groupHtml=
    '<div class="ctn-group'+(confirmed?' confirmed':hasMedia?' in-progress':'')+'" id="grp_'+gi_+'">' +
    // Header: 工厂名 + status
    '<div '+(confirmed?'onclick="window._collapsedKeys=window._collapsedKeys||new Set(); if(window._collapsedKeys.has(\''+g.key+'\')) window._collapsedKeys.delete(\''+g.key+'\'); else window._collapsedKeys.add(\''+g.key+'\'); renderGroups();" ':'')+'style="background:'+(confirmed?'#f0fdf4':hasMedia?'#eff6ff':'#f8fafc')+';border-bottom:1px solid '+(confirmed?'#bbf7d0':hasMedia?'#dbeafe':'#e0e4ea')+';padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:10px;'+(confirmed?'cursor:pointer;':'')+'">' +
    '<div style="flex:1;min-width:0;">' +
    '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
    (facLabel?'<span style="background:'+facColor+';color:#fff;font-size:11px;font-weight:800;padding:3px 10px;border-radius:12px;">🏭 '+esc(facLabel)+'</span>':'')+
    '<span style="font-size:12px;font-weight:800;color:'+(confirmed?'#15803d':hasMedia?'#1e40af':'#374151')+';">柜'+g.seq+(cd.declaration_cargo_name?' · '+esc(cd.declaration_cargo_name):'')+'</span>'+
    (cd.loading_address?'<span style="font-size:10.5px;color:#64748b;">📍 '+esc(cd.loading_address)+'</span>':'<span style="font-size:10.5px;color:#94a3b8;">📍 装货地址待填（走错位置请联系工厂）</span>')+
    addressFix+
    '</div></div>' +
    '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">' +
    '<span style="font-size:11px;font-weight:700;color:'+statusColor+';">'+statusText+'</span>' +
    (!window._lockCtnCount&&groups.length>1?'<span onclick="event.stopPropagation();delCtn('+gi_+')" style="cursor:pointer;color:#dc2626;font-size:11px;font-weight:700;padding:3px 6px;">× 删</span>':'')+
    '</div></div>' +
    (collapsed?'<div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 14px;background:#f0fdf4;border-top:1px solid #dcfce7;font-size:12px;align-items:center;">'+(chips.length?chips.join(''):'')+'<span style="color:#15803d;font-weight:700;align-self:center;">✅ 已确认装货完毕 · 点此展开</span></div>'+collapsedTotal+'</div>':
    // 司机车牌信息行（车牌/司机/柜号/封铅/皮重）— 替代原柜汇总
    '<div style="display:flex;flex-wrap:wrap;gap:6px;padding:8px 14px;border-bottom:1px solid #f0f2f5;background:#fff;"><span style="font-size:10px;color:#94a3b8;font-weight:700;align-self:center;">🚛 司机/车牌</span>'+(chips.length?chips.join(''):'<span style="font-size:10.5px;color:#94a3b8;">待车队派车后显示</span>')+'</div>'+
    // Linked orders
    (cg.length?'<div style="font-size:11px;padding:5px 14px;background:#ecfdf5;border-bottom:1px solid #a7f3d0;color:#047857;font-weight:700;">✓ 已关联：'+cg.map(x=>esc((x.order_no||'').replace(/^\d+-/,''))+(x.cartons?' · '+x.cartons+'箱':'')).join('　')+'</div>':'')+
    // Cargo table
    '<div class="cargo-scroll" style="padding:0 0 8px;">' +
    '<table class="cargo-t"><thead><tr>' +
    '<th>品名 * <span style="cursor:pointer;color:#1a73e8;font-weight:700;font-size:10px;margin-left:4px;" onclick="snapshot();addLine('+gi_+')">＋加</span></th>' +
    '<th style="width:76px;">货号</th>' +
    '<th style="width:120px;">条码</th>' +
    '<th style="width:72px;">规格</th>' +
    '<th style="width:86px;">箱数 *</th>' +
    (showWeights?'<th style="width:96px;">NW kg</th><th style="width:96px;">GW kg</th><th style="width:88px;">CBM</th>':'')+
    '<th style="width:72px;"></th></tr></thead>' +
    '<tbody id="tbody_'+gi_+'">'+g.lines.map((l,li_)=>lineHtml(l.id,l.data,false,showWeights,gi_,li_)).join('')+'</tbody>' +
    '<tfoot><tr class="row-total" id="tfoot_'+gi_+'"><td colspan="4" style="font-size:10px;color:#6b7280;">TOTAL（来自订单原值'+(editMode?' · 点「改」编辑':'')+'）</td><td class="td-num" id="ft_q_'+gi_+'">—</td>'+(showWeights?'<td class="td-num" id="ft_nw_'+gi_+'">—</td><td class="td-num" id="ft_gw_'+gi_+'">—</td><td class="td-num" id="ft_cbm_'+gi_+'">—</td>':'')+'<td></td></tr></tfoot>' +
    '</table></div>' +
    // 装柜信息：照片/视频缩略图 + 上传 + 过磅 + 确认
    '<div style="padding:8px 14px;border-top:1px solid #eef0f3;background:#fafafa;"' +
    ' ondragover="event.preventDefault();this.style.background=\'#eff6ff\';" ondragleave="this.style.background=\'#fafafa\';" ondrop="event.preventDefault();this.style.background=\'#fafafa\';uploadLoadingFiles(event.dataTransfer.files,\''+g.key+'\','+g.seq+')">' +
    '<div style="font-size:10px;color:#94a3b8;font-weight:700;margin-bottom:6px;">📦 装柜信息（照片/视频点击放大）</div>' +
    buildPhotoGrid(g.key,g.seq).replace('class="photo-grid"','class="photo-grid" style="padding:0 0 8px;background:transparent;"')+
    '<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">'+
    '<button onclick="pickLoadingPhoto(\''+g.key+'\','+g.seq+',\'image\')" style="font-size:11px;padding:5px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-weight:700;">📦 装箱图</button>' +
    '<button onclick="pickLoadingPhoto(\''+g.key+'\','+g.seq+',\'video\')" style="font-size:11px;padding:5px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-weight:700;">🎬 视频</button>' +
    '<button onclick="pickLoadingPhoto(\''+g.key+'\','+g.seq+',\'doc\')" style="font-size:11px;padding:5px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-weight:700;">📋 磅单</button>' +
    '<span id="lpTip_'+g.key+'" style="font-size:10px;color:#059669;"></span>' +
    '<span style="color:#64748b;margin-left:4px;">VGM(kg)</span><input id="vgm_'+g.key+'" type="number" step="0.01" value="'+esc(vgmVal)+'" placeholder="含柜皮重" style="width:80px;border:1px solid #cbd5e1;border-radius:5px;padding:3px 6px;font-size:11px;outline:none;" onchange="window._vgmVals=window._vgmVals||{};window._vgmVals[\''+g.key+'\']=this.value;">' +
    '<span style="color:#64748b;">过磅(kg)</span><input id="fw_'+g.key+'" type="number" step="0.01" value="'+((window._fwVals&&window._fwVals[g.key])||'')+'" placeholder="实重" style="width:72px;border:1px solid #cbd5e1;border-radius:5px;padding:3px 6px;font-size:11px;outline:none;" onchange="window._fwVals=window._fwVals||{};window._fwVals[\''+g.key+'\']=this.value;">' +
    (!confirmed?'<button onclick="openConfirmModal(\''+g.key+'\')" class="btn btn-green btn-sm" style="margin-left:auto;">✅ 确认本柜装货完毕</button>':'<span style="font-size:11px;font-weight:700;color:#059669;margin-left:auto;">✅ 本柜已确认</span>')+
    '</div></div></div>');
    return groupHtml;
  }).join('');
  recalc();
}

function recalc(){
  let TQ=0,TNW=0,TGW=0,TCBM=0;
  groups.forEach((g,gi_)=>{
    let q=0,nw=0,gw=0,cbm=0;
    g.lines.forEach(l=>{ const d=l.data||{}; q+=numVal(d.pkg_qty); nw+=numVal(d.nw_kg); gw+=numVal(d.gw_kg); cbm+=numVal(d.cbm_m3); });
    TQ+=q;TNW+=nw;TGW+=gw;TCBM+=cbm;
    const sub=$('gsub_'+gi_); if(sub&&q) sub.textContent=q+'箱 · NW '+nw.toLocaleString()+' · GW '+gw.toLocaleString()+' · '+cbm.toFixed(2)+' CBM';
    const setF=(id,v)=>{ const el=$(id); if(el) el.textContent=v; };
    setF('ft_q_'+gi_,q?q.toLocaleString():'—');
    setF('ft_nw_'+gi_,nw?nw.toLocaleString(undefined,{maximumFractionDigits:2}):'—');
    setF('ft_gw_'+gi_,gw?gw.toLocaleString(undefined,{maximumFractionDigits:2}):'—');
    setF('ft_cbm_'+gi_,cbm?cbm.toLocaleString(undefined,{maximumFractionDigits:3}):'—');
  });
  $('grandTotal').textContent=TQ?'TOTAL · '+groups.length+'柜 · '+TQ+'箱 · NW '+TNW.toLocaleString()+' · GW '+TGW.toLocaleString()+' · '+TCBM.toFixed(2)+' CBM':groups.length+'柜';
}

function openConfirmModal(key){
  window._pendingConfirmKey=key;
  const g=groups.find(x=>x.key===key)||{};
  const cd=(window._cntrDetailBySeq&&window._cntrDetailBySeq[g.seq])||{};
  const hasMedia=((window._uploadedPhotos[key]||[]).length>0)||((cd.pickup_photos||[]).length>0);
  snapshot();
  let q=0,nw=0,gw=0,cbm=0;
  (g.lines||[]).forEach(l=>{ const d=l.data||{}; q+=numVal(d.pkg_qty); nw+=numVal(d.nw_kg); gw+=numVal(d.gw_kg); cbm+=numVal(d.cbm_m3); });
  const items=[
    {label:'工厂',val:g.factory||'—',ok:!!g.factory},
    {label:'柜号',val:cd.container_no||'待派车',ok:true},
    {label:'封铅',val:cd.seal_no||'待派车',ok:true},
    {label:'箱数',val:q||'—',ok:q>0},
    {label:'总重(NW/GW)',val:(nw||'—')+' / '+(gw||'—')+' kg',ok:nw>0},
    {label:'CBM',val:cbm?cbm.toFixed(3):'—',ok:cbm>0},
    {label:'装柜照片/视频',val:hasMedia?'✓ 已上传':'⚠️ 未上传（建议拍照）',ok:hasMedia},
  ];
  $('confirmChecklist').innerHTML='<div style="font-size:12px;margin-bottom:10px;color:#374151;">以下信息将被锁定，请确认无误：</div>'+
    items.map(it=>'<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #f0f2f5;font-size:12px;">'+
      '<span style="color:#6b7280;">'+it.label+'</span><span style="font-weight:700;color:'+(it.ok?'#15803d':'#b91c1c')+';">'+it.val+'</span></div>').join('');
  const m=$('confirmModal'); m.classList.remove('hidden'); m.style.display='flex';
}
function closeConfirmModal(){ const m=$('confirmModal'); m.classList.add('hidden'); m.style.display=''; window._pendingConfirmKey=null; }
function doConfirm(){
  const key=window._pendingConfirmKey; if(!key) return;
  closeConfirmModal();
  save(true, groups.find(x=>x.key===key));
}
