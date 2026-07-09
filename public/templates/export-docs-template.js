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
function normCno(v){return String(v||'').trim().toUpperCase();}
function skuKey(v){return String(v||'').toUpperCase().replace(/\s+/g,'');}
function masterMeta(p){var ks=[p.sku,p.cp_code,p.code,p.item_code];for(var i=0;i<ks.length;i++){var k=skuKey(ks[i]);if(k&&_pmMap[k])return (typeof _pmMap[k]==='string')?{name:_pmMap[k]}:_pmMap[k];}return null;}
function masterName(p){var m=masterMeta(p);return (m&&m.name)||'';}
function codeOf(p){return p.sku||p.cp_code||p.code||p.item_code||'';}
function barcodeOf(p){var m=masterMeta(p)||{},sku=codeOf(p);return p.barcode||p.bar_code||m.barcode||m.factory_code||sku||'';}
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
// 铁律(2026-07-04 Damon拍板):英文版品名一律=报关英文名 declaration_name_en,缺失红标绝不现场翻译造词
function declNameEn(p){var m=masterMeta(p)||{};return p.declaration_name_en||p.declarationNameEn||m.decl_en||'';}
function lineItems(o){return (o&&o._lineItems)||[];}
function qty(p){return Number(p.qty_ctn||p.qty||0)||0;}
function unitOf(p){return p.unit||p.unitOfMeasure||'CTN';}
function qtyUnit(q,u){return String(Math.round(Number(q)||0))+(u||'CTN');}
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
      var v=String(p.product_name||p.productName||p.name||p.name_en||'').trim();
      var meta={name:v,barcode:String(p.barcode||p.bar_code||'').trim(),factory_code:String(p.factory_code||p.factoryCode||'').trim(),decl_en:String(p.declaration_name_en||'').trim()};
      [p.sku,p.cp_code,p.code,p.item_code].forEach(function(c){var k=skuKey(c);if(k)m[k]=meta;});
    });return m;
  }).catch(function(){return {};});
}

// 汇总所有产品行 → 按报关品名分组的海关行（真值来自产品，不用 orders 顶层脏值）
function aggregate(all){
  var groups={},rows=[],total={qty:0,nw:0,gw:0,cbm:0,amt:0};
  all.forEach(function(o){
    lineItems(o).filter(hasProd).forEach(function(p){
      var q=qty(p),nw=nwCtn(p)*q,gw=gwCtn(p)*q,cbm=cbmCtn(p)*q,amt=amount(p);
      // 英文版按报关英文名聚合(对齐提单9品名:猫砂盆/自动猫砂盆/指甲剪/宠物用品都归PET PRODUCTS);中文版按中文报关名
      var key=(_langEn&&declNameEn(p))?declNameEn(p):declName(p);
      var g=groups[key]||(groups[key]={name:key,sizes:{},qty:0,nw:0,gw:0,cbm:0,amt:0});
      if(!g.nameEn)g.nameEn=declNameEn(p);
      g.qty+=q;g.nw+=nw;g.gw+=gw;g.cbm+=cbm;g.amt+=amt;if(p.size)g.sizes[p.size]=1;
      total.qty+=q;total.nw+=nw;total.gw+=gw;total.cbm+=cbm;total.amt+=amt;
    });
  });
  Object.keys(groups).forEach(function(k){var g=groups[k];rows.push({name:g.name,nameEn:g.nameEn||(g.name==='宠物食品'?'PET FOOD':''),size:(Object.keys(g.sizes).length===1?Object.keys(g.sizes)[0]:''),qty:g.qty,nw:g.nw,gw:g.gw,cbm:g.cbm,amt:g.amt,up:(g.qty?g.amt/g.qty:0)});});
  total.rows=rows;total.up=(total.qty?total.amt/total.qty:0);return total;
}

function orderTerms(o){return o.trade_terms||(o.raw&&o.raw.trade_terms)||o.incoterm||(o.raw&&o.raw.incoterm)||'';}
function containerBits(rows,k){
  var vals=uniq((rows||[]).map(function(r){return String(r&&r[k]||'').trim();}));
  return vals.join(' / ');
}
function groupLabel(orders,ctns,terms){
  orders=Array.isArray(orders)?orders:[orders];
  var nos=uniq(orders.map(function(o){return shortNo((o&&o.order_no)||(o&&o.contract_no));}));
  var cno=containerBits(ctns,'container_no'),seal=containerBits(ctns,'seal_no');
  return ['ORDER '+nos.join(' / '),cno||'',containerBits(ctns,'container_type'),seal||'',terms||''].filter(Boolean).join(' · ');
}

function orderContainersFromMap(o,ctnMap){
  var ctns=ctnMap[o.id]||ctnMap[o.order_no]||ctnMap[o.contract_no]||[];
  if(!Array.isArray(ctns))ctns=ctns?[ctns]:[];
  return ctns;
}
function orderHasContainer(o,ctnMap,containerNo){
  var want=normCno(containerNo);
  if(!want)return true;
  return orderContainersFromMap(o,ctnMap).some(function(c){return normCno(c&&c.container_no)===want;});
}
function orderRaw(o){var r=o&&o.raw;if(typeof r==='string')try{return JSON.parse(r)||{};}catch(e){return{};}return (r&&typeof r==='object')?r:{};}
function fsFromOrder(o){
  var r=orderRaw(o), vals=[o&&o.fs_no,r.fs_no,r.fsNo,o&&o.internal_no,r.internal_no,r.internalNo,o&&o.contract_no,o&&o.order_no];
  for(var i=0;i<vals.length;i++){var m=String(vals[i]||'').match(/\bFS[0-9A-Z-]+\b/i);if(m)return m[0].toUpperCase();}
  return '';
}

// 明细行（切「明细模式」时用），ctnMap = {contract_no/order_id → container rows[]}
function detailRows(all,ctnMap){
  var rows=[],groups={},order=[];
  ctnMap=ctnMap||{};
  all.forEach(function(o){
    var ctns=orderContainersFromMap(o,ctnMap);
    var cnos=uniq(ctns.map(function(c){return String(c&&c.container_no||'').trim();}));
    var key=cnos.length?cnos.join(' / '):('__order__'+(o.id||o._id||o.contract_no||o.order_no||order.length));
    if(!groups[key]){
      groups[key]={orders:[],emptyOrders:[],ctns:[],terms:'',items:[]};
      order.push(key);
    }
    var g=groups[key];
    ctns.forEach(function(c){g.ctns.push(c);});
    if(!g.terms)g.terms=orderTerms(o);
    var itemRows=lineItems(o).filter(hasProd).map(function(p){
      var q=qty(p),rn=nwCtn(p)*q,rg=gwCtn(p)*q,rc=cbmCtn(p)*q;
      return {code:codeOf(p),barcode:barcodeOf(p),name:pName(p),nameEn:declNameEn(p),size:p.size||'',qty:q,unit:unitOf(p),nw:rn,gw:rg,cbm:rc,up:unitPrice(p),amt:amount(p)};
    });
    if(itemRows.length)g.orders.push(o);else g.emptyOrders.push(o);
    itemRows.forEach(function(r){g.items.push(r);});
  });
  order.forEach(function(k){
    var g=groups[k];
    if(!g.items.length)return;
    rows.push({isHeader:true,label:groupLabel(g.orders.concat(g.emptyOrders),g.ctns,g.terms)});
    g.items.forEach(function(r){rows.push(r);});
  });
  return rows;
}

var _customsMode=(qp("mode")!=="detail"); // 默认海关单行（正版）; mode=detail→逐SKU明细
var _langEn=(qp('lang')==='en'); // lang=en → 全英文版:品名=报关英文名
function dispName(r){if(!_langEn)return {name:r.name,miss:false};var n=r.nameEn||'';return n?{name:n,miss:false}:{name:'⚠ EN NAME MISSING',miss:true};}
function enUnit(u){if(!_langEn)return u;var m={'组':'SET','套':'SET','个':'PCS','件':'PCS','只':'PCS','条':'PCS','箱':'CTN'};return m[String(u||'').trim()]||u;}
function enSize(s){if(!_langEn)return s;return String(s||'').replace(/层/g,'-LAYER').replace(/米/g,'M');}
function descCell(name,size,miss){return '<span class="desc-name ed"'+(miss?' style="color:#dc2626"':'')+' contenteditable>'+esc(name)+'</span>'+(size?'<span class="desc-size ed" contenteditable>'+esc(size)+'</span>':'');}
function setPLHeader(detail){
  var tb=document.querySelector('#pagePL table thead tr');if(!tb)return;
  tb.innerHTML=detail
    ? '<th class="c" style="width:36px">NO.</th><th style="width:120px">BARCODE</th><th class="l">DESCRIPTION &amp; SIZE</th><th style="width:75px">QTY</th><th style="width:85px">N.W. (KG)</th><th style="width:85px">G.W. (KG)</th><th style="width:75px">CBM (M³)</th>'
    : '<th class="c" style="width:36px">NO.</th><th class="l">DESCRIPTION &amp; SIZE</th><th style="width:80px">QTY (CTN)</th><th style="width:100px">N.W. (KG)</th><th style="width:100px">G.W. (KG)</th><th style="width:90px">CBM (M³)</th>';
}

function renderPL(agg,rows){
  var body='';
  if(_customsMode){
    setPLHeader(false);
    (agg.rows||[]).forEach(function(r,i){var dn=dispName(r);body+='<tr><td class="c">'+('0'+(i+1)).slice(-2)+'</td><td class="l">'+descCell(dn.name,enSize(r.size),dn.miss)+'</td><td>'+qtyUnit(r.qty,'CTN')+'</td><td>'+fmt(r.nw)+'</td><td>'+fmt(r.gw)+'</td><td>'+fmt(r.cbm,3)+'</td></tr>';});
  }else{
    setPLHeader(true);
    var idx=0;
    rows.forEach(function(r){
      if(r.isHeader){
        body+='<tr class="group-header"><td colspan="7" style="text-align:left">'+esc(r.label)+'</td></tr>';
      }else{
        idx++;
        var dn=dispName(r);
        body+='<tr><td class="c">'+('0'+idx).slice(-2)+'</td><td class="c">'+esc(r.barcode)+'</td><td class="l">'+descCell(dn.name,enSize(r.size),dn.miss)+'</td><td>'+qtyUnit(r.qty,enUnit(r.unit))+'</td><td>'+fmt(r.nw)+'</td><td>'+fmt(r.gw)+'</td><td>'+fmt(r.cbm,3)+'</td></tr>';
      }
    });
  }
  body+=_customsMode
    ? '<tr class="grand"><td></td><td class="l">GRAND TOTAL:</td><td>'+qtyUnit(agg.qty,'CTN')+'</td><td>'+fmt(agg.nw)+'</td><td>'+fmt(agg.gw)+'</td><td>'+fmt(agg.cbm,3)+'</td></tr>'
    : '<tr class="grand"><td></td><td></td><td class="l">GRAND TOTAL:</td><td>'+qtyUnit(agg.qty,'CTN')+'</td><td>'+fmt(agg.nw)+'</td><td>'+fmt(agg.gw)+'</td><td>'+fmt(agg.cbm,3)+'</td></tr>';
  document.getElementById('pl-body').innerHTML=body;
}
function renderPriced(pfx,agg,rows,cur){
  var body='';
  if(_customsMode){
    (agg.rows||[]).forEach(function(r,i){var dn=dispName(r);body+='<tr><td class="c">'+('0'+(i+1)).slice(-2)+'</td><td class="l">'+descCell(dn.name,enSize(r.size),dn.miss)+'</td><td>'+r.qty+'</td><td>'+fmt(r.up)+'</td><td>'+fmt(r.amt)+'</td></tr>';});
  }else{
    var idx=0;
    rows.forEach(function(r){
      if(r.isHeader){
        body+='<tr class="group-header"><td colspan="5" style="text-align:left">'+esc(r.label)+'</td></tr>';
      }else{
        idx++;
        var dn=dispName(r);
        body+='<tr><td class="c">'+('0'+idx).slice(-2)+'</td><td class="l">'+descCell(dn.name,enSize(r.size),dn.miss)+'</td><td>'+r.qty+'</td><td>'+fmt(r.up)+'</td><td>'+fmt(r.amt)+'</td></tr>';
      }
    });
  }
  // 运费/杂费行(仅SC/IV,不进PL;不含税,金额直接进合计)——存 primary.raw.inland_freight
  var frt=Number(window._freight||0)||0, grand=Number(agg.amt||0)+frt;
  if(frt>0){
    var flbl=_langEn?(window._freightLabelEn||'INLAND FREIGHT'):(window._freightLabel||'提货运费');
    body+='<tr><td></td><td class="l">'+esc(flbl)+'</td><td></td><td></td><td>'+fmt(frt)+'</td></tr>';
  }
  body+='<tr class="grand"><td></td><td class="l">GRAND TOTAL:</td><td>'+agg.qty+' CTN</td><td>'+(_customsMode?cur:'')+'</td><td>'+fmt(grand)+'</td></tr>';  // 客户版不显CNY
  document.getElementById(pfx+'-body').innerHTML=body;
}

function fillHeader(pfx,primary,all,seller,cur,port){
  setT(pfx+'-sellerName',(seller&&(seller.name_en||seller.name_cn))||primary.issuing_company||'XIAMEN PET BABY IMPORT AND EXPORT CO., LTD');
  setT(pfx+'-sellerAddr',(seller&&(seller.address_en||seller.address))||'4th Floor, 26-9# Huarong Road, Huli, Xiamen, China');
  setT(pfx+'-buyerName',primary.customer||primary.company_name_en||'');
  setT(pfx+'-buyerAddr',primary._buyerAddr||primary.customer_address||'');
  var praw=orderRaw(primary);
  // 多单合并只显示【主订单(URL order_no那个=primary)】的一个FS,不再把全部FS用 / 拼(Damon 2026-07-08定案);单单自然=它自己的FS/PO
  // 主FS取【URL order_no 指定的那单】(Damon 2026-07-08:多单合并显示主订单的FS),不是排序后的all[0];找不到才退primary
  var _urlNo=qp('order_no')||qp('orderNo');
  var _fsOrder=all.filter(function(o){return o&&(String(o.order_no)===_urlNo||shortNo(o.order_no)===shortNo(_urlNo));})[0]||primary;
  var fs=fsFromOrder(_fsOrder)||_fsOrder.fs_no||primary.fs_no||praw.fs_no||_fsOrder.contract_no||_fsOrder.customer_po||'';
  setT(pfx+'-no',fs);
  setT(pfx+'-order',uniq(all.map(function(o){return shortNo(o.order_no);})).join(' / '));
  setT(pfx+'-date',(primary.order_date||'').slice(0,10));
  setT(pfx+'-port',portLine(primary));  // 分模式:报关版XIAMEN/客户版实际起运港(不再用固定port参数)
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
// 港口名中→英规范化：认识的转英文大写，不认识的原样保留(绝不乱翻/造词)
var PORT_EN={'青岛':'QINGDAO','上海':'SHANGHAI','宁波':'NINGBO','宁波北仑':'NINGBO','深圳':'SHENZHEN','厦门':'XIAMEN','天津':'TIANJIN','大连':'DALIAN','广州':'GUANGZHOU','连云港':'LIANYUNGANG','蛇口':'SHEKOU','盐田':'YANTIAN','南沙':'NANSHA','泉州':'QUANZHOU','锦州':'JINZHOU','福州':'FUZHOU','巴生':'PORT KLANG','巴生港':'PORT KLANG','巴生西':'PORT KLANG (WESTPORT)','巴生西港':'PORT KLANG (WESTPORT)','巴生北':'PORT KLANG (NORTHPORT)'};
function normPort(x){if(!x)return '';var t=String(x).trim();if(PORT_EN[t])return PORT_EN[t];var t2=t.replace(/港$/,'');if(PORT_EN[t2])return PORT_EN[t2];return /[\u4e00-\u9fa5]/.test(t)?t:t.toUpperCase();}
function buildPort(primary){
  var pol=normPort(primary.pol||primary.sp_pol||(primary.raw&&primary.raw.sp_pol)||'');
  var pod=normPort(primary.destination_port||primary.pod||primary.sp_pod||(primary.raw&&(primary.raw.destination_port||primary.raw.pod||primary.raw.sp_pod))||'');
  return (pol&&pod)?(pol+' → '+pod):(pol||pod||'');
}
// 起运港=货实际起运的港(Damon 2026-07-09定案A:厦门是报关地属报关单另一栏,不占这里,取消硬写XIAMEN)。
// 来源优先级:①该票orders.pol(实录) ②工厂就近港 factories.ports[0](_factoryPorts map,按factory_code) ③空。
// 客户版港口条另在renderAll按_customsMode整条隐藏(Damon:客户版不显港口)。
var _factoryPorts={}; // {company_code → ports数组} 由 loadFactoryPorts() 填
function factoryFirstPort(factoryCode){
  var arr=_factoryPorts[factoryCode]||[];
  if(!arr.length)return '';
  var item=String(arr[0]||''); // 形如 "Qingdao 青岛"
  var cn=item.split(/\s+/).filter(function(w){return /[一-龥]/.test(w);})[0];
  return normPort(cn||item);
}
function portLine(primary){
  if(!primary)return '';
  var pol=normPort(primary.pol||primary.sp_pol||(primary.raw&&primary.raw.sp_pol)||'');
  if(!pol)pol=factoryFirstPort(primary.factory_code||(primary.raw&&primary.raw.factory_code)||'');
  var pod=normPort(primary.destination_port||primary.pod||primary.sp_pod||(primary.raw&&(primary.raw.destination_port||primary.raw.pod||primary.raw.sp_pod))||'');
  return (pol&&pod)?(pol+' → '+pod):(pol||pod||'');
}
function loadFactoryPorts(){
  return fetch(API+'/api/db/factory-ports',{headers:authH()}).then(function(r){return r.ok?r.json():{data:[]};}).then(function(d){
    (d&&d.data||[]).forEach(function(row){if(row&&row.company_code)_factoryPorts[row.company_code]=row.ports||[];});
  }).catch(function(){});
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
  if(!(all||[]).length)return Promise.resolve({});
  return Promise.all((all||[]).map(function(o){
    var oid=o&&o.id, no=o&&o.contract_no;
    var primary=oid?fetch(API+'/api/db/containers?action=list_by_order&order_id='+encodeURIComponent(oid),{headers:authH()})
      .then(function(r){return r.ok?r.json():{data:[]};}).then(arr).catch(function(){return [];}):Promise.resolve([]);
    return primary.then(function(rows){
      if(rows&&rows.length)return {order:o,rows:rows};
      if(!no)return {order:o,rows:[]};
      return fetch(API+'/api/db/container-bookings?contract_no='+encodeURIComponent(no),{headers:authH()})
        .then(function(r){return r.json();}).then(function(d){return {order:o,rows:arr(d)};})
        .catch(function(){return {order:o,rows:[]};});
    });
  })).then(function(sets){
    var map={};
    sets.forEach(function(s){
      var o=s.order||{};
      if(o.contract_no)map[o.contract_no]=s.rows||[];
      if(o.order_no)map[o.order_no]=s.rows||[];
      if(o.id)map[o.id]=s.rows||[];
    });
    return map;
  }).catch(function(){return {};});
}

function renderAll(){
  var A=window._agg,R=window._rows,cur=window._cur;
  renderPL(A,R);renderPriced('sc',A,R,cur);renderPriced('iv',A,R,cur);
  // 港口随模式(报关/客户)切换实时更新起运港(报关版XIAMEN/客户版实际港)
  if(window._docPrimary)['pl','sc','iv'].forEach(function(p){var v=portLine(window._docPrimary);var e=document.getElementById(p+'-port');if(e)e.textContent=v;});
  // 客户版(detail)不要港口条、不要CNY(Damon 2026-07-08):隐藏港口栏 + 表头(CNY)括号;报关版(customs)保留
  try{
    var showCur=_customsMode;
    document.querySelectorAll('.portbar').forEach(function(el){el.style.display=showCur?'':'none';});
    document.querySelectorAll('.curwrap').forEach(function(el){el.style.display=showCur?'':'none';});
  }catch(e){}
  applyPageFilter();
}
function toggleMode(){
  _customsMode=!_customsMode;
  var b=document.getElementById('btnMode');
  if(b){b.textContent=_customsMode?'📋 明细模式':'🗃 海关模式';b.style.background=_customsMode?'#0891b2':'#059669';}
  renderAll();
}
function syncLangBtn(){var b=document.getElementById('btnLang');if(b){b.textContent=_langEn?'🌐 中文版':'🌐 English';b.style.background=_langEn?'#059669':'#475569';}}
function toggleLang(){
  _langEn=!_langEn;syncLangBtn();
  try{var u=new URL(location.href);if(_langEn)u.searchParams.set('lang','en');else u.searchParams.delete('lang');history.replaceState(null,'',u.toString());}catch(e){}
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
    if(!img)return;_sealRotation[t]=0;img.crossOrigin='anonymous';img.src=url;img.style.display='block';img.style.transform='';if(hint)hint.style.display='none';
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
  var cno=qp('container_no'); if(cno)u+='&container_no='+encodeURIComponent(cno);
  var pg=qp('page'); if(pg==='pl'||pg==='sc'||pg==='iv')u+='&page='+pg;
  if(_langEn)u+='&lang=en';
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
function docBaseName(){return window._docBaseName||qp('order_no')||'draft';}
function downloadPng(){
  var btn=document.querySelector('.btn-dl');btn.textContent='⏳…';btn.disabled=true;document.querySelector('.toolbar').style.display='none';
  var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  s.onload=function(){var only=docPageParam(),pages=only?[{pl:'pagePL',sc:'pageSC',iv:'pageIV'}[only]]:['pagePL','pageSC','pageIV'],i=0;(function nx(){if(i>=pages.length){document.querySelector('.toolbar').style.display='';btn.textContent='📥 下载图片';btn.disabled=false;return;}html2canvas(document.getElementById(pages[i]),{scale:2,useCORS:true,backgroundColor:'#fff'}).then(function(c){var a=document.createElement('a');a.download=pages[i]+'-'+docBaseName()+'.png';a.href=c.toDataURL('image/png');a.click();i++;setTimeout(nx,400);}).catch(function(){i++;nx();});})();};
  if(window.html2canvas)s.onload();else document.head.appendChild(s);
}

function init(){
  applyPageFilter();syncLangBtn();
  var orderNo=qp('order_no')||qp('orderNo');
  var onlyContainer=qp('container_no');
  if(!orderNo){banner('err','请加 ?order_no=XX&token=YY');return;}
  var sibs=(qp('ids')||'').split(',').map(function(s){return s.trim();}).filter(function(s){return s&&s!==orderNo;});
  banner('info','正在拉取订单数据…');
  var _fpP=loadFactoryPorts();  // 工厂就近港map(起运港pol空时兜底);单独await,不塞进下面Promise.all以免打乱res索引(res.slice(2)是兄弟单)
  Promise.all([loadOrder(orderNo),fetchProductMaster()].concat(sibs.map(loadOrder))).then(function(res){
    if(!res[0].length)throw new Error('订单 "'+orderNo+'" 未找到或无权限');
    _pmMap=res[1]||{};
    var primary=res[0][0];
    var all=[primary].concat(res.slice(2).map(function(r){return r[0];}).filter(Boolean));
    all.sort(function(a,b){return String(a.order_no).localeCompare(String(b.order_no));});
    document.getElementById('orderLabel').textContent=orderNo;
    return _fpP.then(function(){return Promise.all(all.map(loadOrderLineItems));}).then(function(lineSets){
      lineSets.forEach(function(lines,i){all[i]._lineItems=lines;});
      var sellerP=fetch(API+'/api/db/seller-profiles',{headers:authH()}).then(function(r){return r.json();}).catch(function(){return [];});
      var addrP=fetchBuyerAddr(primary);
      var ctnP=(onlyContainer||!_customsMode)?loadContainerInfo(all):Promise.resolve({});
      return Promise.all([sellerP,addrP,ctnP]).then(function(rr){
      var d=rr[0],addr=rr[1],ctnMap=rr[2]||{};if(addr)primary._buyerAddr=addr;
      if(onlyContainer){
        all=all.filter(function(o){return orderHasContainer(o,ctnMap,onlyContainer);});
        if(!all.length)throw new Error('该柜没有匹配订单: '+onlyContainer);
      }
      var docPrimary=all[0]||primary,cur=docPrimary.currency||primary.currency||'CNY',port=buildPort(docPrimary)||buildPort(primary);
      var _praw=orderRaw(docPrimary);
      window._freight=Number(docPrimary.inland_freight||_praw.inland_freight||0)||0;
      window._freightLabel=docPrimary.inland_freight_label||_praw.inland_freight_label||'提货运费';
      window._freightLabelEn=docPrimary.inland_freight_label_en||_praw.inland_freight_label_en||'INLAND FREIGHT';
      window._agg=aggregate(all);window._cur=cur;window._docPrimary=docPrimary;  // 存主订单供切模式重算港口
      var _dlFsOrder=all.filter(function(o){return o&&(String(o.order_no)===orderNo||shortNo(o.order_no)===shortNo(orderNo));})[0]||docPrimary;
      window._docBaseName=fsFromOrder(_dlFsOrder)||shortNo(docPrimary.order_no)||orderNo;  // 下载文件名用URL order_no那单的FS
      document.title='Export Documents · '+window._docBaseName;
      window._ctnMap=ctnMap;window._rows=detailRows(all,ctnMap);
      var ps=Array.isArray(d)?d:(d.data||[]);
      var sp=(docPrimary.seller_code&&ps.find(function(x){return x.code===docPrimary.seller_code;}))||ps.find(function(x){return x.name_cn===docPrimary.issuing_company||x.name_en===docPrimary.issuing_company;})||ps.find(function(x){return x.is_default;});
      ['pl','sc','iv'].forEach(function(pfx){fillHeader(pfx,docPrimary,all,sp,cur,port);});
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
