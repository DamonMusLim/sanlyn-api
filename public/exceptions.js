(function(){
"use strict";
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function id(v){return document.getElementById(v)}
function clean(v){return v==null?"":String(v).trim()}
function fmtDate(v){if(!v)return "";var d=new Date(v);if(isNaN(d.getTime()))return String(v).slice(0,10);return d.getFullYear()+"-"+pad(d.getMonth()+1)+"-"+pad(d.getDate())}
function pad(n){return n<10?"0"+n:String(n)}
function apiHeaders(){var h=headers();h["Content-Type"]="application/json";return h}
function request(url,opt,done){
  fetch(url,opt||{}).then(function(r){
    return r.json().catch(function(){return {}}).then(function(j){
      if(!r.ok||!j.success){var e=new Error(j.error||r.statusText||("HTTP "+r.status));e.status=r.status;throw e}
      return j;
    });
  }).then(function(j){done(null,j)}).catch(function(e){done(e)});
}
function ensureStyle(){
  if(id("sanlyn-exc-style"))return;
  var s=document.createElement("style");s.id="sanlyn-exc-style";
  s.textContent=[
    ".sx-mask{position:fixed;inset:0;z-index:9999;background:rgba(10,14,24,.42);display:flex;align-items:center;justify-content:center;padding:18px}",
    ".sx-modal{width:min(760px,96vw);max-height:92vh;background:#fff;border-radius:8px;box-shadow:0 18px 50px rgba(0,0,0,.24);display:flex;flex-direction:column;color:#1f2430;font:13px/1.5 -apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif}",
    ".sx-head{display:flex;align-items:center;justify-content:space-between;padding:13px 16px;border-bottom:1px solid #e8ebf0}",
    ".sx-title{font-size:17px;font-weight:650}.sx-close{border:0;background:#fff;color:#606775;font-size:22px;line-height:1;cursor:pointer;padding:2px 8px}",
    ".sx-body{padding:14px 16px;overflow:auto}.sx-sec{border:1px solid #e4e7ec;border-radius:8px;margin-bottom:12px;background:#fff}",
    ".sx-sec h3{margin:0;padding:9px 11px;border-bottom:1px solid #edf0f3;font-size:14px;background:#fafbfc}.sx-inner{padding:11px}",
    ".sx-types{display:flex;gap:8px;flex-wrap:wrap}.sx-type{display:inline-flex;align-items:center;gap:4px;border:1px solid #d7dce3;border-radius:6px;padding:5px 8px;background:#fff;cursor:pointer}",
    ".sx-type input{margin:0}.sx-mark{display:flex;gap:8px;align-items:center;margin-top:10px}.sx-note{flex:1;min-width:160px;padding:6px 8px;border:1px solid #d7dce3;border-radius:6px;font:inherit}",
    ".sx-btn{border:0;border-radius:6px;padding:6px 11px;background:#1f2430;color:#fff;font:inherit;cursor:pointer;white-space:nowrap}.sx-btn.alt{background:#eef1f5;color:#1f2430}.sx-btn:disabled{opacity:.55;cursor:not-allowed}",
    ".sx-err{display:none;margin-bottom:10px;padding:8px 10px;border:1px solid #f1b6b6;border-radius:6px;background:#fff3f3;color:#b42318}.sx-empty{color:#8b93a1;padding:6px 0}",
    ".sx-row{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid #f0f2f5}.sx-row:last-child{border-bottom:0}",
    ".sx-main{min-width:0}.sx-name{font-weight:650}.sx-meta{color:#667085;font-size:12px;margin-top:2px}.sx-dot{color:#d92d20;margin-right:4px}.sx-ok{color:#16803c;margin-right:4px}",
    "@media(max-width:560px){.sx-mask{align-items:flex-start;padding:8px}.sx-mark{display:block}.sx-note{width:100%;margin-bottom:8px}.sx-row{align-items:flex-start}.sx-btn{padding:6px 9px}}"
  ].join("");
  document.head.appendChild(s);
}
function modalHtml(blNo){
  return '<div class="sx-mask" id="sxMask"><div class="sx-modal" role="dialog" aria-modal="true">'
    +'<div class="sx-head"><div class="sx-title">异常情况 — '+esc(blNo||"")+'</div><button class="sx-close" id="sxClose" type="button">×</button></div>'
    +'<div class="sx-body"><div class="sx-err" id="sxErr"></div>'
    +'<div class="sx-sec"><h3>异常标记</h3><div class="sx-inner"><div class="sx-types" id="sxTypes"></div>'
    +'<div class="sx-mark"><button class="sx-btn alt" id="sxCustom" type="button">新增异常</button><span>备注:</span><input class="sx-note" id="sxNote" type="text" maxlength="500"><button class="sx-btn" id="sxAdd" type="button">标记异常</button></div></div></div>'
    +'<div class="sx-sec"><h3>现存异常</h3><div class="sx-inner" id="sxOpen"></div></div>'
    +'<div class="sx-sec"><h3>处理完成异常</h3><div class="sx-inner" id="sxResolved"></div></div>'
    +'<div class="sx-meta">异常处理完成后可点击异常,使异常切换成完成状态</div>'
    +'</div></div></div>';
}
function setError(msg){var e=id("sxErr");if(!e)return;e.style.display=msg?"block":"none";e.innerHTML=esc(msg||"")}
function selectedCodes(){
  var xs=document.getElementsByName("sxCode");
  var out=[];
  for(var i=0;i<xs.length;i++)if(xs[i].checked)out.push(xs[i].value);
  return out;
}
function renderTypes(types){
  var html="";
  (types||[]).forEach(function(t,i){
    if(t.active===false)return;
    html+='<label class="sx-type"><input type="checkbox" name="sxCode" value="'+esc(t.code)+'"> '+esc(t.name_cn||t.code)+'</label>';
  });
  id("sxTypes").innerHTML=html||'<div class="sx-empty">没有可用异常类型</div>';
}
function renderOpen(rows){
  var html="";
  (rows||[]).forEach(function(r){
    html+='<div class="sx-row"><div class="sx-main"><div class="sx-name"><span class="sx-dot">●</span>'+esc(r.name_cn||r.exception_code)+'</div>'
      +'<div class="sx-meta">负责:'+esc(r.owner_name||r.owner_no||"")+'  '+esc(fmtDate(r.occurred_at))+(r.note?'  '+esc(r.note):'')+'</div></div>'
      +'<button class="sx-btn alt sx-act" type="button" data-id="'+esc(r.id)+'" data-action="resolve">标记完成</button></div>';
  });
  id("sxOpen").innerHTML=html||'<div class="sx-empty">没有现存异常</div>';
}
function renderResolved(rows){
  var html="";
  (rows||[]).forEach(function(r){
    html+='<div class="sx-row"><div class="sx-main"><div class="sx-name"><span class="sx-ok">✓</span>'+esc(r.name_cn||r.exception_code)+'</div>'
      +'<div class="sx-meta">'+esc(fmtDate(r.occurred_at))+'  '+esc(fmtDate(r.resolved_at))+' 完成'+(r.note?'  '+esc(r.note):'')+'</div></div>'
      +'<button class="sx-btn alt sx-act" type="button" data-id="'+esc(r.id)+'" data-action="reopen">重新打开</button></div>';
  });
  id("sxResolved").innerHTML=html||'<div class="sx-empty">没有处理完成异常</div>';
}
function openModal(shippingPlanId,blNo){
  ensureStyle();
  var old=id("sxMask");if(old)old.parentNode.removeChild(old);
  document.body.insertAdjacentHTML("beforeend",modalHtml(blNo));
  var busy=false;
  function close(){var m=id("sxMask");if(m)m.parentNode.removeChild(m)}
  function setBusy(v){busy=v;var b=id("sxAdd");if(b)b.disabled=v}
  function load(){
    setError("");setBusy(true);
    request("/api/db/plan-exceptions?shipping_plan_id="+encodeURIComponent(shippingPlanId),{headers:headers()},function(err,j){
      setBusy(false);
      if(err){setError(err.message);return}
      renderTypes(j.types||[]);
      renderOpen(j.open||[]);
      renderResolved(j.resolved||[]);
    });
  }
  function add(){
    if(busy)return;
    var codes=selectedCodes(),note=clean(id("sxNote").value);
    if(!codes.length){setError("请选择异常类型");return}
    setError("");setBusy(true);
    function next(i){
      if(i>=codes.length){setBusy(false);id("sxNote").value="";load();return}
      request("/api/db/plan-exceptions",{method:"POST",headers:apiHeaders(),body:JSON.stringify({shipping_plan_id:shippingPlanId,exception_code:codes[i],note:note})},function(err){
        if(err){setBusy(false);setError(err.message);return}
        next(i+1);
      });
    }
    next(0);
  }
  function patch(recordId,action){
    if(busy)return;
    setError("");setBusy(true);
    request("/api/db/plan-exceptions",{method:"PATCH",headers:apiHeaders(),body:JSON.stringify({id:recordId,action:action})},function(err){
      setBusy(false);
      if(err){setError(err.message);return}
      load();
    });
  }
  id("sxClose").onclick=close;
  id("sxMask").onclick=function(e){if(e.target.id==="sxMask")close()};
  id("sxAdd").onclick=add;
  id("sxCustom").onclick=function(){id("sxNote").focus()};
  id("sxMask").addEventListener("click",function(e){
    var b=e.target.closest&&e.target.closest(".sx-act");
    if(!b)return;
    patch(b.getAttribute("data-id"),b.getAttribute("data-action"));
  });
  document.addEventListener("keydown",function escClose(e){if(!id("sxMask"))document.removeEventListener("keydown",escClose);else if(e.key==="Escape")close()});
  load();
}
window.SanlynExceptions={open:openModal};
})();
