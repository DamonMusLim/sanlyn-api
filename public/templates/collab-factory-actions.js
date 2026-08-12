async function boot(){
  if(!token){ show('stateDead'); return; }
  const r=await fetch(API+'/validate?token='+encodeURIComponent(token));
  const d=await r.json().catch(()=>({}));
  if(!d.valid||d.role!=='factory_booking'){ show('stateDead'); return; }
  const s=d.booking_sheet||{};
  renderBillingEntry(d.billing||{});
  if(s.scope_missing){
    $('stateDead').innerHTML='<div style="text-align:center;padding:48px 22px;"><div style="font-size:44px;">🔒</div><div style="font-size:15px;font-weight:800;color:#92400e;margin-top:12px;">此链接未限定贵厂范围</div><div style="font-size:12px;color:#6b7280;margin-top:10px;line-height:1.7;">为防止信息串单，本链接已停用。<br>请联系 Sanlyn 重新发送专属链接。</div></div>';
    show('stateDead'); return;
  }
  window._cntrBySeq={};
  (function(){ const order=Array.isArray(s.containers_order)?s.containers_order:[]; const live=Array.isArray(s.containers_live)?s.containers_live:[]; order.forEach((no,i)=>{ const hit=live.find(x=>x.container_no===no); if(hit) window._cntrBySeq[i+1]=hit; }); if(!order.length) live.forEach((x,i)=>{ window._cntrBySeq[i+1]=x; }); })();
  window._cntrDetailBySeq={};
  (Array.isArray(s.containers_detail)?s.containers_detail:[]).forEach(c=>{ if(c) window._cntrDetailBySeq[c.seq||1]=c; });
  window._doneSeqs=new Set((Array.isArray(s.containers_detail)?s.containers_detail:[]).filter(c=>c&&c.loading_done).map(c=>c.seq||1));
  SCOPE=d.factory_scope||null;
  factoryProfileAddress=d.factory_profile_address||null;
  $('topBadge').textContent=s.ext_ref||'工厂协同';   // ⛔绝不用 shipment_no(CY内部号)
  const ordersArr=Array.isArray(s.orders)?s.orders:[]; window._ordersArr=ordersArr;
  // oli_id → 货号/条码/规格(产品主数据),给已存明细(factory_cargo无这几个字段)按oli_id补认货码
  window._oliMeta={}; ordersArr.forEach(o=>(o.items||[]).forEach(it=>{ if(it&&it.oli_id!=null) window._oliMeta[it.oli_id]={sku:it.sku||'',barcode:it.barcode||'',size:it.size||'',brand:it.brand||''}; }));
  const facList=[...new Set(ordersArr.map(o=>o.factory||o.supplier_name||o.factory_name).filter(Boolean))];
  // 工厂专属链接只显本厂名；管理视角多厂时不合并显示，提示各厂独立确认
  const facName=SCOPE?SCOPE.label:facList.join(' / ');
  $('bannerTitle').textContent=(s.ext_ref||'货物确认')+' — 工厂货物确认'+(facName?'（'+facName+'）':'');
  // banner: preview identity (v1.1.0 2026-06-23)
  (function(){
    var el=document.getElementById('previewBanner');
    if(!el){ el=document.createElement('div'); el.id='previewBanner'; document.body.insertBefore(el, document.body.firstChild); }
    if(d.is_preview && d.preview_godview){
      el.style.cssText='background:#fef2f2;border-bottom:2px solid #dc2626;color:#991b1b;font-weight:800;font-size:13px;padding:10px 16px;text-align:center;position:sticky;top:0;z-index:50;';
      el.textContent='\uD83D\uDD13 \u5168\u7968\u603b\u89c8 \u00b7 \u4ec5\u5185\u90e8\u6838\u5bf9 \u00b7 \u8bf7\u52ff\u53d1\u7ed9\u4efb\u4f55\u5de5\u5382\uff08\u6b64\u89c6\u56fe\u542b\u5168\u90e8\u5de5\u5382\u8d27\u7269\uff09';
    } else if(d.is_preview && SCOPE){
      el.style.cssText='background:#eff6ff;border-bottom:2px solid #2563eb;color:#1e40af;font-weight:800;font-size:13px;padding:10px 16px;text-align:center;position:sticky;top:0;z-index:50;';
      el.textContent='\uD83D\uDC41 \u5185\u90e8\u9884\u89c8 \u00b7 \u4f60\u6b63\u4ee5\u3010'+(SCOPE.label||'')+'\u3011\u8eab\u4efd\u67e5\u770b \u2014 \u8fd9\u5c31\u662f\u8be5\u5de5\u5382\u4f1a\u770b\u5230\u7684\u5168\u90e8';
    } else { el.style.display='none'; }
  })();
  const fp=d.factory_progress; if(fp&&fp.total>1) document.querySelector('.portal-login-badge').textContent=(s.ext_ref||'')+' · '+fp.submitted+'/'+fp.total+'厂已确认';
  if(SCOPE) document.querySelector('#step1 .step-sub').textContent='请确认贵厂货柜信息 · 仅您与 Sanlyn 可见';
  const cells=[], cell=(l,v)=>'<div style="border:1px solid #f0f2f5;background:#f8fafc;border-radius:8px;padding:7px 10px;"><div style="font-size:9px;color:#9ca3af;font-weight:700;">'+l+'</div><div style="font-size:12px;font-weight:800;color:#1a1d23;margin-top:2px;">'+v+'</div></div>';
  // 2026-08-06 删「送港/ETD」:工厂只管做货装柜,船期港口是我方物流安排,不给上游看。
  // 后端 collab-field-profiles.js 的 factory profile 也已摘掉这些字段(只删前端 F12 还能看到)。
  if(s.factory_submitted) cells.push(cell('状态','✓ 已提交 · 可修改重交'));
  const blc=s.bl_confirmation||{}; cells.push(cell('客户提单确认', blc.status==='customer_confirmed'?'✓ 客户已确认':'待客户确认'));
  const _q=ordersArr.reduce((t,o)=>t+(Number(o.total_qty)||0),0), _g=ordersArr.reduce((t,o)=>t+(Number(o.gross_weight)||0),0);
  if(_q&&!SCOPE) cells.push(cell('总箱数',_q.toLocaleString()+'箱'+(_g?' · '+_g.toLocaleString()+' kg':'')));
  $('infoGrid').innerHTML=cells.join('');
  var _ft = s.factory_purchase_term || s.freight_term;   // 2026-08-05 优先采购侧(工厂自己那侧)
  if(_ft){ sel.tt=_ft; locked.tt=true; preset('ttRow','tt',_ft,'on-green'); $('ttHint').textContent='（已选定：'+s.freight_term+'）'; $('fobSub').style.display=(s.freight_term==='FOB'||s.freight_term==='EXW')?'block':'none'; }
  if(s.trucking_arrange){ sel.trk=arrangeVal(s.trucking_arrange); locked.trk=true; preset('trkRow','trk',sel.trk,'on-green'); }
  if(s.customs_arrange){ sel.cus=arrangeVal(s.customs_arrange); locked.cus=true; preset('cusRow','cus',sel.cus,'on-green'); }
  selfNote();
  collapseTradeTerms();
  const fa=s.factory_attrs||{};
  sel.bat=fa.battery==='yes'?'yes':'no'; preset('batRow','bat',sel.bat,sel.bat==='no'?'on-green':'on-red'); if(sel.bat==='yes') $('msdsNote').style.display='block';
  sel.wood=fa.wood_packaging==='yes'?'yes':'no'; preset('woodRow','wood',sel.wood,sel.wood==='no'?'on-green':'on-blue');
  if(sel.wood==='yes'){ $('fumWrap').style.display='flex'; if(fa.fumigation){ sel.fum=fa.fumigation; preset('fumRow','fum',sel.fum,sel.fum==='yes'?'on-green':'on-red'); if(sel.fum==='no') $('fumNote').style.display='block'; } }
  // 货物明细 — 始终可编辑，工厂可修改箱数，【按工厂分区，一厂一卡，绝不串】
  editMode=true; $('cargoEdit').style.display='block'; $('cargoSub').textContent='按工厂分区 · 箱数可修改 · 各厂独立确认';
  let fc=Array.isArray(s.factory_cargo)?s.factory_cargo:[];
  const facOf=o=>o.factory||o.supplier_name||o.factory_name||'未指定工厂';
  const mapItem=it=>({oli_id:it.oli_id,cargo_name:it.product_name||it.description||'',sku:it.sku||'',barcode:it.barcode||'',brand:it.brand||'',size:it.size||'',hs_code:it.hs_code||'',pkg_qty:it.ctns||'',nw_kg:Number(it.nw_kgs)||'',gw_kg:Number(it.gw_kgs)||'',cbm_m3:Number(it.cbm)||''});
  const _om=id=>(window._oliMeta&&window._oliMeta[id])||{};
  const mapFc=x=>({oli_id:x.oli_id,cargo_name:x.cargo_name||'',sku:x.sku||_om(x.oli_id).sku||'',barcode:x.barcode||_om(x.oli_id).barcode||'',brand:x.brand||_om(x.oli_id).brand||'',size:x.size||_om(x.oli_id).size||'',hs_code:x.hs_code||'',pkg_qty:x.pkg_qty!=null?x.pkg_qty:'',nw_kg:x.nw_kg!=null?x.nw_kg:'',gw_kg:x.gw_kg!=null?x.gw_kg:'',cbm_m3:x.cbm_m3!=null?x.cbm_m3:'',fe:x.fe});
  // 找出某工厂订单所在的柜 seq（拼柜则多厂同 seq）
  const seqForOrders=ordNos=>{ const seqs=Object.keys(window._cntrBySeq||{}).map(Number); for(const k of seqs){ const ci=window._cntrBySeq[k]; const cnos=(ci&&ci.cargo||[]).map(x=>x.order_no); if(ordNos.some(n=>cnos.includes(n))) return k; } return seqs[0]||1; };
  window._lockCtnCount=true; $('btnAddCtn').style.display='none';
  if(SCOPE){
    // 工厂专属链接：只看本厂本柜
    const fac=SCOPE.label;
    // v1.1.1: scope 只有 label 无 seqs(如按公司名预览)时兜底——从已被后端裁剪的本厂数据推柜号,仍安全不破隔离
    let mySeqs=(Array.isArray(SCOPE.seqs)&&SCOPE.seqs.length)?SCOPE.seqs:null;
    if(!mySeqs){ const a=[...new Set(fc.map(x=>x.container_seq||1))]; const b=Object.keys(window._cntrBySeq||{}).map(Number); mySeqs=a.length?a:(b.length?b:[1]); }
    let myFc=fc.filter(x=>mySeqs.includes(x.container_seq||1)&&(!x.factory_label||x.factory_label===fac));
    const bySeq={}; myFc.forEach(x=>{ const k=x.container_seq||1; (bySeq[k]=bySeq[k]||[]).push(mapFc(x)); });
    mySeqs.forEach(k=>{ if(!(bySeq[k]&&bySeq[k].length)){ const ci=window._cntrBySeq&&window._cntrBySeq[k]; let ords=(ci&&ci.cargo||[]).map(x=>x.order_no).filter(Boolean); if(!ords.length&&mySeqs.length===1) ords=ordersArr.map(o=>o.order_no).filter(Boolean); if(ords.length){ const pre=ordersArr.filter(o=>ords.includes(o.order_no)).flatMap(o=>(o.items||[]).map(mapItem)); if(pre.length) bySeq[k]=pre; } } });
    mySeqs.forEach(k=>addCtn(bySeq[k]||[{}],k,fac));
  } else {
    // 内部/管理视角：多柜按柜槽建卡，避免同厂多柜被合并
    const groupsToAdd=[];
    if(fc.length){
      // 已有保存的明细：按 factory_label + 柜号分组，避免同厂多柜被合并
      const byFac={};
      fc.forEach(x=>{ const seq=x.container_seq||1, f=x.factory_label||('柜'+seq), key=f+'|'+seq; if(!byFac[key]) byFac[key]={factory:x.factory_label||null,seq:seq,lines:[]}; byFac[key].lines.push(mapFc(x)); });
      Object.values(byFac).forEach(grp=>groupsToAdd.push(grp));
    } else if(ordersArr.length){
      const detailSeqs=Object.keys(window._cntrDetailBySeq||{}).map(Number).filter(Boolean).sort((a,b)=>a-b);
      const qty=Number(s.container_qty)||detailSeqs.length||Object.keys(window._cntrBySeq||{}).length||1;
      const seqs=detailSeqs.length?detailSeqs:Array.from({length:qty},(_,i)=>i+1);
      if(seqs.length>1){
        seqs.forEach(k=>{
          const ci=window._cntrBySeq&&window._cntrBySeq[k];
          const ords=(ci&&ci.cargo||[]).map(x=>x.order_no).filter(Boolean);
          const os=ordersArr.filter(o=>ords.includes(o.order_no));
          const facs=[...new Set(os.map(facOf).filter(Boolean))];
          const lines=os.flatMap(o=>(o.items||[]).map(mapItem));
          groupsToAdd.push({factory:facs.length===1?facs[0]:null,seq:k,lines:lines.length?lines:[{}]});
        });
      } else {
        // 单柜旧路径：无保存明细时仍按工厂聚合订单明细预填
        const byFac={};
        ordersArr.forEach(o=>{ const f=facOf(o); if(!byFac[f]) byFac[f]={factory:f,orderNos:[],lines:[]}; byFac[f].orderNos.push(o.order_no); (o.items||[]).forEach(it=>byFac[f].lines.push(mapItem(it))); });
        Object.values(byFac).forEach(grp=>{ if(grp.lines.length) groupsToAdd.push({factory:grp.factory,seq:seqForOrders(grp.orderNos),lines:grp.lines}); });
      }
    }
    if(groupsToAdd.length) groupsToAdd.forEach(grp=>addCtn(grp.lines,grp.seq,grp.factory));
    else addCtn();
  }
  if(s.factory_submitted){ if(s.factory_cargo_ready) $('cargo_ready_date').value=fmtD(s.factory_cargo_ready); if(s.factory_container_type) setTog('ctRow','ct',s.factory_container_type); if(s.factory_cargo_type) setTog('cgtRow','cgt',s.factory_cargo_type); if(s.factory_remarks) $('remarks').value=s.factory_remarks; }
  else if(s.container_type) setTog('ctRow','ct',String(s.container_type).toUpperCase().replace('HC','HQ'));
  if(!sel.cgt||sel.cgt==='普通货物'){ sel.cgt='普通货物'; const el=$('cgtRow').querySelector('[data-cgt="普通货物"]'); if(el) el.classList.add('on-green'); }
  const fe=s.factory_entry||{}, mine=(SCOPE&&fe[SCOPE.label])||fe['default']||Object.values(fe)[0];
  if(mine){ if($('er_contact')) $('er_contact').value=mine.contact||''; if($('er_phone')) $('er_phone').value=mine.phone||''; if($('er_note')) $('er_note').value=mine.note||''; if($('er_url')) $('er_url').value=mine.exam_url||''; if($('erSaved')) $('erSaved').textContent='✓ 已登记'; }
  // 2026-08-06 修：工厂 profile 已屏蔽 so_no/bl_no，原来靠它俩判断"已订舱"会永远 false
  // → 柜型不再锁定、已订舱横幅消失。改用后端下发的 is_booked 布尔，号码本身仍不外发。
  window._booked=!!(s.is_booked||s.so_no||s.bl_no); window._loading=Array.isArray(s.containers_live)&&s.containers_live.length>0;
  // 2026-08-05 修：票级 container_type 为空时（CY00407 就是），原逻辑把四个按钮全锁死且一个都不高亮，
  // 工厂"柜型必填"却永远选不了。→ 票级空就用柜级实际柜型兜底；两边都取不到就【不锁】，让人能选。
  if(window._booked){
    const _ctnCt=((s.containers_live||[]).map(c=>c&&c.container_type).filter(Boolean));
    const _uniq=[...new Set(_ctnCt.map(x=>String(x).toUpperCase().replace('HC','HQ')))];
    const _locked=String(s.container_type||(_uniq.length===1?_uniq[0]:'')||'').toUpperCase().replace('HC','HQ');
    if(_locked){
      sel.ct=_locked;
      const ctRow=$('ctRow');
      if(ctRow) ctRow.querySelectorAll('.tog').forEach(t=>{ t.style.pointerEvents='none'; t.style.opacity=(t.dataset.ct===_locked)?'1':'.3'; });
    }
  }
  if(window._booked||window._loading){ const bits=[]; if(window._booked){ const _ct=sel.ct||s.container_type||''; bits.push('⚓ 已订舱'+(_ct?' · 柜型 '+_ct:'')+(s.container_qty?' × '+s.container_qty:'')+' 已锁定'); } if(window._loading) bits.push('🚛 柜已提 · 装柜进行中'); $('bookedBar').innerHTML='<div style="background:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:8px 12px;margin-bottom:10px;font-size:12px;font-weight:700;color:#047857;">'+bits.join('　')+'</div>'; if(window._loading){ const cf=$('cargo_ready_date'); if(cf) cf.closest('.form-field').style.display='none'; } }
  checkStep1(true); checkStep3(true); show('stateForm');
  window._autoSaveTerms=async function(){ try{ await fetch(API+'/factory-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,partial:true,freight_term:sel.tt||null,trucking_arrange:sel.trk||null,customs_arrange:sel.cus||null})}); }catch(e){} };
  ['ttRow','trkRow','cusRow'].forEach(id=>{ const el=$(id); if(el) el.addEventListener('click',()=>setTimeout(window._autoSaveTerms,50)); });
}

async function save(loadingDone, confirmedGroup){
  if(!window._loading&&!gv('cargo_ready_date')){ reopenStep(1); toast('请选择货好日期'); return; }
  if(!sel.ct){ reopenStep(1); toast('请选择柜型'); return; }
  if(!sel.tt){ reopenStep(1); toast('请选择交易条款'); return; }
  if((sel.tt==='FOB'||sel.tt==='EXW')&&(!sel.trk||!sel.cus)){ reopenStep(1); toast('FOB/EXW 请确认拖车与报关安排'); return; }
  if(sel.wood==='yes'&&!sel.fum){ toast('实木包装请确认是否已熏蒸'); return; }
  let containers=null;
  if(editMode){ snapshot(); containers=[]; groups.forEach(g=>g.lines.forEach(l=>{ const d=l.data; if(d.cargo_name||d.pkg_qty!=null) containers.push({container_seq:g.seq,factory_label:g.factory||null,...d}); })); const bad=containers.find(x=>!x.cargo_name||x.pkg_qty==null); if(bad){ toast('品名和箱数必填'); return; } }
  try{
    const body={token,loading_done:!!loadingDone,cargo_ready_date:gv('cargo_ready_date'),container_type:sel.ct,cargo_type:sel.cgt,remarks:gv('remarks'),freight_term:sel.tt,trucking_arrange:sel.trk,customs_arrange:sel.cus,attrs:{battery:sel.bat,wood_packaging:sel.wood,fumigation:sel.fum}};
    if(containers&&containers.length) body.containers=containers;
    if(confirmedGroup){ body.confirmed_seq=confirmedGroup.seq; body.confirmed_factory=confirmedGroup.factory||null; }
    // 过磅/VGM 按组(key)收集，回填 seq + 工厂
    const _vgm=window._vgmVals||{}, _fw=window._fwVals||{}, cw=[];
    groups.forEach(g=>{ const v=_vgm[g.key], w=_fw[g.key]; if(v||w) cw.push({seq:g.seq,factory_label:g.factory||null,weigh_kg:w||null,vgm_kg:v||null}); });
    if(cw.length) body.container_weights=cw;
    const resp=await fetch(API+'/factory-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const rd=await resp.json();
    if(!resp.ok||!rd.ok){ toast(rd.error||'提交失败'); return; }
    if(loadingDone){ if(confirmedGroup){ window._confirmedKeys.add(confirmedGroup.key); window._collapsedKeys.add(confirmedGroup.key); } renderGroups(); toast('✅ '+(confirmedGroup&&confirmedGroup.factory?confirmedGroup.factory+' ':'')+'装货完毕，已通知 Sanlyn'); }
    else show('stateDone');
  }catch(e){ toast('网络错误，请重试'); }
}

$('cargo_ready_date').addEventListener('change',()=>checkStep1());
function openEntryModal(){ const m=$('entryModal'); if(m){ m.classList.remove('hidden'); m.style.display='flex'; } }
function closeEntryModal(){ const m=$('entryModal'); if(m){ m.classList.add('hidden'); m.style.display=''; } }
function openAddressModal(){
  if(!factoryProfileAddress){ toast('请用工厂专属链接修改地址'); return; }
  const cur=factoryProfileAddress.address||'';
  if($('factoryProfileAddressView')) $('factoryProfileAddressView').textContent=cur||'（当前档案地址为空）';
  if($('factoryAddressInput')) $('factoryAddressInput').value=cur;
  if($('factoryAddressConfirm')) $('factoryAddressConfirm').checked=false;
  syncAddressSubmitState();
  const m=$('addressModal'); if(m){ m.classList.remove('hidden'); m.style.display='flex'; }
}
function closeAddressModal(){ const m=$('addressModal'); if(m){ m.classList.add('hidden'); m.style.display=''; } }
function syncAddressSubmitState(){
  const btn=$('btnAddressSubmit'), inp=$('factoryAddressInput'), chk=$('factoryAddressConfirm');
  if(btn) btn.disabled=!(chk&&chk.checked&&inp&&inp.value.trim()&&inp.value.trim().length<=200);
}
async function submitFactoryAddress(){
  const address=gv('factoryAddressInput');
  if(!factoryProfileAddress){ toast('请用工厂专属链接修改地址'); return; }
  if(!address||address.length>200){ toast('地址不能为空且不能超过200字'); return; }
  if(!$('factoryAddressConfirm')||!$('factoryAddressConfirm').checked){ toast('请先勾选二次确认'); return; }
  const btn=$('btnAddressSubmit'); if(btn) btn.disabled=true;
  try{
    const resp=await fetch(API+'/factory-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action:'update-factory-address',address,confirm:true})});
    const rd=await resp.json();
    if(!resp.ok||!rd.ok){ toast(rd.error||'修改失败'); syncAddressSubmitState(); return; }
    toast('✓ 本厂档案地址已更新');
    closeAddressModal();
    setTimeout(()=>location.reload(),650);
  }catch(e){ toast('网络错误'); syncAddressSubmitState(); }
}
window._driverPhotos={};
function renderDriverModal(){
  const body=$('driverModalBody'); if(!body) return;
  body.innerHTML=groups.map(g=>{
    const cd=(window._cntrDetailBySeq&&window._cntrDetailBySeq[g.seq])||{};
    const plate=[esc(cd.plate||cd.truck_plate),esc(cd.trailer_plate)].filter(Boolean).join('/');
    const info=[];
    if(g.factory) info.push('🏭 '+esc(g.factory));
    info.push('柜'+g.seq+(cd.container_no?' · '+esc(cd.container_no):''));
    if(plate) info.push('车牌 '+plate);
    if(cd.driver_name) info.push('司机 '+esc(cd.driver_name));
    if(cd.driver_phone) info.push('<a href="tel:'+esc(cd.driver_phone)+'" style="color:#1a73e8;font-weight:700;">'+esc(cd.driver_phone)+'</a>');
    if(cd.seal_no) info.push('封铅 '+esc(cd.seal_no));
    if(cd.tare_weight_kg!=null) info.push('皮重 '+esc(cd.tare_weight_kg)+'kg');
    const dispatchPhotos=[].concat(cd.driver_photos||[],cd.plate_photos||[]).map(u=>({url:u,type:'image'}));
    const local=window._driverPhotos[g.key]||[];
    const all=[...dispatchPhotos,...local];
    const thumbs=all.map(p=>{const isVid=p.type==='video';return '<div class="photo-cell" onclick="imgLightbox(\''+esc(p.url)+'\','+(isVid?'true':'false')+')">'+(isVid?'<video src="'+esc(p.url)+'" muted preload="metadata"></video><div class="play-ov">▶</div>':'<img src="'+esc(p.url)+'" loading="lazy">')+'</div>';}).join('');
    return '<div style="border:1px solid #e0e4ea;border-radius:8px;padding:10px 12px;margin-bottom:10px;">'+
      '<div style="font-size:11px;font-weight:700;color:#374151;margin-bottom:6px;">'+info.join(' · ')+'</div>'+
      '<div class="photo-grid" style="padding:0 0 8px;background:transparent;">'+thumbs+'</div>'+
      '<button onclick="pickDriverPhoto(\''+g.key+'\','+g.seq+')" style="font-size:11px;padding:5px 12px;border:1px solid #cbd5e1;border-radius:6px;background:#fff;cursor:pointer;font-weight:700;">📷 上传司机/车牌照片</button>'+
      '<span id="dpTip_'+g.key+'" style="font-size:10px;color:#059669;margin-left:8px;"></span>'+
      '</div>';
  }).join('')||'<div style="font-size:12px;color:#94a3b8;text-align:center;padding:20px;">暂无货柜</div>';
}
function openDriverModal(){ renderDriverModal(); const m=$('driverModal'); if(m){ m.classList.remove('hidden'); m.style.display='flex'; } }
function closeDriverModal(){ const m=$('driverModal'); if(m){ m.classList.add('hidden'); m.style.display=''; } }
const _dpInputs={};
function pickDriverPhoto(key,seq){
  const ik=key+'_'+(seq||'');
  if(!_dpInputs[ik]){ const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*,video/*'; inp.multiple=true;
    inp.addEventListener('change',async e=>{ const files=[...e.target.files]; e.target.value=''; const tip=$('dpTip_'+key); if(tip) tip.textContent='上传中…'; let ok=0;
      for(const f of files){ try{ const isVid=/^video\//.test(f.type); const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(f);}); const resp=await fetch(API+'/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,filename:'[司机车牌]'+f.name,mime:f.type,data_base64:b64,purpose:'driver_photo',container_seq:seq})}); const rd=await resp.json(); if(resp.ok&&rd.ok){ ok++; window._driverPhotos[key]=window._driverPhotos[key]||[]; window._driverPhotos[key].push({url:b64,filename:f.name,type:isVid?'video':'image'}); } }catch(err){} }
      if(tip) tip.textContent='✓ 已上传 '+ok+' 个'; renderDriverModal(); });
    _dpInputs[ik]=inp;
  }
  _dpInputs[ik].click();
}
document.addEventListener('click',e=>{ if(e.target&&e.target.id==='entryModal') closeEntryModal(); if(e.target&&e.target.id==='addressModal') closeAddressModal(); if(e.target&&e.target.id==='confirmModal') closeConfirmModal(); if(e.target&&e.target.id==='cargoEditModal') closeCargoEditModal(); if(e.target&&e.target.id==='cargoConfirmModal') closeCargoConfirmModal(); if(e.target&&e.target.id==='driverModal') closeDriverModal(); if(e.target&&e.target.id==='orderModal') closeOrderModal(); });

const _lpInputs={};
async function uploadLoadingFiles(files, key, seq){
  files=[...(files||[])].filter(f=>f&&(/^image\//.test(f.type)||/^video\//.test(f.type)||/pdf|msword|spreadsheet|excel|openxml/.test(f.type)));
  if(!files.length) return;
  const tip=$('lpTip_'+key); if(tip) tip.textContent='上传中…';
  let ok=0;
  for(const f of files){
    try{
      const isVid=/^video\//.test(f.type), isDoc=!/^image\/|^video\//.test(f.type);
      const prefix=isVid?'[装柜视频]':isDoc?'[磅单]':'[装箱图]';
      const b64=await new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=rej;r.readAsDataURL(f);});
      // 🔴 2026-08-06 修：原来只发 token/filename/mime/data，【container_seq 从不发】。
      // 服务端 collab-validate.js 拿不到 seq 就一律挂 seq1 → 多柜时所有装柜图全堆到第一个柜。
      // 后端 handleCollabUpload 早就支持 container_seq/purpose（还带越权校验），只是前端没接。
      const resp=await fetch(API+'/upload',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({token,filename:prefix+f.name,mime:f.type,data_base64:b64,
          container_seq:seq,                                              // ← 关键：柜序号
          purpose:isVid?'装柜视频':isDoc?'磅单':'装箱图'})});               // ← 别再靠文件名猜类型
      const rd=await resp.json();
      if(resp.ok&&rd.ok){ ok++; if(!isDoc){ window._uploadedPhotos[key]=window._uploadedPhotos[key]||[]; window._uploadedPhotos[key].push({url:b64,filename:f.name,type:isVid?'video':'image'}); } }
    }catch(err){}
  }
  if(tip) tip.textContent='✓ 已上传 '+ok+' 个'; toast('✓ 上传 '+ok+' 个');
  if(ok>0) renderGroups();
}
function pickLoadingPhoto(key, seq, type){
  const ik=key+'_'+type;
  if(!_lpInputs[ik]){
    const inp=document.createElement('input'); inp.type='file';
    if(type==='image') inp.accept='image/*'; else if(type==='video') inp.accept='video/*'; else inp.accept='.pdf,.xlsx,.xls,.doc,.docx,image/*';
    inp.multiple=(type==='image');
    inp.addEventListener('change',e=>{ uploadLoadingFiles(e.target.files,key,seq); e.target.value=''; });
    _lpInputs[ik]=inp;
  }
  _lpInputs[ik].click();
}
function pickPhoto(key, seq){
  const ik=key+'_mix';
  if(!_lpInputs[ik]){
    const inp=document.createElement('input'); inp.type='file'; inp.accept='image/*,video/*'; inp.multiple=true;
    inp.addEventListener('change',e=>{ uploadLoadingFiles(e.target.files,key,seq); e.target.value=''; });
    _lpInputs[ik]=inp;
  }
  _lpInputs[ik].click();
}
document.addEventListener('paste',e=>{ const sf=$('stateForm'); if(!sf||sf.classList.contains('hidden')) return; const imgs=((e.clipboardData&&e.clipboardData.files)?[...e.clipboardData.files]:[]).filter(f=>/^image\//.test(f.type)); if(imgs.length){ e.preventDefault(); if(groups.length===1) uploadLoadingFiles(imgs,groups[0].key,groups[0].seq); else toast('多个工厂/柜时请点对应卡片的📦按钮上传'); } });

let _qrInput=null;
function pickQR(){
  if(!_qrInput){ _qrInput=document.createElement('input'); _qrInput.type='file'; _qrInput.accept='image/*'; _qrInput.addEventListener('change',async e=>{ const f=e.target.files[0]; if(!f) return; try{ const b64=await new Promise((ok,no)=>{const r=new FileReader();r.onload=()=>ok(r.result);r.onerror=no;r.readAsDataURL(f);}); const resp=await fetch(API+'/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,filename:'[入厂二维码]'+f.name,mime:f.type,data_base64:b64})}); const rd=await resp.json(); if(!resp.ok||!rd.ok){ toast(rd.error||'上传失败'); return; } toast('✓ 入厂二维码已上传'); $('erSaved').textContent='✓ 已登记+二维码'; }catch(err){ toast('网络错误'); } e.target.value=''; }); }
  _qrInput.click();
}
async function saveEntryReq(){
  try{ const resp=await fetch(API+'/factory-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,entry_req:{contact:gv('er_contact'),phone:gv('er_phone'),note:gv('er_note'),exam_url:gv('er_url')}})}); const rd=await resp.json(); if(!resp.ok||!rd.ok){ toast(rd.error||'保存失败'); return; } $('erSaved').textContent='✓ 已登记（固化到本厂）'; toast('✓ 入厂要求已登记'); setTimeout(closeEntryModal,700); }catch(e){ toast('网络错误'); }
}
let _orderCandidates=[];
function openOrderModal(){ const m=$('orderModal'); if(m){ m.classList.remove('hidden'); m.style.display='flex'; } }
function closeOrderModal(){ const m=$('orderModal'); if(m){ m.classList.add('hidden'); m.style.display=''; } }
function renderOrderModal(){
  const body=$('orderModalBody'); if(!body) return;
  if(!_orderCandidates.length){ body.innerHTML='<div style="font-size:12px;color:#94a3b8;text-align:center;padding:24px;">暂无可挂订单，请联系 Sanlyn</div>'; return; }
  body.innerHTML=_orderCandidates.map((o,i)=>{
    const no=esc(o.order_no||'—'), ct=esc(o.contract_no||''), cu=esc(o.customer||''), fac=esc(o.factory||''), cartons=o.cartons!=null?esc(o.cartons)+'箱':'箱数—';
    return '<button onclick="linkOrderCandidate('+i+')" style="width:100%;text-align:left;border:1px solid #e0e4ea;background:#fff;border-radius:8px;padding:10px 12px;margin-bottom:8px;cursor:pointer;">'+
      '<div style="display:flex;gap:8px;align-items:center;justify-content:space-between;"><span style="font-size:13px;font-weight:800;color:#111827;">'+no+(ct?' · '+ct:'')+'</span><span style="font-size:11px;font-weight:700;color:#047857;">'+cartons+'</span></div>'+
      '<div style="font-size:11px;color:#64748b;margin-top:4px;">'+[cu,fac,(o.item_count?o.item_count+'项':'')].filter(Boolean).join(' · ')+'</div>'+
      '</button>';
  }).join('');
}
async function pickOrder(){
  openOrderModal();
  const body=$('orderModalBody'); if(body) body.innerHTML='<div style="font-size:12px;color:#64748b;text-align:center;padding:24px;">加载中…</div>';
  try{
    const resp=await fetch(API+'/factory-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action:'list-orders'})});
    const rd=await resp.json();
    if(!resp.ok||!rd.ok){ if(body) body.innerHTML='<div style="font-size:12px;color:#dc2626;text-align:center;padding:24px;">加载失败：'+esc(rd.error||resp.status)+'</div>'; return; }
    _orderCandidates=Array.isArray(rd.orders)?rd.orders:[];
    renderOrderModal();
  }catch(e){ if(body) body.innerHTML='<div style="font-size:12px;color:#dc2626;text-align:center;padding:24px;">网络错误</div>'; }
}
async function linkOrderCandidate(i){
  const o=_orderCandidates[i]; if(!o) return;
  const no=o.order_no||o.contract_no; if(!no) return;
  try{
    const resp=await fetch(API+'/factory-submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,action:'link-order',order_no:no})});
    const rd=await resp.json();
    if(!resp.ok||!rd.ok){ toast('关联失败：'+(rd.error||'未知')); return; }
    closeOrderModal(); toast('✓ 已关联 '+(rd.order_no||no)); setTimeout(()=>location.reload(),800);
  }catch(e){ toast('网络错误'); }
}
var _cargoDocInput=null;
function pickCargoDoc(){
  if(!_cargoDocInput){ _cargoDocInput=document.createElement('input'); _cargoDocInput.type='file'; _cargoDocInput.accept='.pdf,.xlsx,.xls,.doc,.docx,image/*'; _cargoDocInput.addEventListener('change',async function(e){ var f=e.target.files[0]; if(!f) return; toast('上传中…'); try{ var b64=await new Promise(function(ok,no){var r=new FileReader();r.onload=function(){ok(r.result);};r.onerror=no;r.readAsDataURL(f);}); var resp=await fetch(API+'/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,filename:'[cargo]'+f.name,mime:f.type,data_base64:b64})}); var rd=await resp.json(); if(!resp.ok||!rd.ok){ toast(rd.error||'上传失败'); return; } toast('✓ 货单已上传：'+f.name); var bar=$('cargoUploadBar'); if(!bar){ bar=document.createElement('div'); bar.id='cargoUploadBar'; bar.style.cssText='margin:8px 16px 4px;padding:8px 12px;background:#ecfdf5;border:1px solid #a7f3d0;border-radius:7px;font-size:11px;color:#047857;'; var cr=$('cargoRead'); if(cr&&cr.parentNode) cr.parentNode.insertBefore(bar,cr.nextSibling); } bar.innerHTML+='<div>📎 <b>'+((rd.file&&rd.file.filename)?rd.file.filename.replace('[cargo]',''):f.name)+'</b></div>'; }catch(err){ toast('网络错误'); } e.target.value=''; }); }
  _cargoDocInput.click();
}

boot();
