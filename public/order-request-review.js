(function(){
"use strict";
var BASE=(location.pathname.indexOf("/po-test/")===0)?"/po-test":"";
var API=BASE+"/api/db/po-collab/order-request";
var JWT=ls("order_collab_jwt")||ls("sanlyn_jwt"), STATUS="submitted", LIST=[], CUR=null;
function $(id){return document.getElementById(id)}
function ls(k){try{return localStorage.getItem(k)||""}catch(e){return ""}}
function setLs(k,v){try{localStorage.setItem(k,v)}catch(e){}}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function ah(h){h=h||{};if(JWT)h.Authorization="Bearer "+JWT;return h}
function toast(m,e){var t=$("toast");t.textContent=m;t.className="toast"+(e?" err":"");t.style.display="block";clearTimeout(t._h);t._h=setTimeout(function(){t.style.display="none"},3200)}
function api(path,opt){opt=opt||{};opt.headers=ah(opt.headers||{});return fetch(API+path,opt).then(function(r){return r.json().then(function(j){if(r.status===401||j.need_login){showLogin(j.error||"");throw new Error("login")}if(!r.ok||j.ok===false)throw new Error(j.error||("HTTP "+r.status));return j})})}
function showLogin(msg){
  $("app").style.display="none";$("state").style.display="block";
  $("state").innerHTML='<div><b>请登录内部账号</b>'+(msg?'<div style="color:var(--miss)">'+esc(msg)+'</div>':"")+'<input id="u" placeholder="账号" style="margin-top:10px"><input id="p" type="password" placeholder="密码" style="margin-top:8px"><button class="btn pri" id="go" style="margin-top:8px">登录</button><div id="e" style="color:var(--miss);font-size:12px"></div></div>';
  $("go").onclick=function(){var u=$("u").value.trim(),p=$("p").value;if(!u||!p)return;$("go").disabled=true;
    fetch(BASE+"/api/db/auth-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})}).then(function(r){return r.json()}).then(function(j){if(!j.token){$("e").textContent=j.error||"登录失败";$("go").disabled=false;return}JWT=j.token;setLs("order_collab_jwt",j.token);load()}).catch(function(e){$("e").textContent=e.message;$("go").disabled=false})};
}
function load(){api("").then(function(j){LIST=j.requests||[];$("state").style.display="none";$("app").style.display="grid";renderTabs();renderList();var first=LIST.filter(function(x){return x.status===STATUS})[0]||LIST[0];if(first)openReq(first.id)}).catch(function(e){if(e.message!=="login")$("state").textContent=e.message})}
function renderTabs(){var st=["submitted","reviewing","returned","confirmed"];$("tabs").innerHTML=st.map(function(s){var n=LIST.filter(function(x){return x.status===s}).length;return '<button class="btn '+(s===STATUS?"on":"")+'" data-st="'+s+'">'+s+" "+n+"</button>"}).join("")}
function renderList(){var rows=LIST.filter(function(x){return x.status===STATUS});$("list").innerHTML=rows.map(function(r){return '<div class="item '+(CUR&&CUR.id===r.id?"on":"")+'" data-id="'+esc(r.id)+'"><b>#'+esc(r.id)+" · "+esc(r.company_code||r.companyCode||"")+'</b><small>'+esc((r.created_at||"").slice(0,16).replace("T"," "))+"</small></div>"}).join("")||'<div style="color:var(--dim);padding:12px">没有记录</div>'}
function openReq(id){api("?id="+encodeURIComponent(id)).then(function(j){CUR=j.request||{};renderDetail()}).catch(function(e){toast(e.message,true)})}
function val(o,keys){for(var i=0;i<keys.length;i++){if(o&&o[keys[i]]!=null)return o[keys[i]]}return ""}
function renderDetail(){
  $("rid").textContent=CUR.id||"";$("status").textContent=CUR.status||"";$("meta").innerHTML=[
    ["客户",val(CUR,["company_code","companyCode"])],["来源",CUR.source],["要求到货",val(CUR,["required_arrival_date","requiredArrivalDate"])],["客户 PO",val(CUR,["customer_po","customerPO"])],["柜型",CUR.container],["备注",CUR.remarks]
  ].map(function(x){return '<div><b>'+esc(x[0])+'：</b>'+esc(x[1]||"—")+"</div>"}).join("");
  var files=CUR.files||[];$("files").innerHTML=files.length?files.map(function(f,i){return '<div><a href="'+API+'/file?id='+encodeURIComponent(CUR.id)+'&file='+encodeURIComponent(i)+'" target="_blank">原件 '+(i+1)+'</a> '+esc(f.name||"")+"</div>"}).join(""):"<div>未上传原件</div>";
  var refs=CUR.priceRefs||[];$("checks").innerHTML=refs.length?refs.map(function(r){return '<div>'+esc(r.sku||"")+' · '+esc(r.label||"")+"</div>"}).join(""):"<div>暂无价格参考</div>";
  var lines=val(CUR,["products","lines"])||[];$("lines").innerHTML=lines.map(function(l,i){return '<tr data-i="'+i+'"><td><input data-k="sku" value="'+esc(l.sku||"")+'"></td><td><input data-k="productName" value="'+esc(l.productName||l.product_name||l.description||"")+'"></td><td><input class="num" data-k="qty" value="'+esc(l.qty||"")+'"></td><td><input class="num" data-k="unitPrice" value="'+esc(l.unitPrice||l.customerPrice||l.customer_price||"")+'"></td><td><input class="num" data-k="factoryPrice" value="'+esc(l.factoryPrice||"")+'"></td><td><input data-k="priceSource" value="'+esc(l.priceSource||l.price_source||"")+'"></td></tr>'}).join("");
  renderList();
}
function collect(){return [].map.call(document.querySelectorAll("#lines tr"),function(tr){var o={};[].forEach.call(tr.querySelectorAll("input[data-k]"),function(i){o[i.getAttribute("data-k")]=i.value});return o})}
function saveReview(){if(!CUR)return Promise.reject(new Error("未选择申请"));return api("/review",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:CUR.id,review:{products:collect()}})})}
function ask(msg,fn){var m=document.createElement("div");m.className="askmask";m.innerHTML='<div class="askbox"><div>'+esc(msg)+'</div><div style="text-align:right;margin-top:14px"><button class="btn" data-no>取消</button> <button class="btn pri" data-ok>确定</button></div></div>';m.onclick=function(e){if(e.target===m||e.target.hasAttribute("data-no"))m.remove();if(e.target.hasAttribute("data-ok")){m.remove();fn()}};document.body.appendChild(m)}
$("tabs").onclick=function(e){var b=e.target.closest("button[data-st]");if(!b)return;STATUS=b.getAttribute("data-st");CUR=null;renderTabs();renderList();var first=LIST.filter(function(x){return x.status===STATUS})[0];if(first)openReq(first.id)};
$("list").onclick=function(e){var it=e.target.closest(".item[data-id]");if(it)openReq(it.getAttribute("data-id"))};
$("bSave").onclick=function(){var b=this;b.disabled=true;saveReview().then(function(){toast("已保存");load()}).catch(function(e){toast(e.message,true)}).finally(function(){b.disabled=false})};
$("bConfirm").onclick=function(){if(!CUR)return;ask("确认建单？缺工厂含税价时后端会拒绝。",function(){var b=$("bConfirm");b.disabled=true;api("/confirm",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:CUR.id,review:{products:collect()}})}).then(function(){toast("已确认建单");load()}).catch(function(e){toast(e.message,true)}).finally(function(){b.disabled=false})})};
$("bReturn").onclick=function(){if(!CUR)return;var r=$("reason").value.trim();if(!r){toast("退回原因必填",true);$("reason").focus();return}ask("确认退回这条申请？",function(){api("/return",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({id:CUR.id,reason:r})}).then(function(){toast("已退回");$("reason").value="";load()}).catch(function(e){toast(e.message,true)})})};
load();
})();
