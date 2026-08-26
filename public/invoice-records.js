(function(){
  "use strict";
  var API="/api/db/invoice-records",VERSION="v2026.08.26-1";
  var state={rows:[],selected:null,coverage:[],metrics:{},generatedAt:null};
  var moneyFields={amount_ex_tax:1,total_tax:1,amount_incl_tax:1,tax_rate:1};
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
  function sideLabel(side){return side==="out"?"销项":side==="in"?"进项":"发票"}
  function title(r){return r.invoice_no||r.contract_nos&&r.contract_nos[0]||r.customs_nos&&r.customs_nos[0]||("ID "+(r.id||"未接入"))}
  function fieldValue(r,k){return moneyFields[k]?money(r[k]):fmt(r[k])}
  async function api(){
    var p=new URLSearchParams(),q=$("q").value.trim(),side=$("side").value,status=$("status").value;
    if(q)p.set("q",q);if(side)p.set("side",side);if(status)p.set("status",status);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function renderMetrics(){
    var m=state.metrics||{};
    text($("mTotal"),m.total_records||"未接入");
    text($("mOut"),m.out_records||"未接入");
    text($("mIn"),m.in_records||"未接入");
    text($("mAlerts"),m.alert_count||"未接入");
    $("summary").textContent=VERSION+" · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length||"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 finance_invoices_out / finance_invoices_in 可读取记录；当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.side===state.selected.side&&r.id===state.selected.id?" active":""));
      b.type="button";b.dataset.side=r.side||"";b.dataset.id=r.id||"";
      b.appendChild(el("strong","",sideLabel(r.side)+" · "+title(r)));
      b.appendChild(el("span","",fmt(r.issue_date)+" · "+fmt(r.seller_name)+" -> "+fmt(r.buyer_name)));
      b.appendChild(el("span","","价税合计 "+money(r.amount_incl_tax)+" "+fmt(r.currency,"")+" · 状态 "+fmt(r.review_status)+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function allAlerts(){
    var out=[];
    state.rows.forEach(function(r){(r.alerts||[]).forEach(function(a){out.push({row:r,alert:a})})});
    return out;
  }
  function renderAlerts(){
    var box=$("alerts");clear(box);var rows=allAlerts();
    if(!rows.length){box.appendChild(el("div","empty","没有真实业务预警；未接入条目只在字段填充率中显示，不进入忽略/处理。"));return}
    rows.forEach(function(x){
      var d=el("div","alert");
      d.appendChild(el("b","",x.alert.label));
      d.appendChild(el("div","muted",sideLabel(x.row.side)+" · "+title(x.row)+" · 依据 "+x.alert.basis));
      box.appendChild(d);
    });
  }
  function td(tr,v,fb){var c=document.createElement("td");text(c,v,fb);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺发票记录；当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["方向",sideLabel(r.side)],["发票号码",r.invoice_no],["发票类型",r.invoice_type],["开票日期",r.issue_date],
      ["销售方",r.seller_name],["销售方税号",r.seller_tax_id],["购买方",r.buyer_name],["购买方税号",r.buyer_tax_id],
      ["不含税金额",fieldValue(r,"amount_ex_tax")],["税额",fieldValue(r,"total_tax")],["价税合计",fieldValue(r,"amount_incl_tax")],
      ["税率",fieldValue(r,"tax_rate")],["币种",r.currency],["审核状态",r.review_status],["作废状态",r.void_status],
      ["合同号",fmt(r.contract_nos)],["报关单号",fmt(r.customs_nos)],["来源",r.source],["创建/更新",[r.created_at,r.updated_at].filter(has).map(fmt).join(" / ")]
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1],moneyFields[pair[0]]?"未设置":"未接入");body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length)box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"("+x.name+")";}).join("、")));
    $("statePill").className="pill "+(r.alerts&&r.alerts.length?"warn":"");
    text($("statePill"),r.review_status||"未接入状态");
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var groups=state.coverage||[];
    if(!groups.length){box.appendChild(el("div","empty","未接入 · 缺字段统计；当前填充率 未接入。"));return}
    groups.forEach(function(g){
      (g.fields||[]).forEach(function(f){
        var d=el("div","field"),b=el("b","",g.label+" · "+f.label),s=el("span","");
        if(f.state==="not_connected")text(s,"未接入 · 缺 "+g.table+"."+f.name+" 或字段为空；当前填充率 "+pctField(f));
        else text(s,g.table+"."+f.name+" · "+f.filled+"/"+f.total+" · 当前填充率 "+pctField(f));
        d.appendChild(b);d.appendChild(s);box.appendChild(d);
      });
    });
  }
  function render(){renderMetrics();renderList();renderAlerts();renderDetail();renderCoverage()}
  async function load(){
    try{
      var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage||[];state.metrics=d.metrics||{};state.generatedAt=d.generated_at;render();
    }catch(e){$("summary").textContent="读取失败";["list","alerts","detail","coverage"].forEach(function(id){clear($(id));$(id).appendChild(el("div","error",e.message))})}
  }
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;var id=b.dataset.id,side=b.dataset.side;state.selected=state.rows.find(function(r){return String(r.id||"")===id&&String(r.side||"")===side})||state.selected;render()});
  $("reload").addEventListener("click",load);
  $("q").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  $("side").addEventListener("change",load);
  $("status").addEventListener("change",load);
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"开票记录",url:location.pathname+location.search},location.origin);
  load();
})();
