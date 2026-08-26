(function(){
"use strict";
var API="/api/db/custom-nav",state={items:[],selected:new Set(),ready:false};
function $(id){return document.getElementById(id)}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(body){var h={},t=token();if(t)h.Authorization="Bearer "+t;if(body)h["Content-Type"]="application/json";return h}
function showToast(text){$("toast").textContent=String(text||"");$("toast").classList.remove("hidden");setTimeout(function(){$("toast").classList.add("hidden")},1800)}
function postReady(){if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"自定义导航",url:location.pathname+location.search},location.origin)}
async function api(method,body){
  var r=await fetch(API,{method:method||"GET",headers:headers(body),body:body?JSON.stringify(body):undefined});
  var d=await r.json().catch(function(){return{error:"接口返回异常"}});
  if(!r.ok||d.success===false)throw new Error(d.error||d.basis&&d.basis.note||"请求失败");
  return d;
}
function setSummary(d){$("summary").textContent="v2026.08.26-1 · 生成时间 "+new Date(d.generated_at||Date.now()).toLocaleString()}
function row(item, checked){
  var label=document.createElement("label");label.className="row";
  var input=document.createElement("input");input.type="checkbox";input.checked=checked;input.dataset.url=item.url;
  var main=document.createElement("div"),title=document.createElement("div"),url=document.createElement("div");
  title.className="title";url.className="url";title.textContent=item.title;url.textContent=item.url;main.appendChild(title);main.appendChild(url);
  var action=document.createElement("button");action.type="button";action.className="btn";action.dataset.url=item.url;action.textContent=checked?"移除":"加入";
  label.appendChild(input);label.appendChild(main);label.appendChild(action);return label;
}
function render(){
  var chosen=state.items.filter(function(x){return state.selected.has(x.url)});
  $("availableCount").textContent=state.items.length?state.items.length+" 项":"未接入";
  $("selectedCount").textContent=chosen.length?chosen.length+" 项":"未接入";
  $("save").disabled=!state.ready;
  $("available").textContent="";$("selected").textContent="";
  if(!state.items.length){$("available").innerHTML='<div class="empty">未接入: 缺 default_items；当前填充率 未接入</div>'}
  state.items.forEach(function(item){$("available").appendChild(row(item,state.selected.has(item.url)))});
  if(!chosen.length){$("selected").innerHTML='<div class="empty">未接入: 缺 custom_items 配置行；当前填充率 0%</div>'}
  chosen.forEach(function(item){$("selected").appendChild(row(item,true))});
}
async function load(){
  try{
    var d=await api("GET");state.items=d.default_items||[];state.selected=new Set((d.custom_items||[]).map(function(x){return x.url}));state.ready=d.can_save!==false&&!!state.items.length;
    setSummary(d);$("basis").textContent=d.basis&&d.basis.note?d.basis.note:"未接入: 缺 basis；当前填充率 未接入";render();
  }catch(e){$("summary").textContent="v2026.08.26-1 · 读取失败";$("basis").textContent=e.message;state.ready=false;render()}
}
function toggle(url){state.selected.has(url)?state.selected.delete(url):state.selected.add(url);render()}
async function save(){
  var items=state.items.filter(function(x){return state.selected.has(x.url)});
  try{var d=await api("PUT",{items:items});setSummary(d);showToast("已保存");if(window.parent!==window)window.parent.postMessage({type:"sanlyn:nav-updated"},location.origin)}
  catch(e){showToast(e.message)}
}
$("available").onclick=function(e){var t=e.target.closest("[data-url]");if(t)toggle(t.dataset.url)};
$("selected").onclick=function(e){var t=e.target.closest("[data-url]");if(t)toggle(t.dataset.url)};
$("reload").onclick=load;$("save").onclick=save;postReady();load();
})();
