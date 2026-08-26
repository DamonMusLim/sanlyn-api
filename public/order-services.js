(function(){
"use strict";
var API="/api/db/order-services";
var ITEMS=[
  ["BOOKING","订舱"],["TRUCKING","拖车"],["STUFFING","内装"],["CUSTOMS","报关"],
  ["CLEARANCE","清关"],["OVERSEAS","海外段"],["INSURANCE","保险"],["CONTAINER_LEASE","租箱"],
  ["FUMIGATION","熏蒸"],["BUY_DOC","买单"],["CERTIFICATE","办证"],["DOC_MAKING","制单"]
];
var state={loaded:false,writable:false,services:[]};
function $(id){return document.getElementById(id)}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(body){var h=body?{"Content-Type":"application/json"}:{};if(token())h.Authorization="Bearer "+token();return h}
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function value(id){return ($(id).value||"").trim()}
function showLogin(){ $("login").style.display="block"; $("app").style.display="none" }
function msg(text,ok){var box=$("msg");box.textContent="";box.appendChild(el("div","msg "+(ok?"ok":"err"),text))}
function qs(){
  var p=new URLSearchParams(), planId=value("planId"), blNo=value("blNo");
  if(planId)p.set("plan_id",planId);
  if(blNo)p.set("bl_no",blNo);
  return p.toString();
}
async function req(url,opt){
  var r=await fetch(url,opt||{headers:headers()});
  if(r.status===401){showLogin();throw new Error("需要登录")}
  var j=await r.json().catch(function(){return {error:"接口返回异常"}});
  if(!r.ok||j.success===false)throw new Error(j.error||"请求失败");
  return j;
}
function findService(code){return state.services.find(function(x){return x.code===code})||{}}
function serviceStatus(s){
  if(s.state==="selected")return "已勾选；来源 "+(s.source==="explicit"?"人工勾选":("真实字段 "+(s.source_column||"")));
  if(s.state==="not_selected")return "未勾选；来源 真实字段 "+(s.source_column||"");
  return "未接入: 缺 "+((s.missing_fields||["order_services.service_type"]).join(" / "))+"；当前填充率 "+(s.fill_rate||"未接入");
}
function renderServices(){
  var box=$("services");box.textContent="";
  ITEMS.forEach(function(item){
    var code=item[0], name=item[1], s=findService(code), card=el("label","service","");
    var top=el("div","service-top"), cb=document.createElement("input");
    cb.type="checkbox";cb.value=code;cb.checked=s.state==="selected";cb.disabled=!state.loaded||!state.writable;
    top.appendChild(cb);top.appendChild(el("b","",name));card.appendChild(top);
    card.appendChild(el("div","status",serviceStatus(s)));
    card.classList.toggle("selected",s.state==="selected");
    card.classList.toggle("nodata",s.state==="no_data");
    box.appendChild(card);
  });
}
function renderLoaded(j){
  state.loaded=true;state.writable=!!j.writable;state.services=j.data||[];
  var p=j.plan||{};
  $("stamp").textContent="生成时间 "+new Date(j.generated_at||Date.now()).toLocaleString("zh-CN");
  $("planInfo").textContent="当前票据: 计划ID "+(p.id||p.plan_id||"未接入")+"；提单号 "+(p.bl_no||"未接入")+"；订舱号 "+(p.shipment_no||"未接入");
  $("saveBtn").disabled=!state.writable;
  $("setupPanel").hidden=state.writable;
  $("setupPanel").classList.add("readonly");
  $("setupText").textContent=state.writable?"":"缺 "+((j.missing_setup&&j.missing_setup.length)?j.missing_setup.join(" / "):"order_services.service_type + source + plan_id/shipping_plan_id")+"；当前填充率见各服务项";
  renderServices();
}
async function load(){
  try{
    var query=qs();if(!query)throw new Error("请先输入计划 ID 或提单号");
    renderServices();msg("读取中...",true);
    renderLoaded(await req(API+"?"+query,{headers:headers()}));
    msg("已读取真实服务项目。",true);
  }catch(e){msg(e.message,false)}
}
function checkedCodes(){
  return Array.from(document.querySelectorAll('#services input[type="checkbox"]:checked')).map(function(x){return x.value});
}
async function save(){
  try{
    var query=qs();if(!query)throw new Error("请先输入计划 ID 或提单号");
    var body=JSON.stringify({services:checkedCodes()});
    renderLoaded(await req(API+"?"+query,{method:"PATCH",headers:headers(true),body:body}));
    msg("服务项目勾选已保存。",true);
  }catch(e){msg(e.message,false)}
}
function initFromUrl(){
  var p=new URLSearchParams(location.search);
  if(p.get("plan_id"))$("planId").value=p.get("plan_id");
  if(p.get("id"))$("planId").value=p.get("id");
  if(p.get("bl_no"))$("blNo").value=p.get("bl_no");
  renderServices();
  if(qs())load();
}
$("loadBtn").onclick=load;
$("saveBtn").onclick=save;
$("openWb").onclick=function(){
  var url="/order-services"+(qs()?("?"+qs()):"");
  var d={type:"sanlyn:open-tab",title:"服务项目",url:url};
  if(window.parent!==window)window.parent.postMessage(d,location.origin);
  else window.open("/wb-tabs?open="+encodeURIComponent(url),"_blank","noopener");
};
$("go").onclick=async function(){
  try{
    var r=await fetch("/api/db/auth-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:value("u"),password:value("p")})});
    var d=await r.json();
    if(!r.ok||!d.token)throw new Error(d.error||"登录失败");
    localStorage.setItem("sanlyn_token",d.token);
    $("login").style.display="none";$("app").style.display="block";initFromUrl();
  }catch(e){$("le").textContent=e.message}
};
if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"服务项目",url:location.pathname},location.origin);
initFromUrl();
})();
