(function(){
  "use strict";
  var API="/api/db/financial-report",VERSION="v2026.08.26-1";
  var state={metrics:[],sections:[],coverage:[],generatedAt:null};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function has(v){return !(v===null||v===undefined||v===""||(Array.isArray(v)&&!v.length))}
  function text(x,v,fb){x.textContent=has(v)?String(v):(fb||"未接入")}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function money(v){if(!has(v))return "未设置";var n=Number(v);return Number.isFinite(n)?n.toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2}):String(v)}
  function pct(f){return !f||f.fill_rate===null||f.fill_rate===undefined?"未接入":Number(f.fill_rate).toFixed(1).replace(/\.0$/,"")+"%"}
  async function api(){
    var p=new URLSearchParams(),from=$("from").value,to=$("to").value;
    if(from)p.set("from",from);if(to)p.set("to",to);
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
      var c=el("section","metric hgj-card"),n=el("div","num",m.value),note=el("div","muted",m.note);
      if(!has(m.value))n.className="num bad";
      c.appendChild(el("div","muted",m.label));c.appendChild(n);c.appendChild(note);box.appendChild(c);
    });
    if(!state.metrics.length)box.appendChild(el("div","empty","未接入 · 缺财务报表指标；当前填充率 未接入。"));
  }
  function renderSections(){
    var body=$("sections");clear(body);
    if(!state.sections.length){var tr=document.createElement("tr");td(tr,"未接入 · 缺财务真源表；当前填充率 未接入。");td(tr,"");td(tr,"");td(tr,"");td(tr,"");body.appendChild(tr);return}
    state.sections.forEach(function(s){
      if(!s.rows||!s.rows.length){var tr0=document.createElement("tr");td(tr0,s.label);td(tr0,"未接入");td(tr0,"未接入");td(tr0,"未设置");td(tr0,s.reason||"未接入");body.appendChild(tr0);return}
      s.rows.forEach(function(r){var tr=document.createElement("tr"),label=[r.currency||"未设置",r.direction||""].filter(has).join(" / ");td(tr,s.label);td(tr,label||"未设置");td(tr,r.records,"未接入");td(tr,money(r.amount));td(tr,"已接入");body.appendChild(tr)});
    });
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);
    state.coverage.forEach(function(g){
      var title=el("div","field"),b=el("b","",g.label+" · "+g.table),s=el("span","",g.note);
      title.appendChild(b);title.appendChild(s);box.appendChild(title);
      (g.fields||[]).forEach(function(f){
        var d=el("div","field"),fb=el("b","",f.name),fs=el("span","");
        if(f.state==="ready")text(fs,g.table+"."+f.name+" · "+f.filled+"/"+f.total+" · 当前填充率 "+pct(f));
        else text(fs,"未接入 · 缺 "+g.table+"."+f.name+" 或字段为空；当前填充率 "+pct(f));
        d.appendChild(fb);d.appendChild(fs);box.appendChild(d);
      });
    });
    if(!state.coverage.length)box.appendChild(el("div","empty","未接入 · 缺字段统计；当前填充率 未接入。"));
  }
  function render(){
    $("summary").textContent=VERSION+" · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
    renderMetrics();renderSections();renderCoverage();
  }
  async function load(){
    try{var d=await api();state.metrics=d.metrics||[];state.sections=d.sections||[];state.coverage=d.coverage||[];state.generatedAt=d.generated_at;render();}
    catch(e){$("summary").textContent=VERSION+" · 读取失败";["metrics","sections","coverage"].forEach(function(id){clear($(id));$(id).appendChild(el(id==="sections"?"tr":"div","error",e.message))})}
  }
  $("reload").addEventListener("click",load);
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"财务报表",url:location.pathname+location.search},location.origin);
  load();
})();
