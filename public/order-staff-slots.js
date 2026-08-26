(function(){
"use strict";
var API="/api/db/order-staff-slots",state={order:null,slots:[],roster:[],missing:[]};
function $(id){return document.getElementById(id)}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(){var h={"Content-Type":"application/json"};if(token())h.Authorization="Bearer "+token();return h}
function el(tag,cls,txt){var n=document.createElement(tag);if(cls)n.className=cls;if(txt!==undefined)n.textContent=txt;return n}
function value(id){return ($(id).value||"").trim()}
function showLogin(){$("login").style.display="block";$("app").style.display="none"}
function msg(txt,ok){var box=$("msg");box.textContent="";box.appendChild(el("div","msg "+(ok?"ok":"err"),txt))}
async function req(url,opt){
  var r=await fetch(url,opt||{headers:headers()});
  if(r.status===401){showLogin();throw new Error("需要登录")}
  var j=await r.json().catch(function(){return {}});
  if(!r.ok||j.success===false)throw new Error(j.error||r.statusText);
  return j;
}
function rosterLabel(p){
  return [p.staff_no,p.name,p.domain,p.duty].filter(Boolean).join(" · ");
}
function option(select,value,label){
  var o=document.createElement("option");o.value=value||"";o.textContent=label||value||"未设置";select.appendChild(o);
}
function renderSetup(){
  var p=$("setupPanel"),t=$("setupText");
  if(!state.missing.length){p.hidden=true;t.textContent="";return}
  p.hidden=false;
  t.textContent="未接入: 缺 "+state.missing.join("、")+"；当前填充率见各角色槽。保存前需人工建表确认。";
}
function renderOrder(){
  var o=state.order;
  $("saveBtn").disabled=!o||state.missing.length>0;
  if(!o){$("orderInfo").textContent="未找到订单；请输入订单号、合同号或客户业务编号。";return}
  $("orderInfo").textContent=[
    o.order_no||("ID "+o.id),o.contract_no||"合同号未设置",o.customer_po||"客户业务编号未设置",o.customer||"客户未设置",o.status||"状态未设置"
  ].join(" · ");
}
function renderSlots(){
  var box=$("slots");box.textContent="";
  (state.slots||[]).forEach(function(s){
    var card=el("div","slot "+(s.state==="assigned"?"assigned":"nodata"));
    card.appendChild(el("b","",s.label||s.role_key));
    var sel=document.createElement("select");sel.dataset.role=s.role_key;
    option(sel,"","未设置");
    state.roster.forEach(function(p){option(sel,p.staff_no,rosterLabel(p))});
    sel.value=s.staff_no||"";
    sel.disabled=state.missing.length>0;
    card.appendChild(sel);
    if(s.state==="assigned"){
      card.appendChild(el("div","status","已接入: "+(s.staff_no||"")+" "+(s.staff_name||"")+"；当前填充率 "+(s.fill_rate||"未接入")));
    }else{
      var miss=(s.missing_fields||["order_staff_slots.staff_no","ai_staff.staff_no"]).join("、");
      card.appendChild(el("div","status","未接入: 缺 "+miss+"；当前填充率 "+(s.fill_rate||"未接入")));
    }
    box.appendChild(card);
  });
}
function applyData(j){
  state.order=j.order||null;state.slots=j.slots||[];state.roster=j.roster||[];state.missing=j.missing_fields||[];
  renderSetup();renderOrder();renderSlots();
}
async function load(){
  $("stamp").textContent="生成时间 "+new Date().toLocaleString("zh-CN");
  var no=value("orderNo"),url=API;
  if(no)url+="?order_no="+encodeURIComponent(no);
  applyData(await req(url,{headers:headers()}));
}
function collectSlots(){
  var out={};
  document.querySelectorAll("#slots select").forEach(function(s){out[s.dataset.role]=s.value});
  return out;
}
$("loadBtn").onclick=function(){load().catch(function(e){msg(e.message,false)})};
$("saveBtn").onclick=async function(){
  try{
    if(!state.order)throw new Error("先读取订单");
    var j=await req(API,{method:"PATCH",headers:headers(),body:JSON.stringify({order_id:state.order.id,slots:collectSlots()})});
    applyData(j);msg("人员槽已保存。",true);
  }catch(e){msg(e.message,false)}
};
$("openWb").onclick=function(){
  var d={type:"sanlyn:open-tab",title:"订单人员槽",url:"/order-staff-slots"};
  if(window.parent!==window)window.parent.postMessage(d,location.origin);
  else window.open("/wb-tabs?open="+encodeURIComponent("/order-staff-slots"),"_blank","noopener");
};
$("go").onclick=async function(){
  try{
    var r=await fetch("/api/db/auth-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:value("u"),password:value("p")})});
    var d=await r.json();
    if(!r.ok||!d.token)throw new Error(d.error||"登录失败");
    localStorage.setItem("sanlyn_token",d.token);
    $("login").style.display="none";$("app").style.display="block";load();
  }catch(e){$("le").textContent=e.message}
};
if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"订单人员槽",url:location.pathname},location.origin);
load().catch(function(e){if(e.message!=="需要登录")msg(e.message,false)});
})();
