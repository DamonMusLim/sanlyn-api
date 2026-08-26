(function(){
"use strict";
var API="/api/db/order-draft-entry";
var currentDraftId=null;
function $(id){return document.getElementById(id)}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(){var h={"Content-Type":"application/json"};if(token())h.Authorization="Bearer "+token();return h}
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function showLogin(){ $("login").style.display="block"; $("app").style.display="none" }
function msg(text,ok){var box=$("msg");box.textContent="";var d=el("div","msg "+(ok?"ok":"err"),text);box.appendChild(d)}
async function req(url,opt){
  var r=await fetch(url,opt||{headers:headers()});
  if(r.status===401){showLogin();throw new Error("需要登录")}
  var j=await r.json().catch(function(){return {}});
  if(!r.ok||j.success===false)throw new Error(j.error||r.statusText);
  return j;
}
function value(id){return ($(id).value||"").trim()}
function renderStats(rows){
  var box=$("stats");box.textContent="";
  (rows||[]).forEach(function(r){
    var card=el("div","stat");
    card.appendChild(el("b","",r.label||r.field));
    if(!r.connected||r.fill_rate==null){
      var miss=r.missing||("orders."+r.field);
      var rate=r.total?("未接入（样本 "+r.total+" 行，无已填）"):"未接入";
      card.appendChild(el("span","","未接入: 缺 "+miss+"；当前填充率 "+rate));
    }else{
      card.appendChild(el("span","","当前填充率 "+r.fill_rate+"%（orders."+r.field+"）"));
    }
    box.appendChild(card);
  });
}
function renderDraft(order){
  currentDraftId=order.id||currentDraftId;
  $("patchBtn").hidden=!currentDraftId;
  $("draftBox").hidden=false;
  $("draftInfo").textContent="已建草稿: "+(order.order_no||("ID "+order.id))+"；状态 "+(order.status||"draft")+"；合同号 "+(order.contract_no||"未设置");
  var miss=$("missing");miss.textContent="";
  var raw=order.raw||{}, arr=raw.draft_missing_fields||[];
  if(!arr.length){miss.appendChild(el("span","pill","补全率 100%"));return}
  miss.appendChild(el("div","meta","待补字段："));
  arr.forEach(function(x){miss.appendChild(el("span","pill",(x.label||x.field)+" · "+(x.field||"")))});
}
async function load(){
  $("stamp").textContent="生成时间 "+new Date().toLocaleString("zh-CN");
  var j=await req(API,{headers:headers()});
  renderStats(j.field_stats||[]);
  var dl=$("buyers");dl.textContent="";
  (j.buyers||[]).forEach(function(b){
    var o=document.createElement("option");
    o.value=b.company_code||"";
    o.label=[b.name_en,b.name_cn].filter(Boolean).join(" / ");
    dl.appendChild(o);
  });
}
function payload(){
  return {
    companyCode:value("companyCode"),
    customer_po:value("customerPo"),
    destination_port:value("destinationPort"),
    factory_code:value("factoryCode"),
    trade_terms:value("tradeTerms"),
    purchase_trade_terms:value("purchaseTerms"),
    consignee:value("consignee"),
    remarks:value("remarks"),
    products:[]
  };
}
$("createBtn").onclick=async function(){
  try{
    var j=await req(API,{method:"POST",headers:headers(),body:JSON.stringify(payload())});
    renderDraft(j.order);
    msg("草稿单已建立，缺口保存在 raw.draft_missing_fields。",true);
  }catch(e){msg(e.message,false)}
};
$("patchBtn").onclick=async function(){
  try{
    if(!currentDraftId)throw new Error("先建草稿单");
    var j=await req(API,{method:"PATCH",headers:headers(),body:JSON.stringify({id:currentDraftId,fields:payload()})});
    renderDraft(j.order);
    msg("草稿补全信息已保存。",true);
  }catch(e){msg(e.message,false)}
};
$("openWb").onclick=function(){
  var d={type:"sanlyn:open-tab",title:"订单录入",url:"/order-entry"};
  if(window.parent!==window)window.parent.postMessage(d,location.origin);
  else window.open("/wb-tabs?open="+encodeURIComponent("/order-entry"),"_blank","noopener");
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
load().catch(function(e){if(e.message!=="需要登录")msg(e.message,false)});
})();
