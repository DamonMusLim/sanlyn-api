// Shared DAS seal picker for single-document templates (PI / PL / SC).
var _sealTarget='all:seller',_stamps=[],_localStamps=[],_pendingFile=null,_sealRotation={};
function sealCfg(){return window.DAS_SEAL_CONFIG||{};}
function sealPrefix(){return sealCfg().prefix||'doc';}
function sealTargets(t){
  if(!t)return[];
  var a=String(t).split(':');
  if(a[0]==='all')return [sealPrefix()+':'+a[1]];
  return [t];
}
function sealKey(t){
  var a=String(t).split(':'),p=a[0],w=a[1];
  if(p===sealPrefix()&&w==='seller'&&sealCfg().legacyKey)return sealCfg().legacyKey;
  return p+'_seal_'+w;
}
function sealEsc(s){
  if(typeof esc==='function')return esc(s);
  return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
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
function dropSeal(e,target){
  e.preventDefault();
  var f=e.dataTransfer.files[0];if(!f||!f.type.startsWith('image/'))return;
  var r=new FileReader();r.onload=function(ev){applySeal(target,ev.target.result,f.name.replace(/\.[^.]+$/,''));};r.readAsDataURL(f);
}
window.addEventListener('message',function(e){
  if(!e.data||e.data.type!=='seal-ready')return;
  applySeal(_sealTarget,e.data.dataUrl,e.data.label||'印章');closeModal();
});
function switchTab(name){
  ['das','local','make','upload'].forEach(function(t){
    var b=document.getElementById('tab-'+t),c=document.getElementById('tab-'+t+'-content');
    if(b){b.style.background=t===name?'#3b82f6':'#f1f5f9';b.style.color=t===name?'#fff':'#64748b';}
    if(c)c.style.display=t===name?'':'none';
  });
  if(name==='das')loadDasStamps();if(name==='local')renderLocalStamps();
}
function openSealPicker(target){
  _sealTarget=target||'all:seller';
  var m=document.getElementById('sealModal');if(m)m.style.display='flex';
  var dasTab=document.getElementById('tab-das');
  if(typeof tok==='function'&&tok()){if(dasTab)dasTab.style.display='';switchTab('das');}
  else{if(dasTab)dasTab.style.display='none';loadLocalStamps();switchTab(_localStamps.length?'local':'make');}
}
function closeModal(){var m=document.getElementById('sealModal');if(m)m.style.display='none';}
function pickSeal(){openSealPicker('all:seller');}
function loadLocalStamps(){try{_localStamps=JSON.parse(localStorage.getItem('pc_local_stamps')||'[]');}catch(e){_localStamps=[];}}
function renderLocalStamps(){
  var g=document.getElementById('localGrid');if(!g)return;loadLocalStamps();
  if(!_localStamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">暂无本地章</div>';return;}
  g.innerHTML=_localStamps.map(function(s,i){return '<div onclick="selLocal('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center"><img src="'+sealEsc(s.url)+'" style="width:64px;height:64px;object-fit:contain"><div style="font-size:11px;color:#475569;margin-top:4px">'+sealEsc(s.name||'印章')+'</div></div>';}).join('');
}
function selLocal(i){loadLocalStamps();applySeal(_sealTarget,_localStamps[i].url,_localStamps[i].name);closeModal();}
function loadDasStamps(){
  var g=document.getElementById('stampGrid');if(!g)return;
  g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载中…</div>';
  fetch(API+'/api/db/customer-stamps',{headers:authH()}).then(function(r){return r.json();}).then(function(d){
    var stamps=Array.isArray(d)?d:(d.stamps||d.data||[]);
    if(!stamps.length){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">DAS暂无印章</div>';return;}
    _stamps=stamps;
    g.innerHTML=stamps.map(function(s,i){return '<div onclick="selStamp('+i+')" style="border:2px solid #e2e8f0;border-radius:10px;padding:10px;cursor:pointer;text-align:center"><img src="'+sealEsc(s.url)+'" style="width:64px;height:64px;object-fit:contain" onerror="this.style.opacity=0.3"><div style="font-size:11px;color:#475569;margin-top:4px">'+sealEsc(s.name||'印章')+'</div></div>';}).join('');
  }).catch(function(){g.innerHTML='<div style="grid-column:1/-1;text-align:center;color:#94a3b8;padding:20px">加载失败</div>';});
}
function selStamp(i){applySeal(_sealTarget,_stamps[i].url,_stamps[i].name);closeModal();}
function onFileChosen(e){
  var file=e.target.files[0];if(!file)return;_pendingFile=file;
  var r=new FileReader();r.onload=function(ev){document.getElementById('uploadPreview').src=ev.target.result;document.getElementById('uploadPreview').style.display='block';document.getElementById('uploadPlaceholder').style.display='none';};r.readAsDataURL(file);
  if(!document.getElementById('uploadSealName').value)document.getElementById('uploadSealName').value=file.name.replace(/\.[^.]+$/,'');
  ['uploadUseBtn','uploadLocalBtn'].forEach(function(id){document.getElementById(id).disabled=false;});e.target.value='';
}
function useUploadedSeal(){
  if(!_pendingFile)return;
  var name=document.getElementById('uploadSealName').value.trim()||'印章';
  var r=new FileReader();r.onload=function(ev){applySeal(_sealTarget,ev.target.result,name);closeModal();};r.readAsDataURL(_pendingFile);
}
function saveSealToLocal(){
  if(!_pendingFile)return;
  var name=document.getElementById('uploadSealName').value.trim()||'印章';
  var r=new FileReader();r.onload=function(ev){
    loadLocalStamps();_localStamps.unshift({id:'local_'+Date.now(),name:name,url:ev.target.result});
    localStorage.setItem('pc_local_stamps',JSON.stringify(_localStamps.slice(0,30)));
    document.getElementById('uploadStatus').textContent='✓ 已保存本地';document.getElementById('uploadStatus').style.color='#16a34a';
    setTimeout(function(){switchTab('local');},600);
  };r.readAsDataURL(_pendingFile);
}
function restoreDasSeals(){
  ['buyer','seller'].forEach(function(w){
    var t=sealPrefix()+':'+w;
    try{var s=JSON.parse(localStorage.getItem(sealKey(t))||'null');if(s&&s.url)applySeal(t,s.url,s.name);}catch(e){}
  });
}
document.addEventListener('DOMContentLoaded',restoreDasSeals);
