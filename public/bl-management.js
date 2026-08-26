(function(){
  "use strict";
  var API="/api/db/bl-management";
  var state={rows:[],selected:null,coverage:null,actions:null,generatedAt:null};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function text(x,v,fallback){x.textContent=v===null||v===undefined||v===""?(fallback||"未设置"):String(v)}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function pct(filled,total){if(!total)return "未接入";return Math.round(Number(filled||0)*1000/Number(total))/10+"%"}
  function field(name){var fs=((state.coverage&&state.coverage.fields)||[]).concat((state.coverage&&state.coverage.doc_fields)||[]);return fs.find(function(f){return f.name===name})||null}
  function fieldRate(names){
    var fs=names.map(field).filter(Boolean).filter(function(f){return f.state==="ready"});
    if(!fs.length)return "未接入";
    var total=fs.reduce(function(a,f){return a+Number(f.total||0)},0);
    var filled=fs.reduce(function(a,f){return a+Number(f.filled||0)},0);
    return pct(filled,total);
  }
  async function api(){
    var p=new URLSearchParams(), q=$("search").value.trim(), st=$("state").value;
    if(q)p.set("q",q);if(st)p.set("state",st);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function stateLabel(s){
    return {ready:"提单字段已填",pending_booking:"未出运",missing_bl:"已出运缺提单号",missing_master_house:"缺MBL/HBL",missing_release:"缺放单方式"}[s]||"待核";
  }
  function renderMetrics(){
    var cov=state.coverage||{};
    text($("mRows"),cov.total_rows?cov.total_rows:"未接入");
    text($("mBl"),fieldRate(["bl_no"]));
    text($("mMh"),fieldRate(["mbl_no","hbl_no"]));
    text($("mDoc"),"未接入");
    $("summary").textContent="v2026.08.26-1 · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function rowTitle(r){return r.shipment_no||r.bl_no||r.mbl_no||("ID "+r.id)}
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 shipping_plans 真实记录，当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.id===state.selected.id?" active":""));
      b.type="button";b.dataset.id=r.id;
      b.appendChild(el("strong","",rowTitle(r)));
      b.appendChild(el("span","BL "+(r.bl_no||"未接入")+" · MBL "+(r.mbl_no||"未接入")+" · HBL "+(r.hbl_no||"未接入")));
      b.appendChild(el("span","状态 "+stateLabel(r.state)+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function td(tr,v){var c=document.createElement("td");text(c,v);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);
    var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取 shipping_plans 记录，当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["CY号",r.shipment_no],["提单号",r.bl_no],["MBL",r.mbl_no],["HBL",r.hbl_no],["SO号",r.so_no],
      ["放单方式",r.release_type],["首次出单",r.first_issued_at],["电放时间",r.telex_released_at],
      ["船名航次",[r.vessel,r.voyage].filter(Boolean).join(" / ")],["ETD/ETA",[r.etd,r.eta].filter(Boolean).join(" / ")],
      ["柜号",r.container_no],["柜量/柜型",[r.container_qty,r.container_type].filter(function(x){return x!==null&&x!==undefined&&x!==""}).join(" / ")],
      ["客户",r.customer],["货代",r.forwarder_cn],["出单公司",r.issuing_company],["业务状态",r.status]
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1]);body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length)box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"(shipping_plans."+x.name+")";}).join("、")));
    $("readyPill").className="pill "+(r.state==="ready"?"":"warn");
    text($("readyPill"),stateLabel(r.state));
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);
    var fs=((state.coverage&&state.coverage.fields)||[]).concat((state.coverage&&state.coverage.doc_fields)||[]);
    if(!fs.length){box.appendChild(el("div","empty","未接入 · 缺字段清单，当前填充率 未接入。"));return}
    fs.forEach(function(f){
      var d=el("div","field"), name=el("b","",f.label), meta=el("span","");
      if(f.state==="not_connected")text(meta,"未接入 · 缺 shipping_plans."+f.name+"；当前填充率 未接入");
      else text(meta,"shipping_plans."+f.name+" · "+f.filled+"/"+f.total+" · "+pct(f.filled,f.total));
      d.appendChild(name);d.appendChild(meta);box.appendChild(d);
    });
  }
  function renderActions(){
    var box=$("actionsState");clear(box);
    var s=state.actions||{}, missing=(s.missing_fields||[]).map(function(x){return x.label+"(shipping_plans."+x.name+")";}).join("、");
    var rates=((state.coverage&&state.coverage.doc_fields)||[]).map(function(f){return f.name+" "+(f.state==="ready"?pct(f.filled,f.total):"未接入");}).join("；");
    box.appendChild(el("p","bad","未接入"));
    box.appendChild(el("p","muted",s.note||"缺提单草稿/确认/发送工作流字段和外部放单通道；本页只读。"));
    box.appendChild(el("p","muted","缺字段："+(missing||"未设置")+"。当前填充率："+(rates||"未接入")+"。"));
    box.appendChild(el("p","muted","未接入条目不提供忽略，也不会执行对外发送或放单。"));
  }
  function render(){renderMetrics();renderList();renderDetail();renderCoverage();renderActions()}
  async function load(){
    try{
      var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;
      state.coverage=d.coverage||null;state.actions=d.actions||null;state.generatedAt=d.generated_at;render();
    }catch(e){$("summary").textContent="读取失败";clear($("list"));$("list").appendChild(el("div","error",e.message))}
  }
  $("list").addEventListener("click",function(e){
    var b=e.target.closest(".row");if(!b)return;
    var id=Number(b.dataset.id);state.selected=state.rows.find(function(r){return r.id===id})||state.selected;render();
  });
  $("reload").addEventListener("click",load);
  $("search").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  $("state").addEventListener("change",load);
  $("openWb").addEventListener("click",function(){
    var url="/bl-management";
    if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",title:"提单管理",url:url},location.origin);
    else window.open("/wb-tabs?open="+encodeURIComponent(url),"_blank","noopener");
  });
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"提单管理",url:location.pathname},location.origin);
  load();
})();
