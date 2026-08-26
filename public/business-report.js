(function(){
  "use strict";
  var API="/api/db/business-report",VERSION="v2026.08.26-1";
  var state={metrics:[],rows:[],monthly:[],coverage:[],generatedAt:null};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function has(v){return !(v===null||v===undefined||v===""||(Array.isArray(v)&&!v.length))}
  function text(x,v,fb){x.textContent=has(v)?String(v):(fb||"未接入")}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function fmt(v,fb){if(!has(v))return fb||"未设置";return String(v).slice(0,120).replace("T"," ")}
  function money(v,c){if(!has(v))return "未设置";var n=Number(v);return (c?c+" ":"")+(Number.isFinite(n)?n.toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}):String(v))}
  function pct(f){return !f||f.fill_rate===null||f.fill_rate===undefined?"未接入":Number(f.fill_rate).toFixed(1).replace(/\.0$/,"")+"%"}
  async function api(){
    var p=new URLSearchParams(),from=$("from").value,to=$("to").value,q=$("q").value.trim();
    if(from)p.set("from",from);if(to)p.set("to",to);if(q)p.set("q",q);
    var r=await fetch(API+"?"+p.toString(),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function td(tr,v,fb){var c=document.createElement("td");text(c,v,fb);tr.appendChild(c)}
  function renderMetrics(){
    var box=$("metrics");clear(box);
    state.metrics.forEach(function(m){
      var card=el("section","metric hgj-card"),label=el("div","muted",m.label),num=el("div","num",m.state==="ready"?m.value:"未接入"),note=el("div","muted",m.note);
      if(m.state!=="ready")num.className="num bad";
      card.appendChild(label);card.appendChild(num);card.appendChild(note);box.appendChild(card);
    });
    if(!state.metrics.length)box.appendChild(el("div","empty","未接入 · 缺业务报表指标；当前填充率 未接入。"));
  }
  function renderMonthly(){
    var body=$("monthly");clear(body);text($("monthCount"),state.monthly.length||"未接入");
    if(!state.monthly.length){var tr=document.createElement("tr");td(tr,"未接入 · 缺 orders.order_date 可汇总记录；当前填充率 未接入。");td(tr,"");td(tr,"");body.appendChild(tr);return}
    state.monthly.forEach(function(r){var tr=document.createElement("tr");td(tr,r.month);td(tr,r.order_count,"未接入");td(tr,money(r.order_amount));body.appendChild(tr)});
  }
  function renderRows(){
    var body=$("rows");clear(body);text($("rowCount"),state.rows.length||"未接入");
    if(!state.rows.length){var tr=document.createElement("tr");td(tr,"未接入 · 缺 orders 可读取记录或当前筛选无真实数据。");td(tr,"");td(tr,"");td(tr,"");td(tr,"");td(tr,"");body.appendChild(tr);return}
    state.rows.forEach(function(r){
      var tr=document.createElement("tr");
      td(tr,fmt(r.order_no||r.contract_no));td(tr,fmt(r.order_date));td(tr,fmt(r.customer));td(tr,fmt(r.factory));td(tr,fmt(r.status));td(tr,money(r.total_amount,r.currency));
      body.appendChild(tr);
    });
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);
    state.coverage.forEach(function(g){
      var title=el("div","field"),b=el("b","",g.label+" · "+g.table),s=el("span","",g.note);
      title.appendChild(b);title.appendChild(s);box.appendChild(title);
      (g.fields||[]).forEach(function(f){
        var d=el("div","field"),fb=el("b","",f.name),fs=el("span","");
        text(fs,f.state==="ready"?f.filled+"/"+f.total+" · 当前填充率 "+pct(f):"未接入 · 缺 "+g.table+"."+f.name+" 或字段为空；当前填充率 "+pct(f));
        d.appendChild(fb);d.appendChild(fs);box.appendChild(d);
      });
    });
    if(!state.coverage.length)box.appendChild(el("div","empty","未接入 · 缺字段统计；当前填充率 未接入。"));
  }
  function render(){
    $("summary").textContent=VERSION+" · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
    renderMetrics();renderMonthly();renderRows();renderCoverage();
  }
  async function load(){
    try{var d=await api();state.metrics=d.metrics||[];state.rows=d.rows||[];state.monthly=d.monthly||[];state.coverage=d.coverage||[];state.generatedAt=d.generated_at;render();}
    catch(e){$("summary").textContent=VERSION+" · 读取失败";["metrics","monthly","rows","coverage"].forEach(function(id){clear($(id));$(id).appendChild(el(id==="metrics"||id==="coverage"?"div":"tr","error",e.message))})}
  }
  $("reload").addEventListener("click",load);
  $("q").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"业务报表",url:location.pathname+location.search},location.origin);
  load();
})();
