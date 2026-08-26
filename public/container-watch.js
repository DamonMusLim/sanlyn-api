(function(){
  "use strict";
  var API="/api/db/container-watch",VERSION="v2026.08.26-1";
  var state={rows:[],selected:null,coverage:null,generatedAt:null,ignored:new Set(JSON.parse(localStorage.getItem("container_watch_ignored")||"[]"))};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function text(x,v,fallback){x.textContent=v===null||v===undefined||v===""?(fallback||"未接入"):String(v)}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function has(v){return !(v===null||v===undefined||v===""||(Array.isArray(v)&&!v.length))}
  function fmt(v){return Array.isArray(v)?(v.length?v.join(", "):"未接入"):has(v)?String(v).slice(0,19).replace("T"," "):"未接入"}
  function pct(v){return v===null||v===undefined?"未接入":Number(v).toFixed(1).replace(/\.0$/,"")+"%"}
  function key(r,a){return r.id+":"+a.kind}
  async function api(){
    var p=new URLSearchParams(),q=$("q").value.trim();if(q)p.set("q",q);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function fieldRate(name){
    var f=((state.coverage&&state.coverage.fields)||[]).find(function(x){return x.name===name});
    return f?pct(f.fill_rate):"未接入";
  }
  function title(r){return r.container_no||r.bl_no||r.shipment_no||r.contract_no||("ID "+r.id)}
  function activeAlerts(){
    var out=[];
    state.rows.forEach(function(r){(r.alerts||[]).forEach(function(a){if(!state.ignored.has(key(r,a)))out.push({row:r,alert:a})})});
    return out;
  }
  function renderMetrics(){
    var alerts=activeAlerts().length;
    text($("mRows"),state.rows.length||"未接入");
    text($("mAlerts"),alerts||"未接入");
    text($("mCtn"),fieldRate("container_no"));
    text($("mTrack"),fieldRate("tracking_updated_at"));
    $("summary").textContent=VERSION+" · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length||"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 shipping_plans 可读取记录，当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.id===state.selected.id?" active":""));
      b.type="button";b.dataset.id=r.id;
      b.appendChild(el("strong","",title(r)));
      b.appendChild(el("span","","BL "+fmt(r.bl_no)+" · 船名 "+fmt([r.vessel,r.voyage].filter(Boolean).join(" / "))));
      b.appendChild(el("span","","ETA "+fmt(r.eta)+" · 预警 "+((r.alerts||[]).length||"无")+" · 缺字段 "+(r.missing_count||"无")));
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
      btn.type="button";btn.onclick=function(){state.ignored.add(key(x.row,x.alert));localStorage.setItem("container_watch_ignored",JSON.stringify(Array.from(state.ignored)));render()};
      d.appendChild(left);d.appendChild(btn);box.appendChild(d);
    });
  }
  function renderRoute(){
    var box=$("route");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺 shipping_plans 记录，当前填充率 未接入。"));return}
    var wrap=el("div","route");
    [["柜号",r.container_no,"shipping_plans.container_no"],["起运",r.pol,"shipping_plans.pol"],["ETD",r.etd,"shipping_plans.etd"],["ETA",r.eta,"shipping_plans.eta"],["状态",r.current_status_cn,"shipping_plans.current_status_cn"]].forEach(function(p){
      var d=el("div"),b=el("b","",p[0]),s=el("span","",has(p[1])?fmt(p[1]):"未接入 · 缺 "+p[2]+"；当前填充率 "+fieldRate(p[2].split(".")[1]));
      d.appendChild(b);d.appendChild(s);wrap.appendChild(d);
    });
    box.appendChild(wrap);$("statePill").className="pill "+(r.container_no?"":"warn");text($("statePill"),r.container_no?"已接入柜号":"未接入柜号");
  }
  function td(tr,v){var c=document.createElement("td");text(c,fmt(v));tr.appendChild(c)}
  function renderDetail(){
    var box=$("coverage");clear(box);
    var fs=(state.coverage&&state.coverage.fields)||[];
    if(!fs.length){box.appendChild(el("div","empty","未接入 · 缺 coverage 统计，当前填充率 未接入。"));return}
    fs.forEach(function(f){
      var d=el("div","field"),b=el("b","",f.label),s=el("span","");
      if(f.state==="not_connected")text(s,"未接入 · 缺 "+f.table+"."+f.name+" 或字段为空；当前填充率 "+pct(f.fill_rate));
      else text(s,f.table+"."+f.name+" · 当前填充率 "+pct(f.fill_rate));
      d.appendChild(b);d.appendChild(s);box.appendChild(d);
    });
    if(state.selected&&state.selected.missing&&state.selected.missing.length){
      var p=el("div","muted","当前票缺字段："+state.selected.missing.map(function(x){return x.label+"("+x.table+"."+x.name+")"}).join("、"));
      box.appendChild(p);
    }
  }
  function render(){renderMetrics();renderList();renderAlerts();renderRoute();renderDetail()}
  async function load(){
    try{
      var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage||null;state.generatedAt=d.generated_at;render();
    }catch(e){$("summary").textContent="读取失败";["list","alerts","route","coverage"].forEach(function(id){clear($(id));$(id).appendChild(el("div","error",e.message))})}
  }
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;var id=Number(b.dataset.id);state.selected=state.rows.find(function(r){return r.id===id})||state.selected;render()});
  $("reload").addEventListener("click",load);
  $("q").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"盯箱宝",url:location.pathname+location.search},location.origin);
  var init=new URLSearchParams(location.search).get("q")||"";if(init)$("q").value=init;
  load();
})();
