(function(){
  "use strict";
  var API="/api/db/settlement-management",VERSION="v2026.08.26-1";
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
  function pct(f){return !f||f.fill_rate===null||f.fill_rate===undefined?"未接入":Number(f.fill_rate).toFixed(1).replace(/\\.0$/,"")+"%";}
  function rowTitle(r){return [r.target_type,r.target_id].filter(has).join(" · ")||("ID "+(r.id||"未接入"));}
  function missingText(){return state.reason||"未接入 · 缺 finance_settlement_links 可核销真实链接；当前填充率 未接入。";}
  async function api(){
    var p=new URLSearchParams(),q=$("q").value.trim(),target=$("targetType").value,status=$("status").value;
    if(q)p.set("q",q);if(target)p.set("target_type",target);if(status)p.set("status",status);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
    var d=await r.json().catch(function(){return{success:false,error:"接口返回异常"};});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function setMetric(id,v){text($(id),has(v)?v:"未接入");}
  function renderMetrics(){
    var m=state.metrics||{};
    setMetric("mTotal",m.total_links);setMetric("mApplied",m.applied_links);setMetric("mAlerts",m.alert_count);
    text($("mState"),state.rows.length?"已接入":"未接入");$("mState").className=state.rows.length?"num":"num warn";
    $("summary").textContent=VERSION+" · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function renderAmounts(){
    var box=$("amounts");clear(box);var rows=(state.metrics&&state.metrics.by_currency)||[];
    if(!rows.length){box.appendChild(el("div","empty",missingText()));return;}
    rows.forEach(function(r){var d=el("div","amount");d.appendChild(el("span","muted",fmt(r.currency)));d.appendChild(el("b","",money(r.amount,r.currency)));box.appendChild(d);});
  }
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length||"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty",missingText()));return;}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&String(r.id)===String(state.selected.id)?" active":""));b.type="button";b.dataset.id=r.id||"";
      b.appendChild(el("strong","",rowTitle(r)));
      b.appendChild(el("span","",fmt(r.status)+" · 收付ID "+fmt(r.payment_id)+" · 来源 "+fmt(r.source)));
      b.appendChild(el("span","",money(r.amount_applied,r.currency)+" · 创建人 "+fmt(r.created_by)+" · "+fmt(r.created_at)));
      box.appendChild(b);
    });
  }
  function allAlerts(){var out=[];state.rows.forEach(function(r){(r.alerts||[]).forEach(function(a){out.push({row:r,alert:a});});});return out;}
  function renderAlerts(){
    var box=$("alerts");clear(box);var rows=allAlerts();
    if(!rows.length){box.appendChild(el("div","empty","没有真实业务预警；未接入字段只在字段填充率中显示，不进入忽略/处理。"));return;}
    rows.forEach(function(x){var d=el("div","alert");d.appendChild(el("b","",x.alert.label));d.appendChild(el("div","muted",rowTitle(x.row)+" · 依据 "+x.alert.basis));box.appendChild(d);});
  }
  function td(tr,v,fb){var c=document.createElement("td");text(c,v,fb);tr.appendChild(c);}
  function renderDetail(){
    var box=$("detail");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty",missingText()));return;}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [["核销ID",r.id],["收付ID",r.payment_id],["核销对象",r.target_type],["对象编号",r.target_id],["核销金额",money(r.amount_applied,r.currency)],["币种",r.currency],["状态",r.status],["来源",r.source],["创建人",r.created_by],["创建时间",r.created_at],["更新时间",r.updated_at]].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1],"未设置");body.appendChild(tr);});
    table.appendChild(body);box.appendChild(table);text($("statePill"),r.status||"未接入状态");
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var cov=state.coverage;
    if(!cov||!cov.fields||!cov.fields.length){box.appendChild(el("div","empty","未接入 · 缺 finance_settlement_links 字段；当前填充率 未接入。"));return;}
    cov.fields.forEach(function(f){var d=el("div","field");d.appendChild(el("b","",f.label));d.appendChild(el("span","",cov.table+"."+f.name+" · "+f.filled+"/"+f.total+" · 当前填充率 "+pct(f)));box.appendChild(d);});
  }
  function render(){renderMetrics();renderAmounts();renderList();renderAlerts();renderDetail();renderCoverage();}
  async function load(){
    try{var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage;state.metrics=d.metrics||{};state.generatedAt=d.generated_at;state.reason=d.reason||"";render();}
    catch(e){$("summary").textContent=VERSION+" · 读取失败";["amounts","list","alerts","detail","coverage"].forEach(function(id){clear($(id));$(id).appendChild(el("div","error",e.message));});}
  }
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;var id=b.dataset.id;state.selected=state.rows.find(function(r){return String(r.id||"")===id;})||state.selected;render();});
  $("reload").addEventListener("click",load);$("q").addEventListener("keydown",function(e){if(e.key==="Enter")load();});
  $("targetType").addEventListener("change",load);$("status").addEventListener("change",load);
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"核销管理",url:location.pathname+location.search},location.origin);
  load();
})();
