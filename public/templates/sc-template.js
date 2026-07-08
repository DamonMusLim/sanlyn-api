// sc-template.js — 销售合同动态加载。版式照 documents.js type=pi（灰白版），字段只对应不编造。
var API='https://api.sanlyn.cn';
function qp(n){return new URLSearchParams(location.search).get(n)||'';}
function tok(){try{return qp('token')||localStorage.getItem('sanlyn_jwt')||localStorage.getItem('sanlyn_token')||'';}catch(e){return '';}}
function authH(){var h={'Content-Type':'application/json'};var t=tok();if(t)h.Authorization='Bearer '+t;return h;}
function setT(id,v){var e=document.getElementById(id);if(e&&v!=null&&String(v).length)e.textContent=v;}
function shortNo(no){return String(no||'').replace(/^\d+-/,'');} // 40-CL-19 → CL-19
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function fmtM(n){var x=Number(n)||0;return x.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function banner(t,m){var i=document.getElementById('infoBanner'),e=document.getElementById('errBanner');if(i)i.style.display='none';if(e)e.style.display='none';if(t==='err'&&e){e.textContent='⚠ '+m;e.style.display='block';}if(t==='info'&&i){i.textContent=m;i.style.display='block';}}

function loadOrder(no){
  return fetch(API+'/api/db/orders?order_no='+encodeURIComponent(no),{headers:authH()})
    .then(function(r){return r.json();}).then(function(d){
      var rows=d.data||d.orders||(Array.isArray(d)?d:[]);
      if(rows.length)return rows;
      return fetch(API+'/api/db/orders?contract_no='+encodeURIComponent(no),{headers:authH()}).then(function(r){return r.json();}).then(function(d){return d.data||d.orders||(Array.isArray(d)?d:[]);});
    });
}

function init(){
  var orderNo=qp('order_no')||qp('orderNo');
  if(!orderNo){banner('err','未传 order_no，请加 ?order_no=XX&token=YY');document.getElementById('piBody').innerHTML='';return;}
  var idsRaw=qp('ids');
  var sibs=idsRaw?idsRaw.split(',').map(function(s){return s.trim();}).filter(function(s){return s&&s!==orderNo;}):[];
  banner('info','正在拉取订单数据…');
  Promise.all([loadOrder(orderNo)].concat(sibs.map(loadOrder))).then(function(res){
    if(!res[0].length)throw new Error('订单 "'+orderNo+'" 未找到或无权限');
    var primary=res[0][0];
    var all=[primary].concat(res.slice(1).map(function(r){return r[0];}).filter(Boolean));
    all.sort(function(a,b){return String(a.order_no).localeCompare(String(b.order_no));}); // CL-16..19 升序，对齐 documents.js
    fillDoc(primary,all);
  }).catch(function(e){banner('err',e.message);});
  try{var s=JSON.parse(localStorage.getItem('sc_seal')||'null');if(s&&s.url)applySeal(s.url);}catch(e){}
}

function fillDoc(primary,all){
  // 买方(BILL TO) = orders.customer / customer_address（客户单据：买方=客户）
  setT('buyerName',primary.customer||primary.company_name_en||'');
  setT('buyerAddr',primary.customer_address||'');
  // DETAILS — 编号铁律[[sanlyn_id_hierarchy_rule]]: No.=fs_no我们内部号(多订单只一个), PO No.=客户PO, 工厂contract_no绝不上客户单
  var uniq=function(a){return a.filter(function(v,i){return v&&a.indexOf(v)===i;});};
  var praw=primary.raw||{};
  var _fs=primary.fs_no||praw.fs_no||primary.internal_no||praw.internal_no||'';
  if(!_fs&&/^FS/i.test(primary.contract_no||''))_fs=primary.contract_no;
  setT('contractNo',_fs); // No.
  setT('poNo',uniq(all.map(function(o){return o.customer_po||shortNo(o.order_no);})).join(' / ')); // PO No.
  setT('orderNo',all.map(function(o){return shortNo(o.order_no);}).join(' / ')); // CL-19 / CL-18 ...
  setT('docDate',(primary.order_date||'').slice(0,10)||new Date().toISOString().slice(0,10));
  var cur=primary.currency||'CNY';
  setT('curr',cur);document.getElementById('curH1').textContent=cur;document.getElementById('curH2').textContent=cur;
  // 卖方 = orders.issuing_company；抬头/银行/条款按 seller_code 查 seller-profiles 真值表
  fetch(API+'/api/db/seller-profiles',{headers:authH()}).then(function(r){return r.json();}).then(function(d){
    var ps=Array.isArray(d)?d:(d.data||[]);
    var p=(primary.seller_code&&ps.find(function(x){return x.code===primary.seller_code;}))||ps.find(function(x){return x.name_cn===primary.issuing_company||x.name_en===primary.issuing_company;})||ps.find(function(x){return x.is_default;});
    if(p){
      setT('sellerName',p.name_en||p.name_cn||primary.issuing_company||'');
      setT('sellerAddr',p.address_en||p.address||'');
      var acct=(cur==='USD')?('Account No. (USD): '+(p.usd_account||'')):('Account No. (CNY): '+(p.rmb_account||''));
      var bank=['Beneficiary: '+(p.name_en||''),'Bank: '+(p.bank_name||''),'SWIFT: '+(p.bank_swift||''),p.bank_addr?'Bank Address: '+p.bank_addr:'',acct].filter(function(s){return s&&!/: $/.test(s);}).join('\n');
      document.getElementById('banking').innerText=bank+'\n* Please verify bank info before payment.';
      if(p.terms_sc)document.getElementById('terms').innerText=p.terms_sc; else setDefaultTerms();
      if(p.seal_url){applySeal(p.seal_url);}
    }else{ setT('sellerName',primary.issuing_company||''); setDefaultTerms(); }
  }).catch(function(){setT('sellerName',primary.issuing_company||'');setDefaultTerms();});
  // 产品表：按订单分组（ORDER CL-16），行=name/size/qty/unitPrice/subtotal（客户成交价，禁 factoryPrice/cost）
  var html='',idx=1,total=0;
  all.forEach(function(o){
    var prods=(o.products||(o.raw&&o.raw.products)||[]).filter(function(p){return p&&(p.name||p.name_en);});
    if(!prods.length)return;
    html+='<tr class="group-header"><td colspan="5">ORDER '+esc(shortNo(o.order_no))+'</td></tr>'; // FS合同号只在顶部一行,组内不重复
    prods.forEach(function(p){
      var name=p.name||p.name_en||'';var sz=p.size?' ('+p.size+')':'';
      var qty=Number(p.qty||p.qty_ctn||0)||0;
      var up=Number(p.unitPrice||p.unit_price||0)||0;            // 客户成交价
      var amt=Number(p.subtotal||(qty*up))||0;
      total+=amt;
      html+='<tr><td>'+('0'+(idx++)).slice(-2)+'</td><td>'+esc(name+sz)+'</td><td>'+qty+'</td><td class="text-right">'+fmtM(up)+'</td><td class="text-right">'+fmtM(amt)+'</td></tr>';
    });
  });
  if(!html)html='<tr><td colspan="5" style="text-align:center;padding:14px;color:#94a3b8">无产品数据</td></tr>';
  var cur2=primary.currency||'CNY';
  html+='<tr class="total-row"><td colspan="3" class="text-right" style="color:#555">TOTAL AMOUNT ('+cur2+'):</td><td colspan="2" class="text-right" style="font-size:16px">'+fmtM(total)+'</td></tr>';
  document.getElementById('piBody').innerHTML=html;
  banner('','');
}

function setDefaultTerms(){
  var el=document.getElementById('terms');if(el.innerText.trim())return;
  el.innerText='1. PACKING Export seaworthy cartons + inner packaging per approved spec sheet & sealed samples.\n2. SHIPMENT Within 30 days of receipt of deposit and written confirmation of specifications.\n3. L release or telex release. Title retained until full payment. Overdue bank lending rate interest.\n4. CLAIMS Written notice within 14 days of arrival, with opening video + batch records. Liability capped at invoice value of defective portion only.\n5. FORCE MAJEURE Port congestion, vessel cancellation, raw material shortage, policy changes included. Either party may cancel without liability if delay exceeds 60 days.\n6. GENERAL PI > SC > IV; Chinese law (CISG excluded); CIETAC Xiamen arbitration; English.';
}

function saveDraft(){try{localStorage.setItem('sc_draft_'+(qp('order_no')||'manual'),JSON.stringify({html:document.getElementById('page').innerHTML}));banner('info','✓ 草稿已保存');setTimeout(function(){banner('','');},1500);}catch(e){}}
function downloadPng(){
  var btn=document.querySelector('.btn-dl');btn.textContent='⏳…';btn.disabled=true;
  document.querySelector('.toolbar').style.display='none';
  var s=document.createElement('script');s.src='https://api.sanlyn.cn/templates/vendor/html2canvas.min.js';
  s.onload=function(){html2canvas(document.getElementById('page'),{scale:2,useCORS:true,backgroundColor:'#fff'}).then(function(c){document.querySelector('.toolbar').style.display='';var a=document.createElement('a');a.download='SC-'+(qp('order_no')||'draft')+'.png';a.href=c.toDataURL('image/png');a.click();btn.textContent='📥 下载图片';btn.disabled=false;}).catch(function(){document.querySelector('.toolbar').style.display='';btn.textContent='📥 下载图片';btn.disabled=false;});};
  if(window.html2canvas)s.onload();else document.head.appendChild(s);
}
init();
