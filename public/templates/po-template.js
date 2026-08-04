var API='https://api.sanlyn.cn';
var _sealTarget=null,_stamps=[],_localStamps=[],_pendingFile=null,_sealRotation={buyer:0,seller:0};

function qp(n){return new URLSearchParams(location.search).get(n)||'';}
function getToken(){try{return qp('token')||localStorage.getItem('sanlyn_jwt')||localStorage.getItem('sanlyn_token')||'';}catch(e){return '';}}
function authH(){var t=getToken();var h={'Content-Type':'application/json'};if(t)h['Authorization']='Bearer '+t;return h;}

// ── 2026-08-04 Damon「根治」: 认证失败绝不许伪装成「订单未找到」 ──
// 病根: loadOrder 只做 r.json(),完全不看 HTTP 状态码。401 返回 {"error":"Unauthorized"}
//       → rows=[] → 报「订单 XX 未找到或无权限」。Damon 看到这句第一反应是数据坏了,
//       实际是 token 空/过期。今天他就这么撞了一次(48-CL-17,地址栏 &token= 后面是空的)。
function AUTH_ERR(){var e=new Error('__AUTH__');e.__auth=true;return e;}
function chkAuth(r){
  if(r.status===401||r.status===403) throw AUTH_ERR();
  return r.json();
}
function showAuthDead(){
  // 2026-08-04 实测: 本页在 api.sanlyn.cn，主站在 ai.sanlyn.cn —— 两个不同的域。
  // 浏览器 localStorage 按域隔离，本页的 localStorage 永远是空的([]，实测),
  // 所以它读不到主站登录态,只认网址里的 ?token=。
  // ⛔ 上一版写「去重新登录」是错的:登录多少次都不会让这条链接生效,必须重新生成带 token 的链接。
  var app='https://ai.sanlyn.cn/data#customs';
  var e=document.getElementById('errBanner');
  if(e){
    e.style.display='block';
    e.innerHTML='🔗 <b>这条链接缺少访问凭证，打不开</b>'
      +'<div style="font-size:12.5px;margin-top:6px;font-weight:400;line-height:1.7">'
      +'网址末尾的 <code>token=</code> 是空的。<br>'
      +'本页在 <b>api.sanlyn.cn</b>，而登录信息存在 <b>ai.sanlyn.cn</b> —— 两个不同的域，'
      +'浏览器不允许互相读取。<b>所以重新登录也没用</b>，必须回系统里重新生成一条带凭证的链接。'
      +'</div>'
      +'<div style="margin-top:10px"><a href="'+app+'" target="_blank" '
      +'style="display:inline-block;background:#2563eb;color:#fff;padding:7px 16px;'
      +'border-radius:6px;text-decoration:none;font-size:13px;font-weight:600">'
      +'去报关主表重新生成 ➜</a>'
      +'<span style="font-size:11.5px;color:#64748b;margin-left:10px">'
      +'在那边点单据按钮，生成的链接会自动带上凭证</span></div>';
  }
  var i2=document.getElementById('infoBanner'); if(i2)i2.style.display='none';
  // 2026-08-04 Damon:「港口还在」——出错时别再画半成品单据骨架。
  // 空表头+空港口条会让人以为是数据丢了(他就是这么判断的),整张藏起来只留提示。
  try{ document.querySelectorAll('.doc-page').forEach(function(el){el.style.display='none';}); }catch(_){}
  try{ var tb=document.querySelector('.toolbar'); if(tb) tb.style.display='none'; }catch(_){}
}

function initRotHandle(who){
  var key=who==='buyer'?'Buyer':'Seller';
  var area=document.getElementById('seal'+key),img=document.getElementById('seal'+key+'Img');
  if(!img)return;img.style.cursor='grab';img.title='拖动印章旋转';
  img.onmousedown=function(e){
    e.preventDefault();e.stopPropagation();img.style.cursor='grabbing';
    var rect=area.getBoundingClientRect(),cx=rect.left+rect.width/2,cy=rect.top+rect.height/2;
    var sm=Math.atan2(e.clientY-cy,e.clientX-cx)*180/Math.PI,sr=_sealRotation[who]||0;
    function move(ev){var a=Math.atan2(ev.clientY-cy,ev.clientX-cx)*180/Math.PI;_sealRotation[who]=sr+(a-sm);img.style.transform='rotate('+_sealRotation[who].toFixed(1)+'deg)';}
    function up(){img.style.cursor='grab';document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);}
    document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);
  };
}
function applySeal(who,url,name){
  var key=who==='buyer'?'Buyer':'Seller';
  var img=document.getElementById('seal'+key+'Img'),hint=document.getElementById('seal'+key+'Hint');
  _sealRotation[who]=0;img.crossOrigin='anonymous';img.src=url;img.style.display='block';img.style.transform='';hint.style.display='none';
  var si=document.getElementById('status'+key+'Img'),sn=document.getElementById('status'+key+'Name');
  if(si){si.crossOrigin='anonymous';si.src=url;si.style.display='inline';}if(sn){sn.textContent=name||(who==='buyer'?'买方章':'卖方章');sn.classList.remove('empty');}
  try{localStorage.setItem('po_seal_'+who,JSON.stringify({url:url,name:name||''}));}catch(e){}
  initRotHandle(who);
}
function clearSeals(){
  ['buyer','seller'].forEach(function(w){
    var key=w==='buyer'?'Buyer':'Seller';
    var img=document.getElementById('seal'+key+'Img'),hint=document.getElementById('seal'+key+'Hint');
    img.src='';img.style.display='none';img.style.transform='';hint.style.display='';
    img.onmousedown=null;img.style.cursor='';_sealRotation[w]=0;
    try{localStorage.removeItem('po_seal_'+w);}catch(e){}
    var si=document.getElementById('status'+key+'Img'),sn=document.getElementById('status'+key+'Name');
    if(si)si.style.display='none';if(sn){sn.textContent='未选择';sn.classList.add('empty');}
  });
}
function dropSeal(e,who){e.preventDefault();var f=e.dataTransfer.files[0];if(!f||!f.type.startsWith('image/'))return;var r=new FileReader();r.onload=function(ev){applySeal(who,ev.target.result,f.name.replace(/\.[^.]+$/,''));};r.readAsDataURL(f);}
window.addEventListener('message',function(e){if(!e.data||e.data.type!=='seal-ready')return;applySeal(_sealTarget,e.data.dataUrl,e.data.label||'印章');closeModal();});

function switchTab(name){
  ['das','local','make','upload'].forEach(function(t){
    var b=document.getElementById('tab-'+t),c=document.getElementById('tab-'+t+'-content');
    if(b){b.style.background=t===name?'#3b82f6':'#f1f5f9';b.style.color=t===name?'#fff':'#64748b';}
    if(c)c.style.display=t===name?'':'none';
  });
  if(name==='das')loadDasStamps();if(name==='local')renderLocalStamps();
}
function openSealPicker(who){
  _sealTarget=who;document.getElementById('sealModal').style.display='flex';
  var tok=getToken(),dasTab=document.getElementById('tab-das');
  if(tok){dasTab.style.display='';switchTab('das');}else{dasTab.style.display='none';loadLocalStamps();switchTab(_localStamps.length?'local':'make');}
}
function closeModal(){document.getElementById('sealModal').style.display='none';}
function loadLocalStamps(){try{_localStamps=JSON.parse(localStorage.getItem('pc_local_stamps')||'[]');}catch(e){_localStamps=[];}}
function renderLocalStamps(){
  var g=document.getElementById('localGrid');if(!g)return;loadLocalStamps();
  if(!_localStamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">暂无本地章</div>';return;}
  g.innerHTML=_localStamps.map(function(s,i){return '<div onclick="selLocal('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center" onmouseover="this.style.borderColor=\'#3b82f6\'" onmouseout="this.style.borderColor=\'#e2e8f0\'"><img src="'+s.url+'" style="width:64px;height:64px;object-fit:contain"><div style="font-size:11px;color:#475569;margin-top:4px">'+(s.name||'印章')+'</div></div>';}).join('');
}
function selLocal(i){loadLocalStamps();applySeal(_sealTarget,_localStamps[i].url,_localStamps[i].name);closeModal();}
function loadDasStamps(){
  var g=document.getElementById('stampGrid');g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载中…</div>';
  fetch(API+'/api/db/customer-stamps',{headers:authH()}).then(chkAuth).then(function(d){
    var stamps=Array.isArray(d)?d:(d.stamps||d.data||[]);
    if(!stamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">DAS暂无印章</div>';return;}
    _stamps=stamps;
    g.innerHTML=stamps.map(function(s,i){return '<div onclick="selStamp('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center" onmouseover="this.style.borderColor=\'#3b82f6\'" onmouseout="this.style.borderColor=\'#e2e8f0\'"><img src="'+s.url+'" style="width:64px;height:64px;object-fit:contain" onerror="this.style.opacity=0.3"><div style="font-size:11px;color:#475569;margin-top:4px">'+(s.name||'印章')+'</div></div>';}).join('');
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

function makeGroupRow(label){return '<tr class="group-header"><td colspan="7" contenteditable>'+label+'</td><td class="no-print" style="background:#dbeafe;border:none"></td></tr>';}
function makeProductRow(no,name,qty,perBag,ctnPrice,amount,barcode){
  var q=parseFloat(qty)||0,pb=parseFloat(perBag)||0,cp=parseFloat(ctnPrice)||0,amt=parseFloat(amount)||(q*cp)||0;
  return '<tr>'
    +'<td contenteditable>'+no+'</td>'
    +'<td class="left" contenteditable>'+name+'</td>'
    +'<td contenteditable data-v="qty">'+q+'</td>'
    +'<td contenteditable data-v="pbag">'+pb+'</td>'
    +'<td contenteditable data-v="cprice">'+cp+'</td>'
    +'<td contenteditable data-v="amt">'+amt.toFixed(2)+'</td>'
    +'<td contenteditable>'+barcode+'</td>'
    +'<td class="no-print" style="padding:2px;border-left:none"><div class="row-actions"><button class="row-btn row-btn-del" onclick="delRow(this)">✕</button><button class="row-btn row-btn-dup" onclick="dupRow(this)">⧉</button></div></td>'
    +'</tr>';
}
function delRow(btn){btn.closest('tr').remove();recalcTotals();}
function dupRow(btn){var tr=btn.closest('tr');tr.after(tr.cloneNode(true));recalcTotals();}
function addRow(){document.getElementById('poBody').insertAdjacentHTML('beforeend',makeProductRow('','',0,0,0,0,''));}
function addGroup(){document.getElementById('poBody').insertAdjacentHTML('beforeend',makeGroupRow('ORDER '));}
function recalcTotals(){
  var qty=0,amt=0;
  document.querySelectorAll('#poBody tr:not(.group-header) td[data-v="qty"]').forEach(function(td){qty+=parseFloat(td.textContent)||0;});
  document.querySelectorAll('#poBody tr:not(.group-header) td[data-v="amt"]').forEach(function(td){amt+=parseFloat(td.textContent)||0;});
  document.getElementById('ttlQty').textContent=qty||'—';
  document.getElementById('ttlAmt').textContent=amt?amt.toFixed(2):'—';
}
document.addEventListener('input',function(e){
  var td=e.target.closest&&e.target.closest('#poBody td[data-v]');
  if(td&&td.dataset.v!=='amt'){
    var tr=td.parentElement,q=tr.querySelector('[data-v="qty"]'),c=tr.querySelector('[data-v="cprice"]'),a=tr.querySelector('[data-v="amt"]');
    if(q&&c&&a)a.textContent=((parseFloat(q.textContent)||0)*(parseFloat(c.textContent)||0)).toFixed(2); // 金额=数量×箱价(公式)
  }
  if(e.target.closest&&e.target.closest('#poBody'))recalcTotals(); // 合计=各行金额求和(公式)
});

function setText(id,val){if(!val)return;var el=document.getElementById(id);if(el&&!el.textContent.trim())el.textContent=val;}
function appendText(id,val){if(!val)return;var el=document.getElementById(id);if(el){var cur=el.textContent.trim();el.textContent=cur?cur+' / '+val:val;}}

function loadOrder(no){
  return fetch(API+'/api/db/orders?order_no='+encodeURIComponent(no),{headers:authH()})
    .then(chkAuth)
    .then(function(d){
      var rows=d.data||d.orders||(Array.isArray(d)?d:[]);
      // fallback: try contract_no if order_no finds nothing
      if(!rows.length) return fetch(API+'/api/db/orders?contract_no='+encodeURIComponent(no),{headers:authH()}).then(chkAuth).then(function(d){return d.data||d.orders||(Array.isArray(d)?d:[]);});
      return rows;
    });
}

function init(){
  var orderNo=qp('order_no')||qp('orderNo');
  var idsRaw=qp('ids');
  if(!orderNo){
    document.getElementById('poBody').innerHTML='<tr><td colspan="8" style="text-align:center;padding:14px;color:#64748b;border:1px solid #bbb">未传 order_no，请手动填写或加 ?order_no=XX&token=YY</td></tr>';
    hideBanner();return;
  }
  // 2026-08-04: token 空就当场停,别跑一圈再报「订单未找到」。
  if(!getToken()){showAuthDead();return;}
  showBanner('info','正在加载订单数据…');
  var siblingNos=idsRaw?idsRaw.split(',').map(function(s){return s.trim();}).filter(function(s){return s&&s!==orderNo;}):[];
  var allFetches=[loadOrder(orderNo)];
  siblingNos.forEach(function(no){allFetches.push(loadOrder(no));});
  Promise.all(allFetches).then(function(results){
    var primaryRows=results[0];
    if(!primaryRows.length)throw new Error('订单 "'+orderNo+'" 在系统里查不到 —— 确认单号是否正确');
    var primary=primaryRows[0];
    window._poPrimary=primary;
    // Fill header fields from primary order
    var raw=primary.raw||{};
    setText('orderNo',primary.order_no||'');
    setText('contractNo',primary.contract_no||raw.contractNo||'');
    setText('orderDate',(primary.created_at||primary.order_date||'').slice(0,10)||new Date().toISOString().slice(0,10));
    setText('remarks',primary.remarks||raw.remarks||'');
    fillDates(primary); // 期望/预计发货/预计交货/实际交货 日期字段
    // ── 买卖双方：采购合同上下游关系，全部直接取 orders 字段 ──────────────
    //   买方(甲方) = orders.issuing_company（开票主体，向工厂采购的是我们）
    //   卖方(乙方) = orders.factory       （生产工厂）
    setText('buyerName',primary.issuing_company||'');
    setText('sellerName',primary.factory||'');
    // 税号/开户行不在订单行上：买方按 seller_code 查我方主体，卖方按工厂名查 companies
    var _sc=primary.seller_code||'';
    fetch(API+'/api/db/seller-profiles',{headers:authH()}).then(chkAuth).then(function(d){
      var ps=Array.isArray(d)?d:(d.data||[]);
      var p=(_sc&&ps.find(function(x){return x.code===_sc;}))||ps.find(function(x){return x.name_cn===primary.issuing_company;})||ps.find(function(x){return x.is_default;});
      if(p){setText('buyerName',p.name_cn||'');setText('buyerTaxNo',p.tax_no||'');setText('buyerBank',p.bank_name_cn||p.bank_name||'');setText('buyerAccount',p.rmb_account||'');}
    }).catch(function(){});
    if(primary.factory)fetch(API+'/api/db/companies?q='+encodeURIComponent(primary.factory),{headers:authH()}).then(chkAuth).then(function(d){
      var cs=Array.isArray(d)?d:(d.data||[]);
      var c=cs.find(function(x){return x.name_cn===primary.factory;})||cs[0];
      if(c){setText('sellerName',c.name_cn||'');setText('sellerTaxNo',c.tax_id||c.tax_no||'');setText('sellerBank',c.bank_name||'');setText('sellerAccount',c.bank_account||'');}
    }).catch(function(){});
    // ── 产品+价格：优先 order_line_items（有 product_name），降级到 orders.products ────
    var allOrders=[primary].concat(results.slice(1).map(function(r){return r[0];}).filter(Boolean));
    return Promise.all(allOrders.map(function(o){
      if(!o||!o.id)return Promise.resolve(null);
      return fetch(API+'/api/db/order-line-items?order_id='+encodeURIComponent(o.id),{headers:authH()})
        .then(function(r){return r.ok?r.json():null;}).catch(function(){return null;});
    })).then(function(oliResults){
      var html='',rowIdx=1;
      allOrders.forEach(function(order,idx){
        if(!order)return;
        if(order!==primary){appendText('orderNo',order.order_no||'');}
        var oli=oliResults[idx];
        var oliRows=oli&&Array.isArray(oli.data)?oli.data:[];
        var validOliRows=oliRows.filter(function(r){return r&&String(r.product_name||'').trim();});
        var prods;
        if(validOliRows.length){
          prods=validOliRows.map(function(r){return{name:r.product_name||'',qty:r.qty_ctn,bgBx:r.bg_bx||1,factoryPrice:r.factory_price||r.unit_price||0,factorySubtotal:r.factory_subtotal,subtotal:r.subtotal,barcode:r.barcode||'',size:r.size||''};});
        }else{
          prods=(order.products||(order.raw&&order.raw.products)||[]).filter(function(p){return p&&(p.name||p.name_en||p.name_cn||p.sku);});
        }
        if(!prods.length)return;
        html+=makeGroupRow('单号 '+(order.order_no||order.contract_no||''));
        prods.forEach(function(p){
          var name=p.name||p.name_en||p.name_cn||p.sku||'';if(p.size)name+=' ('+p.size+')';
          var qty=parseFloat(p.qty||p.qty_ctn||0)||0;
          var bg=parseFloat(p.bgBx||p.bg_bx||1)||1;
          var ctnP=parseFloat(p.factoryPrice||p.unitPrice||p.factory_price||p.unit_price||0)||0;
          var perB=bg?ctnP/bg:ctnP;
          var amtSource=p.factorySubtotal!=null&&p.factorySubtotal!==''?p.factorySubtotal:(p.subtotal!=null&&p.subtotal!==''?p.subtotal:null);
          var amt=amtSource!=null?(parseFloat(amtSource)||0):(qty*ctnP);
          html+=makeProductRow(('0'+(rowIdx++)).slice(-2),name,qty,perB.toFixed(2),ctnP.toFixed(2),amt.toFixed(2),p.barcode||p.code||p.ean||'');
        });
      });
      document.getElementById('poBody').innerHTML=html||'<tr><td colspan="8" style="text-align:center;padding:12px;color:#64748b;border:1px solid #bbb">无产品数据，可点击"＋加产品行"手动添加</td></tr>';
      recalcTotals();hideBanner();setTimeout(handleHashAction,300);
    });
  }).catch(function(e){ if(e&&e.__auth){showAuthDead();return;} showBanner('err',e.message); });
  ['buyer','seller'].forEach(function(w){try{var s=JSON.parse(localStorage.getItem('po_seal_'+w)||'null');if(s&&s.url)applySeal(w,s.url,s.name);}catch(e){}});
}

// ── 日期字段：期望交货(客户要求,只读) / 预计发货 / 预计交货 / 实际交货 ──
function fillDates(o){
  var raw=o.raw||{};
  var req=(o.required_arrival||raw.requiredArrival||'').slice(0,10);  // 客户期望交货日期
  var ship=(o.confirmed_ship_date||'').slice(0,10);                   // 预计发货(工厂填)
  var deliv=(o.confirmed_delivery||o.delivery_date||'').slice(0,10);  // 预计交货
  var actual=(o.actual_handover_date||'').slice(0,10);               // 实际交货
  setDate('reqDelivery',req);
  setDate('estShip',ship);
  setDate('estDelivery',deliv);
  setDate('actualDelivery',actual);
  // 期望交货日期：客户没要求就整行隐藏
  var reqRow=document.getElementById('reqDeliveryRow');
  if(reqRow)reqRow.style.display=req?'':'none';
}
function setDate(id,val){var el=document.getElementById(id);if(el&&val)el.value=val;}

// ── 修改日志（右侧栏，追加式）────────────────────────────────
function logChange(text){
  var box=document.getElementById('changeLogBody');if(!box)return;
  var empty=document.getElementById('clEmpty');if(empty)empty.remove();
  var now=new Date();var ts=now.toISOString().slice(0,16).replace('T',' ');
  var div=document.createElement('div');div.className='cl-item';
  div.innerHTML='<span class="cl-ts">'+ts+'</span> '+text;
  box.insertBefore(div,box.firstChild);
}

function saveDraft(){
  var key='po_draft_'+(qp('order_no')||'manual');
  try{localStorage.setItem(key,JSON.stringify({html:document.getElementById('printPage').innerHTML}));showBanner('ok','✓ 草稿已保存');setTimeout(hideBanner,2000);}catch(e){}
}
function downloadPng(){
  var btn=document.querySelector('.btn-download');
  btn.textContent='⏳ 生成中…';btn.disabled=true;
  document.querySelector('.toolbar').style.display='none';
  var script=document.createElement('script');
  script.src='https://api.sanlyn.cn/templates/vendor/html2canvas.min.js';
  script.onload=function(){
    html2canvas(document.getElementById('printPage'),{scale:2,useCORS:true,backgroundColor:'#ffffff',logging:false}).then(function(canvas){
      document.querySelector('.toolbar').style.display='';
      var a=document.createElement('a');a.download='PO-'+(qp('order_no')||'draft')+'.png';a.href=canvas.toDataURL('image/png');a.click();
      btn.textContent='📥 下载图片';btn.disabled=false;
    }).catch(function(){document.querySelector('.toolbar').style.display='';btn.textContent='📥 下载图片';btn.disabled=false;});
  };
  if(window.html2canvas)script.onload();else document.head.appendChild(script);
}
function showBanner(type,msg){['infoBanner','errBanner','okBanner'].forEach(function(id){document.getElementById(id).style.display='none';});var m={info:'infoBanner',err:'errBanner',ok:'okBanner'};var el=document.getElementById(m[type]);if(el){el.textContent=(type==='err'?'⚠ ':'')+msg;el.style.display='block';}}
function hideBanner(){['infoBanner','errBanner','okBanner'].forEach(function(id){document.getElementById(id).style.display='none';});}

function exportExcel(){
  var btn=document.querySelector('.btn-excel');if(btn){btn.textContent='生成中...';btn.disabled=true;}
  function reset(){if(btn){btn.textContent='下载Excel';btn.disabled=false;}}
  function run(){try{
    var g=function(id){var e=document.getElementById(id);return e?e.textContent.trim():'';};
    var aoa=[['采购合同 PURCHASE ORDER'],['买方',g('buyerName'),'卖方',g('sellerName')],['单号',g('orderNo'),'合同号',g('contractNo'),'日期',g('orderDate')],[]];
    var heads=[].map.call(document.querySelectorAll('table thead th'),function(t){return t.textContent.replace(/\s+/g,' ').trim();}).filter(function(x){return x;});
    aoa.push(heads);
    [].forEach.call(document.querySelectorAll('#poBody tr'),function(tr){
      if(tr.classList.contains('group-header')){aoa.push([tr.textContent.trim()]);return;}
      var cells=[].map.call(tr.querySelectorAll('td[contenteditable]'),function(td){var v=td.textContent.trim(),n=Number(v.replace(/,/g,''));return v&&/^[\d,.]+$/.test(v)?n:v;});
      if(cells.length)aoa.push(cells);
    });
    var tot=document.querySelector('.total-row');if(tot)aoa.push([].map.call(tot.querySelectorAll('td:not(.no-print)'),function(td){return td.textContent.trim();}));
    var wb=XLSX.utils.book_new(),ws=XLSX.utils.aoa_to_sheet(aoa);ws['!cols']=heads.map(function(h,i){return {wch:i===1?36:14};});
    XLSX.utils.book_append_sheet(wb,ws,'PO');XLSX.writeFile(wb,'PO-'+(qp('order_no')||'draft')+'.xlsx');
  }catch(e){alert('导出失败: '+e.message);}reset();}
  if(window.XLSX)return run();var s=document.createElement('script');s.src='https://api.sanlyn.cn/templates/vendor/xlsx.full.min.js';s.onload=run;s.onerror=function(){alert('Excel库加载失败');reset();};document.head.appendChild(s);
}
function handleHashAction(){var h=(location.hash||'').toLowerCase();if(h.indexOf('excel')>=0)exportExcel();else if(h.indexOf('seal')>=0||h.indexOf('stamp')>=0)openSealPicker('seller');else if(h.indexOf('print')>=0)window.print();}
init();
