// export-docs-template.js — PL + SC + IV 三合一出口单据 · 正版海关单行格式（按 XM-1(6) PDF）
// 铁律：海关单行 = 汇总产品行（禁用 orders 顶层 total_qty/net_weight，那是脏值）。字段只对应不编造。
var API='https://api.sanlyn.cn',_pmMap={},_sealTarget='all:seller',_stamps=[],_localStamps=[],_pendingFile=null,_sealRotation={};
function qp(n){return new URLSearchParams(location.search).get(n)||'';}
function docPageParam(){var p=String(qp('page')||'').toLowerCase();return /^(pl|sc|iv)$/.test(p)?p:'';}
function applyPageFilter(){
  var only=docPageParam(),map={pl:'pagePL',sc:'pageSC',iv:'pageIV'};
  Object.keys(map).forEach(function(k){
    var el=document.getElementById(map[k]);if(el)el.style.display=(!only||only===k)?'':'none';
  });
}
function tok(){try{return qp('token')||localStorage.getItem('sanlyn_jwt')||localStorage.getItem('sanlyn_token')||'';}catch(e){return '';}}
function authH(){var h={'Content-Type':'application/json'};var t=tok();if(t)h.Authorization='Bearer '+t;return h;}
function setT(id,v){var e=document.getElementById(id);if(e&&v!=null&&String(v).trim().length)e.textContent=v;}
function shortNo(no){return String(no||'').replace(/^\d+-/,'');}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmt(n,d){var x=Number(n)||0;d=(d==null?2:d);return x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});}
function banner(t,m){var i=document.getElementById('infoBanner'),e=document.getElementById('errBanner');if(i)i.style.display='none';if(e)e.style.display='none';if(t==='err'&&e){e.textContent='⚠ '+m;e.style.display='block';}if(t==='info'&&i){i.textContent=m;i.style.display='block';}}
function uniq(a){return a.filter(function(v,i){return v&&a.indexOf(v)===i;});}
function skuKey(v){return String(v||'').toUpperCase().replace(/\s+/g,'');}
function masterName(p){var ks=[p.sku,p.cp_code,p.code,p.item_code];for(var i=0;i<ks.length;i++){var k=skuKey(ks[i]);if(k&&_pmMap[k])return _pmMap[k];}return '';}
function pName(p){return p.product_name||p.productName||p.blDescription||p.bl_description||p.name_en||p.name||masterName(p)||p.sku||'';}
function hasProd(p){return p&&(p.productName||p.product_name||p.name||p.name_en||p.declarationName||p.declaration_name||p.blDescription||p.bl_description||p.sku);}
function arr(d){return d&&Array.isArray(d.data)?d.data:(d&&Array.isArray(d.companies)?d.companies:(Array.isArray(d)?d:(d&&d.data?[d.data]:[])));}
function firstText(v){
  if(!v)return '';
  if(typeof v==='string')return v;
  if(Array.isArray(v))return v.map(firstText).filter(Boolean).join('\n');
  if(typeof v==='object')return v.en||v.address_en||v.full_en||v.full||v.cn||v.address||v.text||v.value||Object.keys(v).map(function(k){return firstText(v[k]);}).filter(Boolean)[0]||'';
  return String(v||'');
}
function declName(p){return p.declarationName||p.declaration_name||p.blDescription||p.bl_description||'宠物食品';}
function lineItems(o){return (o&&o._lineItems)||[];}
function qty(p){return Number(p.qty_ctn||p.qty||0)||0;}
function nwCtn(p){return Number(p.nw_ctn||p.netWeight||p.net_weight||0)||0;}
function gwCtn(p){return Number(p.gw_ctn||p.grossWeight||p.gross_weight||0)||0;}
function cbmCtn(p){return Number(p.cbm_ctn||p.cbm||p.cbmPerCtn||p.cbm_per_ctn||0)||0;}
function unitPrice(p){return Number(p.unit_price||p.unitPrice||0)||0;}
function amount(p){var q=qty(p),u=unitPrice(p);return Number(p.subtotal||(q*u))||0;}

function loadOrder(no){
  return fetch(API+'/api/db/orders?order_no='+encodeURIComponent(no),{headers:authH()})
    .then(function(r){return r.json();}).then(function(d){
      var rows=d.data||d.orders||(Array.isArray(d)?d:[]);
      if(rows.length)return rows;
      return fetch(API+'/api/db/orders?contract_no='+encodeURIComponent(no),{headers:authH()}).then(function(r){return r.json();}).then(function(d){return d.data||d.orders||(Array.isArray(d)?d:[]);});
    });
}
function loadOrderLineItems(order){
  var id=Number(order&&order.id);
  if(!id)return Promise.resolve([]);
  return fetch(API+'/api/db/order-line-items?order_id='+encodeURIComponent(id),{headers:authH()})
    .then(function(r){return r.json();}).then(arr);
}
function fetchProductMaster(){
  return fetch(API+'/api/db/products?limit=5000',{headers:authH()}).then(function(r){return r.json();}).then(arr).then(function(rows){
    var m={};rows.forEach(function(p){
      var v=String(p.product_name||p.productName||p.name||p.name_en||'').trim();if(!v)return;
      [p.sku,p.cp_code,p.code,p.item_code].forEach(function(c){var k=skuKey(c);if(k)m[k]=v;});
    });return m;
  }).catch(function(){return {};});
}

// 汇总所有产品行 → 按报关品名分组的海关行（真值来自产品，不用 orders 顶层脏值）
function aggregate(all){
  var groups={},rows=[],total={qty:0,nw:0,gw:0,cbm:0,amt:0};
  all.forEach(function(o){
    lineItems(o).filter(hasProd).forEach(function(p){
      var q=qty(p),nw=nwCtn(p)*q,gw=gwCtn(p)*q,cbm=cbmCtn(p)*q,amt=amount(p);
      var key=declName(p);
      var g=groups[key]||(groups[key]={name:key,sizes:{},qty:0,nw:0,gw:0,cbm:0,amt:0});
      g.qty+=q;g.nw+=nw;g.gw+=gw;g.cbm+=cbm;g.amt+=amt;if(p.size)g.sizes[p.size]=1;
      total.qty+=q;total.nw+=nw;total.gw+=gw;total.cbm+=cbm;total.amt+=amt;
    });
  });
  Object.keys(groups).forEach(function(k){var g=groups[k];rows.push({name:g.name,size:(Object.keys(g.sizes).length===1?Object.keys(g.sizes)[0]:''),qty:g.qty,nw:g.nw,gw:g.gw,cbm:g.cbm,amt:g.amt,up:(g.qty?g.amt/g.qty:0)});});
  total.rows=rows;total.up=(total.qty?total.amt/total.qty:0);return total;
}

function orderTerms(o){return o.trade_terms||(o.raw&&o.raw.trade_terms)||o.incoterm||(o.raw&&o.raw.incoterm)||'';}
function containerBits(rows,k){
  var vals=uniq((rows||[]).map(function(r){return String(r&&r[k]||'').trim();}));
  return vals.join(' / ');
}
function groupLabel(o,ctns){
  var cno=containerBits(ctns,'container_no'),seal=containerBits(ctns,'seal_no');
  return ['ORDER '+shortNo(o.order_no||o.contract_no),cno||'',containerBits(ctns,'container_type'),seal||'',orderTerms(o)].filter(Boolean).join(' · ');
}

// 明细行（切「明细模式」时用），ctnMap = {contract_no → container_bookings rows[]}
function detailRows(all,ctnMap){
  var rows=[];
  ctnMap=ctnMap||{};
  all.forEach(function(o){
    var ctns=ctnMap[o.contract_no]||ctnMap[o.order_no]||[];
    if(!Array.isArray(ctns))ctns=ctns?[ctns]:[];
    rows.push({isHeader:true,label:groupLabel(o,ctns)});
    lineItems(o).filter(hasProd).forEach(function(p){
      var q=qty(p),rn=nwCtn(p)*q,rg=gwCtn(p)*q,rc=cbmCtn(p)*q;
      rows.push({name:pName(p),size:p.size||'',qty:q,nw:rn,gw:rg,cbm:rc,up:unitPrice(p),amt:amount(p)});
    });
  });
  return rows;
}

var _customsMode=(qp("mode")!=="detail"); // 默认海关单行（正版）; mode=detail→逐SKU明细
function descCell(name,size){return '<span class="desc-name ed" contenteditable>'+esc(name)+'</span>'+(size?'<span class="desc-size ed" contenteditable>'+esc(size)+'</span>':'');}

function renderPL(agg,rows){
  var body='';
  if(_customsMode){
    (agg.rows||[]).forEach(function(r,i){body+='<tr><td class="c">'+('0'+(i+1)).slice(-2)+'</td><td class="l">'+descCell(r.name,r.size)+'</td><td>'+r.qty+'</td><td>'+fmt(r.nw)+'</td><td>'+fmt(r.gw)+'</td><td>'+fmt(r.cbm,3)+'</td></tr>';});
  }else{
    var idx=0;
    rows.forEach(function(r){
      if(r.isHeader){
        body+='<tr class="group-header"><td colspan="6" style="text-align:left">'+esc(r.label)+'</td></tr>';
      }else{
        idx++;
        body+='<tr><td class="c">'+('0'+idx).slice(-2)+'</td><td class="l">'+descCell(r.name,r.size)+'</td><td>'+r.qty+'</td><td>'+fmt(r.nw)+'</td><td>'+fmt(r.gw)+'</td><td>'+fmt(r.cbm,3)+'</td></tr>';
      }
    });
  }
  body+='<tr class="grand"><td></td><td class="l">GRAND TOTAL:</td><td>'+agg.qty+'</td><td>'+fmt(agg.nw)+'</td><td>'+fmt(agg.gw)+'</td><td>'+fmt(agg.cbm,3)+'</td></tr>';
  document.getElementById('pl-body').innerHTML=body;
}
function renderPriced(pfx,agg,rows,cur){
  var body='';
  if(_customsMode){
    (agg.rows||[]).forEach(function(r,i){body+='<tr><td class="c">'+('0'+(i+1)).slice(-2)+'</td><td class="l">'+descCell(r.name,r.size)+'</td><td>'+r.qty+'</td><td>'+fmt(r.up)+'</td><td>'+fmt(r.amt)+'</td></tr>';});
  }else{
    var idx=0;
    rows.forEach(function(r){
      if(r.isHeader){
        body+='<tr class="group-header"><td colspan="5" style="text-align:left">'+esc(r.label)+'</td></tr>';
      }else{
        idx++;
        body+='<tr><td class="c">'+('0'+idx).slice(-2)+'</td><td class="l">'+descCell(r.name,r.size)+'</td><td>'+r.qty+'</td><td>'+fmt(r.up)+'</td><td>'+fmt(r.amt)+'</td></tr>';
      }
    });
  }
  body+='<tr class="grand"><td></td><td class="l">GRAND TOTAL:</td><td>'+agg.qty+' CTN</td><td>'+cur+'</td><td>'+fmt(agg.amt)+'</td></tr>';
  document.getElementById(pfx+'-body').innerHTML=body;
}

function fillHeader(pfx,primary,all,seller,cur,port){
  setT(pfx+'-sellerName',(seller&&(seller.name_en||seller.name_cn))||primary.issuing_company||'XIAMEN PET BABY IMPORT AND EXPORT CO., LTD');
  setT(pfx+'-sellerAddr',(seller&&(seller.address_en||seller.address))||'4th Floor, 26-9# Huarong Road, Huli, Xiamen, China');
  setT(pfx+'-buyerName',primary.customer||primary.company_name_en||'');
  setT(pfx+'-buyerAddr',primary._buyerAddr||primary.customer_address||'');
  var praw=primary.raw||{};
  var fs=primary.fs_no||praw.fs_no||primary.contract_no||'';
  setT(pfx+'-no',fs);
  setT(pfx+'-order',uniq(all.map(function(o){return shortNo(o.order_no);})).join(' / '));
  setT(pfx+'-date',(primary.order_date||'').slice(0,10));
  setT(pfx+'-port',port);
  setT(pfx+'-cur',cur);
  var h1=document.getElementById(pfx+'-curh1'),h2=document.getElementById(pfx+'-curh2');
  if(h1)h1.textContent=cur;if(h2)h2.textContent=cur;
}

function fillPriced(pfx,seller,cur){
  var bank=document.getElementById(pfx+'-bank');
  if(bank&&!bank.textContent.trim()){
    if(seller){
      var acct=(cur==='USD')?(seller.usd_account||''):(seller.rmb_account||'');
      bank.innerText=['Beneficiary: '+(seller.name_en||seller.name_cn||''),'Bank: '+(seller.bank_name||''),'A/C No. ('+cur+'): '+acct,'SWIFT: '+(seller.bank_swift||''),(seller.bank_addr?'Bank Address: '+seller.bank_addr:'')].filter(function(s){return s&&!/: $/.test(s);}).join('\n')+'\n* Please verify bank info before payment.';
    }else{bank.innerText='Beneficiary: XIAMEN PET BABY IMPORT AND EXPORT CO., LTD\nBank: BANK OF CHINA XIAMEN WENZAO SUB-BRANCH\nA/C No. (CNY): 431279918006\nSWIFT: BKCHCNBJ73A\nBank Address: No. 40 North Hubin Road, Xiamen, China\n* Please verify bank info before payment.';}
  }
  var te=document.getElementById(pfx+'-terms');
  if(te&&!te.textContent.trim()){
    te.innerText=(seller&&seller.terms_sc)?seller.terms_sc:'1. Export standard cartons; goods shipped as per agreed specifications.\n2. Shipment within 30 days of deposit received.\n3. Payment: 30% Deposit, 70% balance against BL copy (unless otherwise agreed).\n4. Claims must be raised within 30 days of arrival at POD.';
  }
}
function buildPort(primary){
  var pol=primary.pol||primary.sp_pol||(primary.raw&&primary.raw.sp_pol)||'';
  var pod=primary.destination_port||primary.pod||primary.sp_pod||(primary.raw&&(primary.raw.destination_port||primary.raw.pod||primary.raw.sp_pod))||'';
  return (pol&&pod)?(pol+' → '+pod):(pol||pod||'');
}
function fetchBuyerAddr(primary){
  if((primary.customer_address||'').trim())return Promise.resolve('');
  var code=primary.company_code||'';
  if(!code)return Promise.resolve('');
  return fetch(API+'/api/db/companies?q='+encodeURIComponent(code),{headers:authH()}).then(function(r){return r.json();}).then(function(d){
    var rows=arr(d),row=rows.find(function(x){return x.code===code||x.company_code===code;})||rows[0]||{};
    return firstText(row.address_en)||firstText(row.address)||firstText(row.addresses)||firstText(row.raw&&row.raw.address)||'';
  }).catch(function(){return '';});
}
function loadContainerInfo(all){
  var contracts=uniq((all||[]).map(function(o){return o.contract_no;}).filter(Boolean));
  if(!contracts.length)return Promise.resolve({});
  return Promise.all(contracts.map(function(no){
    return fetch(API+'/api/db/container-bookings?contract_no='+encodeURIComponent(no),{headers:authH()})
      .then(function(r){return r.json();}).then(function(d){return {no:no,rows:arr(d)};})
      .catch(function(){return {no:no,rows:[]};});
  })).then(function(sets){
    var map={};
    sets.forEach(function(s){map[s.no]=s.rows||[];});
    return map;
  }).catch(function(){return {};});
}

function renderAll(){
  var A=window._agg,R=window._rows,cur=window._cur;
  renderPL(A,R);renderPriced('sc',A,R,cur);renderPriced('iv',A,R,cur);
  applyPageFilter();
}
function toggleMode(){
  _customsMode=!_customsMode;
  var b=document.getElementById('btnMode');
  if(b){b.textContent=_customsMode?'📋 明细模式':'🗃 海关模式';b.style.background=_customsMode?'#0891b2':'#059669';}
  renderAll();
}

function sealTargets(t){
  if(!t)return[];
  var a=String(t).split(':'),pages=['pl','sc','iv'];
  if(a[0]==='all')return pages.map(function(p){return p+':'+a[1];});
  return [t];
}
function sealKey(t){return 'export_docs_seal_'+String(t).replace(':','_');}
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
  if(!url){url=target;target='all:seller';}
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
  _sealTarget=target||'all:seller';document.getElementById('sealModal').style.display='flex';
  var dasTab=document.getElementById('tab-das');
  if(tok()){dasTab.style.display='';switchTab('das');}else{dasTab.style.display='none';loadLocalStamps();switchTab(_localStamps.length?'local':'make');}
}
function closeModal(){document.getElementById('sealModal').style.display='none';}
function pickSeal(){openSealPicker('all:seller');}
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
function _docUrl(fmt){
  var oid=qp('order_no')||qp('orderNo'), ids=qp('ids')||oid;
  var u='/api/db/documents?type=pack&id='+encodeURIComponent(oid)+'&ids='+encodeURIComponent(ids)+'&audience=customer';
  if(typeof _customsMode!=='undefined'&&_customsMode)u+='&customs=1';
  var pg=qp('page'); if(pg==='pl'||pg==='sc'||pg==='iv')u+='&page='+pg;
  if(fmt)u+='&format='+fmt;
  u+='&token='+encodeURIComponent(tok());
  return u;
}
function dlDoc(fmt){window.open(_docUrl(fmt),'_blank');}
function fwdDoc(){
  var link=location.href;
  var done=function(){banner('info','✓ 链接已复制,可转发');setTimeout(function(){banner('','');},2000);};
  var fb=function(){prompt('复制此链接转发:',link);};
  try{navigator.clipboard.writeText(link).then(done,fb);}catch(e){fb();}
}
function saveDraft(){try{localStorage.setItem('export_docs_draft_'+(qp('order_no')||'manual'),JSON.stringify({pl:document.getElementById('pagePL').innerHTML,sc:document.getElementById('pageSC').innerHTML,iv:document.getElementById('pageIV').innerHTML}));banner('info','✓ 草稿已保存');setTimeout(function(){banner('','');},1500);}catch(e){}}
function downloadPng(){
  var btn=document.querySelector('.btn-dl');btn.textContent='⏳…';btn.disabled=true;document.querySelector('.toolbar').style.display='none';
  var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  s.onload=function(){var only=docPageParam(),pages=only?[{pl:'pagePL',sc:'pageSC',iv:'pageIV'}[only]]:['pagePL','pageSC','pageIV'],i=0;(function nx(){if(i>=pages.length){document.querySelector('.toolbar').style.display='';btn.textContent='📥 下载图片';btn.disabled=false;return;}html2canvas(document.getElementById(pages[i]),{scale:2,useCORS:true,backgroundColor:'#fff'}).then(function(c){var a=document.createElement('a');a.download=pages[i]+'-'+(qp('order_no')||'draft')+'.png';a.href=c.toDataURL('image/png');a.click();i++;setTimeout(nx,400);}).catch(function(){i++;nx();});})();};
  if(window.html2canvas)s.onload();else document.head.appendChild(s);
}

function init(){
  applyPageFilter();
  var orderNo=qp('order_no')||qp('orderNo');
  if(!orderNo){banner('err','请加 ?order_no=XX&token=YY');return;}
  var sibs=(qp('ids')||'').split(',').map(function(s){return s.trim();}).filter(function(s){return s&&s!==orderNo;});
  banner('info','正在拉取订单数据…');
  Promise.all([loadOrder(orderNo),fetchProductMaster()].concat(sibs.map(loadOrder))).then(function(res){
    if(!res[0].length)throw new Error('订单 "'+orderNo+'" 未找到或无权限');
    _pmMap=res[1]||{};
    var primary=res[0][0];
    var all=[primary].concat(res.slice(2).map(function(r){return r[0];}).filter(Boolean));
    all.sort(function(a,b){return String(a.order_no).localeCompare(String(b.order_no));});
    var cur=primary.currency||'CNY';
    var port=buildPort(primary);
    document.getElementById('orderLabel').textContent=orderNo;
    return Promise.all(all.map(loadOrderLineItems)).then(function(lineSets){
      lineSets.forEach(function(lines,i){all[i]._lineItems=lines;});
      window._agg=aggregate(all);window._cur=cur;
      var sellerP=fetch(API+'/api/db/seller-profiles',{headers:authH()}).then(function(r){return r.json();}).catch(function(){return [];});
      var addrP=fetchBuyerAddr(primary);
      var ctnP=!_customsMode?loadContainerInfo(all):Promise.resolve({});
      return Promise.all([sellerP,addrP,ctnP]).then(function(rr){
      var d=rr[0],addr=rr[1],ctnMap=rr[2]||{};if(addr)primary._buyerAddr=addr;
      window._ctnMap=ctnMap;window._rows=detailRows(all,ctnMap);
      var ps=Array.isArray(d)?d:(d.data||[]);
      var sp=(primary.seller_code&&ps.find(function(x){return x.code===primary.seller_code;}))||ps.find(function(x){return x.name_cn===primary.issuing_company||x.name_en===primary.issuing_company;})||ps.find(function(x){return x.is_default;});
      ['pl','sc','iv'].forEach(function(pfx){fillHeader(pfx,primary,all,sp,cur,port);});
      fillPriced('sc',sp,cur);fillPriced('iv',sp,cur);
      renderAll();
      if(sp&&sp.seal_url)applySeal('all:seller',sp.seal_url,sp.name_en||sp.name_cn||'Seller seal');
      banner('','');
      });
    });
  }).catch(function(e){banner('err',e.message);});
  ['pl','sc','iv'].forEach(function(p){['buyer','seller'].forEach(function(w){try{var s=JSON.parse(localStorage.getItem(sealKey(p+':'+w))||'null');if(s&&s.url)applySeal(p+':'+w,s.url,s.name);}catch(e){}});});
}
init();
