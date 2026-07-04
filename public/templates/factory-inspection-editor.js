// factory-inspection-editor.js — 厂检单/QC 可编辑模版(填检验值+盖章+保存入库),复用CN编辑器印章系统
var API='https://api.sanlyn.cn',_sealTarget='fi:seller',_stamps=[],_localStamps=[],_pendingFile=null,_sealRotation={},_order='',_kind='fi',_items=[],_sampleName='',_sellerCode='',_dasMode='all',_curSealName='',_lang='zh';
var _EN={'水分':'Moisture','结团性':'Clumping','吸水率':'Water Absorption','结团强度':'Clump Strength','硬度':'Hardness','pH':'pH','pH值':'pH','白度':'Whiteness','容重':'Bulk Density','粉尘率':'Dust Rate','粉尘':'Dust','气味':'Odor','除臭效果':'Deodorization','颗粒度':'Granule Size','外观':'Appearance','包装':'Packaging','净含量':'Net Content'};
function qp(n){return new URLSearchParams(location.search).get(n)||'';}
function tok(){try{return qp('token')||localStorage.getItem('sanlyn_jwt')||localStorage.getItem('sanlyn_token')||'';}catch(e){return '';}}
function authH(){var h={'Content-Type':'application/json'};var t=tok();if(t)h.Authorization='Bearer '+t;return h;}
function setT(id,v){var e=document.getElementById(id);if(e)e.textContent=(v==null?'':v);}
function txt(id){var e=document.getElementById(id);return e?e.textContent.trim():'';}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}
function banner(t,m){var i=document.getElementById('infoBanner'),e=document.getElementById('errBanner');if(i)i.style.display='none';if(e)e.style.display='none';if(t==='err'&&e){e.textContent='⚠ '+m;e.style.display='block';}if(t==='info'&&i){i.textContent=m;i.style.display='block';}}
function updateSealStatus(){var el=document.getElementById('sealStatus');if(!el)return;if(_curSealName){el.textContent='章: '+_curSealName+' ✓';el.style.background='#fef2f2';el.style.borderColor='#fecaca';el.style.color='#b91c1c';}else{el.textContent='章: 未盖';el.style.background='#f1f5f9';el.style.borderColor='#cbd5e1';el.style.color='#334155';}}

/* ── 判定合格/超标 ── */
function checkSpec(spec,val){var v=parseFloat(val);if(isNaN(v))return null;spec=String(spec).replace(/\s/g,'');var m;
  if((m=spec.match(/^[≤<]=?([\d.]+)$/)))return v<=parseFloat(m[1]);
  if((m=spec.match(/^[≥>]=?([\d.]+)$/)))return v>=parseFloat(m[1]);
  if((m=spec.match(/^([\d.]+)[-~]([\d.]+)$/)))return v>=parseFloat(m[1])&&v<=parseFloat(m[2]);
  return null;}
function verdictHtml(spec,val){if(val===''||val==null)return '<span class="verdict-na">—</span>';var ok=checkSpec(spec,val);if(ok===null)return '<span class="verdict-na">—</span>';var P=_lang==='en'?'PASS':'合格',F=_lang==='en'?'⚠ FAIL':'⚠ 超标';return ok?'<span class="verdict-ok">'+P+'</span>':'<span class="verdict-bad">'+F+'</span>';}
function recompute(el){var tr=el.closest('tr');var spec=tr.querySelector('[data-f="spec"]').textContent.trim();var val=tr.querySelector('[data-f="result"]').textContent.trim();tr.querySelector('[data-f="verdict"]').innerHTML=verdictHtml(spec,val);}
function renderItems(items){
  _items=items||[];
  document.getElementById('fi-body').innerHTML=_items.map(function(it){
    var nm=(_lang==='en'&&_EN[it.name])?_EN[it.name]:it.name;
    return '<tr>'
      +'<td>'+esc(it.no)+'</td>'
      +'<td class="ed" contenteditable data-f="name" data-zhname="'+esc(it.name)+'">'+esc(nm)+'</td>'
      +'<td class="ed" contenteditable data-f="unit">'+esc(it.unit)+'</td>'
      +'<td class="ed" contenteditable data-f="spec">'+esc(it.spec)+'</td>'
      +'<td class="res ed" contenteditable data-f="result" data-ph="'+(_lang==='en'?'fill value':'填检验值')+'" oninput="recompute(this)">'+esc(it.result)+'</td>'
      +'<td data-f="verdict">'+verdictHtml(it.spec,it.result)+'</td>'
      +'</tr>';
  }).join('');
}
/* ── 中英切换 ── */
function captureResults(){document.querySelectorAll('#fi-body tr').forEach(function(tr,i){if(_items[i]){var rs=tr.querySelector('[data-f="result"]');if(rs)_items[i].result=rs.textContent.trim();var sp=tr.querySelector('[data-f="spec"]');if(sp)_items[i].spec=sp.textContent.trim();var un=tr.querySelector('[data-f="unit"]');if(un)_items[i].unit=un.textContent.trim();}});}
function applyLang(){document.querySelectorAll('[data-en]').forEach(function(el){if(!el.hasAttribute('data-zh'))el.setAttribute('data-zh',el.textContent);el.textContent=(_lang==='en')?el.getAttribute('data-en'):el.getAttribute('data-zh');});var b=document.getElementById('langBtn');if(b)b.textContent=_lang==='en'?'🌐 中文':'🌐 English';}
function toggleLang(){captureResults();_lang=(_lang==='en')?'zh':'en';renderItems(_items);applyLang();}
function dlExcel(){saveResults().then(function(){window.open(API+'/api/db/doc-render?kind='+encodeURIComponent(_kind)+'&id='+encodeURIComponent(_order)+'&format=xlsx&token='+encodeURIComponent(tok()),'_blank');});}

/* ── 加载 ── */
function load(){
  _order=qp('id')||qp('order_no');_kind=qp('kind')||'fi';
  if(!_order){banner('err','请加 ?kind=fi&id=订单号&token=YY');return;}
  document.getElementById('lbl').textContent=_order+' · '+_kind;
  banner('info','加载中…');
  fetch(API+'/api/db/doc-render?kind='+encodeURIComponent(_kind)+'&id='+encodeURIComponent(_order)+'&format=json&token='+encodeURIComponent(tok()),{headers:authH()})
    .then(function(r){return r.json();}).then(function(d){
      if(d.error)throw new Error(d.error);
      _sellerCode=d.factory_company||'';_sampleName=d.sample_name||'';
      setT('fi-factory',d.factory_display);setT('fi-sample',d.sample_name);
      setT('fi-std','参考标准：'+(d.ref_std||''));
      setT('fi-report',d.report_no);setT('fi-order',d.order_no);setT('fi-prod',d.sample_name);
      setT('fi-spec',d.product_spec);setT('fi-batch',d.batch_no);setT('fi-proddate',d.prod_date);
      setT('fi-qtywt',d.qty_weight);setT('fi-inspdate',d.insp_date);setT('fi-sampleqty',d.sample_qty);
      setT('fi-note',d.note);setT('fi-inspector',d.inspector);setT('fi-reviewer',d.reviewer);
      renderItems(d.items||[]);
      if(d.seal_url){applySeal('fi:seller',d.seal_url,'工厂章');_curSealName='工厂章';updateSealStatus();}
      else{try{var s=JSON.parse(localStorage.getItem(sealKey('fi:seller'))||'null');if(s&&s.url){applySeal('fi:seller',s.url,s.name);_curSealName=s.name||'章';updateSealStatus();}}catch(e){}}
      banner('','');
    }).catch(function(e){banner('err','加载失败: '+e.message);});
}

/* ── 保存检验结果 → factory_doc_results ── */
function collectResults(){
  var results={};
  document.querySelectorAll('#fi-body tr').forEach(function(tr){
    var nm=tr.querySelector('[data-f="name"]'),rs=tr.querySelector('[data-f="result"]');
    if(nm&&rs){var name=(nm.getAttribute('data-zhname')||nm.textContent).trim(),val=rs.textContent.trim();if(name)results[name]=val;}
  });
  var sq=txt('fi-sampleqty');if(sq)results['送检批量']=sq;
  var bn=txt('fi-batch');if(bn)results['生产批号']=bn;
  return results;
}
function saveResults(){
  var results=collectResults();
  banner('info','保存中…');
  return fetch(API+'/api/db/doc-render',{method:'POST',headers:authH(),body:JSON.stringify({order_no:_order,kind:_kind,results:results})})
    .then(function(r){return r.json();}).then(function(d){
      if(d.success){banner('info','✓ 检验结果已保存入库('+d.count+'项)·单据/PDF/别处打开都显真实值');}
      else{banner('err','保存失败: '+(d.error||''));}
      setTimeout(function(){banner('','');},2800);
      return d;
    }).catch(function(e){banner('err','保存失败: '+e.message);});
}
function dlPdf(){ saveResults().then(function(){ window.open(API+'/api/db/doc-render?kind='+encodeURIComponent(_kind)+'&id='+encodeURIComponent(_order)+'&format=pdf&token='+encodeURIComponent(tok()),'_blank'); }); }
function fwdLink(){ var u=location.href; try{navigator.clipboard.writeText(u);banner('info','✓ 编辑器链接已复制');setTimeout(function(){banner('','');},1500);}catch(e){prompt('复制链接:',u);} }
function downloadPng(){
  var btn=document.querySelector('.btn-dl');btn.textContent='⏳…';btn.disabled=true;document.querySelector('.toolbar').style.display='none';
  var done=function(){document.querySelector('.toolbar').style.display='';btn.textContent='📥 下载图片';btn.disabled=false;};
  var s=document.createElement('script');s.src='https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  s.onload=function(){html2canvas(document.getElementById('page'),{scale:2,useCORS:true,backgroundColor:'#fff'}).then(function(c){var a=document.createElement('a');a.download='厂检单_'+(_sampleName||'')+'_'+_order+'.png';a.href=c.toDataURL('image/png');a.click();done();}).catch(done);};
  if(window.html2canvas)s.onload();else document.head.appendChild(s);
}

/* ── 印章系统(复用CN编辑器) ── */
function sealTargets(t){if(!t)return[];return [t];}
function sealKey(t){return 'fi_editor_seal_'+String(t).replace(':','_');}
function initRotHandle(t){
  var id=t.replace(':','-'),area=document.getElementById(id+'-seal-area'),img=document.getElementById(id+'-seal');
  if(!area||!img)return;img.style.cursor='grab';img.title='拖动旋转';
  img.onmousedown=function(e){e.preventDefault();e.stopPropagation();img.style.cursor='grabbing';
    var r=area.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
    var sm=Math.atan2(e.clientY-cy,e.clientX-cx)*180/Math.PI,sr=_sealRotation[t]||0;
    function mv(ev){var a=Math.atan2(ev.clientY-cy,ev.clientX-cx)*180/Math.PI;_sealRotation[t]=sr+(a-sm);img.style.transform='rotate('+_sealRotation[t].toFixed(1)+'deg)';}
    function up(){img.style.cursor='grab';document.removeEventListener('mousemove',mv);document.removeEventListener('mouseup',up);}
    document.addEventListener('mousemove',mv);document.addEventListener('mouseup',up);};
}
function applySeal(target,url,name){
  if(!url){url=target;target='fi:seller';}
  sealTargets(target).forEach(function(t){
    var id=t.replace(':','-'),img=document.getElementById(id+'-seal'),hint=document.getElementById(id+'-seal-hint');
    if(!img)return;_sealRotation[t]=0;img.src=url;img.style.display='block';img.style.transform='';if(hint)hint.style.display='none';
    try{localStorage.setItem(sealKey(t),JSON.stringify({url:url,name:name||''}));}catch(e){}
    initRotHandle(t);
  });
}
function dropSeal(e,target){e.preventDefault();var f=e.dataTransfer.files[0];if(!f||!f.type.startsWith('image/'))return;var r=new FileReader();r.onload=function(ev){applySeal(target,ev.target.result,f.name.replace(/\.[^.]+$/,''));_curSealName=f.name.replace(/\.[^.]+$/,'');updateSealStatus();};r.readAsDataURL(f);}
window.addEventListener('message',function(e){if(!e.data||e.data.type!=='seal-ready')return;applySeal(_sealTarget,e.data.dataUrl,e.data.label||'印章');_curSealName=e.data.label||'印章';updateSealStatus();closeModal();});
function switchTab(name){['das','local','make','upload'].forEach(function(t){var b=document.getElementById('tab-'+t),c=document.getElementById('tab-'+t+'-content');if(b){b.style.background=t===name?'#3b82f6':'#f1f5f9';b.style.color=t===name?'#fff':'#64748b';}if(c)c.style.display=t===name?'':'none';});if(name==='das')loadDasStamps();if(name==='local')renderLocalStamps();}
function openSealPicker(target){_sealTarget=target||'fi:seller';document.getElementById('sealModal').style.display='flex';var dasTab=document.getElementById('tab-das');if(tok()){dasTab.style.display='';switchTab('das');}else{dasTab.style.display='none';loadLocalStamps();switchTab(_localStamps.length?'local':'make');}}
function closeModal(){document.getElementById('sealModal').style.display='none';}
function loadLocalStamps(){try{_localStamps=JSON.parse(localStorage.getItem('pc_local_stamps')||'[]');}catch(e){_localStamps=[];}}
function renderLocalStamps(){var g=document.getElementById('localGrid');if(!g)return;loadLocalStamps();if(!_localStamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">暂无本地章</div>';return;}g.innerHTML=_localStamps.map(function(s,i){return '<div onclick="selLocal('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center"><img src="'+esc(s.url)+'" style="width:64px;height:64px;object-fit:contain"><div style="font-size:11px;color:#475569;margin-top:4px">'+esc(s.name||'印章')+'</div></div>';}).join('');}
function selLocal(i){loadLocalStamps();applySeal(_sealTarget,_localStamps[i].url,_localStamps[i].name);_curSealName=_localStamps[i].name||'章';updateSealStatus();closeModal();}
function loadDasStamps(){
  var g=document.getElementById('stampGrid');g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载中…</div>';
  var url=API+'/api/db/customer-stamps'+(_dasMode==='all'?'?scope=all':(_sellerCode?('?company_code='+encodeURIComponent(_sellerCode)):''));
  fetch(url,{headers:authH()}).then(function(r){return r.json();}).then(function(d){
    var stamps=Array.isArray(d)?d:(d.stamps||d.data||[]);_stamps=stamps;
    var seg=function(m,l){return '<button onclick="setDasMode(\''+m+'\')" style="padding:4px 12px;border-radius:20px;border:1px solid '+(_dasMode===m?'#3b82f6':'#cbd5e1')+';background:'+(_dasMode===m?'#3b82f6':'#fff')+';color:'+(_dasMode===m?'#fff':'#475569')+';font-size:11px;font-weight:700;cursor:pointer">'+l+'</button>';};
    var toggle='<div style="grid-column:1/-1;display:flex;gap:6px;margin-bottom:6px">'+seg('company','🏢 本工厂章')+seg('all','📚 全部我的章')+'</div>';
    if(!stamps.length){g.innerHTML=toggle+'<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">此范围暂无印章</div>';return;}
    g.innerHTML=toggle+stamps.map(function(s,i){
      return '<div style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;text-align:center;position:relative">'
        +'<img onclick="selStamp('+i+')" src="'+esc(s.url)+'" style="width:60px;height:60px;object-fit:contain;cursor:pointer" title="点击盖章" onerror="this.style.opacity=0.3">'
        +'<div style="font-size:11px;color:#334155;margin-top:4px;font-weight:600">'+esc(s.name||'印章')+'</div>'
        +(s.company_code?'<div style="font-size:9px;color:#94a3b8;font-family:ui-monospace,monospace">'+esc(s.company_code)+'</div>':'')
        +'</div>';
    }).join('');
  }).catch(function(){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载失败</div>';});
}
function setDasMode(m){_dasMode=m;loadDasStamps();}
function selStamp(i){var s=_stamps[i];applySeal(_sealTarget,s.url,s.name);_curSealName=s.name||'章';updateSealStatus();closeModal();}
function onFileChosen(e){var file=e.target.files[0];if(!file)return;_pendingFile=file;var r=new FileReader();r.onload=function(ev){document.getElementById('uploadPreview').src=ev.target.result;document.getElementById('uploadPreview').style.display='block';document.getElementById('uploadPlaceholder').style.display='none';};r.readAsDataURL(file);if(!document.getElementById('uploadSealName').value)document.getElementById('uploadSealName').value=file.name.replace(/\.[^.]+$/,'');['uploadUseBtn','uploadLocalBtn'].forEach(function(id){document.getElementById(id).disabled=false;});e.target.value='';}
function useUploadedSeal(){if(!_pendingFile)return;var name=document.getElementById('uploadSealName').value.trim()||'印章';var r=new FileReader();r.onload=function(ev){applySeal(_sealTarget,ev.target.result,name);_curSealName=name;updateSealStatus();closeModal();};r.readAsDataURL(_pendingFile);}
function saveSealToLocal(){if(!_pendingFile)return;var name=document.getElementById('uploadSealName').value.trim()||'印章';var r=new FileReader();r.onload=function(ev){loadLocalStamps();_localStamps.unshift({id:'local_'+Date.now(),name:name,url:ev.target.result});localStorage.setItem('pc_local_stamps',JSON.stringify(_localStamps.slice(0,30)));document.getElementById('uploadStatus').textContent='✓ 已保存本地';document.getElementById('uploadStatus').style.color='#16a34a';setTimeout(function(){switchTab('local');},600);};r.readAsDataURL(_pendingFile);}

load();
