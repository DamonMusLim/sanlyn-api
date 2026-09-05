(function(){
  "use strict";
  var API="/api/db/booking-platform";
  var state={rows:[],selected:null,coverage:null,channel:null,documents:null,generatedAt:null,nextOnly:false};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function text(x,v,fallback){x.textContent=v===null||v===undefined||v===""?(fallback||"未设置"):String(v)}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function pct(filled,total){if(!total)return "未接入";return Math.round(Number(filled||0)*1000/Number(total))/10+"%"}
  function fields(){return ((state.coverage&&state.coverage.fields)||[]).concat((state.coverage&&state.coverage.channel_fields)||[]).concat((state.coverage&&state.coverage.document_fields)||[])}
  function field(name){return fields().find(function(f){return f.name===name})||null}
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
    if(state.nextOnly)p.set("next","1");
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function stateLabel(s){
    return {ready:"订舱字段已填",not_connected:"未接入",missing_booking:"缺订舱号",missing_schedule:"缺船期",missing_forwarder:"缺货代"}[s]||"待核";
  }
  function renderMetrics(){
    var cov=state.coverage||{};
    text($("mRows"),cov.total_rows?cov.total_rows:"未接入");
    text($("mBooking"),fieldRate(["booking_no","forwarder_booking_no","so_no"]));
    text($("mSchedule"),fieldRate(["vessel","voyage","etd"]));
    text($("mChannel"),"未接入");
    $("summary").textContent="v2026.09.05-1 · "+(state.nextOnly?"下一票试走 · ":"")+"生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function rowTitle(r){return r.shipment_no||r.booking_no||r.forwarder_booking_no||r.so_no||("ID "+r.id)}
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 shipping_plans 真实记录；当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.id===state.selected.id?" active":""));
      b.type="button";b.dataset.id=r.id;
      b.appendChild(el("strong","",rowTitle(r)));
      b.appendChild(el("span","","订舱 "+(r.booking_no||r.forwarder_booking_no||r.so_no||"未接入")+" · "+(r.pol||"未设置")+" / "+(r.pod||"未设置")));
      b.appendChild(el("span","","船期 "+([r.vessel,r.voyage].filter(Boolean).join(" / ")||"未接入")+" · ETD "+(r.etd||"未接入")+" · 资料 "+(r.doc_ready?"可下载":"未接入")+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function td(tr,v){var c=document.createElement("td");text(c,v);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);
    var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取 shipping_plans 记录；当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["CY号",r.shipment_no],["订舱号",r.booking_no],["货代订舱号",r.forwarder_booking_no],["SO号",r.so_no],["提单号",r.bl_no],
      ["船公司",r.carrier_code],["货代",r.forwarder_cn],["起运/目的港",[r.pol,r.pod].filter(Boolean).join(" / ")],
      ["船名航次",[r.vessel,r.voyage].filter(Boolean).join(" / ")],["ETD/ETA",[r.etd,r.eta].filter(Boolean).join(" / ")],
      ["截关/截港/SI",[r.cutoff_time,r.cy_cutoff,r.si_cutoff].filter(Boolean).join(" / ")],
      ["柜量/柜型",[r.container_qty,r.container_type].filter(function(x){return x!==null&&x!==undefined&&x!==""}).join(" / ")],
      ["客户",r.customer],["状态",r.status]
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1]);body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length)box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"(shipping_plans."+x.name+")";}).join("、")));
    $("readyPill").className="pill "+(r.state==="ready"?"":(r.state==="not_connected"?"bad":"warn"));
    text($("readyPill"),stateLabel(r.state));
  }
  function docRateText(){
    var f=field("file_url");
    if(!f||f.state!=="ready")return "当前填充率 未接入";
    return "当前填充率 "+pct(f.filled,f.total);
  }
  function renderDocs(){
    var box=$("docs");clear(box);
    var r=state.selected, docs=(r&&r.docs)||[], ready=docs.filter(function(d){return d.url&&(d.kind==="bl"||d.kind==="signed")});
    $("docPill").className="pill "+(ready.length?"":"bad");
    text($("docPill"),ready.length?("可下载 "+ready.length+" 份"):"未接入");
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取 shipping_plans 记录；当前填充率 未接入。"));return}
    if(!ready.length){
      var miss=(state.documents&&state.documents.missing_fields||[]).map(function(x){return (x.table||"document_files")+"."+x.name}).join("、");
      var why=miss?("缺字段 "+miss):(docs.length?"缺提单/签单资料 URL":"缺 document_files/ocean_doc_intake 提单/签单资料记录");
      box.appendChild(el("div","empty","未接入 · "+why+"；"+docRateText()+"。"));
      return;
    }
    var table=document.createElement("table"),body=document.createElement("tbody");
    ready.forEach(function(d){
      var tr=document.createElement("tr"), c1=document.createElement("td"), c2=document.createElement("td"), c3=document.createElement("td"), a=document.createElement("a");
      text(c1,d.kind==="bl"?"提单资料":"签单资料");text(c2,[d.name||d.type||"未设置",d.source].filter(Boolean).join(" · "));
      a.className="hgj-link";a.href=d.url;a.target="_blank";a.rel="noopener";a.textContent="下载";
      c3.appendChild(a);tr.appendChild(c1);tr.appendChild(c2);tr.appendChild(c3);body.appendChild(tr);
    });
    table.appendChild(body);box.appendChild(table);
    box.appendChild(el("p","muted","来源 document_files/ocean_doc_intake.file_url；"+docRateText()+"。"));
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var fs=fields();
    if(!fs.length){box.appendChild(el("div","empty","未接入 · 缺字段清单；当前填充率 未接入。"));return}
    fs.forEach(function(f){
      var d=el("div","field"), name=el("b","",f.label), meta=el("span","");
      var table=f.table||"shipping_plans";
      if(f.state==="not_connected")text(meta,"未接入 · 缺 "+table+"."+f.name+"；当前填充率 未接入");
      else text(meta,table+"."+f.name+" · "+f.filled+"/"+f.total+" · "+pct(f.filled,f.total));
      d.appendChild(name);d.appendChild(meta);box.appendChild(d);
    });
  }
  function renderChannel(){
    var box=$("channelState");clear(box);
    var s=state.channel||{}, missing=(s.missing_fields||[]).map(function(x){return x.label+"(shipping_plans."+x.name+")";}).join("、");
    var rates=((state.coverage&&state.coverage.channel_fields)||[]).map(function(f){return f.name+" "+(f.state==="ready"?pct(f.filled,f.total):"未接入");}).join("；");
    box.appendChild(el("p","bad","未接入"));
    box.appendChild(el("p","muted",s.note||"缺订舱外部发送通道、通道状态字段和回执字段；本页只读。"));
    box.appendChild(el("p","muted","缺字段："+(missing||"未设置")+"。当前填充率："+(rates||"未接入")+"。"));
    box.appendChild(el("p","muted","未接入条目不提供忽略，也不会向货代或船公司发送订舱。"));
  }
  function render(){renderMetrics();renderList();renderDetail();renderDocs();renderCoverage();renderChannel()}
  async function load(){
    try{
      var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;
      state.coverage=d.coverage||null;state.channel=d.booking_channel||null;state.documents=d.documents||null;state.generatedAt=d.generated_at;render();
    }catch(e){$("summary").textContent="读取失败";clear($("list"));$("list").appendChild(el("div","error",e.message))}
  }
  $("list").addEventListener("click",function(e){
    var b=e.target.closest(".row");if(!b)return;
    var id=Number(b.dataset.id);state.selected=state.rows.find(function(r){return r.id===id})||state.selected;render();
  });
  $("reload").addEventListener("click",load);
  $("nextTicket").addEventListener("click",function(){state.nextOnly=!state.nextOnly;$("nextTicket").classList.toggle("primary",state.nextOnly);load()});
  $("search").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  $("state").addEventListener("change",load);
  $("sendBtn").addEventListener("click",function(){alert("订舱通道未接入：缺 booking_channel_status / booking_channel_sent_at / booking_channel_receipt_no 和外部通道凭证；当前页面只读。")});
  $("openWb").addEventListener("click",function(){
    var url="/booking-platform";
    if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",title:"订舱平台",url:url},location.origin);
    else window.open("/wb-tabs?open="+encodeURIComponent(url),"_blank","noopener");
  });
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"订舱平台",url:location.pathname},location.origin);
  load();
})();
