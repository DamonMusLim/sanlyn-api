(function(){
  "use strict";
  var API="/api/db/cargo-insurance",VERSION="v2026.08.26-1";
  var state={rows:[],selected:null,coverage:null,generatedAt:null,ignored:new Set(JSON.parse(localStorage.getItem("cargo_insurance_ignored")||"[]"))};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function has(v){return !(v===null||v===undefined||v==="")}
  function text(x,v,fallback){x.textContent=has(v)?String(v):(fallback||"未接入")}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function fmt(v,fallback){return has(v)?String(v).slice(0,80).replace("T"," "):(fallback||"未设置")}
  function pctField(f){return !f||f.fill_rate===null||f.fill_rate===undefined?"未接入":Number(f.fill_rate).toFixed(1).replace(/\.0$/,"")+"%"}
  function field(name){return ((state.coverage&&state.coverage.fields)||[]).find(function(f){return f.name===name})||null}
  function key(r,a){return (r.id||r.bl_no||r.order_ref||"row")+":"+a.kind}
  function title(r){return r.policy_no||r.bl_no||r.order_ref||r.contract_no||("ID "+(r.id||"未接入"))}
  async function api(){
    var p=new URLSearchParams(),q=$("q").value.trim(),st=$("state").value;
    if(q)p.set("q",q);if(st)p.set("state",st);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function activeAlerts(){
    var out=[];
    state.rows.forEach(function(r){(r.alerts||[]).forEach(function(a){if(!state.ignored.has(key(r,a)))out.push({row:r,alert:a})})});
    return out;
  }
  function renderMetrics(){
    var total=(state.coverage&&state.coverage.total_rows)||0;
    text($("mRows"),total?total:"未接入");
    text($("mPolicy"),pctField(field("policy_no")));
    text($("mInsured"),pctField(field("insured_amount")));
    text($("mPremium"),pctField(field("premium_rmb")));
    $("summary").textContent=VERSION+" · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 insurance_policies 可读取记录；当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.id===state.selected.id?" active":""));
      b.type="button";b.dataset.id=r.id||"";
      b.appendChild(el("strong","",title(r)));
      b.appendChild(el("span","","被保险人 "+fmt(r.insured_name)+" · 保险公司 "+fmt(r.insurer)));
      b.appendChild(el("span","","保额 "+fmt(r.insured_amount)+" "+fmt(r.currency,"")+" · 保费 "+fmt(r.premium_rmb)+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function renderAlerts(){
    var box=$("alerts");clear(box);var rows=activeAlerts();
    if(!rows.length){box.appendChild(el("div","empty","没有未忽略的真实业务预警；未接入条目不会进入忽略列表。"));return}
    rows.forEach(function(x){
      var d=el("div","alert"),left=el("div"),btn=el("button","","忽略");
      left.appendChild(el("b","",x.alert.label));
      left.appendChild(el("div","muted",title(x.row)+" · 依据 "+x.alert.basis));
      btn.type="button";btn.onclick=function(){state.ignored.add(key(x.row,x.alert));localStorage.setItem("cargo_insurance_ignored",JSON.stringify(Array.from(state.ignored)));render()};
      d.appendChild(left);d.appendChild(btn);box.appendChild(d);
    });
  }
  function td(tr,v,fb){var c=document.createElement("td");text(c,v,fb);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺 insurance_policies 记录；当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["订单/合同",[r.order_ref,r.contract_no].filter(has).join(" / ")],["BL",r.bl_no],["状态",r.status],
      ["被保险人",r.insured_name],["投保人",r.policyholder_name],["投保人税号",r.policyholder_tax_id],
      ["航线",[r.pol,r.pod].filter(has).join(" / ")],["船名航次",r.vessel_voyage],["ETD",r.etd],
      ["货物描述",r.cargo_description],["件数包装",r.packing_qty],["发票金额",r.invoice_amount],
      ["保险金额",r.insured_amount],["币种",r.currency],["加成比例",r.markup_pct],
      ["费率",r.rate],["保费人民币",r.premium_rmb],["保单号",r.policy_no],["保单PDF",r.policy_pdf_url],
      ["填单/提交",[r.filled_at,r.submitted_at].filter(has).join(" / ")]
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1],"未设置");body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length)box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"(insurance_policies."+x.name+")";}).join("、")));
    $("statePill").className="pill "+(r.policy_no?"":"warn");text($("statePill"),r.policy_no?"已有保单号":"未接入保单号");
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var fs=(state.coverage&&state.coverage.fields)||[];
    if(!fs.length){box.appendChild(el("div","empty","未接入 · 缺 insurance_policies 字段统计；当前填充率 未接入。"));return}
    fs.forEach(function(f){
      var d=el("div","field"),b=el("b","",f.label),s=el("span","");
      if(f.state==="not_connected")text(s,"未接入 · 缺 insurance_policies."+f.name+" 或字段为空；当前填充率 "+pctField(f));
      else text(s,"insurance_policies."+f.name+" · "+f.filled+"/"+f.total+" · 当前填充率 "+pctField(f));
      d.appendChild(b);d.appendChild(s);box.appendChild(d);
    });
  }
  function render(){renderMetrics();renderList();renderAlerts();renderDetail();renderCoverage()}
  async function load(){
    try{
      var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage||null;state.generatedAt=d.generated_at;render();
    }catch(e){$("summary").textContent="读取失败";["list","alerts","detail","coverage"].forEach(function(id){clear($(id));$(id).appendChild(el("div","error",e.message))})}
  }
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;var id=b.dataset.id;state.selected=state.rows.find(function(r){return String(r.id||"")===id})||state.selected;render()});
  $("reload").addEventListener("click",load);
  $("q").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  $("state").addEventListener("change",load);
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"货运保险",url:location.pathname+location.search},location.origin);
  load();
})();
