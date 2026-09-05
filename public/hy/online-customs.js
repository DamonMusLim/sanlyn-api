(function(){
  "use strict";
  var API="/api/db/online-customs";
  var state={rows:[],selected:null,coverage:null,send:null};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(el){while(el.firstChild)el.removeChild(el.firstChild)}
  function text(el,v,fallback){el.textContent=v===null||v===undefined||v===""?(fallback||"未设置"):String(v)}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function pct(filled,total){if(!total)return "未接入";return Math.round(Number(filled||0)*1000/Number(total))/10+"%"}
  function money(v,currency){return v===null||v===undefined||v===""?"未接入":String(currency||"")+" "+Number(v).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:2})}
  async function api(q){
    var r=await fetch(API+(q?"?q="+encodeURIComponent(q):""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function fieldRate(fields){
    var ready=(fields||[]).filter(function(f){return f.state==="ready"});
    if(!ready.length)return "未接入";
    var total=ready.reduce(function(a,f){return a+Number(f.total||0)},0);
    var filled=ready.reduce(function(a,f){return a+Number(f.filled||0)},0);
    return pct(filled,total);
  }
  function renderMetrics(){
    var cov=state.coverage||{};
    text($("mRows"),cov.total_rows?cov.total_rows:"未接入");
    text($("mHeader"),fieldRate(cov.fields));
    text($("mItems"),fieldRate(cov.item_fields));
    text($("mSend"),"未接入");
    $("summary").textContent="v2026.08.26-1 · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function rowTitle(r){return r.declaration_no||("ID "+r.id)}
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 customs_declarations 真实记录，当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.id===state.selected.id?" active":""));
      b.type="button";b.dataset.id=r.id;
      b.appendChild(el("strong","",rowTitle(r)));
      b.appendChild(el("span","",(r.declaration_status||"未设置")+" · "+(r.trade_country||"未设置")+" → "+(r.arrive_country||"未设置")+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function td(tr,v){var c=document.createElement("td");text(c,v);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);
    var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取报关单记录，当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["报关单号",r.declaration_no],["报关状态",r.declaration_status],["贸易国/运抵国",[r.trade_country,r.arrive_country].filter(Boolean).join(" / ")],
      ["成交/运输/监管",[r.transaction_term,r.transport_mode,r.supervision_mode].filter(Boolean).join(" / ")],
      ["申报/放行日期",[r.declared_at,r.released_at].filter(Boolean).join(" / ")],
      ["报关行",r.broker],["经营单位",r.owner_company],["柜号",Array.isArray(r.container_nos)?r.container_nos.join(" / "):r.container_nos],
      ["明细行",r.line_count||"未接入"],["表头申报货值",money(r.total_declaration_amount,r.total_declaration_currency)],
      ["逐项申报货值",money(r.items_amount,r.total_declaration_currency)]
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1]);body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length){
      box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"("+x.name+")";}).join("、")));
    }
    text($("readyPill"),r.missing_count?"待补字段":"表头已填");
  }
  function addField(box,f,table){
    var d=el("div","field"),name=el("b","",f.label),meta=el("span","");
    if(f.state==="not_connected")text(meta,"未接入 · 缺 "+table+"."+f.name+"；当前填充率 未接入");
    else text(meta,table+"."+f.name+" · "+f.filled+"/"+f.total+" · "+pct(f.filled,f.total));
    d.appendChild(name);d.appendChild(meta);box.appendChild(d);
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var cov=state.coverage||{};
    var fields=(cov.fields||[]).map(function(f){return [f,"customs_declarations"]}).concat((cov.item_fields||[]).map(function(f){return [f,"customs_declaration_items"]}));
    if(!fields.length){box.appendChild(el("div","empty","未接入 · 缺字段清单，当前填充率 未接入。"));return}
    fields.forEach(function(pair){addField(box,pair[0],pair[1])});
  }
  function renderSendState(){
    var box=$("sendState");clear(box);var s=state.send||{};
    var missing=(s.missing_fields||[]).map(function(x){return x.label+"("+x.name+")";}).join("、");
    var rates=(s.fill_rates||[]).map(function(f){return f.name+" "+(f.state==="ready"?pct(f.filled,f.total):"未接入");}).join("；");
    box.appendChild(el("p","bad","未接入"));
    box.appendChild(el("p","muted",s.note||"在线报关通道尚未接入：需要单一窗口/第三方通道接口和通道凭证。"));
    box.appendChild(el("p","muted","当前页面只用于核对已入库报关单表头和逐项字段，不对外发送。"));
    box.appendChild(el("p","muted","启用发送需要 online_customs_status / online_customs_sent_at / online_customs_receipt_no 三列 + 通道凭证。"));
    box.appendChild(el("p","muted","缺字段："+(missing||"未设置")+"。当前填充率："+(rates||"未接入")+"。"));
    box.appendChild(el("p","muted","未接入条目不提供忽略，也不执行对外发送。"));
  }
  function render(){renderMetrics();renderList();renderDetail();renderCoverage();renderSendState()}
  async function load(){
    try{
      var d=await api($("search").value.trim());
      state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage||null;
      state.send=d.send_channel||null;state.generatedAt=d.generated_at;render();
    }catch(e){$("summary").textContent="读取失败";clear($("list"));$("list").appendChild(el("div","error",e.message))}
  }
  $("list").addEventListener("click",function(e){
    var b=e.target.closest(".row");if(!b)return;
    var id=Number(b.dataset.id);state.selected=state.rows.find(function(r){return r.id===id})||state.selected;render();
  });
  $("reload").addEventListener("click",load);
  $("search").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  $("sendBtn").addEventListener("click",function(){alert("在线报关通道尚未接入：缺单一窗口/第三方通道接口、通道凭证、online_customs_status / online_customs_sent_at / online_customs_receipt_no；当前页面只读核对，不对外发送。")});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"在线报关",url:location.pathname},location.origin);
  load();
})();
