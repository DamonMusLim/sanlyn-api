(function(){
  "use strict";
  var API="/api/db/ams-send";
  var state={rows:[],selected:null,coverage:null,send:null,generatedAt:null};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(el){while(el.firstChild)el.removeChild(el.firstChild)}
  function text(el,v,fallback){el.textContent=v===null||v===undefined||v===""?(fallback||"未设置"):String(v)}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function pct(filled,total){if(!total)return "未接入";return Math.round(Number(filled||0)*1000/Number(total))/10+"%"}
  async function api(q,id){
    var p=new URLSearchParams();if(q)p.set("q",q);if(id)p.set("id",id);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
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
    text($("mPlan"),fieldRate(cov.fields));
    text($("mParty"),fieldRate(cov.party_fields));
    text($("mSend"),"未接入");
    $("summary").textContent="生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function rowTitle(r){return r.shipment_no||r.bl_no||r.so_no||("ID "+r.id)}
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺可识别美线 shipping_plans 记录，当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&String(r.id)===String(state.selected.id)?" active":""));
      b.type="button";b.dataset.id=r.id;
      b.appendChild(el("strong","",rowTitle(r)));
      b.appendChild(el("span","",([r.carrier_code,r.vessel,r.voyage].filter(Boolean).join(" / ")||"未设置")+" · "+([r.pol,r.pod].filter(Boolean).join(" → ")||"航线未设置")+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function td(tr,v){var c=document.createElement("td");text(c,v);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);
    var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取美线船期记录，当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [["订舱号",r.shipment_no],["SO号",r.so_no],["提单号",r.bl_no],["船公司",r.carrier_code],["船名航次",[r.vessel,r.voyage].filter(Boolean).join(" / ")],["航线",[r.pol,r.pod].filter(Boolean).join(" → ")],["ETD/ETA",[r.etd,r.eta].filter(Boolean).join(" / ")],["收货地/目的地",[r.place_of_receipt,r.final_destination].filter(Boolean).join(" / ")],["发货人",r.shipper_name],["收货人",r.consignee_name],["通知人",r.notify_name],["舱单明细行",r.line_count?"真实记录 "+r.line_count:"未接入"]].forEach(function(pair){
      var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1]);body.appendChild(tr);
    });
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length)box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"("+x.name+")";}).join("、")));
    text($("readyPill"),r.missing_count?"待补字段":"基础字段已填");
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);
    var fields=[].concat((state.coverage&&state.coverage.fields)||[],(state.coverage&&state.coverage.party_fields)||[]);
    if(!fields.length){box.appendChild(el("div","empty","未接入 · 缺字段清单，当前填充率 未接入。"));return}
    fields.forEach(function(f){
      var d=el("div","field"),name=el("b","",f.label),meta=el("span","");
      if(f.state==="not_connected")text(meta,"未接入 · 缺字段 "+f.name+"；当前填充率 未接入");
      else text(meta,f.name+" · "+f.filled+"/"+f.total+" · "+pct(f.filled,f.total));
      d.appendChild(name);d.appendChild(meta);box.appendChild(d);
    });
  }
  function renderSendState(){
    var box=$("sendState");clear(box);
    var s=state.send||{}, missing=(s.missing_fields||[]).map(function(x){return x.label+"("+x.name+")";}).join("、");
    var rates=((state.coverage&&state.coverage.send_fields)||[]).map(function(f){return f.name+" "+(f.state==="ready"?pct(f.filled,f.total):"未接入");}).join("；");
    box.appendChild(el("p","bad","未接入"));
    box.appendChild(el("p","muted",s.note||"缺AMS/ABI或第三方申报通道接口、通道凭证、发送状态字段和回执字段。"));
    box.appendChild(el("p","muted","当前页面只用于核对美线船期、收发通和舱单明细字段是否齐全，为将来发送做准备。"));
    box.appendChild(el("p","muted","缺字段："+(missing||"ams_send_status / ams_sent_at / ams_receipt_no")+"。当前填充率："+(rates||"未接入")+"。"));
    box.appendChild(el("p","muted","未接入条目不提供忽略，也不执行对外发送。"));
  }
  function render(){renderMetrics();renderList();renderDetail();renderCoverage();renderSendState()}
  async function load(id){
    try{
      var d=await api($("search").value.trim(),id);
      state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage||null;
      state.send=d.send_channel||null;state.generatedAt=d.generated_at;render();
    }catch(e){$("summary").textContent="读取失败";clear($("list"));$("list").appendChild(el("div","error",e.message))}
  }
  $("list").addEventListener("click",function(e){
    var b=e.target.closest(".row");if(!b)return;
    var id=b.dataset.id;state.selected=state.rows.find(function(r){return String(r.id)===String(id)})||state.selected;load(id);
  });
  $("reload").addEventListener("click",function(){load()});
  $("search").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  $("sendBtn").addEventListener("click",function(){alert("AMS发送通道尚未对接：缺AMS/ABI或第三方申报接口、通道凭证、ams_send_status / ams_sent_at / ams_receipt_no 三列；当前页面只做数据核对。")});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"AMS发送",url:location.pathname},location.origin);
  load();
})();
