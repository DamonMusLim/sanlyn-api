var API='https://api.sanlyn.cn';
var TYPE=(qp('type')||'pi').toLowerCase(),_cfg,_pmMap={},_sealTarget='seller',_stamps=[],_localStamps=[],_pendingFile=null,_sealRotation={buyer:0,seller:0};
var CFG={
  pi:{code:'PI',title:'PROFORMA INVOICE',cols:function(c){return ['NO.','DESCRIPTION & SIZE','QTY','PER BAG ('+c+')','CTN PRICE ('+c+')','AMOUNT ('+c+')'];},price:'selling'},
  sc:{code:'SC',title:'SALES CONTRACT',cols:function(c){return ['NO.','DESCRIPTION & SIZE','QTY','PER BAG ('+c+')','CTN PRICE ('+c+')','AMOUNT ('+c+')'];},price:'selling'},
  iv:{code:'IV',title:'COMMERCIAL INVOICE',cols:function(c){return ['NO.','DESCRIPTION & SIZE','QTY','PER BAG ('+c+')','CTN PRICE ('+c+')','AMOUNT ('+c+')'];},price:'selling'},
  pl:{code:'PL',title:'PACKING LIST',cols:function(){return ['NO.','DESCRIPTION & SIZE','CTN','NW(KG)','GW(KG)','CBM'];},price:null},
  po:{code:'PO',title:'PURCHASE ORDER',cols:function(c){return ['NO.','DESCRIPTION & SIZE','QTY','PER BAG ('+c+')','CTN PRICE ('+c+')','AMOUNT ('+c+')'];},price:'factory'}
};
function qp(n){return new URLSearchParams(location.search).get(n)||'';}
function getToken(){try{return qp('token')||localStorage.getItem('sanlyn_jwt')||localStorage.getItem('sanlyn_token')||'';}catch(e){return '';}}
function authH(){var h={'Content-Type':'application/json'},t=getToken();if(t)h.Authorization='Bearer '+t;return h;}
function arr(d){return Array.isArray(d)?d:(d&&Array.isArray(d.data)?d.data:(d&&Array.isArray(d.orders)?d.orders:[]));}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmt(n,d){var x=Number(n)||0;d=d==null?2:d;return x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});}
function num(s){return Number(String(s==null?'':s).replace(/,/g,''))||0;}
function shortNo(no){return String(no||'').replace(/^\d+-/,'');}
function uniq(a){return a.filter(function(v,i){return v&&a.indexOf(v)===i;});}
function setText(id,v,force){var e=document.getElementById(id);if(e&&(force||!e.textContent.trim())&&v!=null&&String(v).length)e.textContent=v;}
function banner(type,msg){['infoBanner','errBanner','okBanner'].forEach(function(id){var e=document.getElementById(id);if(e)e.style.display='none';});var id={info:'infoBanner',err:'errBanner',ok:'okBanner'}[type],e=document.getElementById(id);if(e&&msg){e.textContent=(type==='err'?'⚠ ':'')+msg;e.style.display='block';}}
function hideBanner(){['infoBanner','errBanner','okBanner'].forEach(function(id){var e=document.getElementById(id);if(e)e.style.display='none';});}

function init(){
  _cfg=CFG[TYPE]||CFG.pi;document.title=_cfg.title+' · Sanlyn';renderShell('CNY');
  var orderNo=qp('order_no')||qp('orderNo');if(!orderNo){banner('err','未传 order_no，请加 ?type='+TYPE+'&order_no=XX&token=YY');return;}
  var sibs=(qp('ids')||'').split(',').map(function(s){return s.trim();}).filter(function(s){return s&&s!==orderNo;});
  banner('info','正在拉取订单数据...');
  Promise.all([loadOrder(orderNo),fetchProductMaster()].concat(sibs.map(loadOrder))).then(function(res){
    if(!res[0].length)throw new Error('订单 "'+orderNo+'" 未找到或无权限');
    _pmMap=res[1]||{};
    var primary=res[0][0],all=[primary].concat(res.slice(2).map(function(r){return r[0];}).filter(Boolean));
    all.sort(function(a,b){return String(a.order_no||'').localeCompare(String(b.order_no||''));});
    fillDoc(primary,all);hideBanner();setTimeout(handleHashAction,300);
  }).catch(function(e){banner('err',e.message);});
  ['buyer','seller'].forEach(function(w){try{var s=JSON.parse(localStorage.getItem(sealKey(w))||'null');if(s&&s.url)applySeal(w,s.url,s.name);}catch(e){}});
}
function renderShell(cur){
  var cols=_cfg.cols(cur||'CNY');
  document.getElementById('docTitleEn').textContent=_cfg.title;document.getElementById('docTitleCn').textContent='';
  document.getElementById('tableHead').innerHTML=cols.map(function(c,i){return '<th class="'+(i>1?'text-right':'')+'">'+esc(c)+'</th>';}).join('')+'<th class="no-print" style="width:16px;background:#374151;border:none"></th>';
  document.getElementById('docFoot').innerHTML='<tr class="total-row" id="totalRow"></tr>';
  var cw=document.getElementById('currencyWrap');if(cw)cw.style.display=TYPE==='pl'?'none':'';
}
function loadOrder(no){
  return fetch(API+'/api/db/orders?order_no='+encodeURIComponent(no),{headers:authH()}).then(function(r){return r.json();}).then(function(d){
    var rows=arr(d);if(rows.length)return rows;
    return fetch(API+'/api/db/orders?contract_no='+encodeURIComponent(no),{headers:authH()}).then(function(r){return r.json();}).then(arr);
  });
}
function fetchProductMaster(){
  return fetch(API+'/api/db/products?limit=5000',{headers:authH()}).then(function(r){return r.json();}).then(arr).then(function(rows){
    var m={};rows.forEach(function(p){var v=String(p.name||p.name_en||p.product_name||'').split(/\s{2,}/)[0].trim();if(!v)return;[p.sku,p.cp_code,p.code,p.item_code].forEach(function(c){var k=String(c||'').toUpperCase().replace(/\s+/g,'');if(k)m[k]=v;});});return m;
  }).catch(function(){return {};});
}
function fetchSellers(){return fetch(API+'/api/db/seller-profiles',{headers:authH()}).then(function(r){return r.json();}).then(arr).catch(function(){return[];});}
function fetchVendor(name){if(!name)return Promise.resolve([]);return fetch(API+'/api/db/companies?q='+encodeURIComponent(name),{headers:authH()}).then(function(r){return r.json();}).then(arr).catch(function(){return[];});}

function fillDoc(primary,all){
  var raw=primary.raw||{},cur=primary.currency||'CNY',fs=primary.fs_no||raw.fs_no||primary.internal_no||raw.internal_no||'';
  if(!fs&&/^FS/i.test(primary.contract_no||''))fs=primary.contract_no;
  renderShell(cur);setText('contractNo',TYPE==='po'?(primary.contract_no||raw.contractNo||fs):fs,true);
  setText('orderNo',uniq(all.map(function(o){return shortNo(o.order_no);})).join(' / '),true);
  var _po=uniq(all.map(function(o){return o.customer_po;}).filter(Boolean)).join(' / ');var _poLi=document.getElementById('poNoLi');if(_po){setText('poNo',_po,true);if(_poLi)_poLi.style.display='';}else if(_poLi){_poLi.style.display='none';}
  setText('docDate',(primary.order_date||primary.created_at||'').slice(0,10)||new Date().toISOString().slice(0,10),true);
  setText('curr',cur,true);setText('curH1',cur,true);setText('curH2',cur,true);
  if(TYPE==='po')fillPoParties(primary);else fillClientParties(primary,cur);
  renderRows(all);restoreDraft();
}
function fillClientParties(primary,cur){
  setText('buyerName',primary.customer||primary.company_name_en||'',true);setText('buyerAddr',primary.customer_address||'',true);
  fetchSellers().then(function(ps){
    var p=(primary.seller_code&&ps.find(function(x){return x.code===primary.seller_code;}))||ps.find(function(x){return x.name_cn===primary.issuing_company||x.name_en===primary.issuing_company;})||ps.find(function(x){return x.is_default;});
    if(p){setText('sellerName',p.name_en||p.name_cn||primary.issuing_company||'',true);setText('sellerAddr',p.address_en||p.address||'',true);fillBankAndTerms(p,cur);if(p.seal_url)applySeal('seller',p.seal_url,p.name_en||p.name_cn||'Seller seal');}
    else{setText('sellerName',primary.issuing_company||'',true);setDefaultTerms();}
  }).catch(function(){setText('sellerName',primary.issuing_company||'',true);setDefaultTerms();});
}
function fillPoParties(primary){
  setText('buyerName',primary.issuing_company||'',true);setText('buyerAddr','',true);setText('sellerName',primary.factory||'',true);setText('sellerAddr','',true);
  fetchSellers().then(function(ps){var p=(primary.seller_code&&ps.find(function(x){return x.code===primary.seller_code;}))||ps.find(function(x){return x.name_cn===primary.issuing_company||x.name_en===primary.issuing_company;})||ps.find(function(x){return x.is_default;});if(p){setText('buyerName',p.name_en||p.name_cn||primary.issuing_company||'',true);setText('buyerAddr',p.address_en||p.address||p.address_cn||'',true);if(p.seal_url)applySeal('buyer',p.seal_url,p.name_en||p.name_cn||'Buyer seal');}}).catch(function(){});
  fetchVendor(primary.factory).then(function(cs){var c=cs.find(function(x){return x.name_cn===primary.factory||x.factory_name===primary.factory||x.name_en===primary.factory;})||cs[0];if(c){setText('sellerName',c.name_en||c.name_cn||c.factory_name||primary.factory||'',true);setText('sellerAddr',c.address_en||c.address||c.address_cn||'',true);}}).catch(function(){});
  document.getElementById('banking').innerText='';setDefaultTerms();
}
function fillBankAndTerms(p,cur){
  var acct=cur==='USD'?'Account No. (USD): '+(p.usd_account||''):'Account No. (CNY): '+(p.rmb_account||'');
  document.getElementById('banking').innerText=['Beneficiary: '+(p.name_en||p.name_cn||''),'Bank: '+(p.bank_name||''),'SWIFT: '+(p.bank_swift||''),p.bank_addr?'Bank Address: '+p.bank_addr:'',acct,'* Please verify bank info before payment.'].filter(function(s){return s&&!/: $/.test(s);}).join('\n');
  if(p.terms_iv)document.getElementById('terms').innerText=p.terms_iv;else if(p.terms_sc)document.getElementById('terms').innerText=p.terms_sc;else setDefaultTerms();
}
function setDefaultTerms(){
  var el=document.getElementById('terms');if(!el||el.innerText.trim())return;
  el.innerText='1. PACKING Export seaworthy cartons + inner packaging per approved spec sheet & sealed samples.\n2. SHIPMENT Within 30 days of receipt of deposit and written confirmation of specifications; Buyer-caused delays toll the clock.\n3. QUALITY & CLAIMS BV report + batch records; liability capped at invoice value of the defective portion only.\n4. FORCE MAJEURE Port congestion, vessel cancellation, raw material shortage or policy changes; either party may cancel without liability if delay exceeds 60 days.\n5. DISPUTES Order of precedence PI > SC > IV; Chinese law (CISG excluded); CIETAC Beijing; English; loser pays costs.';
}
function productsOf(o){var ps=o.products||(o.raw&&o.raw.products)||[];if(typeof ps==='string')try{ps=JSON.parse(ps);}catch(e){ps=[];}return (ps||[]).filter(function(p){return p&&(p.name||p.name_en||p.productName||p.product_name||p.name_cn||p.declarationName||p.declaration_name||p.sku);});}
function masterName(p){var c=[p.sku,p.cp_code,p.code,p.item_code];for(var i=0;i<c.length;i++){var k=String(c[i]||'').toUpperCase().replace(/\s+/g,'');if(k&&_pmMap[k])return _pmMap[k];}return '';}
function prodName(p){var mn=masterName(p);var n=p.name||p.name_en||p.productName||p.product_name||p.name_cn||mn||p.declarationName||p.declaration_name||p.sku||'';var sz=p.size||p.spec||p.specification||'';return sz?n+' ('+sz+')':n;}
function rowActions(){return '<td class="no-print" style="padding:2px;border-left:none"><div class="row-actions"><button class="row-btn row-btn-del" onclick="delRow(this)">×</button><button class="row-btn row-btn-dup" onclick="dupRow(this)">⧉</button></div></td>';}
function groupRow(label){return '<tr class="group-header"><td colspan="6" contenteditable>'+esc(label)+'</td><td class="no-print" style="background:#dbeafe;border:none"></td></tr>';}
function renderRows(all){
  var html='',idx=1;
  all.forEach(function(o){var ps=productsOf(o);if(!ps.length)return;html+=groupRow('ORDER '+shortNo(o.order_no||o.contract_no));ps.forEach(function(p){html+=productRow(p,idx++);});});
  document.getElementById('docBody').innerHTML=html||'<tr><td colspan="7" style="text-align:center;padding:14px;color:#94a3b8">无产品数据，可点击"＋ 加产品行"手动添加</td></tr>';
  recalcTotals();
}
function productRow(p,idx){
  var qty=Number(p.qty||p.qty_ctn||0)||0,bg=Number(p.bgBx||p.bg_bx||1)||1,cells;
  if(TYPE==='pl'){
    var nw=(Number(p.netWeight||p.net_weight||0)||0)*qty,gw=(Number(p.grossWeight||p.gross_weight||0)||0)*qty,cbm=(Number(p.cbm||p.cbmPerCtn||p.cbm_per_ctn||0)||0)*qty;
    cells=[('0'+idx).slice(-2),prodName(p),qty,fmt(nw),fmt(gw),fmt(cbm,3)];
  }else{
    var ctn=TYPE==='po'?(Number(p.factoryPrice||p.factory_price||p.unitPrice||p.unit_price||0)||0):(Number(p.sellingPrice||p.selling_price||p.unitPrice||p.unit_price||0)||0);
    var amt=TYPE==='po'?(Number(p.factorySubtotal||p.factory_subtotal||p.subtotal||(qty*ctn))||0):(Number(p.sellingSubtotal||p.selling_subtotal||p.subtotal||(qty*ctn))||0);
    cells=[('0'+idx).slice(-2),prodName(p),qty,fmt(bg?ctn/bg:ctn),fmt(ctn),fmt(amt)];
  }
  return '<tr>'+cells.map(function(c,i){return '<td contenteditable class="'+(i>1?'text-right':'')+'">'+esc(c)+'</td>';}).join('')+rowActions()+'</tr>';
}
function emptyRow(){return '<tr>'+_cfg.cols(document.getElementById('curr').textContent||'CNY').map(function(_,i){return '<td contenteditable class="'+(i>1?'text-right':'')+'"></td>';}).join('')+rowActions()+'</tr>';}
function addRow(){var b=document.getElementById('docBody');if(b.children.length===1&&b.textContent.indexOf('无产品数据')>=0)b.innerHTML='';b.insertAdjacentHTML('beforeend',emptyRow());recalcTotals();}
function addGroup(){var b=document.getElementById('docBody');if(b.children.length===1&&b.textContent.indexOf('无产品数据')>=0)b.innerHTML='';b.insertAdjacentHTML('beforeend',groupRow('ORDER '));}
function delRow(btn){btn.closest('tr').remove();recalcTotals();}
function dupRow(btn){var tr=btn.closest('tr');tr.after(tr.cloneNode(true));recalcTotals();}
function recalcTotals(){
  var rows=[].slice.call(document.querySelectorAll('#docBody tr:not(.group-header)')),qty=0,amt=0,nw=0,gw=0,cbm=0,cur=(document.getElementById('curr')||{}).textContent||'CNY';
  rows.forEach(function(tr){var t=tr.children;if(t.length<6)return;if(TYPE==='pl'){qty+=num(t[2].textContent);nw+=num(t[3].textContent);gw+=num(t[4].textContent);cbm+=num(t[5].textContent);}else{qty+=num(t[2].textContent);amt+=num(t[5].textContent);}});
  document.getElementById('totalRow').innerHTML=TYPE==='pl'?'<td colspan="2" class="text-right">TOTAL:</td><td class="text-right">'+fmt(qty,0)+'</td><td class="text-right">'+fmt(nw)+'</td><td class="text-right">'+fmt(gw)+'</td><td class="text-right">'+fmt(cbm,3)+'</td><td class="no-print" style="border:none;background:#fafafa"></td>':'<td colspan="2" class="text-right">TOTAL:</td><td class="text-right">'+fmt(qty,0)+'</td><td colspan="2" class="text-right">TOTAL AMOUNT ('+esc(cur)+'):</td><td class="text-right">'+fmt(amt)+'</td><td class="no-print" style="border:none;background:#fafafa"></td>';
}
document.addEventListener('input',function(e){if(e.target.closest&&e.target.closest('#docBody'))recalcTotals();});

function draftKey(){return 'doc_draft_'+TYPE+'_'+(qp('order_no')||qp('orderNo')||'manual');}
function saveDraft(){try{localStorage.setItem(draftKey(),JSON.stringify({html:document.getElementById('printPage').innerHTML,ts:Date.now()}));banner('ok','✓ 草稿已保存');setTimeout(hideBanner,1500);}catch(e){banner('err','草稿保存失败');}}
function restoreDraft(){try{var d=JSON.parse(localStorage.getItem(draftKey())||'null');if(d&&d.html&&confirm('发现本地草稿，是否恢复？')){document.getElementById('printPage').innerHTML=d.html;recalcTotals();['buyer','seller'].forEach(initRotHandle);}}catch(e){}}
function downloadPng(){
  var btn=document.querySelector('.btn-download');if(btn){btn.textContent='生成中...';btn.disabled=true;}document.querySelector('.toolbar').style.display='none';
  function done(){document.querySelector('.toolbar').style.display='';if(btn){btn.textContent='下载图片';btn.disabled=false;}}
  function run(){html2canvas(document.getElementById('printPage'),{scale:2,useCORS:true,backgroundColor:'#ffffff',logging:false}).then(function(c){done();var a=document.createElement('a');a.download=_cfg.code+'-'+(qp('order_no')||'draft')+'.png';a.href=c.toDataURL('image/png');a.click();}).catch(done);}
  if(window.html2canvas)return run();var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';s.onload=run;s.onerror=done;document.head.appendChild(s);
}
function exportExcel(){
  var btn=document.querySelector('.btn-excel');if(btn){btn.textContent='生成中...';btn.disabled=true;}
  function reset(){if(btn){btn.textContent='下载Excel';btn.disabled=false;}}
  function run(){try{
    var aoa=[],heads=[].map.call(document.querySelectorAll('#tableHead th'),function(t){return t.textContent.trim();}).filter(Boolean);
    aoa.push([document.getElementById('docTitleEn').textContent]);aoa.push(['No.',document.getElementById('contractNo').textContent,'Order No.',document.getElementById('orderNo').textContent,'Date',document.getElementById('docDate').textContent]);aoa.push(['Buyer',document.getElementById('buyerName').textContent,'Seller',document.getElementById('sellerName').textContent]);aoa.push([]);aoa.push(heads);
    [].forEach.call(document.querySelectorAll('#docBody tr'),function(tr){if(tr.classList.contains('group-header')){aoa.push([tr.textContent.trim()]);return;}var cells=[].map.call(tr.querySelectorAll('td[contenteditable]'),function(td){var v=td.textContent.trim(),n=num(v);return v&&/^[\d,.]+$/.test(v)?n:v;});if(cells.length)aoa.push(cells);});
    var total=[].map.call(document.querySelectorAll('#totalRow td:not(.no-print)'),function(td){return td.textContent.trim();});if(total.length)aoa.push(total);
    var wb=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet(aoa);ws['!cols']=heads.map(function(h,i){return {wch:i===1?38:16};});XLSX.utils.book_append_sheet(wb,ws,_cfg.code);XLSX.writeFile(wb,_cfg.code+'-'+(qp('order_no')||'draft')+'.xlsx');
  }catch(e){alert('导出失败: '+e.message);}reset();}
  if(window.XLSX)return run();var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';s.onload=run;s.onerror=function(){alert('Excel库加载失败');reset();};document.head.appendChild(s);
}
function handleHashAction(){var h=(location.hash||'').toLowerCase();if(h.indexOf('excel')>=0)exportExcel();else if(h.indexOf('seal')>=0||h.indexOf('stamp')>=0)openSealPicker('seller');else if(h.indexOf('print')>=0)window.print();}

function sealKey(w){return 'doc_editor_seal_'+w;}
function initRotHandle(who){var key=who==='buyer'?'Buyer':'Seller',area=document.getElementById('seal'+key),img=document.getElementById('seal'+key+'Img');if(!img||!area)return;img.onmousedown=function(e){e.preventDefault();e.stopPropagation();img.style.cursor='grabbing';var r=area.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2,sm=Math.atan2(e.clientY-cy,e.clientX-cx)*180/Math.PI,sr=_sealRotation[who]||0;function mv(ev){var a=Math.atan2(ev.clientY-cy,ev.clientX-cx)*180/Math.PI;_sealRotation[who]=sr+(a-sm);img.style.transform='rotate('+_sealRotation[who].toFixed(1)+'deg)';}function up(){img.style.cursor='grab';document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);}document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);};}
function applySeal(who,url,name){var key=who==='buyer'?'Buyer':'Seller',img=document.getElementById('seal'+key+'Img'),hint=document.getElementById('seal'+key+'Hint');_sealRotation[who]=0;if(img){img.src=url;img.style.display='block';img.style.transform='';}if(hint)hint.style.display='none';var si=document.getElementById('status'+key+'Img'),sn=document.getElementById('status'+key+'Name');if(si){si.src=url;si.style.display='inline';}if(sn){sn.textContent=name||(who==='buyer'?'买方章':'卖方章');sn.classList.remove('empty');}try{localStorage.setItem(sealKey(who),JSON.stringify({url:url,name:name||''}));}catch(e){}initRotHandle(who);}
function clearSeals(){['buyer','seller'].forEach(function(w){var key=w==='buyer'?'Buyer':'Seller',img=document.getElementById('seal'+key+'Img'),hint=document.getElementById('seal'+key+'Hint'),si=document.getElementById('status'+key+'Img'),sn=document.getElementById('status'+key+'Name');if(img){img.src='';img.style.display='none';img.style.transform='';img.onmousedown=null;}if(hint)hint.style.display='';if(si)si.style.display='none';if(sn){sn.textContent='未选择';sn.classList.add('empty');}_sealRotation[w]=0;try{localStorage.removeItem(sealKey(w));}catch(e){}});}
function dropSeal(e,who){e.preventDefault();var f=e.dataTransfer.files&&e.dataTransfer.files[0];if(!f||!f.type.startsWith('image/'))return;var r=new FileReader();r.onload=function(ev){applySeal(who,ev.target.result,f.name.replace(/\.[^.]+$/,''));};r.readAsDataURL(f);}
window.addEventListener('message',function(e){if(!e.data||e.data.type!=='seal-ready')return;applySeal(_sealTarget,e.data.dataUrl,e.data.label||'印章');closeModal();});
function switchTab(name){['das','local','make','upload'].forEach(function(t){var b=document.getElementById('tab-'+t),c=document.getElementById('tab-'+t+'-content');if(b){b.style.background=t===name?'#3b82f6':'#f1f5f9';b.style.color=t===name?'#fff':'#64748b';}if(c)c.style.display=t===name?'':'none';});if(name==='das')loadDasStamps();if(name==='local')renderLocalStamps();}
function openSealPicker(who){_sealTarget=who||'seller';document.getElementById('sealModal').style.display='flex';var das=document.getElementById('tab-das');if(getToken()){das.style.display='';switchTab('das');}else{das.style.display='none';loadLocalStamps();switchTab(_localStamps.length?'local':'make');}}
function closeModal(){document.getElementById('sealModal').style.display='none';}
function loadLocalStamps(){try{_localStamps=JSON.parse(localStorage.getItem('pc_local_stamps')||'[]');}catch(e){_localStamps=[];}}
function renderLocalStamps(){var g=document.getElementById('localGrid');loadLocalStamps();if(!_localStamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">暂无本地章</div>';return;}g.innerHTML=_localStamps.map(function(s,i){return '<div onclick="selLocal('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center"><img src="'+esc(s.url)+'" style="width:64px;height:64px;object-fit:contain"><div style="font-size:11px;color:#475569;margin-top:4px">'+esc(s.name||'印章')+'</div></div>';}).join('');}
function selLocal(i){loadLocalStamps();if(_localStamps[i]){applySeal(_sealTarget,_localStamps[i].url,_localStamps[i].name);closeModal();}}
function loadDasStamps(){var g=document.getElementById('stampGrid');g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载中...</div>';fetch(API+'/api/db/customer-stamps',{headers:authH()}).then(function(r){return r.json();}).then(function(d){_stamps=arr(d.stamps?d.stamps:d);if(!_stamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">DAS暂无印章</div>';return;}g.innerHTML=_stamps.map(function(s,i){return '<div onclick="selStamp('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center"><img src="'+esc(s.url)+'" style="width:64px;height:64px;object-fit:contain"><div style="font-size:11px;color:#475569;margin-top:4px">'+esc(s.name||'印章')+'</div></div>';}).join('');}).catch(function(){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载失败</div>';});}
function selStamp(i){if(_stamps[i]){applySeal(_sealTarget,_stamps[i].url,_stamps[i].name);closeModal();}}
function onFileChosen(e){var file=e.target.files[0];if(!file)return;_pendingFile=file;var r=new FileReader();r.onload=function(ev){document.getElementById('uploadPreview').src=ev.target.result;document.getElementById('uploadPreview').style.display='block';document.getElementById('uploadPlaceholder').style.display='none';};r.readAsDataURL(file);if(!document.getElementById('uploadSealName').value)document.getElementById('uploadSealName').value=file.name.replace(/\.[^.]+$/,'');['uploadUseBtn','uploadLocalBtn'].forEach(function(id){document.getElementById(id).disabled=false;});e.target.value='';}
function useUploadedSeal(){if(!_pendingFile)return;var name=document.getElementById('uploadSealName').value.trim()||'印章',r=new FileReader();r.onload=function(ev){applySeal(_sealTarget,ev.target.result,name);closeModal();};r.readAsDataURL(_pendingFile);}
function saveSealToLocal(){if(!_pendingFile)return;var name=document.getElementById('uploadSealName').value.trim()||'印章',r=new FileReader();r.onload=function(ev){loadLocalStamps();_localStamps.unshift({id:'local_'+Date.now(),name:name,url:ev.target.result});localStorage.setItem('pc_local_stamps',JSON.stringify(_localStamps.slice(0,30)));document.getElementById('uploadStatus').textContent='已保存本地';setTimeout(function(){switchTab('local');},600);};r.readAsDataURL(_pendingFile);}
init();
