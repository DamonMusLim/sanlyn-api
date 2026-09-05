(function(){
  "use strict";
  var API="/api/db/shipment-tracking";
  var state={rows:[],selected:null,coverage:null,generatedAt:null};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function text(x,v,fallback){x.textContent=v===null||v===undefined||v===""?(fallback||"未接入"):String(v)}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function has(v){return !(v===null||v===undefined||v===""||(Array.isArray(v)&&!v.length))}
  function pct(v){return v===null||v===undefined?"未接入":Number(v).toFixed(1).replace(/\.0$/,"")+"%"}
  function fmt(v){return Array.isArray(v)?(v.length?v.join(", "):"未接入"):has(v)?v:"未接入"}
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
  function stageRate(){
    var stages=(state.coverage&&state.coverage.stages)||[];
    if(!stages.length)return "未接入";
    var ready=stages.filter(function(s){return s.state==="ready"}).length;
    return ready+"/"+stages.length;
  }
  function renderMetrics(){
    var rows=state.rows.length;
    text($("mRows"),rows||"未接入");
    text($("mTrack"),fieldRate("current_status_cn"));
    text($("mStage"),stageRate());
    $("summary").textContent="v2026.08.26-1 · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function rowTitle(r){return r.shipment_no||r.bl_no||r.contract_no||("ID "+r.id)}
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length||"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 shipping_plans 可读取记录，当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.id===state.selected.id?" active":""));
      b.type="button";b.dataset.id=r.id;
      b.appendChild(el("strong","",rowTitle(r)));
      b.appendChild(el("span","","BL "+fmt(r.bl_no)+" · 柜号 "+fmt(r.container_no)));
      b.appendChild(el("span","","状态 "+fmt(r.current_status_cn)+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function renderTimeline(){
    var box=$("timeline");clear(box);
    var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺 shipping_plans 记录，当前填充率 未接入。"));return}
    var wrap=el("div","track");
    (r.stages||[]).forEach(function(s){
      var d=el("div","step "+(s.state==="ready"?"ready":"miss"));
      d.appendChild(el("b","",s.label));
      d.appendChild(el("span",s.state==="ready"?"pill":"pill warn",s.state==="ready"?"已接入":"未接入"));
      var ul=document.createElement("ul");
      (s.fields||[]).forEach(function(f){
        var li=document.createElement("li");
        li.textContent=f.state==="ready"?f.label+"："+fmt(f.value):"缺 "+f.table+"."+f.name+"；当前填充率见下方";
        ul.appendChild(li);
      });
      d.appendChild(ul);wrap.appendChild(d);
    });
    box.appendChild(wrap);
    $("statePill").className="pill "+((r.stages||[]).some(function(s){return s.state==="ready"})?"":"warn");
    text($("statePill"),(r.stages||[]).some(function(s){return s.state==="ready"})?"部分接入":"未接入");
  }
  function td(tr,v){var c=document.createElement("td");text(c,fmt(v));tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺当前票字段，当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [["订舱号",r.shipment_no],["提单号",r.bl_no],["合同号",r.contract_no],["订单号",r.order_nos],
      ["起运港/目的港",[r.pol,r.pod].filter(Boolean).join(" / ")],["船名航次",[r.vessel,r.voyage].filter(Boolean).join(" / ")],
      ["柜号",r.container_no],["柜量/柜型",[r.container_qty,r.container_type].filter(function(x){return x!==null&&x!==undefined&&x!==""}).join(" / ")],
      ["客户",r.customer],["货代",r.forwarder_cn],["船踪状态",r.current_status_cn],["船踪更新时间",r.tracking_updated_at]
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1]);body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length)box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"("+x.table+"."+x.name+")"}).join("、")));
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);
    var fs=((state.coverage&&state.coverage.fields)||[]).concat(((state.coverage&&state.coverage.stages)||[]).flatMap(function(s){return s.fields||[]}));
    if(!fs.length){box.appendChild(el("div","empty","未接入 · 缺 coverage 统计，当前填充率 未接入。"));return}
    fs.forEach(function(f){
      var d=el("div","field"),b=el("b","",f.label),s=el("span","");
      if(f.state==="not_connected")text(s,"未接入 · 缺 shipping_plans."+f.name+" 或字段为空；当前填充率 "+pct(f.fill_rate));
      else text(s,"shipping_plans."+f.name+" · 当前填充率 "+pct(f.fill_rate));
      d.appendChild(b);d.appendChild(s);box.appendChild(d);
    });
  }
  function render(){renderMetrics();renderList();renderTimeline();renderDetail();renderCoverage()}
  async function load(){
    try{
      var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage||null;state.generatedAt=d.generated_at;render();
    }catch(e){$("summary").textContent="读取失败";clear($("list"));$("list").appendChild(el("div","error",e.message));["timeline","detail","coverage"].forEach(function(id){$(id).replaceChildren(el("div","error",e.message))})}
  }
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;var id=Number(b.dataset.id);state.selected=state.rows.find(function(r){return r.id===id})||state.selected;render()});
  $("reload").addEventListener("click",load);
  $("q").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"全程货物跟踪",url:location.pathname+location.search},location.origin);
  var init=new URLSearchParams(location.search).get("q")||"";if(init)$("q").value=init;
  load();
})();
