(function(){
  "use strict";
  var API="/api/db/receipt-payment-management",VERSION="v2026.08.26-1";
  var state={rows:[],selected:null,coverage:[],metrics:{},generatedAt:null};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function has(v){return !(v===null||v===undefined||v===""||(Array.isArray(v)&&!v.length))}
  function text(x,v,fallback){x.textContent=has(v)?String(v):(fallback||"未接入")}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function fmt(v,fallback){if(!has(v))return fallback||"未设置";if(Array.isArray(v))return v.join("、")||fallback||"未设置";return String(v).slice(0,120).replace("T"," ")}
  function money(v){if(!has(v))return "未设置";var n=Number(v);return Number.isFinite(n)?n.toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}):String(v)}
  function pctField(f){return !f||f.fill_rate===null||f.fill_rate===undefined?"未接入":Number(f.fill_rate).toFixed(1).replace(/\.0$/,"")+"%"}
  function dirLabel(v){return v==="AR"?"收款":v==="AP"?"付款":(has(v)?v:"未分类")}
  function rowTitle(r){return r.payment_no||r.bank_ref||r.contract_no||("ID "+(r.id||"未接入"))}
  async function api(){
    var p=new URLSearchParams(),q=$("q").value.trim(),direction=$("direction").value,status=$("status").value;
    if(q)p.set("q",q);if(direction)p.set("direction",direction);if(status)p.set("status",status);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function metric(id,v){text($(id),has(v)?v:"未接入")}
  function renderMetrics(){
    var m=state.metrics||{};
    metric("mTotal",m.total_records);metric("mAr",m.ar_records);metric("mAp",m.ap_records);metric("mAlerts",m.alert_count);
    $("summary").textContent=VERSION+" · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function renderAmounts(){
    var box=$("amounts");clear(box);var rows=(state.metrics&&state.metrics.by_currency)||[];
    if(!rows.length){box.appendChild(el("div","empty","未接入 · 缺 finance_payments 金额/币种可汇总记录；当前填充率 未接入。"));return}
    rows.forEach(function(r){
      var d=el("div","amount");
      d.appendChild(el("span","muted",fmt(r.currency)));
      d.appendChild(el("b","", "收款 "+money(r.ar)));
      d.appendChild(el("span","muted","付款 "+money(r.ap)));
      box.appendChild(d);
    });
  }
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length||"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 finance_payments 可读取记录；当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.id===state.selected.id?" active":""));b.type="button";b.dataset.id=r.id||"";
      b.appendChild(el("strong","",dirLabel(r.direction_canonical)+" · "+rowTitle(r)));
      b.appendChild(el("span","",fmt(r.payment_date||r.paid_date)+" · "+fmt(r.customer||r.customer_en)+" · "+fmt(r.status)));
      b.appendChild(el("span","","金额 "+money(r.effective_amount)+" "+fmt(r.currency,"")+" · 来源 "+fmt(r.amount_source)+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function allAlerts(){
    var out=[];state.rows.forEach(function(r){(r.alerts||[]).forEach(function(a){out.push({row:r,alert:a})})});return out;
  }
  function renderAlerts(){
    var box=$("alerts");clear(box);var rows=allAlerts();
    if(!rows.length){box.appendChild(el("div","empty","没有真实业务预警；未接入条目只在字段填充率中显示，不进入忽略/处理。"));return}
    rows.forEach(function(x){var d=el("div","alert");d.appendChild(el("b","",x.alert.label));d.appendChild(el("div","muted",dirLabel(x.row.direction_canonical)+" · "+rowTitle(x.row)+" · 依据 "+x.alert.basis));box.appendChild(d)});
  }
  function td(tr,v,fb){var c=document.createElement("td");text(c,v,fb);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺收付记录；当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["方向",dirLabel(r.direction_canonical)],["收付编号",r.payment_no],["状态",r.status],["收付日期",r.payment_date],
      ["入账日期",r.paid_date],["币种",r.currency],["本次金额",money(r.effective_amount)],["金额来源",r.amount_source],
      ["客户",r.customer||r.customer_en],["合同号",r.contract_no],["订单号",r.order_no],["银行流水",r.bank_ref],
      ["收付类型",r.payment_type],["水单",r.tt_slip_url],["发票附件",r.invoice_url],["创建/更新",[r.created_at,r.updated_at].filter(has).map(fmt).join(" / ")]
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1],"未设置");body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length)box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"("+x.name+")";}).join("、")));
    $("statePill").className="pill "+(r.alerts&&r.alerts.length?"warn":"");
    text($("statePill"),r.status||"未接入状态");
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var groups=state.coverage||[];
    if(!groups.length){box.appendChild(el("div","empty","未接入 · 缺字段统计；当前填充率 未接入。"));return}
    groups.forEach(function(g){(g.fields||[]).forEach(function(f){
      var d=el("div","field"),b=el("b","",f.label),s=el("span","");
      if(f.state==="not_connected")text(s,"未接入 · 缺 "+g.table+"."+f.name+" 或字段为空；当前填充率 "+pctField(f));
      else text(s,g.table+"."+f.name+" · "+f.filled+"/"+f.total+" · 当前填充率 "+pctField(f));
      d.appendChild(b);d.appendChild(s);box.appendChild(d);
    })});
  }
  function render(){renderMetrics();renderAmounts();renderList();renderAlerts();renderDetail();renderCoverage()}
  async function load(){
    try{var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage||[];state.metrics=d.metrics||{};state.generatedAt=d.generated_at;render()}
    catch(e){$("summary").textContent="读取失败";["amounts","list","alerts","detail","coverage"].forEach(function(id){clear($(id));$(id).appendChild(el("div","error",e.message))})}
  }
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;var id=b.dataset.id;state.selected=state.rows.find(function(r){return String(r.id||"")===id})||state.selected;render()});
  $("reload").addEventListener("click",load);
  $("q").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  $("direction").addEventListener("change",load);$("status").addEventListener("change",load);
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"收付管理",url:location.pathname+location.search},location.origin);
  load();
})();
