(function(){
"use strict";
var API="/api/db/order-draft-entry";
var currentDraftId=null;
var duplicateOrder=null;
function $(id){return document.getElementById(id)}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(){var h={"Content-Type":"application/json"};if(token())h.Authorization="Bearer "+token();return h}
function el(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n}
function showLogin(){ $("login").style.display="block"; $("app").style.display="none" }
function msg(text,ok){var box=$("msg");box.textContent="";var d=el("div","msg "+(ok?"ok":"err"),text);box.appendChild(d)}
function duplicateText(d){
  if(!d)return "";
  return "已存在: "+(d.public_order_no||d.order_no||("ID "+d.id))+"；状态 "+(d.status||"未设置")+"；企业内部编号 "+(d.internal_snowflake_id||"未接入");
}
function statusText(v){return v==="new"||!v?"新建":v}
async function req(url,opt){
  var r=await fetch(url,opt||{headers:headers()});
  if(r.status===401){showLogin();throw new Error("需要登录")}
  var j=await r.json().catch(function(){return {}});
  if(!r.ok||j.success===false)throw new Error(j.error||r.statusText);
  return j;
}
function value(id){return ($(id).value||"").trim()}
async function checkDuplicate(){
  duplicateOrder=null;
  var hint=$("dupHint");hint.textContent="";hint.className="meta";
  var company=value("companyCode"), po=value("customerPo");
  if(!company||!po)return null;
  var url=API+"?action=duplicate-check&companyCode="+encodeURIComponent(company)+"&customerPo="+encodeURIComponent(po);
  if(currentDraftId)url+="&excludeId="+encodeURIComponent(currentDraftId);
  var j=await req(url,{headers:headers()});
  duplicateOrder=j.duplicate||null;
  if(duplicateOrder){
    hint.className="meta err";
    hint.textContent="重复预警："+duplicateText(duplicateOrder);
  }else{
    hint.className="meta ok";
    hint.textContent="未发现同客户重复业务编号";
  }
  return duplicateOrder;
}
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
function renderIdStats(rows){
  var box=$("idStats");box.textContent="";
  (rows||[]).forEach(function(r){
    var card=el("div","stat");
    card.appendChild(el("b","",r.label||r.field));
    if(!r.connected||r.fill_rate==null){
      var miss=r.missing||("orders."+r.field);
      var rate=r.total?("未接入（样本 "+r.total+" 行，已填 "+(r.filled||0)+" 行）"):"未接入";
      card.appendChild(el("span","","未接入: 缺 "+miss+"；当前填充率 "+rate+"；规则 "+(r.policy||"未设置")));
    }else{
      card.appendChild(el("span","","当前填充率 "+r.fill_rate+"%（orders."+r.field+"；规则 "+(r.policy||"未设置")+"）"));
    }
    box.appendChild(card);
  });
  if(!box.children.length)box.appendChild(el("div","stat","未接入: 缺 orders.public_order_no / orders.internal_snowflake_id；当前填充率 未接入"));
}
function idCard(label,value,field){
  var card=el("div","stat");
  card.appendChild(el("b","",label));
  card.appendChild(el("span","",value||("未接入: 缺 orders."+field+"；当前填充率 未接入")));
  return card;
}
function renderDraft(order){
  currentDraftId=order.id||currentDraftId;
  $("patchBtn").hidden=!currentDraftId;
  $("draftBox").hidden=false;
  var ids=$("draftIds");ids.textContent="";
  ids.appendChild(idCard("对外单号",order.public_order_no||order.order_no,"public_order_no"));
  ids.appendChild(idCard("内部主键",order.internal_snowflake_id,"internal_snowflake_id"));
  $("draftInfo").textContent="已新建: "+(order.public_order_no||order.order_no||("ID "+order.id))+"；状态 "+statusText(order.status)+"；合同号 "+(order.contract_no||"未设置");
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
  renderIdStats(j.identifier_stats||[]);
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
    if(await checkDuplicate())throw new Error("客户业务编号重复，已停止新建。"+duplicateText(duplicateOrder));
    var j=await req(API,{method:"POST",headers:headers(),body:JSON.stringify(payload())});
    renderDraft(j.order);
    msg("订单已新建，缺口保存在 raw.draft_missing_fields。",true);
  }catch(e){msg(e.message,false)}
};
$("patchBtn").onclick=async function(){
  try{
    if(!currentDraftId)throw new Error("先新建订单");
    if(await checkDuplicate())throw new Error("客户业务编号重复，已停止保存。"+duplicateText(duplicateOrder));
    var j=await req(API,{method:"PATCH",headers:headers(),body:JSON.stringify({id:currentDraftId,fields:payload()})});
    renderDraft(j.order);
    msg("新建单补全信息已保存。",true);
  }catch(e){msg(e.message,false)}
};
$("openWb").onclick=function(){
  var d={type:"sanlyn:open-tab",title:"订单录入",url:"/order-entry"};
  if(window.parent!==window)window.parent.postMessage(d,location.origin);
  else window.open("/wb-tabs?open="+encodeURIComponent("/order-entry"),"_blank","noopener");
};
$("customerPo").addEventListener("blur",function(){checkDuplicate().catch(function(e){msg(e.message,false)})});
$("companyCode").addEventListener("change",function(){checkDuplicate().catch(function(e){msg(e.message,false)})});
$("go").onclick=async function(){
  try{
    var r=await fetch("/api/db/auth-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:value("u"),password:value("p")})});
    var d=await r.json();
    if(!r.ok||!d.token)throw new Error(d.error||"登录失败");
    localStorage.setItem("sanlyn_token",d.token);
    $("login").style.display="none";$("app").style.display="block";load();
  }catch(e){$("le").textContent=e.message}
};
if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"订单录入",url:location.pathname},location.origin);
load().catch(function(e){if(e.message!=="需要登录")msg(e.message,false)});
})();
