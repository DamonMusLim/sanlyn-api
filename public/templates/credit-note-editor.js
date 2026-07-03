// credit-note-editor.js — 独立 CN 可编辑单据模版 (复用 export-docs 的印章/导出机制,数据源=credit_notes)
var API='https://api.sanlyn.cn',_sealTarget='cn:seller',_stamps=[],_localStamps=[],_pendingFile=null,_sealRotation={},_cnNo='';
function qp(n){return new URLSearchParams(location.search).get(n)||'';}
function tok(){try{return qp('token')||localStorage.getItem('sanlyn_jwt')||localStorage.getItem('sanlyn_token')||'';}catch(e){return '';}}
function authH(){var h={'Content-Type':'application/json'};var t=tok();if(t)h.Authorization='Bearer '+t;return h;}
function setT(id,v){var e=document.getElementById(id);if(e&&v!=null&&String(v).trim().length)e.textContent=v;}
function txt(id){var e=document.getElementById(id);return e?e.textContent:'';}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function num(v){var x=parseFloat(String(v==null?'':v).replace(/[^0-9.\-]/g,''));return isNaN(x)?0:x;}
function fmt(n,d){var x=Number(n)||0;d=(d==null?2:d);return x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});}
function banner(t,m){var i=document.getElementById('infoBanner'),e=document.getElementById('errBanner');if(i)i.style.display='none';if(e)e.style.display='none';if(t==='err'&&e){e.textContent='⚠ '+m;e.style.display='block';}if(t==='info'&&i){i.textContent=m;i.style.display='block';}}

/* ── credit items table ─────────────────────────────── */
function itemRow(i,it){
  return '<tr>'
    +'<td class="c">'+('0'+(i+1)).slice(-2)+'</td>'
    +'<td class="l"><span class="ed" contenteditable data-f="desc" data-ph="品名">'+esc(it.desc||'')+'</span></td>'
    +'<td><span class="ed" contenteditable data-f="qty" oninput="recalc(this)">'+esc(it.qty!=null?it.qty:'')+'</span></td>'
    +'<td><span class="ed" contenteditable data-f="unit">'+esc(it.unit||'')+'</span></td>'
    +'<td><span class="ed" contenteditable data-f="diff" oninput="recalc(this)">'+esc(it.diff!=null?it.diff:'')+'</span></td>'
    +'<td><span class="ed" contenteditable data-f="amount" oninput="recomputeTotal()">'+esc(it.amount!=null?it.amount:'')+'</span></td>'
    +'<td class="c"><span class="rowdel" onclick="delRow(this)">✕</span></td></tr>';
}
function rowsData(){
  var out=[];
  document.querySelectorAll('#cn-body tr').forEach(function(tr){
    if(tr.classList.contains('grand')||!tr.querySelector('[data-f]'))return;
    var g=function(f){var e=tr.querySelector('[data-f="'+f+'"]');return e?e.textContent.trim():'';};
    out.push({desc:g('desc'),qty:g('qty'),unit:g('unit'),diff:g('diff'),amount:g('amount')});
  });
  return out;
}
function renumber(){var i=0;document.querySelectorAll('#cn-body tr').forEach(function(tr){if(tr.classList.contains('grand')||!tr.querySelector('[data-f]'))return;var c=tr.querySelector('td.c');if(c)c.textContent=('0'+(++i)).slice(-2);});}
function recomputeTotal(){
  var tot=0;rowsData().forEach(function(r){tot+=num(r.amount);});
  var body=document.getElementById('cn-body'),old=body.querySelector('tr.grand');if(old)old.remove();
  var tr=document.createElement('tr');tr.className='grand';
  tr.innerHTML='<td></td><td class="l">贷记总额 TOTAL CREDIT (CNY):</td><td></td><td></td><td></td><td class="red">'+fmt(tot)+'</td><td></td>';
  body.appendChild(tr);
}
function recalc(el){
  var tr=el.closest('tr'),q=num(tr.querySelector('[data-f="qty"]').textContent),d=num(tr.querySelector('[data-f="diff"]').textContent);
  var a=tr.querySelector('[data-f="amount"]');if(a)a.textContent=fmt(-(q*d));
  recomputeTotal();
}
function delRow(el){el.closest('tr').remove();renumber();recomputeTotal();}
function addRow(){
  var body=document.getElementById('cn-body'),grand=body.querySelector('tr.grand');
  var tmp=document.createElement('tbody');tmp.innerHTML=itemRow(rowsData().length,{});
  var tr=tmp.firstChild;if(grand)body.insertBefore(tr,grand);else body.appendChild(tr);
  renumber();recomputeTotal();
}
function renderItems(items){
  var b='';items.forEach(function(it,i){b+=itemRow(i,it);});
  document.getElementById('cn-body').innerHTML=b;recomputeTotal();
}

/* ── data loaders ───────────────────────────────────── */
function loadCN(cnNo){return fetch(API+'/api/db/credit-notes?cn_no='+encodeURIComponent(cnNo),{headers:authH()}).then(function(r){return r.json();}).then(function(d){return d.data||d;});}
function fetchBuyerAddr(code){if(!code)return Promise.resolve('');return fetch(API+'/api/db/companies?q='+encodeURIComponent(code),{headers:authH()}).then(function(r){return r.json();}).then(function(d){var rows=Array.isArray(d)?d:(d.data||d.companies||[]);var row=rows.find(function(x){return x.code===code||x.company_code===code;})||rows[0]||{};return row.address||'';}).catch(function(){return '';});}
function fetchCustomerPo(orderNo){if(!orderNo)return Promise.resolve('');return fetch(API+'/api/db/orders?order_no='+encodeURIComponent(orderNo),{headers:authH()}).then(function(r){return r.json();}).then(function(d){var rows=d.data||d.orders||(Array.isArray(d)?d:[]);var o=rows[0]||{};return o.customer_po||o.customer_po_no||'';}).catch(function(){return '';});}

/* ── toolbar actions ────────────────────────────────── */
function _docUrl(f){var u='/api/db/documents?type=cn&id='+encodeURIComponent(_cnNo)+'&audience=customer';if(f)u+='&format='+f;u+='&token='+encodeURIComponent(tok());return u;}
function dlDoc(f){window.open(_docUrl(f),'_blank');}
function fwdDoc(){
  banner('info','正在生成共享链接…');
  fetch(API+'/api/db/credit-notes?action=share&cn_no='+encodeURIComponent(_cnNo),{method:'POST',headers:authH()})
    .then(function(r){return r.json();}).then(function(d){
      if(d.ok){try{navigator.clipboard.writeText(d.quickUrl);}catch(e){}banner('info','✓ 共享链接已复制 · 密码 '+d.password+' · 7天有效');prompt('已复制链接。密码 '+d.password+'：',d.quickUrl);}
      else banner('err',d.error||'生成失败');
      setTimeout(function(){banner('','');},3000);
    }).catch(function(e){banner('err',e.message);});
}
function snapshot(){return {sellerName:txt('cn-sellerName'),sellerAddr:txt('cn-sellerAddr'),buyerName:txt('cn-buyerName'),buyerAddr:txt('cn-buyerAddr'),no:txt('cn-no'),order:txt('cn-order'),contract:txt('cn-contract'),date:txt('cn-date'),remarks:txt('cn-remarks'),bank:document.getElementById('cn-bank').innerText,items:rowsData()};}
function saveDraft(){try{localStorage.setItem('cn_draft_'+_cnNo,JSON.stringify(snapshot()));banner('info','✓ 草稿已保存(本机)');setTimeout(function(){banner('','');},1500);}catch(e){banner('err','保存失败');}}
function applyDraft(){
  try{var d=JSON.parse(localStorage.getItem('cn_draft_'+_cnNo)||'null');if(!d)return;
    var map={sellerName:'cn-sellerName',sellerAddr:'cn-sellerAddr',buyerName:'cn-buyerName',buyerAddr:'cn-buyerAddr',no:'cn-no',order:'cn-order',contract:'cn-contract',date:'cn-date',remarks:'cn-remarks'};
    Object.keys(map).forEach(function(k){if(d[k]!=null&&String(d[k]).trim())setT(map[k],d[k]);});
    if(d.bank)document.getElementById('cn-bank').innerText=d.bank;
    if(d.items&&d.items.length)renderItems(d.items);
    banner('info','↺ 已恢复本机草稿');setTimeout(function(){banner('','');},1500);
  }catch(e){}
}
function downloadPng(){
  var btn=document.querySelector('.btn-dl');btn.textContent='⏳…';btn.disabled=true;document.querySelector('.toolbar').style.display='none';
  var done=function(){document.querySelector('.toolbar').style.display='';btn.textContent='📥 下载图片';btn.disabled=false;};
  var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  s.onload=function(){html2canvas(document.getElementById('pageCN'),{scale:2,useCORS:true,backgroundColor:'#fff'}).then(function(c){var a=document.createElement('a');a.download='CN-'+(_cnNo||'draft')+'.png';a.href=c.toDataURL('image/png');a.click();done();}).catch(done);};
  if(window.html2canvas)s.onload();else document.head.appendChild(s);
}

/* ── seal system (复用 export-docs) ─────────────────── */
function sealTargets(t){if(!t)return[];var a=String(t).split(':');if(a[0]==='all')return ['cn:'+a[1]];return [t];}
function sealKey(t){return 'cn_editor_seal_'+String(t).replace(':','_');}
function initRotHandle(t){
  var id=t.replace(':','-'),area=document.getElementById(id+'-seal-area'),img=document.getElementById(id+'-seal');
  if(!area||!img)return;img.style.cursor='grab';img.title='拖动印章旋转';
  img.onmousedown=function(e){
    e.preventDefault();e.stopPropagation();img.style.cursor='grabbing';
    var r=area.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
    var sm=Math.atan2(e.clientY-cy,e.clientX-cx)*180/Math.PI,sr=_sealRotation[t]||0;
    function move(ev){var a=Math.atan2(ev.clientY-cy,ev.clientX-cx)*180/Math.PI;_sealRotation[t]=sr+(a-sm);img.style.transform='rotate('+_sealRotation[t].toFixed(1)+'deg)';}
    function up(){img.style.cursor='grab';document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);}
    document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);
  };
}
function applySeal(target,url,name){
  if(!url){url=target;target='cn:seller';}
  sealTargets(target).forEach(function(t){
    var id=t.replace(':','-'),img=document.getElementById(id+'-seal'),hint=document.getElementById(id+'-seal-hint');
    if(!img)return;_sealRotation[t]=0;img.src=url;img.style.display='block';img.style.transform='';if(hint)hint.style.display='none';
    try{localStorage.setItem(sealKey(t),JSON.stringify({url:url,name:name||''}));}catch(e){}
    initRotHandle(t);
  });
}
function dropSeal(e,target){e.preventDefault();var f=e.dataTransfer.files[0];if(!f||!f.type.startsWith('image/'))return;var r=new FileReader();r.onload=function(ev){applySeal(target,ev.target.result,f.name.replace(/\.[^.]+$/,''));};r.readAsDataURL(f);}
window.addEventListener('message',function(e){if(!e.data||e.data.type!=='seal-ready')return;applySeal(_sealTarget,e.data.dataUrl,e.data.label||'印章');closeModal();});
function switchTab(name){
  ['das','local','make','upload'].forEach(function(t){
    var b=document.getElementById('tab-'+t),c=document.getElementById('tab-'+t+'-content');
    if(b){b.style.background=t===name?'#3b82f6':'#f1f5f9';b.style.color=t===name?'#fff':'#64748b';}
    if(c)c.style.display=t===name?'':'none';
  });
  if(name==='das')loadDasStamps();if(name==='local')renderLocalStamps();
}
function openSealPicker(target){
  _sealTarget=target||'cn:seller';document.getElementById('sealModal').style.display='flex';
  var dasTab=document.getElementById('tab-das');
  if(tok()){dasTab.style.display='';switchTab('das');}else{dasTab.style.display='none';loadLocalStamps();switchTab(_localStamps.length?'local':'make');}
}
function closeModal(){document.getElementById('sealModal').style.display='none';}
function loadLocalStamps(){try{_localStamps=JSON.parse(localStorage.getItem('pc_local_stamps')||'[]');}catch(e){_localStamps=[];}}
function renderLocalStamps(){
  var g=document.getElementById('localGrid');if(!g)return;loadLocalStamps();
  if(!_localStamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">暂无本地章</div>';return;}
  g.innerHTML=_localStamps.map(function(s,i){return '<div onclick="selLocal('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center"><img src="'+esc(s.url)+'" style="width:64px;height:64px;object-fit:contain"><div style="font-size:11px;color:#475569;margin-top:4px">'+esc(s.name||'印章')+'</div></div>';}).join('');
}
function selLocal(i){loadLocalStamps();applySeal(_sealTarget,_localStamps[i].url,_localStamps[i].name);closeModal();}
function loadDasStamps(){
  var g=document.getElementById('stampGrid');g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载中…</div>';
  fetch(API+'/api/db/customer-stamps',{headers:authH()}).then(function(r){return r.json();}).then(function(d){
    var stamps=Array.isArray(d)?d:(d.stamps||d.data||[]);
    if(!stamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">DAS暂无印章</div>';return;}
    _stamps=stamps;
    g.innerHTML=stamps.map(function(s,i){return '<div onclick="selStamp('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center"><img src="'+esc(s.url)+'" style="width:64px;height:64px;object-fit:contain" onerror="this.style.opacity=0.3"><div style="font-size:11px;color:#475569;margin-top:4px">'+esc(s.name||'印章')+'</div></div>';}).join('');
  }).catch(function(){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载失败</div>';});
}
function selStamp(i){applySeal(_sealTarget,_stamps[i].url,_stamps[i].name);closeModal();}
function onFileChosen(e){
  var file=e.target.files[0];if(!file)return;_pendingFile=file;
  var r=new FileReader();r.onload=function(ev){document.getElementById('uploadPreview').src=ev.target.result;document.getElementById('uploadPreview').style.display='block';document.getElementById('uploadPlaceholder').style.display='none';};r.readAsDataURL(file);
  if(!document.getElementById('uploadSealName').value)document.getElementById('uploadSealName').value=file.name.replace(/\.[^.]+$/,'');
  ['uploadUseBtn','uploadLocalBtn'].forEach(function(id){document.getElementById(id).disabled=false;});e.target.value='';
}
function useUploadedSeal(){if(!_pendingFile)return;var name=document.getElementById('uploadSealName').value.trim()||'印章';var r=new FileReader();r.onload=function(ev){applySeal(_sealTarget,ev.target.result,name);closeModal();};r.readAsDataURL(_pendingFile);}
function saveSealToLocal(){if(!_pendingFile)return;var name=document.getElementById('uploadSealName').value.trim()||'印章';var r=new FileReader();r.onload=function(ev){loadLocalStamps();_localStamps.unshift({id:'local_'+Date.now(),name:name,url:ev.target.result});localStorage.setItem('pc_local_stamps',JSON.stringify(_localStamps.slice(0,30)));document.getElementById('uploadStatus').textContent='✓ 已保存本地';document.getElementById('uploadStatus').style.color='#16a34a';setTimeout(function(){switchTab('local');},600);};r.readAsDataURL(_pendingFile);}

/* ── init ───────────────────────────────────────────── */
function init(){
  _cnNo=qp('cn_no')||qp('id');
  if(!_cnNo){banner('err','请加 ?cn_no=CN-xxxx&token=YY');return;}
  document.getElementById('cnLabel').textContent=_cnNo;
  banner('info','正在拉取贷记单…');
  loadCN(_cnNo).then(function(cn){
    if(!cn||!cn.cn_no)throw new Error('贷记单 "'+_cnNo+'" 未找到或无权限');
    var raw=cn.raw||{};
    setT('cn-sellerName',raw.issuing_company||'XIAMEN PET BABY IMPORT AND EXPORT CO., LTD');
    setT('cn-sellerAddr','4th Floor, 26-9# Huarong Road, Huli, Xiamen, China');
    setT('cn-buyerName',cn.company_name||'');
    setT('cn-no',cn.cn_no);
    setT('cn-order',cn.order_no||'');
    setT('cn-date',(cn.issued_date||'').slice(0,10));
    setT('cn-remarks',cn.note||'');
    document.getElementById('cn-bank').innerText='受益人 XIAMEN PET BABY IMPORT AND EXPORT CO., LTD\n银行 BANK OF CHINA XIAMEN WENZAO SUB-BRANCH\nSWIFT BKCHCNBJ73A\n账号 RMB 431279918006 / USD 4299 8287 9286';
    var raws=(Array.isArray(cn.items)?cn.items:(typeof cn.items==='string'?(function(){try{return JSON.parse(cn.items);}catch(e){return [];}})():[]));
    var items=raws.map(function(it){return {desc:it.desc||it.product||it.product_name||'',qty:(it.qty!=null?it.qty:''),unit:it.qty_unit||it.unit||'',diff:(it.price_diff!=null?it.price_diff:(it.unit_price_diff!=null?it.unit_price_diff:'')),amount:(it.amount!=null?it.amount:'')};});
    if(!items.length)items=[{}];
    renderItems(items);
    fetchBuyerAddr(cn.company_code).then(function(a){if(a&&!txt('cn-buyerAddr').trim())setT('cn-buyerAddr',a);});
    fetchCustomerPo(cn.order_no).then(function(po){setT('cn-contract',po||cn.contract_no||'');});
    fetch(API+'/api/db/seller-profiles',{headers:authH()}).then(function(r){return r.json();}).then(function(d){var ps=Array.isArray(d)?d:(d.data||[]);var sp=ps.find(function(x){return x.is_default;})||ps[0];if(sp&&sp.seal_url&&!localStorage.getItem(sealKey('cn:seller')))applySeal('cn:seller',sp.seal_url,sp.name_en||sp.name_cn||'Seller seal');}).catch(function(){});
    applyDraft();
    banner('','');
  }).catch(function(e){banner('err',e.message);});
  ['buyer','seller'].forEach(function(w){try{var s=JSON.parse(localStorage.getItem(sealKey('cn:'+w))||'null');if(s&&s.url)applySeal('cn:'+w,s.url,s.name);}catch(e){}});
}
init();
