(function(){
"use strict";
var API="/api/db/audit-review",VERSION="v2026.08.26-1";
var TYPES={quote:"报价审核",fee_template:"费用模板审核",order:"订单审核",bl:"提单审核",fee:"费用审核",bill:"账单审核",company:"往来公司审核",contract:"合同审核"};
var NAME_TO_TYPE={"报价审核":"quote","费用模板审核":"fee_template","订单审核":"order","提单审核":"bl","费用审核":"fee","账单审核":"bill","往来公司审核":"company","合同审核":"contract"};
var state={type:new URLSearchParams(location.search).get("type")||NAME_TO_TYPE[new URLSearchParams(location.search).get("module")]||"quote",modules:[]};
function $(id){return document.getElementById(id)}
function text(n,v){n.textContent=v==null||v===""?"未设置":String(v)}
function el(tag,cls,txt){var n=document.createElement(tag);if(cls)n.className=cls;if(txt!==undefined)text(n,txt);return n}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function stateText(v){return v==="ready"?"已接入":v==="partial"?"部分接入":"未接入"}
function countText(v){return v==null||v===0?"未接入":String(v)}
function pct(v){return v==null?"未接入":v+"%"}
function apiUrl(){return API+"?type="+encodeURIComponent(state.type)}
async function getJson(url){
  var h={},t=token();if(t)h.Authorization="Bearer "+t;
  var r=await fetch(url,{headers:h}),d=await r.json().catch(function(){return {error:"接口返回异常"}});
  if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
  return d;
}
function openTab(title,url){
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",title:title,url:url},location.origin);
  else window.open(url,"_blank","noopener");
}
function renderTabs(){
  var box=$("tabs");box.textContent="";
  (state.modules.length?state.modules:Object.keys(TYPES).map(function(k){return {key:k,label:TYPES[k]}})).forEach(function(m){
    var b=el("button","tab hgj-tabbtn"+(m.key===state.type?" active":""),m.label);
    b.type="button";b.dataset.type=m.key;
    b.onclick=function(){state.type=m.key;history.replaceState(null,"","?type="+encodeURIComponent(m.key));load()};
    box.appendChild(b);
  });
}
function sourceReason(s){
  if(!s)return "未接入：缺来源表";
  var miss=(s.missing||[]).join(", ");
  if(s.state==="not_connected")return "未接入：缺字段 "+(miss||"或来源表无数据")+"；当前填充率 未接入";
  if(s.state==="partial")return "部分接入：缺字段 "+miss+"；当前填充率 "+pct(s.fill_rate);
  return "已接入：字段填充率 "+pct(s.fill_rate)+"；状态字段 "+(s.status_field||"未接入");
}
function renderMetrics(d){
  text($("title"),d.label||"审核管理专项");
  text($("stamp"),VERSION+" · 生成时间 "+new Date(d.generated_at||Date.now()).toLocaleString("zh-CN"));
  text($("mState"),stateText(d.source&&d.source.state));$("mState").className="num "+((d.source&&d.source.state)==="ready"?"":"na");
  text($("mStateBasis"),sourceReason(d.source));
  text($("mFill"),pct(d.source&&d.source.fill_rate));$("mFill").className="num "+((d.source&&d.source.fill_rate)!=null?"":"na");
  text($("mFillBasis"),"来源 "+((d.source&&d.source.table)||"未接入"));
  text($("mPending"),countText(d.todo&&d.todo.count));$("mPending").className="num "+(d.todo&&d.todo.count?"bad":"na");
  text($("mPendingBasis"),d.todo&&d.todo.state==="ready"?"operation_todos 真实队列":"未接入："+((d.todo&&d.todo.reason)||"缺待审队列表"));
  text($("basis"),d.note||"未接入");
}
function table(headers,rows,fill){
  var t=el("table"),thead=el("thead"),hr=el("tr"),tb=el("tbody");
  headers.forEach(function(h){hr.appendChild(el("th","",h))});thead.appendChild(hr);t.appendChild(thead);
  if(!rows.length){var tr=el("tr"),td=el("td","empty","未接入");td.colSpan=headers.length;tr.appendChild(td);tb.appendChild(tr)}
  rows.forEach(function(r){var tr=el("tr");fill(tr,r);tb.appendChild(tr)});
  t.appendChild(tb);return t;
}
function td(tr,v,cls){var cell=el("td",cls);text(cell,v);tr.appendChild(cell);return cell}
function renderSources(d){
  var box=$("sources");box.textContent="";
  box.appendChild(table(["来源表","状态","缺字段","填充率","待审"],d.tables||[],function(tr,r){
    td(tr,r.table,"mono");td(tr,stateText(r.state),r.state==="ready"?"":"warn");td(tr,(r.missing||[]).join(", ")||"无");td(tr,pct(r.fill_rate),"mono");td(tr,countText(r.pending),"mono");
  }));
}
function renderRows(d){
  var box=$("rows");box.textContent="";
  text($("todoBasis"),d.todo&&d.todo.state==="ready"?"依据 operation_todos；零条显示未接入，不反推假数字":((d.todo&&d.todo.reason)||"未接入"));
  var rows=d.todo&&Array.isArray(d.todo.rows)?d.todo.rows:[];
  box.appendChild(table(["时间","事项","来源","状态","级别","目标"],rows,function(tr,r){
    var title=td(tr,r.created_at,"mono");title.title=r.id||"";
    td(tr,r.title,"rowtitle");td(tr,r.target_table||"未设置","mono");td(tr,r.status||"未设置");td(tr,r.severity||"未设置");td(tr,r.target_id||"未设置","mono");
    tr.style.cursor="pointer";tr.onclick=function(){openTab(r.title||d.label,"/ops-todos?view=pending_review")};
  }));
}
async function load(){
  renderTabs();
  try{
    var payload=await getJson(apiUrl()),d=payload.data||{};
    state.modules=payload.modules||state.modules;renderTabs();renderMetrics(d);renderSources(d);renderRows(d);
    if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:d.label||"审核管理专项",url:location.pathname+location.search},location.origin);
  }catch(e){
    text($("stamp"),VERSION+" · 读取失败");["sources","rows"].forEach(function(id){var b=$(id);b.textContent="";b.appendChild(el("div","err",e.message))});
  }
}
load();
})();
