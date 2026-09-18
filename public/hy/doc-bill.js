(function(){
"use strict";

function clean(v){return String(v==null?"":v).trim()}
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function num(v){var n=Number(v);return Number.isFinite(n)?n:null}
function money(v){var n=num(v);return n==null?"":(Math.round(n*100)/100).toFixed(2)}
function qs(){try{return new URLSearchParams(location.search)}catch(e){return new URLSearchParams("")}}
var bootToken=clean(qs().get("token"));
function token(){
  var t=clean(qs().get("token"))||bootToken;
  if(t)return t;
  try{return clean(localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token"))}catch(e){return ""}
}
function roleFromToken(t){
  try{
    var part=(t.split(".")[1]||"").replace(/-/g,"+").replace(/_/g,"/");
    var json=JSON.parse(decodeURIComponent(Array.prototype.map.call(atob(part),function(c){return "%"+("00"+c.charCodeAt(0).toString(16)).slice(-2)}).join("")));
    return clean(json.role||json.user_role||json.claims&&json.claims.role).toLowerCase();
  }catch(e){return ""}
}
function activeType(){
  var p=qs(),t=clean(p.get("type"));
  if(t)return t;
  var btn=document.querySelector("[data-type].active,[data-type][aria-pressed='true'],[data-type][aria-selected='true']");
  return clean(btn&&btn.getAttribute("data-type"))||"fob_invoice";
}
function blNo(){
  var p=qs();
  return clean(p.get("bl")||p.get("bl_no")||p.get("mbl_no")||document.querySelector("#blText")&&document.querySelector("#blText").textContent);
}
function api(path){return "/api/db/customer-bill"+(path||"")}
function headers(){
  var h={"Content-Type":"application/json"},t=token();
  if(t)h.Authorization="Bearer "+t;
  return h;
}
function post(path,body){
  return fetch(api(path),{method:"POST",credentials:"same-origin",headers:headers(),body:JSON.stringify(body||{})})
    .then(function(r){return r.json().catch(function(){return {ok:false,error:"bad_response"}}).then(function(j){j._status=r.status;return j})});
}
function statusText(s){
  return {draft:"草稿",sent:"已发客户 等待确认",confirmed:"客户已确认 已锁定",void:"已作废"}[clean(s)]||clean(s)||"草稿";
}
function eventText(e){
  var name={sent:"发出",viewed:"客户打开",commented:"客户留言原文",confirmed:"客户确认",price_changed:"改价",voided:"作废",legacy_registered:"补录"}[e.event]||e.event;
  var who=clean(e.actor||e.by),note=clean(e.note);
  return name+(who?" · "+who:"")+(note?" · "+note:"");
}
function errorText(j){
  var e=clean(j&&j.error);
  if(e==="missing_floor")return "没有底价（货代账单未录），不能发"+listIds(j);
  if(e==="below_floor")return "低于底价"+(j&&j.floor!=null?" "+money(j.floor):"")+"，不能保存"+belowList(j);
  if(e==="missing_fx_rate")return "出单日没有汇率，不能发";
  if(e==="no_lines")return "没有可发的费用";
  if(e==="locked")return "已锁定，不能改";
  if(e==="paid_or_invoiced")return "已收款或已开票，不能作废";
  if(e==="forbidden")return "没有权限";
  return e||"操作失败";
}
function listIds(j){
  var ids=j&&j.line_ids;
  return Array.isArray(ids)&&ids.length?"："+ids.join(", "):"";
}
function belowList(j){
  var rows=Array.isArray(j&&j.lines)?j.lines:[];
  return rows.length?"："+rows.map(function(x){return clean(x.line_id)+" 底价 "+money(x.floor)}).join("；"):"";
}
function installStyle(){
  if(document.querySelector("#docBillStyle"))return;
  var s=document.createElement("style");
  s.id="docBillStyle";
  s.textContent=[
    "#customerBillPanel{border-bottom:1px solid var(--hgj-line);background:var(--hgj-card);padding:10px 12px;color:var(--hgj-text);font-size:12px}",
    "#customerBillPanel:empty{display:none}.bill-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}.bill-head strong{font-size:13px;color:var(--hgj-title)}",
    ".bill-btn{height:28px;border:1px solid var(--hgj-line);border-radius:4px;background:var(--hgj-card);color:var(--hgj-text);padding:0 8px;cursor:pointer}.bill-btn.primary{border-color:var(--hgj-primary,#006AFF);color:var(--hgj-primary,#006AFF)}.bill-btn:disabled{opacity:.55;cursor:default}",
    ".bill-select,.bill-input{height:28px;border:1px solid var(--hgj-line);border-radius:4px;background:var(--hgj-card);color:var(--hgj-text);padding:0 6px;max-width:160px}.bill-input{width:92px;text-align:right}",
    ".bill-msg{color:#b42318;font-weight:600}.bill-msg.ok{color:#027a48}.bill-table-wrap{overflow:auto}.bill-table{width:100%;border-collapse:collapse;min-width:760px}.bill-table th,.bill-table td{border-top:1px solid var(--hgj-line);padding:6px;text-align:left;vertical-align:top}.bill-table th{color:var(--hgj-muted);font-weight:600}",
    ".bill-block{border-top:1px solid var(--hgj-line);padding-top:8px;margin-top:8px}.bill-meta{display:flex;gap:10px;flex-wrap:wrap;color:var(--hgj-muted)}.bill-note{color:#b45309;font-weight:600}.bill-history,.bill-events{margin:6px 0 0 0;padding-left:18px;color:var(--hgj-muted)}.bill-lock{color:#667085}.bill-row-error{color:#b42318;font-weight:600}",
    "@media print{#customerBillPanel{display:none!important}}"
  ].join("");
  document.head.appendChild(s);
}

var state={bl:"",type:"",data:null,payer:"",msg:"",ok:false,loading:false,req:0,admin:false,lastLink:""};

function root(){
  var el=document.querySelector("#customerBillPanel");
  if(el)return el;
  el=document.createElement("section");
  el.id="customerBillPanel";
  el.setAttribute("aria-label","内部客户账单改价面板");
  var bar=document.querySelector("header.bar"), page=document.querySelector("main.page")||document.body;
  if(bar&&bar.parentNode)bar.parentNode.insertBefore(el,bar.nextSibling);
  else page.insertBefore(el,page.firstChild);
  return el;
}
function lineBill(line){
  var id=clean(line.customer_bill_id);
  return (state.data.bills||[]).filter(function(b){return clean(b.id)===id})[0]||null;
}
function isLocked(line){
  var b=lineBill(line);
  return b&&clean(b.status)==="confirmed";
}
function lineStatus(line){
  var b=lineBill(line);
  if(!b)return line.customer_bill_id?"已入单":"未入单";
  return statusText(b.status);
}
function payerCodes(){
  var set={};
  (state.data.lines||[]).forEach(function(x){var p=clean(x.payer_company_code);if(p)set[p]=1});
  (state.data.bills||[]).forEach(function(x){var p=clean(x.payer_company_code);if(p)set[p]=1});
  return Object.keys(set);
}
function visibleLines(){
  return (state.data.lines||[]).filter(function(x){return !state.payer||clean(x.payer_company_code)===state.payer});
}
function hasConfirmed(){
  return (state.data.bills||[]).some(function(b){return clean(b.payer_company_code)===state.payer&&clean(b.status)==="confirmed"});
}
function hasFreeLines(){
  return visibleLines().some(function(x){return !x.customer_bill_id});
}
function render(){
  var el=root();
  if(!state.bl){el.innerHTML="";return}
  if(state.loading){el.innerHTML='<div class="bill-head"><strong>客户账单</strong><span>加载中...</span></div>';return}
  if(!state.data){el.innerHTML='<div class="bill-head"><strong>客户账单</strong><span class="bill-msg">'+esc(state.msg||"未加载")+'</span></div>';return}
  var payers=payerCodes();
  if(!state.payer&&payers.length)state.payer=payers[0];
  var sendText=hasConfirmed()&&hasFreeLines()?"发追加费用单":"发客户确认";
  el.innerHTML=[
    '<div class="bill-head"><strong>客户账单</strong><span>BL '+esc(state.bl)+'</span>',
    payers.length>1?'<select id="billPayer" class="bill-select">'+payers.map(function(p){return '<option value="'+esc(p)+'"'+(p===state.payer?' selected':'')+'>'+esc(p)+'</option>'}).join("")+'</select>':'<span>付款方 '+esc(state.payer||payers[0]||"")+'</span>',
    '<button id="billSend" class="bill-btn primary" type="button">'+sendText+'</button>',
    '<span id="billMsg" class="bill-msg '+(state.ok?"ok":"")+'">'+msgHtml()+'</span></div>',
    rowsHtml(), billsHtml(), historyHtml()
  ].join("");
  bindPanel();
}
function msgHtml(){
  if(state.lastLink)return '已生成客户链接：'+esc(state.lastLink)+' <button id="billCopyLink" class="bill-btn" type="button">复制链接</button>';
  return esc(state.msg);
}
function rowsHtml(){
  var rows=visibleLines();
  if(!rows.length)return '<div class="bill-msg">没有可发的费用</div>';
  return '<div class="bill-table-wrap"><table class="bill-table"><thead><tr><th>费用</th><th>数量</th><th>币种</th><th>底价</th><th>加价</th><th>卖价</th><th>状态</th></tr></thead><tbody>'+
    rows.map(function(x){
      var floor=num(x.floor),sale=num(x.sale),markup=floor==null||sale==null?null:sale-floor, locked=isLocked(x);
      var markupCell=locked?'<span class="bill-lock">🔒 '+esc(money(markup))+'</span>':'<input class="bill-input" data-line="'+esc(x.id)+'" data-floor="'+esc(floor==null?"":floor)+'" data-markup="'+esc(markup==null?"":money(markup))+'" value="'+esc(markup==null?"":money(markup))+'">';
      return '<tr data-row="'+esc(x.id)+'"><td>'+esc(x.cost_category)+'</td><td>'+esc(x.qty||1)+'</td><td>'+esc((x.currency||"").toUpperCase())+'</td><td>'+esc(money(floor))+'</td><td>'+markupCell+'<div class="bill-row-error"></div></td><td>'+esc(money(sale))+'</td><td>'+esc(lineStatus(x))+'</td></tr>';
    }).join("")+'</tbody></table></div>';
}
function billsHtml(){
  var bills=(state.data.bills||[]).filter(function(b){return !state.payer||clean(b.payer_company_code)===state.payer});
  if(!bills.length)return "";
  return bills.map(function(b){
    var locked=clean(b.status)==="confirmed";
    return '<div class="bill-block"><div class="bill-meta"><strong>'+esc(b.doc_no||("账单 #"+b.id))+'</strong><span>'+esc(statusText(b.status))+'</span><span>出单日 '+esc(b.issue_date||"")+'</span><span>汇率 '+esc(b.fx_rate||"")+'</span><span>合计 USD '+esc(money(b.total_usd))+'</span><span>CNY '+esc(money(b.total_cny))+'</span></div>'+
      (locked?'<div class="bill-note">已锁定。要改只能开追加费用单；作废仅限未收款未开票</div>':"")+
      eventsHtml(b)+(state.admin&&locked?'<button class="bill-btn" data-void="'+esc(b.id)+'" type="button">作废</button>':"")+'</div>';
  }).join("");
}
function eventsHtml(b){
  var events=Array.isArray(b.events)?b.events:[];
  if(!events.length)return "";
  return '<ol class="bill-events">'+events.map(function(e){return '<li>'+esc(clean(e.created_at).replace("T"," ").slice(0,19))+' · '+esc(eventText(e))+'</li>'}).join("")+'</ol>';
}
function historyHtml(){
  var rows=(state.data.price_history||[]).filter(function(h){return visibleLines().some(function(x){return clean(x.id)===clean(h.row_id)})});
  if(!rows.length)return "";
  return '<div class="bill-block"><strong>改价记录</strong><ol class="bill-history">'+rows.map(function(h){
    return '<li>'+esc(money(h.old_value))+' → '+esc(money(h.new_value))+' · '+esc(h.actor||"")+' · '+esc(clean(h.created_at).replace("T"," ").slice(0,19))+' · '+esc(h.reason||"")+'</li>';
  }).join("")+'</ol></div>';
}
function bindPanel(){
  var sel=document.querySelector("#billPayer");
  if(sel)sel.addEventListener("change",function(){state.payer=sel.value;state.msg="";state.lastLink="";render()});
  var send=document.querySelector("#billSend");
  if(send)send.addEventListener("click",sendBill);
  var copy=document.querySelector("#billCopyLink");
  if(copy)copy.addEventListener("click",function(){navigator.clipboard&&navigator.clipboard.writeText(state.lastLink)});
  Array.prototype.forEach.call(document.querySelectorAll(".bill-input"),function(inp){
    inp.addEventListener("blur",function(){saveLine(inp)});
  });
  Array.prototype.forEach.call(document.querySelectorAll("[data-void]"),function(btn){
    btn.addEventListener("click",function(){voidBill(btn.getAttribute("data-void"))});
  });
}
function load(){
  var req=++state.req,t=token();
  var nextType=activeType();
  if(state.type&&state.type!==nextType)state.lastLink="";
  state.bl=blNo(); state.type=nextType; state.admin=roleFromToken(t)==="admin"; state.loading=!!state.bl; state.msg=""; render();
  if(!state.bl)return;
  fetch(api("?bl="+encodeURIComponent(state.bl)+"&type="+encodeURIComponent(state.type)),{credentials:"same-origin",headers:t?{Authorization:"Bearer "+t}:{}})
    .then(function(r){return r.json().catch(function(){return {ok:false,error:"bad_response"}})})
    .then(function(j){
      if(req!==state.req)return;
      state.loading=false; state.ok=false;
      if(!j.ok){state.data=null; state.msg=errorText(j); render(); return}
      state.data=j; state.payer=state.payer&&payerCodes().indexOf(state.payer)>=0?state.payer:(payerCodes()[0]||""); render();
    })
    .catch(function(){if(req===state.req){state.loading=false;state.data=null;state.msg="客户账单加载失败";render()}});
}
function saveLine(inp){
  var floor=num(inp.getAttribute("data-floor")),old=clean(inp.getAttribute("data-markup")),markup=num(inp.value),box=inp.parentNode.querySelector(".bill-row-error");
  box.textContent="";
  if(clean(inp.value)===old)return;
  if(floor==null){box.textContent="没有底价（货代账单未录），不能发";inp.value=old;return}
  if(markup==null){box.textContent="请输入数字";inp.value=old;return}
  post("/line-price",{line_id:inp.getAttribute("data-line"),sale_amount:Math.round((floor+markup)*100)/100}).then(function(j){
    if(!j.ok){box.textContent=errorText(j);inp.value=old;return}
    state.msg="已保存";state.ok=true;load();
  }).catch(function(){box.textContent="保存失败";inp.value=old});
}
function sendBill(){
  state.msg="发送中...";state.ok=false;state.lastLink="";render();
  post("/send",{bl:state.bl,type:state.type,payer_company_code:state.payer}).then(function(j){
    if(!j.ok){state.msg=errorText(j);state.ok=false;render();return}
    state.msg="已生成客户链接："+clean(j.url);state.ok=true;state.lastLink=clean(j.url);render();load();
  }).catch(function(){state.msg="发送失败";state.ok=false;render()});
}
function voidBill(id){
  var reason=prompt("请输入作废原因");
  if(!clean(reason))return;
  if(!confirm("确认作废这张客户账单？"))return;
  post("/void",{bill_id:id,reason:reason}).then(function(j){
    state.msg=j.ok?"已作废":errorText(j);state.ok=!!j.ok;render();load();
  }).catch(function(){state.msg="作废失败";state.ok=false;render()});
}
function init(){
  installStyle();
  load();
  Array.prototype.forEach.call(document.querySelectorAll("[data-type]"),function(btn){btn.addEventListener("click",function(){state.lastLink="";setTimeout(load,0)})});
  window.addEventListener("popstate",load);
  window.HyDocBill={reload:load};
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",init);else init();
})();
