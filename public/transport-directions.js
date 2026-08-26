(function(){
  "use strict";
  var API="/api/db/transport-directions",VERSION="v2026.08.26-1";
  var state={rows:[],selected:null,directions:[],coverage:null,generatedAt:null};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function has(v){return !(v===null||v===undefined||v==="")}
  function text(x,v,fallback){x.textContent=has(v)?String(v):(fallback||"未接入")}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function pct(v){return v===null||v===undefined?"未接入":Number(v).toFixed(1).replace(/\.0$/,"")+"%"}
  function title(r){return r.shipment_no||r.booking_no||r.so_no||r.bl_no||("ID "+(r.id||"未接入"))}
  function fmt(v,fb){return has(v)?String(v).slice(0,90).replace("T"," "):(fb||"未设置")}
  async function api(){
    var p=new URLSearchParams(),q=$("q").value.trim(),d=$("direction").value;
    if(q)p.set("q",q);if(d)p.set("direction",d);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
    var body=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||body.success===false)throw new Error(body.error||"请求失败");
    return body;
  }
  function renderMetrics(){
    var box=$("metrics");clear(box);
    (state.directions||[]).forEach(function(d){
      var m=el("button","metric hgj-card");m.type="button";m.dataset.key=d.key;
      m.appendChild(el("b","",d.label));
      m.appendChild(el("div","num "+(d.state==="ready"?"":"bad"),d.state==="ready"?d.rows:"未接入"));
      m.appendChild(el("div","muted",d.state==="ready"?"当前填充率 "+pct(d.fill_rate):d.note));
      box.appendChild(m);
    });
    $("summary").textContent=VERSION+" · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺可识别方向的 shipping_plans 真实记录；当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&String(r.id)===String(state.selected.id)?" active":""));
      b.type="button";b.dataset.id=r.id||"";
      b.appendChild(el("strong","",title(r)));
      b.appendChild(el("span","",(r.direction_label||"未接入方向")+" · "+fmt(r.customer)+" · "+fmt(r.status)));
      b.appendChild(el("span","",[fmt(r.pol),fmt(r.pod)].join(" / ")+" · ETD "+fmt(r.etd)+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function td(tr,v,fb){var c=document.createElement("td");text(c,v,fb);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取 shipping_plans 记录；当前填充率 未接入。"));text($("statePill"),"未接入");return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["方向",r.direction_label],["识别依据",r.direction_basis],["CY/订舱/SO/BL",[r.shipment_no,r.booking_no,r.so_no,r.bl_no].filter(has).join(" / ")],
      ["客户",r.customer],["起运/目的地",[r.pol,r.pod].filter(has).join(" / ")],["ETD/ETA",[r.etd,r.eta].filter(has).join(" / ")],
      ["承运人",r.carrier_code],["货代",r.forwarder_cn],["车队",r.trucking_cn],["状态",r.status],["方向源字段值",r.source_text]
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1],"未设置");body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length)box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"("+x.table+"."+x.name+")";}).join("、")));
    $("statePill").className="pill "+(r.direction_key?"":"bad");text($("statePill"),r.direction_label||"未接入方向");
  }
  function renderDirectionState(){
    var box=$("directionState");clear(box);
    (state.directions||[]).forEach(function(d){
      var x=el("div","field"),b=el("b","",d.label),s=el("span","");
      if(d.state==="ready")text(s,"真实记录 "+d.rows+"；依据 shipping_plans 方向字段；当前填充率 "+pct(d.fill_rate));
      else text(s,d.note+"；缺字段："+(d.missing_fields||[]).map(function(f){return f.table+"."+f.name;}).join("、"));
      x.appendChild(b);x.appendChild(s);box.appendChild(x);
    });
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var fs=(state.coverage&&state.coverage.fields)||[];
    if(!fs.length){box.appendChild(el("div","empty","未接入 · 缺方向字段清单；当前填充率 未接入。"));return}
    fs.forEach(function(f){
      var d=el("div","field"),b=el("b","",f.label),s=el("span","");
      if(f.state==="not_connected")text(s,"未接入 · 缺 "+f.table+"."+f.name+" 或字段为空；当前填充率 "+pct(f.fill_rate));
      else text(s,f.table+"."+f.name+" · "+f.filled+"/"+f.total+" · 当前填充率 "+pct(f.fill_rate));
      d.appendChild(b);d.appendChild(s);box.appendChild(d);
    });
  }
  function render(){renderMetrics();renderList();renderDetail();renderDirectionState();renderCoverage()}
  async function load(){
    try{
      var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;
      state.directions=d.directions||[];state.coverage=d.coverage||null;state.generatedAt=d.generated_at;render();
    }catch(e){$("summary").textContent="读取失败";["list","detail","directionState","coverage"].forEach(function(id){clear($(id));$(id).appendChild(el("div","error",e.message))})}
  }
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;state.selected=state.rows.find(function(r){return String(r.id||"")===b.dataset.id})||state.selected;render()});
  $("metrics").addEventListener("click",function(e){var b=e.target.closest(".metric");if(!b)return;$("direction").value=b.dataset.key||"";load()});
  $("reload").addEventListener("click",load);
  $("q").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  $("direction").addEventListener("change",load);
  $("openWb").addEventListener("click",function(){var url="/transport-directions";if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",title:"六方向运输",url:url},location.origin);else window.open("/wb-tabs?open="+encodeURIComponent(url),"_blank","noopener")});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"六方向运输",url:location.pathname+location.search},location.origin);
  load();
})();
