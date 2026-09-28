(function(){
  "use strict";
  var API="/api/db/manifest-message-channel";
  var state={rows:[],selected:null,coverage:null,outbox:null,preview:null};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={"Content-Type":"application/json"},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(el){while(el.firstChild)el.removeChild(el.firstChild)}
  function text(el,v,fallback){el.textContent=v===null||v===undefined||v===""?(fallback||"未设置"):String(v)}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function pct(filled,total){if(!total)return "未接入";return Math.round(Number(filled||0)*1000/Number(total))/10+"%"}
  function rate(fields){var ready=(fields||[]).filter(function(f){return f.state==="ready"});if(!ready.length)return "未接入";var total=ready.reduce(function(a,f){return a+Number(f.total||0)},0),filled=ready.reduce(function(a,f){return a+Number(f.filled||0)},0);return pct(filled,total)}
  async function req(method, body){
    var p=new URLSearchParams(), q=$("search").value.trim();
    if(q)p.set("q",q);if(state.selected&&state.selected.id)p.set("id",state.selected.id);
    var opt={method:method,headers:headers()};if(body)opt.body=JSON.stringify(body);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),opt),d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(!r.ok||d.success===false){var e=new Error(d.error||"请求失败");e.data=d;throw e}
    return d;
  }
  function rowTitle(r){return r.shipment_no||r.bl_no||("ID "+r.id)}
  function renderMetrics(){
    var cov=state.coverage||{}, ob=state.outbox||{};
    text($("mRows"),cov.total_rows?cov.total_rows:"未接入");
    text($("mHeader"),rate(cov.header_fields));
    text($("mOutbox"),ob.state==="ready"?"已接入":"未接入");
    $("mOutbox").className="num "+(ob.state==="ready"?"":"bad");
    $("summary").textContent="生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 customs_shipments 真实记录，当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.id===state.selected.id?" active":""));b.type="button";b.dataset.id=r.id;
      b.appendChild(el("strong","",rowTitle(r)));
      b.appendChild(el("span","",(r.company_name||r.company_code||"未设置")+" · BL "+(r.bl_no||"未设置")+" · "+([r.vessel,r.voyage].filter(Boolean).join(" / ")||"船名航次未设置")));
      box.appendChild(b);
    });
  }
  function td(tr,v){var c=document.createElement("td");text(c,v);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取舱单记录，当前填充率 未接入。"));text($("readyPill"),"未接入");return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [["舱单编号",r.shipment_no],["委托单位",r.company_name||r.company_code],["船公司",r.carrier],["船名航次",[r.vessel,r.voyage].filter(Boolean).join(" / ")],["提单号",r.bl_no],["装卸港",[r.pol,r.pod].filter(Boolean).join(" → ")],["发货人",r.shipper_name],["收货人",r.consignee_name],["通知人",r.notify_name],["状态",r.status]].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1]);body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);text($("readyPill"),"真实记录");
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var fields=(state.coverage&&state.coverage.header_fields)||[];
    if(!fields.length){box.appendChild(el("div","empty","未接入 · 缺字段清单，当前填充率 未接入。"));return}
    fields.forEach(function(f){var d=el("div","field"),b=el("b","",f.label),s=el("span","");if(f.state==="not_connected")text(s,"未接入 · 缺 customs_shipments."+f.name+"；当前填充率 未接入");else text(s,"customs_shipments."+f.name+" · "+f.filled+"/"+f.total+" · "+pct(f.filled,f.total));d.appendChild(b);d.appendChild(s);box.appendChild(d)});
  }
  function renderOutbox(){
    var box=$("outbox");clear(box);var ob=state.outbox||{};
    if(ob.state!=="ready"){var miss=(ob.missing_fields||[]).join("、")||"manifest_message_outbox";box.appendChild(el("p","bad","未接入"));box.appendChild(el("p","muted","缺待发表/字段："+miss+"；当前填充率 未接入。"));box.appendChild(el("p","muted","未接入条目不提供忽略；请人工确认建表后再保存待发。"));return}
    var drafts=ob.drafts||[];box.appendChild(el("p","muted","待发表已接入；保存动作只写 pending_send/blocked，不执行发送。"));
    if(!drafts.length){box.appendChild(el("div","empty","暂无待发报文。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    drafts.forEach(function(d){var tr=document.createElement("tr");td(tr,d.id);td(tr,d.channel);td(tr,d.status);td(tr,d.updated_at||d.created_at);body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
  }
  function renderPreview(){
    if(!state.preview){text($("preview"),"未接入 · 尚未生成报文；缺待发表 manifest_message_outbox 时不能落地，当前填充率 未接入。");text($("previewPill"),"未接入");return}
    text($("preview"),JSON.stringify(state.preview,null,2));text($("previewPill"),state.preview.status||"已生成");
  }
  function render(){renderMetrics();renderList();renderDetail();renderCoverage();renderOutbox();renderPreview()}
  async function load(){
    try{var d=await req("GET");state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage||null;state.outbox=d.outbox||null;state.generatedAt=d.generated_at;render()}
    catch(e){$("summary").textContent="读取失败";clear($("list"));$("list").appendChild(el("div","error",e.message))}
  }
  async function action(name){
    try{var d=await req("POST",{action:name});state.preview=d.message||d;await load();renderPreview();alert(name==="validate"?"校验完成，未落地。":"已落地待发，未发送。")}
    catch(e){state.preview=e.data||{error:e.message};renderPreview();alert(e.message)}
  }
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;var id=Number(b.dataset.id);state.selected=state.rows.find(function(r){return r.id===id})||state.selected;render()});
  $("reload").addEventListener("click",load);
  $("search").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  $("validate").addEventListener("click",function(){action("validate")});
  $("save").addEventListener("click",function(){action("save")});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"报文数据通道",url:location.pathname+location.search},location.origin);
  load();
})();
