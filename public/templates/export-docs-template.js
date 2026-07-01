// export-docs-template.js — PL + SC + IV 三合一出口单据 · 正版海关单行格式（按 XM-1(6) PDF）
// 铁律：海关单行 = 汇总产品行（禁用 orders 顶层 total_qty/net_weight，那是脏值）。字段只对应不编造。
var API='https://api.sanlyn.cn';
function qp(n){return new URLSearchParams(location.search).get(n)||'';}
function tok(){try{return qp('token')||localStorage.getItem('sanlyn_jwt')||localStorage.getItem('sanlyn_token')||'';}catch(e){return '';}}
function authH(){var h={'Content-Type':'application/json'};var t=tok();if(t)h.Authorization='Bearer '+t;return h;}
function setT(id,v){var e=document.getElementById(id);if(e&&v!=null&&String(v).trim().length)e.textContent=v;}
function shortNo(no){return String(no||'').replace(/^\d+-/,'');}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmt(n,d){var x=Number(n)||0;d=(d==null?2:d);return x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});}
function banner(t,m){var i=document.getElementById('infoBanner'),e=document.getElementById('errBanner');if(i)i.style.display='none';if(e)e.style.display='none';if(t==='err'&&e){e.textContent='⚠ '+m;e.style.display='block';}if(t==='info'&&i){i.textContent=m;i.style.display='block';}}
function uniq(a){return a.filter(function(v,i){return v&&a.indexOf(v)===i;});}
function pName(p){return p.name||p.blDescription||p.bl_description||p.name_en||p.sku||'';}
function hasProd(p){return p&&(p.name||p.name_en||p.declarationName||p.blDescription||p.sku);}
function arr(d){return d&&Array.isArray(d.data)?d.data:(d&&Array.isArray(d.companies)?d.companies:(Array.isArray(d)?d:(d&&d.data?[d.data]:[])));}
function firstText(v){
  if(!v)return '';
  if(typeof v==='string')return v;
  if(Array.isArray(v))return v.map(firstText).filter(Boolean).join('\n');
  if(typeof v==='object')return v.en||v.address_en||v.full_en||v.full||v.cn||v.address||v.text||v.value||Object.keys(v).map(function(k){return firstText(v[k]);}).filter(Boolean)[0]||'';
  return String(v||'');
}
function declName(p){return p.declarationName||p.declaration_name||p.blDescription||p.bl_description||'宠物食品';}

function loadOrder(no){
  return fetch(API+'/api/db/orders?order_no='+encodeURIComponent(no),{headers:authH()})
    .then(function(r){return r.json();}).then(function(d){
      var rows=d.data||d.orders||(Array.isArray(d)?d:[]);
      if(rows.length)return rows;
      return fetch(API+'/api/db/orders?contract_no='+encodeURIComponent(no),{headers:authH()}).then(function(r){return r.json();}).then(function(d){return d.data||d.orders||(Array.isArray(d)?d:[]);});
    });
}

// 汇总所有产品行 → 按报关品名分组的海关行（真值来自产品，不用 orders 顶层脏值）
function aggregate(all){
  var groups={},rows=[],total={qty:0,nw:0,gw:0,cbm:0,amt:0};
  all.forEach(function(o){
    (o.products||(o.raw&&o.raw.products)||[]).filter(hasProd).forEach(function(p){
      var q=Number(p.qty||p.qty_ctn||0)||0;
      var nw=(Number(p.netWeight||p.net_weight||0)||0)*q;
      var gw=(Number(p.grossWeight||p.gross_weight||0)||0)*q;
      var cbm=(Number(p.cbm||p.cbmPerCtn||p.cbm_per_ctn||0)||0)*q;
      var amt=Number(p.subtotal||(q*(Number(p.unitPrice||p.unit_price||0)||0)))||0;
      var key=declName(p);
      var g=groups[key]||(groups[key]={name:key,sizes:{},qty:0,nw:0,gw:0,cbm:0,amt:0});
      g.qty+=q;g.nw+=nw;g.gw+=gw;g.cbm+=cbm;g.amt+=amt;if(p.size)g.sizes[p.size]=1;
      total.qty+=q;total.nw+=nw;total.gw+=gw;total.cbm+=cbm;total.amt+=amt;
    });
  });
  Object.keys(groups).forEach(function(k){var g=groups[k];rows.push({name:g.name,size:Object.keys(g.sizes).join(' / '),qty:g.qty,nw:g.nw,gw:g.gw,cbm:g.cbm,amt:g.amt,up:(g.qty?g.amt/g.qty:0)});});
  total.rows=rows;total.up=(total.qty?total.amt/total.qty:0);return total;
}

// 明细行（切「明细模式」时用）
function detailRows(all,mode){
  var rows=[];
  all.forEach(function(o){
    (o.products||(o.raw&&o.raw.products)||[]).filter(hasProd).forEach(function(p){
      var q=Number(p.qty||p.qty_ctn||0)||0;
      rows.push({name:pName(p),size:p.size||'',qty:q,
        nw:(Number(p.netWeight||p.net_weight||0)||0)*q,
        gw:(Number(p.grossWeight||p.gross_weight||0)||0)*q,
        cbm:(Number(p.cbm||p.cbmPerCtn||0)||0)*q,
        up:Number(p.unitPrice||p.unit_price||0)||0,
        amt:Number(p.subtotal||(q*(Number(p.unitPrice||p.unit_price||0)||0)))||0});
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
    rows.forEach(function(r,i){body+='<tr><td class="c">'+('0'+(i+1)).slice(-2)+'</td><td class="l">'+descCell(r.name,r.size)+'</td><td>'+r.qty+'</td><td>'+fmt(r.nw)+'</td><td>'+fmt(r.gw)+'</td><td>'+fmt(r.cbm,3)+'</td></tr>';});
  }
  body+='<tr class="grand"><td></td><td class="l">GRAND TOTAL:</td><td>'+agg.qty+'</td><td>'+fmt(agg.nw)+'</td><td>'+fmt(agg.gw)+'</td><td>'+fmt(agg.cbm,3)+'</td></tr>';
  document.getElementById('pl-body').innerHTML=body;
}
function renderPriced(pfx,agg,rows,cur){
  var body='';
  if(_customsMode){
    (agg.rows||[]).forEach(function(r,i){body+='<tr><td class="c">'+('0'+(i+1)).slice(-2)+'</td><td class="l">'+descCell(r.name,r.size)+'</td><td>'+r.qty+'</td><td>'+fmt(r.up)+'</td><td>'+fmt(r.amt)+'</td></tr>';});
  }else{
    rows.forEach(function(r,i){body+='<tr><td class="c">'+('0'+(i+1)).slice(-2)+'</td><td class="l">'+descCell(r.name,r.size)+'</td><td>'+r.qty+'</td><td>'+fmt(r.up)+'</td><td>'+fmt(r.amt)+'</td></tr>';});
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

function renderAll(){
  var A=window._agg,R=window._rows,cur=window._cur;
  renderPL(A,R);renderPriced('sc',A,R,cur);renderPriced('iv',A,R,cur);
}
function toggleMode(){
  _customsMode=!_customsMode;
  var b=document.getElementById('btnMode');
  if(b){b.textContent=_customsMode?'📋 明细模式':'🗃 海关模式';b.style.background=_customsMode?'#0891b2':'#059669';}
  renderAll();
}

function applySeal(url){['pl','sc','iv'].forEach(function(pfx){var img=document.getElementById(pfx+'-seal');if(img){img.src=url;img.style.display='block';}});try{localStorage.setItem('export_docs_seal',JSON.stringify({url:url}));}catch(e){}}
function pickSeal(){document.getElementById('sealFile').click();}
function onSealFile(e){var f=e.target.files[0];if(!f||!f.type.startsWith('image/'))return;var r=new FileReader();r.onload=function(ev){applySeal(ev.target.result);};r.readAsDataURL(f);e.target.value='';}
function saveDraft(){try{localStorage.setItem('export_docs_draft_'+(qp('order_no')||'manual'),JSON.stringify({pl:document.getElementById('pagePL').innerHTML,sc:document.getElementById('pageSC').innerHTML,iv:document.getElementById('pageIV').innerHTML}));banner('info','✓ 草稿已保存');setTimeout(function(){banner('','');},1500);}catch(e){}}
function downloadPng(){
  var btn=document.querySelector('.btn-dl');btn.textContent='⏳…';btn.disabled=true;document.querySelector('.toolbar').style.display='none';
  var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  s.onload=function(){var pages=['pagePL','pageSC','pageIV'],i=0;(function nx(){if(i>=pages.length){document.querySelector('.toolbar').style.display='';btn.textContent='📥 下载图片';btn.disabled=false;return;}html2canvas(document.getElementById(pages[i]),{scale:2,useCORS:true,backgroundColor:'#fff'}).then(function(c){var a=document.createElement('a');a.download=pages[i]+'-'+(qp('order_no')||'draft')+'.png';a.href=c.toDataURL('image/png');a.click();i++;setTimeout(nx,400);}).catch(function(){i++;nx();});})();};
  if(window.html2canvas)s.onload();else document.head.appendChild(s);
}

function init(){
  var orderNo=qp('order_no')||qp('orderNo');
  if(!orderNo){banner('err','请加 ?order_no=XX&token=YY');return;}
  var sibs=(qp('ids')||'').split(',').map(function(s){return s.trim();}).filter(function(s){return s&&s!==orderNo;});
  banner('info','正在拉取订单数据…');
  Promise.all([loadOrder(orderNo)].concat(sibs.map(loadOrder))).then(function(res){
    if(!res[0].length)throw new Error('订单 "'+orderNo+'" 未找到或无权限');
    var primary=res[0][0];
    var all=[primary].concat(res.slice(1).map(function(r){return r[0];}).filter(Boolean));
    all.sort(function(a,b){return String(a.order_no).localeCompare(String(b.order_no));});
    var cur=primary.currency||'CNY';
    var port=buildPort(primary);
    document.getElementById('orderLabel').textContent=orderNo;
    window._agg=aggregate(all);window._rows=detailRows(all);window._cur=cur;
    var sellerP=fetch(API+'/api/db/seller-profiles',{headers:authH()}).then(function(r){return r.json();}).catch(function(){return [];});
    var addrP=fetchBuyerAddr(primary);
    Promise.all([sellerP,addrP]).then(function(rr){
      var d=rr[0],addr=rr[1];if(addr)primary._buyerAddr=addr;
      var ps=Array.isArray(d)?d:(d.data||[]);
      var sp=(primary.seller_code&&ps.find(function(x){return x.code===primary.seller_code;}))||ps.find(function(x){return x.name_cn===primary.issuing_company||x.name_en===primary.issuing_company;})||ps.find(function(x){return x.is_default;});
      ['pl','sc','iv'].forEach(function(pfx){fillHeader(pfx,primary,all,sp,cur,port);});
      fillPriced('sc',sp,cur);fillPriced('iv',sp,cur);
      renderAll();
      if(sp&&sp.seal_url)applySeal(sp.seal_url);
      banner('','');
    });
  }).catch(function(e){banner('err',e.message);});
  try{var s=JSON.parse(localStorage.getItem('export_docs_seal')||'null');if(s&&s.url)applySeal(s.url);}catch(e){}
}
init();
