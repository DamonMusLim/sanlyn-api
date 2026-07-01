var API='https://api.sanlyn.cn';
var TYPE=(qp('type')||'pi').toLowerCase(),_cfg,_sealTarget=null,_stamps=[],_localStamps=[],_pendingFile=null,_sealRotation={buyer:0,seller:0};
var CFG={
  po:{code:'PO',title:'采购合同 PURCHASE ORDER',cols:['行号','品名','数量','单价(袋)','箱价','金额','条形码'],price:'factoryPrice',parties:'po',bank:false,terms:false},
  sc:{code:'SC',title:'销售合同 SALES CONTRACT',cols:['No','Description','Qty','Unit Price','Amount'],price:'sellingPrice',parties:'client',bank:true,terms:true},
  iv:{code:'IV',title:'商业发票 COMMERCIAL INVOICE',cols:['No','Description','Qty','Unit Price','Amount'],price:'sellingPrice',parties:'client',bank:false,terms:false},
  pl:{code:'PL',title:'装箱单 PACKING LIST',cols:['CP Code','Description','CTN','NW(KG)','GW(KG)','CBM'],price:null,parties:'client',bank:false,terms:false},
  pi:{code:'PI',title:'形式发票 PROFORMA INVOICE',cols:['No','Description','Qty','Unit Price','Amount'],price:'sellingPrice',parties:'client',bank:false,terms:false}
};
function qp(n){return new URLSearchParams(location.search).get(n)||'';}
function getToken(){try{return qp('token')||localStorage.getItem('sanlyn_jwt')||localStorage.getItem('sanlyn_token')||'';}catch(e){return '';}}
function authH(){var t=getToken(),h={'Content-Type':'application/json'};if(t)h.Authorization='Bearer '+t;return h;}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmt(n,d){var x=Number(n)||0;d=d==null?2:d;return x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});}
function shortNo(no){return String(no||'').replace(/^\d+-/,'');}
function arr(d){return Array.isArray(d)?d:(d&&Array.isArray(d.data)?d.data:(d&&Array.isArray(d.orders)?d.orders:[]));}
function setText(id,val,force){var el=document.getElementById(id);if(el&&(force||!el.textContent.trim())&&val!=null&&String(val).length)el.textContent=val;}
function banner(type,msg){['infoBanner','errBanner','okBanner'].forEach(function(id){var e=document.getElementById(id);if(e)e.style.display='none';});var id={info:'infoBanner',err:'errBanner',ok:'okBanner'}[type],el=document.getElementById(id);if(el){el.textContent=(type==='err'?'⚠ ':'')+msg;el.style.display='block';}}
function hideBanner(){['infoBanner','errBanner','okBanner'].forEach(function(id){var e=document.getElementById(id);if(e)e.style.display='none';});}

function init(){
  _cfg=CFG[TYPE]||CFG.pi;document.title=_cfg.code+' · Sanlyn';renderShell();
  var orderNo=qp('order_no')||qp('orderNo');if(!orderNo){banner('err','未传 order_no，请加 ?type='+TYPE+'&order_no=XX');return;}
  banner('info','正在拉取订单数据...');
  loadOrder(orderNo).then(function(rows){if(!rows.length)throw new Error('订单 "'+orderNo+'" 未找到或无权限');fillDoc(rows[0],[rows[0]]);hideBanner();}).catch(function(e){banner('err',e.message);});
  ['buyer','seller'].forEach(function(w){try{var s=JSON.parse(localStorage.getItem(sealKey(w))||'null');if(s&&s.url)applySeal(w,s.url,s.name);}catch(e){}});
}
function renderShell(){
  var parts=_cfg.title.split(' ');document.getElementById('docTitleCn').textContent=parts[0]||_cfg.title;document.getElementById('docTitleEn').textContent=parts.slice(1).join(' ')||'DOCUMENT';
  document.getElementById('currencyWrap').style.display=_cfg.price?'':'none';
  document.getElementById('bankSection').style.display=_cfg.bank?'':'none';document.getElementById('termsSection').style.display=_cfg.terms?'':'none';
  document.getElementById('partyGrid').innerHTML=partyBox('buyer','Buyer')+partyBox('seller',TYPE==='po'?'Vendor':'Seller');
  if(TYPE!=='po')[].forEach.call(document.querySelectorAll('.po-only'),function(e){e.style.display='none';});
  var th=_cfg.cols.map(function(c,i){var st=i===1?'text-align:left;min-width:170px':'';return '<th style="'+st+'">'+esc(c)+'</th>';}).join('')+'<th class="no-print" style="width:16px;background:#374151;border:none"></th>';
  document.getElementById('tableHead').innerHTML=th;
  document.getElementById('docFoot').innerHTML='<tr class="total-row" id="totalRow"></tr>';
}
function partyBox(prefix,title){
  return '<div class="party-box"><div class="party-title">'+title+'</div>'
    +'<div class="party-row"><span class="party-key">Name:</span><span class="ed ed-bold" id="'+prefix+'Name" contenteditable data-ph="'+title+' name"></span></div>'
    +'<div class="party-row"><span class="party-key">Address:</span><span class="ed ed-bold" id="'+prefix+'Addr" contenteditable data-ph="Address"></span></div>'
    +'<div class="party-row po-only"><span class="party-key">Tax No.:</span><span class="ed ed-bold" id="'+prefix+'TaxNo" contenteditable data-ph="Tax No."></span></div>'
    +'<div class="party-row po-only"><span class="party-key">Bank:</span><span class="ed ed-bold" id="'+prefix+'Bank" contenteditable data-ph="Bank"></span></div>'
    +'<div class="party-row po-only"><span class="party-key">Account:</span><span class="ed ed-bold" id="'+prefix+'Account" contenteditable data-ph="Account"></span></div>'
    +'</div>';
}
function loadOrder(no){return fetch(API+'/api/db/orders?order_no='+encodeURIComponent(no),{headers:authH()}).then(function(r){return r.json();}).then(arr);}
function fetchSellers(){return fetch(API+'/api/db/seller-profiles',{headers:authH()}).then(function(r){return r.json();}).then(arr).catch(function(){return[];});}
function fetchVendor(name){if(!name)return Promise.resolve([]);return fetch(API+'/api/db/companies?q='+encodeURIComponent(name),{headers:authH()}).then(function(r){return r.json();}).then(arr).catch(function(){return[];});}

function fillDoc(primary,all){
  var raw=primary.raw||{},uniq=function(a){return a.filter(function(v,i){return v&&a.indexOf(v)===i;});};
  setText('contractNo',TYPE==='po'?(primary.contract_no||raw.contractNo||''):(primary.fs_no||raw.fs_no||primary.internal_no||raw.internal_no||primary.contract_no||''),true);
  setText('orderNo',all.map(function(o){return shortNo(o.order_no);}).join(' / '),true);
  setText('poNo',uniq(all.map(function(o){return o.customer_po||shortNo(o.order_no);})).join(' / '),true);
  setText('docDate',(primary.order_date||primary.created_at||'').slice(0,10)||new Date().toISOString().slice(0,10),true);
  setText('curr',primary.currency||'CNY',true);setText('remarks',primary.remarks||raw.remarks||'',true);
  if(TYPE==='po')fillPoParties(primary);else fillClientParties(primary);
  renderRows(all);restoreDraft();
}
function fillPoParties(primary){
  setText('buyerName',primary.issuing_company||'',true);setText('sellerName',primary.factory||'',true);
  fetchSellers().then(function(ps){var p=(primary.seller_code&&ps.find(function(x){return x.code===primary.seller_code;}))||ps.find(function(x){return x.name_cn===primary.issuing_company||x.name_en===primary.issuing_company;})||ps.find(function(x){return x.is_default;});if(p){setText('buyerName',p.name_cn||p.name_en||'',true);setText('buyerAddr',p.address_cn||p.address||p.address_en||'',true);setText('buyerTaxNo',p.tax_no||'',true);setText('buyerBank',p.bank_name_cn||p.bank_name||'',true);setText('buyerAccount',p.rmb_account||'',true);}});
  fetchVendor(primary.factory).then(function(cs){var c=cs.find(function(x){return x.name_cn===primary.factory||x.factory_name===primary.factory;})||cs[0];if(c){setText('sellerName',c.name_cn||c.factory_name||'',true);setText('sellerAddr',c.address||c.address_cn||'',true);setText('sellerTaxNo',c.tax_id||c.tax_no||'',true);setText('sellerBank',c.bank_name||'',true);setText('sellerAccount',c.bank_account||'',true);}});
}
function fillClientParties(primary){
  setText('buyerName',primary.customer||primary.company_name_en||'',true);setText('buyerAddr',primary.customer_address||'',true);
  fetchSellers().then(function(ps){var p=(primary.seller_code&&ps.find(function(x){return x.code===primary.seller_code;}))||ps.find(function(x){return x.name_cn===primary.issuing_company||x.name_en===primary.issuing_company;})||ps.find(function(x){return x.is_default;});if(p){setText('sellerName',p.name_en||p.name_cn||primary.issuing_company||'',true);setText('sellerAddr',p.address_en||p.address||'',true);fillBankAndTerms(p,primary.currency||'CNY');if(p.seal_url)applySeal('seller',p.seal_url,p.name_en||p.name_cn||'Seller seal');}else setText('sellerName',primary.issuing_company||'',true);});
}
function fillBankAndTerms(p,cur){
  var acct=cur==='USD'?'Account No. (USD): '+(p.usd_account||''):'Account No. (CNY): '+(p.rmb_account||'');
  document.getElementById('banking').innerText=['Beneficiary: '+(p.name_en||p.name_cn||''),'Bank: '+(p.bank_name||''),'SWIFT: '+(p.bank_swift||''),p.bank_addr?'Bank Address: '+p.bank_addr:'',acct].filter(function(s){return s&&!/: $/.test(s);}).join('\n');
  document.getElementById('terms').innerText=p.terms_sc||'1. Packing: Export seaworthy cartons per approved specification.\n2. Shipment: Per confirmed schedule.\n3. Payment: Per confirmed commercial terms.\n4. Claims: Written notice with evidence within 14 days of arrival.\n5. Governing documents: PI > SC > IV.';
}

function renderRows(all){
  var html='',idx=1,tot={qty:0,amt:0,nw:0,gw:0,cbm:0};
  all.forEach(function(o){var ps=o.products||(o.raw&&o.raw.products)||[];if(typeof ps==='string')try{ps=JSON.parse(ps);}catch(e){ps=[];}ps=(ps||[]).filter(function(p){return p&&(p.name||p.name_en||p.name_cn);});if(!ps.length)return;html+=groupRow('ORDER '+shortNo(o.order_no||o.contract_no));ps.forEach(function(p){html+=productRow(p,idx++,tot);});});
  document.getElementById('docBody').innerHTML=html||'<tr><td colspan="'+(_cfg.cols.length+1)+'" style="text-align:center;padding:14px;color:#94a3b8">无产品数据，可点击“加产品行”手动添加</td></tr>';
  recalcTotals();
}
function groupRow(label){return '<tr class="group-header"><td colspan="'+_cfg.cols.length+'" contenteditable>'+esc(label)+'</td><td class="no-print" style="background:#dbeafe;border:none"></td></tr>';}
function productRow(p,idx,tot){
  var name=p.name||p.name_en||p.name_cn||'';if(p.size)name+=' ('+p.size+')';
  var qty=Number(p.qty||p.qty_ctn||0)||0,bg=Number(p.bgBx||p.bg_bx||1)||1,unit=0,amt=0,cells;
  if(TYPE==='pl'){var nw=(Number(p.netWeight||p.net_weight||0)||0)*qty,gw=(Number(p.grossWeight||p.gross_weight||0)||0)*qty,cbm=(Number(p.cbm||p.cbmPerCtn||p.cbm_per_ctn||0)||0)*qty;tot.qty+=qty;tot.nw+=nw;tot.gw+=gw;tot.cbm+=cbm;cells=[p.code||p.cp_code||('0'+idx).slice(-2),name,qty,fmt(nw),fmt(gw),fmt(cbm,3)];}
  else if(TYPE==='po'){unit=Number(p.factoryPrice||p.factory_price||p.unitPrice||p.unit_price||0)||0;amt=Number(p.factorySubtotal||p.factory_subtotal||p.subtotal||(qty*unit))||0;tot.qty+=qty;tot.amt+=amt;cells=[('0'+idx).slice(-2),name,qty,fmt(bg?unit/bg:unit),fmt(unit),fmt(amt),p.barcode||p.code||p.ean||''];}
  else{unit=Number(p.sellingPrice||p.selling_price||p.unitPrice||p.unit_price||0)||0;amt=Number(p.sellingSubtotal||p.selling_subtotal||p.subtotal||(qty*unit))||0;tot.qty+=qty;tot.amt+=amt;cells=[('0'+idx).slice(-2),name,qty,fmt(unit),fmt(amt)];}
  return '<tr>'+cells.map(function(c,i){var dv=(i===2?' data-v="qty"':(i===4&&TYPE!=='pl'?' data-v="amt"':''));return '<td contenteditable class="'+(i===1?'left':'')+'"'+dv+'>'+esc(c)+'</td>';}).join('')+'<td class="no-print" style="padding:2px;border-left:none"><div class="row-actions"><button class="row-btn row-btn-del" onclick="delRow(this)">×</button><button class="row-btn row-btn-dup" onclick="dupRow(this)">⧉</button></div></td></tr>';
}
function addRow(){document.getElementById('docBody').insertAdjacentHTML('beforeend',emptyRow());recalcTotals();}
function emptyRow(){var n=_cfg.cols.length;return '<tr>'+Array.from({length:n}).map(function(_,i){return '<td contenteditable class="'+(i===1?'left':'')+'"'+(i===2?' data-v="qty"':(i===n-1&&TYPE!=='pl'?' data-v="amt"':''))+'></td>';}).join('')+'<td class="no-print" style="padding:2px;border-left:none"><div class="row-actions"><button class="row-btn row-btn-del" onclick="delRow(this)">×</button><button class="row-btn row-btn-dup" onclick="dupRow(this)">⧉</button></div></td></tr>';}
function addGroup(){document.getElementById('docBody').insertAdjacentHTML('beforeend',groupRow('ORDER '));}
function delRow(btn){btn.closest('tr').remove();recalcTotals();}
function dupRow(btn){var tr=btn.closest('tr');tr.after(tr.cloneNode(true));recalcTotals();}
function recalcTotals(){
  var rows=[].slice.call(document.querySelectorAll('#docBody tr:not(.group-header)')),qty=0,amt=0,nw=0,gw=0,cbm=0,n=_cfg.cols.length;
  rows.forEach(function(tr){var t=tr.children;if(TYPE==='pl'){qty+=Number(t[2].textContent)||0;nw+=Number(String(t[3].textContent).replace(/,/g,''))||0;gw+=Number(String(t[4].textContent).replace(/,/g,''))||0;cbm+=Number(String(t[5].textContent).replace(/,/g,''))||0;}else{qty+=Number(t[2].textContent)||0;amt+=Number(String(t[n-1].textContent).replace(/,/g,''))||0;}});
  document.getElementById('totalRow').innerHTML=TYPE==='pl'?'<td colspan="2" class="text-right">TOTAL:</td><td>'+fmt(qty,0)+'</td><td class="text-right">'+fmt(nw)+'</td><td class="text-right">'+fmt(gw)+'</td><td class="text-right">'+fmt(cbm,3)+'</td><td class="no-print" style="border:none;background:#f8fafc"></td>':'<td colspan="'+(n-2)+'" class="text-right">TOTAL AMOUNT:</td><td>'+fmt(qty,0)+'</td><td class="text-right">'+fmt(amt)+'</td><td class="no-print" style="border:none;background:#f8fafc"></td>';
}
document.addEventListener('input',function(e){if(e.target.closest&&e.target.closest('#docBody'))recalcTotals();});

function draftKey(){return 'doc_draft_'+TYPE+'_'+(qp('order_no')||'manual');}
function saveDraft(){try{localStorage.setItem(draftKey(),JSON.stringify({html:document.getElementById('printPage').innerHTML,ts:Date.now()}));banner('ok','✓ 草稿已保存');setTimeout(hideBanner,1500);}catch(e){banner('err','草稿保存失败');}}
function restoreDraft(){try{var d=JSON.parse(localStorage.getItem(draftKey())||'null');if(d&&d.html&&confirm('发现本地草稿，是否恢复？'))document.getElementById('printPage').innerHTML=d.html;}catch(e){}}
function downloadPng(){
  var btn=document.querySelector('.btn-download');btn.textContent='生成中...';btn.disabled=true;document.querySelector('.toolbar').style.display='none';
  var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  s.onload=function(){html2canvas(document.getElementById('printPage'),{scale:2,useCORS:true,backgroundColor:'#ffffff',logging:false}).then(function(c){document.querySelector('.toolbar').style.display='';var a=document.createElement('a');a.download=_cfg.code+'-'+(qp('order_no')||'draft')+'.png';a.href=c.toDataURL('image/png');a.click();btn.textContent='下载图片';btn.disabled=false;}).catch(function(){document.querySelector('.toolbar').style.display='';btn.textContent='下载图片';btn.disabled=false;});};
  if(window.html2canvas)s.onload();else document.head.appendChild(s);
}

function sealKey(w){return 'doc_editor_seal_'+w;}
function initRotHandle(who){var key=who==='buyer'?'Buyer':'Seller',area=document.getElementById('seal'+key),img=document.getElementById('seal'+key+'Img');if(!img)return;img.onmousedown=function(e){e.preventDefault();e.stopPropagation();img.style.cursor='grabbing';var r=area.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,sm=Math.atan2(e.clientY-cy,e.clientX-cx)*180/Math.PI,sr=_sealRotation[who]||0;function mv(ev){var a=Math.atan2(ev.clientY-cy,ev.clientX-cx)*180/Math.PI;_sealRotation[who]=sr+(a-sm);img.style.transform='rotate('+_sealRotation[who].toFixed(1)+'deg)';}function up(){img.style.cursor='grab';document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);}document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);};}
function applySeal(who,url,name){var key=who==='buyer'?'Buyer':'Seller',img=document.getElementById('seal'+key+'Img'),hint=document.getElementById('seal'+key+'Hint');_sealRotation[who]=0;if(img){img.src=url;img.style.display='block';img.style.transform='';}if(hint)hint.style.display='none';var si=document.getElementById('status'+key+'Img'),sn=document.getElementById('status'+key+'Name');if(si){si.src=url;si.style.display='inline';}if(sn){sn.textContent=name||(who==='buyer'?'买方章':'卖方章');sn.classList.remove('empty');}try{localStorage.setItem(sealKey(who),JSON.stringify({url:url,name:name||''}));}catch(e){}initRotHandle(who);}
function clearSeals(){['buyer','seller'].forEach(function(w){var key=w==='buyer'?'Buyer':'Seller',img=document.getElementById('seal'+key+'Img'),hint=document.getElementById('seal'+key+'Hint');if(img){img.src='';img.style.display='none';img.style.transform='';img.onmousedown=null;}if(hint)hint.style.display='';_sealRotation[w]=0;try{localStorage.removeItem(sealKey(w));}catch(e){}var si=document.getElementById('status'+key+'Img'),sn=document.getElementById('status'+key+'Name');if(si)si.style.display='none';if(sn){sn.textContent='未选择';sn.classList.add('empty');}});}
function dropSeal(e,who){e.preventDefault();var f=e.dataTransfer.files[0];if(!f||!f.type.startsWith('image/'))return;var r=new FileReader();r.onload=function(ev){applySeal(who,ev.target.result,f.name.replace(/\.[^.]+$/,''));};r.readAsDataURL(f);}
window.addEventListener('message',function(e){if(!e.data||e.data.type!=='seal-ready')return;applySeal(_sealTarget,e.data.dataUrl,e.data.label||'印章');closeModal();});
function switchTab(name){['das','local','make','upload'].forEach(function(t){var b=document.getElementById('tab-'+t),c=document.getElementById('tab-'+t+'-content');if(b){b.style.background=t===name?'#3b82f6':'#f1f5f9';b.style.color=t===name?'#fff':'#64748b';}if(c)c.style.display=t===name?'':'none';});if(name==='das')loadDasStamps();if(name==='local')renderLocalStamps();}
function openSealPicker(who){_sealTarget=who;document.getElementById('sealModal').style.display='flex';var tok=getToken(),das=document.getElementById('tab-das');if(tok){das.style.display='';switchTab('das');}else{das.style.display='none';loadLocalStamps();switchTab(_localStamps.length?'local':'make');}}
function closeModal(){document.getElementById('sealModal').style.display='none';}
function loadLocalStamps(){try{_localStamps=JSON.parse(localStorage.getItem('pc_local_stamps')||'[]');}catch(e){_localStamps=[];}}
function renderLocalStamps(){var g=document.getElementById('localGrid');loadLocalStamps();if(!_localStamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">暂无本地章</div>';return;}g.innerHTML=_localStamps.map(function(s,i){return '<div onclick="selLocal('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center"><img src="'+esc(s.url)+'" style="width:64px;height:64px;object-fit:contain"><div style="font-size:11px;color:#475569;margin-top:4px">'+esc(s.name||'印章')+'</div></div>';}).join('');}
function selLocal(i){loadLocalStamps();applySeal(_sealTarget,_localStamps[i].url,_localStamps[i].name);closeModal();}
function loadDasStamps(){var g=document.getElementById('stampGrid');g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载中...</div>';fetch(API+'/api/db/customer-stamps',{headers:authH()}).then(function(r){return r.json();}).then(function(d){_stamps=arr(d.stamps?d.stamps:d);if(!_stamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">DAS暂无印章</div>';return;}g.innerHTML=_stamps.map(function(s,i){return '<div onclick="selStamp('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center"><img src="'+esc(s.url)+'" style="width:64px;height:64px;object-fit:contain"><div style="font-size:11px;color:#475569;margin-top:4px">'+esc(s.name||'印章')+'</div></div>';}).join('');}).catch(function(){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载失败</div>';});}
function selStamp(i){applySeal(_sealTarget,_stamps[i].url,_stamps[i].name);closeModal();}
function onFileChosen(e){var file=e.target.files[0];if(!file)return;_pendingFile=file;var r=new FileReader();r.onload=function(ev){document.getElementById('uploadPreview').src=ev.target.result;document.getElementById('uploadPreview').style.display='block';document.getElementById('uploadPlaceholder').style.display='none';};r.readAsDataURL(file);if(!document.getElementById('uploadSealName').value)document.getElementById('uploadSealName').value=file.name.replace(/\.[^.]+$/,'');['uploadUseBtn','uploadLocalBtn'].forEach(function(id){document.getElementById(id).disabled=false;});e.target.value='';}
function useUploadedSeal(){if(!_pendingFile)return;var name=document.getElementById('uploadSealName').value.trim()||'印章',r=new FileReader();r.onload=function(ev){applySeal(_sealTarget,ev.target.result,name);closeModal();};r.readAsDataURL(_pendingFile);}
function saveSealToLocal(){if(!_pendingFile)return;var name=document.getElementById('uploadSealName').value.trim()||'印章',r=new FileReader();r.onload=function(ev){loadLocalStamps();_localStamps.unshift({id:'local_'+Date.now(),name:name,url:ev.target.result});localStorage.setItem('pc_local_stamps',JSON.stringify(_localStamps.slice(0,30)));document.getElementById('uploadStatus').textContent='已保存本地';setTimeout(function(){switchTab('local');},600);};r.readAsDataURL(_pendingFile);}
init();
