(function(){
  "use strict";
  var API="/api/db/commission-report",VERSION="v2026.08.26-1";
  var state={rows:[],selected:null,coverage:null,metrics:{},generatedAt:null,reason:""};
  var $=function(id){return document.getElementById(id);};
  var NF=new Intl.NumberFormat("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2});
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||"";}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h;}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild);}
  function has(v){return !(v===null||v===undefined||v==="");}
  function text(x,v,fallback){x.textContent=has(v)?String(v):(fallback||"未接入");}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x;}
  function fmt(v,fallback){if(!has(v))return fallback||"未设置";return String(v).slice(0,140).replace("T"," ");}
  function money(v,c){if(!has(v))return"未设置";var n=Number(v);return Number.isFinite(n)?((c?c+" ":"")+NF.format(n)):"未设置";}
  function rate(v){if(!has(v))return"未设置";var n=Number(v);return Number.isFinite(n)?(n*100).toFixed(2).replace(/\\.00$/,"")+"%":"未设置";}
  function pct(f){return !f||f.fill_rate===null||f.fill_rate===undefined?"未接入":Number(f.fill_rate).toFixed(1).replace(/\\.0$/,"")+"%";}
  function title(r){return [r.username,r.company,r.company_code].filter(has).join(" · ")||"未接入对象";}
  function missingText(){return state.reason||"未接入 · 缺 accounts/orders 提成字段；当前填充率 未接入。";}
  function defaultMonth(){var d=new Date();d.setMonth(d.getMonth()-1,1);return d.toISOString().slice(0,7);}
  async function api(){
    var p=new URLSearchParams(),q=$("q").value.trim(),m=$("month").value||defaultMonth();
    p.set("month",m);if(q)p.set("q",q);
    var r=await fetch(API+"?"+p.toString(),{headers:headers()});
    var d=await r.json().catch(function(){return{success:false,error:"接口返回异常"};});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function setMetric(id,v){text($(id),has(v)?v:"未接入");}
  function renderMetrics(){
    var m=state.metrics||{};
    setMetric("mPeople",m.reseller_count);setMetric("mOrders",m.paid_order_count);setMetric("mAlerts",m.alert_count);
    text($("mState"),state.rows.length?"已接入":"未接入");$("mState").className=state.rows.length?"num":"num warn";
    $("summary").textContent=VERSION+" · 期间 "+($("month").value||defaultMonth())+" · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function renderAmounts(){
    var box=$("amounts");clear(box);var rows=(state.metrics&&state.metrics.by_currency)||[];
    if(!rows.length){box.appendChild(el("div","empty",missingText()));return;}
    rows.forEach(function(r){var d=el("div","amount");d.appendChild(el("span","muted",fmt(r.currency)));d.appendChild(el("b","",money(r.commission_due,r.currency)));d.appendChild(el("span","muted","回款销售额 "+money(r.paid_sales,r.currency)));box.appendChild(d);});
  }
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length||"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty",missingText()));return;}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&title(r)===title(state.selected)?" active":""));b.type="button";b.dataset.key=title(r);
      b.appendChild(el("strong","",title(r)));
      b.appendChild(el("span","",fmt(r.currency)+" · 费率 "+rate(r.commission_rate)+" · 已回款订单 "+fmt(r.paid_order_count)));
      b.appendChild(el("span","",money(r.commission_due,r.currency)+" · 回款期间 "+fmt(r.first_settled_at)+" 至 "+fmt(r.last_settled_at)));
      box.appendChild(b);
    });
  }
  function allAlerts(){var out=[];state.rows.forEach(function(r){(r.alerts||[]).forEach(function(a){out.push({row:r,alert:a});});});return out;}
  function renderAlerts(){
    var box=$("alerts");clear(box);var rows=allAlerts();
    if(!rows.length){box.appendChild(el("div","empty","没有真实业务预警；未接入字段只在字段填充率中显示，不进入忽略/处理。"));return;}
    rows.forEach(function(x){var d=el("div","alert");d.appendChild(el("b","",x.alert.label));d.appendChild(el("div","muted",title(x.row)+" · 依据 "+x.alert.basis));box.appendChild(d);});
  }
  function td(tr,v,fb){var c=document.createElement("td");text(c,v,fb);tr.appendChild(c);}
  function renderDetail(){
    var box=$("detail");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty",missingText()));return;}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [["账号",r.username],["公司",r.company],["客户编码",r.company_code],["费率",rate(r.commission_rate)],["币种",r.currency],["已回款订单",r.paid_order_count],["回款销售额",money(r.paid_sales,r.currency)],["应提金额",money(r.commission_due,r.currency)],["最早回款完成",r.first_settled_at],["最晚回款完成",r.last_settled_at]].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1],"未设置");body.appendChild(tr);});
    table.appendChild(body);box.appendChild(table);text($("statePill"),r.alerts&&r.alerts.length?"有预警":"已接入");
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var cov=state.coverage;
    if(!cov||!cov.fields||!cov.fields.length){box.appendChild(el("div","empty","未接入 · 缺 accounts/orders 字段；当前填充率 未接入。"));return;}
    cov.fields.forEach(function(f){var d=el("div","field");d.appendChild(el("b","",f.label));d.appendChild(el("span","",f.table+"."+f.name+" · "+f.filled+"/"+f.total+" · 当前填充率 "+pct(f)));box.appendChild(d);});
  }
  function render(){renderMetrics();renderAmounts();renderList();renderAlerts();renderDetail();renderCoverage();}
  async function load(){
    try{var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage;state.metrics=d.metrics||{};state.generatedAt=d.generated_at;state.reason=d.reason||"";render();}
    catch(e){$("summary").textContent=VERSION+" · 读取失败";["amounts","list","alerts","detail","coverage"].forEach(function(id){clear($(id));$(id).appendChild(el("div","error",e.message));});}
  }
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;var key=b.dataset.key;state.selected=state.rows.find(function(r){return title(r)===key;})||state.selected;render();});
  $("reload").addEventListener("click",load);$("q").addEventListener("keydown",function(e){if(e.key==="Enter")load();});
  $("month").value=defaultMonth();$("month").addEventListener("change",load);
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"提成管理",url:location.pathname+location.search},location.origin);
  load();
})();
