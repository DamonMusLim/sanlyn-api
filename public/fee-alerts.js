(function(){
"use strict";
var API="/api/db/fee-alerts";
var state={tab:"entered",data:null,open:new Set(),ignored:new Set(JSON.parse(localStorage.getItem("fee_alert_ignored")||"[]"))};
function $(id){return document.getElementById(id)}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(body){var h={},t=token();if(t)h.Authorization="Bearer "+t;if(body)h["Content-Type"]="application/json";return h}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(m){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m]})}
function setText(id,text){$(id).textContent=text==null||text===""?"未接入":String(text)}
function showToast(text){$("toast").textContent=text;$("toast").classList.remove("hidden");setTimeout(function(){$("toast").classList.add("hidden")},1800)}
function openWorkbenchTab(title,url){if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",title:title,url:url},location.origin);else window.open(url,"_blank","noopener")}
function saveIgnored(){localStorage.setItem("fee_alert_ignored",JSON.stringify(Array.from(state.ignored)))}
function displayCount(stage,fallback){return stage&&stage.state==="ready"&&stage.count!=null?String(stage.count):(fallback||"未接入")}
function basisNote(stage){return stage&&stage.basis&&stage.basis.note?stage.basis.note:"未接入"}
async function api(method,body){
  var r=await fetch(API,{method:method||"GET",headers:headers(body),body:body?JSON.stringify(body):undefined});
  var d=await r.json().catch(function(){return{error:"接口返回异常"}});
  if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
  return d;
}
async function load(){
  try{state.data=await api();render();}
  catch(e){setText("summary","v2026.08.26-2 · 读取失败");$("list").innerHTML='<div class="err">'+esc(e.message)+'</div>'}
}
function renderMetrics(){
  var d=state.data||{}, stages=d.fee_stages||{}, inv=d.invoiced||{}, unk=d.unknown||{}, set=d.settled||{};
  $("summary").textContent=d.generated_at?"v2026.08.26-2 · 生成时间 "+new Date(d.generated_at).toLocaleString():"v2026.08.26-2 · 已加载";
  setText("mEntered",displayCount(stages.entered));setText("mEnteredNote",basisNote(stages.entered));
  setText("mCompleted",displayCount(stages.completed));setText("mCompletedNote",basisNote(stages.completed));
  setText("mInvoice",displayCount(inv));
  setText("mInvoiceNote","依据 "+(inv.basis&&inv.basis.table||"未设置")+"；可判断 "+(inv.basis&&inv.basis.eligible!=null?inv.basis.eligible:"未设置")+" 行");
  setText("mUnknown",unk.count==null?"未设置":unk.count);
  var r=unk.reasons||{};
  setText("mUnknownNote","挂不到票 "+(r.no_shipping_plan_link==null?"未设置":r.no_shipping_plan_link)+"，无账期 "+(r.no_bill_month==null?"未设置":r.no_bill_month)+"，挂靠异常 "+(r.shipping_plan_unresolved==null?"未设置":r.shipping_plan_unresolved));
  setText("mSettled",set.state==="not_connected"?"未接入":displayCount(set,"未设置"));
  setText("mSettledNote",basisNote(set));
}
function filteredRows(){
  var rows=(state.data&&state.data.invoiced&&state.data.invoiced.rows)||[];
  return rows.filter(function(r){return !state.ignored.has(String(r.id))});
}
function rowHtml(r){
  var id=String(r.id),detail=state.open.has(id);
  var title="账单编号 "+(r.bill_no||r.id)+" 到账期了，还没有开票，快去看看吧。";
  return '<article class="row" data-title="'+esc(r.bill_no||r.bl_no||id)+'" data-url="/rates?bill_id='+encodeURIComponent(id)+'"><div class="main"><div class="title">'+esc(title)+'</div><div class="meta"><span class="pill">BL '+esc(r.bl_no||"未设置")+'</span><span class="pill">账期 '+esc(r.bill_month||"未设置")+'</span><span class="pill">依据 '+esc(r.basis||"未设置")+'</span></div>'+(detail?'<div class="detail">供应商 '+esc(r.supplier||"未设置")+' · 费用 '+esc(r.cost_category||"未设置")+' · 金额 '+esc(r.currency||"")+" "+esc(r.amount==null?"未设置":r.amount)+' · shipping_plan '+esc(r.shipping_plan_id||"未设置")+'</div>':"")+'</div><div><button class="btn detailBtn" data-id="'+esc(id)+'">查看详情</button> <button class="btn ignoreBtn" data-id="'+esc(id)+'">忽略</button></div></article>';
}
function stagePanel(key,label){
  var stage=state.data&&state.data.fee_stages&&state.data.fee_stages[key];
  $("tabNote").textContent=basisNote(stage);
  $("ignoreAll").disabled=true;
  $("ignoreAll").hidden=true;
  var count=displayCount(stage);
  $("list").innerHTML='<div class="empty">'+esc(label)+' · '+esc(count)+'<div class="detail">'+esc(basisNote(stage))+'</div></div>';
}
function renderList(){
  var d=state.data||{}, box=$("list");
  $("ignoreAll").hidden=state.tab!=="invoiced";
  $("ignoreAll").disabled=state.tab!=="invoiced"||d.invoiced&&d.invoiced.state!=="ready"||!filteredRows().length;
  if(state.tab==="entered")return stagePanel("entered","已录入");
  if(state.tab==="completed")return stagePanel("completed","已完成");
  if(state.tab==="settled"){
    $("tabNote").textContent=basisNote(d.settled);
    box.innerHTML='<div class="empty">未接入 · '+esc(basisNote(d.settled))+'</div>';return;
  }
  $("tabNote").textContent=basisNote(d.invoiced);
  if(d.invoiced&&d.invoiced.state!=="ready"){box.innerHTML='<div class="empty">未接入 · '+esc(basisNote(d.invoiced))+'</div>';return}
  var rows=filteredRows();
  if(!rows.length){box.innerHTML='<div class="empty">没有未忽略的业务预警</div>';return}
  box.innerHTML=rows.map(rowHtml).join("");
}
function render(){
  renderMetrics();
  document.querySelectorAll(".tab").forEach(function(b){b.classList.toggle("active",b.dataset.tab===state.tab)});
  renderList();
}
document.querySelector(".tabs").onclick=function(e){var b=e.target.closest(".tab");if(!b)return;state.tab=b.dataset.tab;render()};
$("reload").onclick=load;
$("ignoreAll").onclick=async function(){
  if(state.tab!=="invoiced")return;
  var rows=filteredRows();rows.forEach(function(r){state.ignored.add(String(r.id))});saveIgnored();render();
  try{for(var i=0;i<rows.length;i++)await api("POST",{kind:"invoiced",id:String(rows[i].id)});showToast("已忽略当前业务预警")}
  catch(e){showToast(e.message);load()}
};
$("list").onclick=async function(e){
  var detail=e.target.closest(".detailBtn"),ignore=e.target.closest(".ignoreBtn");
  if(detail){var did=detail.dataset.id;state.open.has(did)?state.open.delete(did):state.open.add(did);render();return}
  if(ignore){var id=ignore.dataset.id;state.ignored.add(id);saveIgnored();render();try{await api("POST",{kind:"invoiced",id:id});showToast("已忽略")}catch(err){state.ignored.delete(id);saveIgnored();render();showToast(err.message)}return}
  var row=e.target.closest(".row[data-url]");if(row)openWorkbenchTab(row.dataset.title,row.dataset.url);
};
if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"费用预警",url:location.pathname+location.search},location.origin);
load();
})();
