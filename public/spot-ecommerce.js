(function(){
  "use strict";
  var API="/api/db/spot-ecommerce";
  var state={rows:[],selected:null,coverage:null,channel:null,generatedAt:null};
  var $=function(id){return document.getElementById(id)};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
  function clear(x){while(x.firstChild)x.removeChild(x.firstChild)}
  function text(x,v,fallback){x.textContent=v===null||v===undefined||v===""?(fallback||"未设置"):String(v)}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x}
  function pct(filled,total){if(!total)return "未接入";return Math.round(Number(filled||0)*1000/Number(total))/10+"%"}
  function fields(){return ((state.coverage&&state.coverage.fields)||[]).concat((state.coverage&&state.coverage.online_fields)||[])}
  function field(name){return fields().find(function(f){return f.name===name})||null}
  function fieldRate(names){
    var fs=names.map(field).filter(Boolean).filter(function(f){return f.state==="ready"});
    if(!fs.length)return "未接入";
    var total=fs.reduce(function(a,f){return a+Number(f.total||0)},0),filled=fs.reduce(function(a,f){return a+Number(f.filled||0)},0);
    return pct(filled,total);
  }
  async function api(){
    var p=new URLSearchParams(),q=$("search").value.trim(),st=$("state").value;
    if(q)p.set("q",q);if(st)p.set("state",st);
    var r=await fetch(API+(p.toString()?"?"+p.toString():""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"}});
    if(r.status===401)throw new Error("需要登录");
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function stateLabel(s){return {ready:"基础字段已填",not_connected:"未接入",no_online:"缺线上价",needs_price:"缺门店价",stock_risk:"库存预警"}[s]||"待核"}
  function renderMetrics(){
    var cov=state.coverage||{};
    text($("mRows"),cov.total_rows?cov.total_rows:"未接入");
    text($("mMt"),fieldRate(["mt_price"]));
    text($("mEle"),fieldRate(["ele_price"]));
    text($("mChannel"),"未接入");
    $("summary").textContent="v2026.08.26-1 · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function money(v){return v===null||v===undefined||v===""?"未设置":String(v)}
  function rowTitle(r){return r.product_name||r.product_code||"未接入"}
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),state.rows.length?state.rows.length:"未接入");
    if(!state.rows.length){box.appendChild(el("div","empty","未接入 · 缺 petstore_ops_row 真实记录；当前填充率 未接入。"));return}
    state.rows.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.product_code===state.selected.product_code?" active":""));
      b.type="button";b.dataset.code=r.product_code||"";
      b.appendChild(el("strong","",rowTitle(r)));
      b.appendChild(el("span","","编码 "+(r.product_code||"未接入")+" · 分类 "+(r.category||"未设置")+" · 条码 "+(r.barcode||"未设置")));
      b.appendChild(el("span","","门店价 "+money(r.store_price)+" · 美团 "+money(r.mt_price)+" · 饿了么 "+money(r.ele_price)+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function td(tr,v){var c=document.createElement("td");text(c,v);tr.appendChild(c)}
  function renderDetail(){
    var box=$("detail");clear(box);var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺可读取 petstore_ops_row 记录；当前填充率 未接入。"));return}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [["商品编码",r.product_code],["商品名称",r.product_name],["分类/规格",[r.category,r.spec_text].filter(Boolean).join(" / ")],["条码",r.barcode],["门店价/成本价",[money(r.store_price),money(r.cost_price)].join(" / ")],["美团/饿了么",[money(r.mt_price),money(r.ele_price)].join(" / ")],["线上原价/活动价",[money(r.online_original_price),money(r.online_activity_price)].join(" / ")],["竞店价/竞店",[money(r.market_price),r.market_store||"未设置"].join(" / ")],["库存/可售天数",[money(r.cur_stock),money(r.days_of_supply)].join(" / ")],["效期剩余/货架位",[money(r.days_left),r.shelf_code||"未设置"].join(" / ")],["补货判断",r.restock_verdict]].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1]);body.appendChild(tr)});
    table.appendChild(body);box.appendChild(table);
    if(r.warnings&&r.warnings.length)box.appendChild(el("p","bad","真实业务预警："+r.warnings.join("、")));
    if(r.missing&&r.missing.length)box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.label+"(petstore_ops_row."+x.name+")";}).join("、")));
    $("statePill").className="pill "+(r.state==="ready"?"":(r.state==="not_connected"?"bad":"warn"));text($("statePill"),stateLabel(r.state));
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);var fs=fields();
    if(!fs.length){box.appendChild(el("div","empty","未接入 · 缺字段清单；当前填充率 未接入。"));return}
    fs.forEach(function(f){var d=el("div","field"),b=el("b","",f.label),m=el("span","");
      if(f.state==="not_connected")text(m,"未接入 · 缺 petstore_ops_row."+f.name+"；当前填充率 未接入");
      else text(m,"petstore_ops_row."+f.name+" · "+f.filled+"/"+f.total+" · "+pct(f.filled,f.total));
      d.appendChild(b);d.appendChild(m);box.appendChild(d);
    });
  }
  function renderChannel(){
    var box=$("channelState");clear(box);
    box.appendChild(el("p","bad","未接入"));
    box.appendChild(el("p","muted",(state.channel&&state.channel.note)||"缺SPOT电商外部上架、订单回流和履约回执字段；本页只读。"));
    box.appendChild(el("p","muted","缺字段：spot_listing_status、spot_order_no、spot_fulfillment_receipt。当前填充率：未接入。"));
    box.appendChild(el("p","muted","未接入条目不提供忽略，也不会发布商品、改价或同步库存。"));
  }
  function render(){renderMetrics();renderList();renderDetail();renderCoverage();renderChannel()}
  async function load(){try{var d=await api();state.rows=d.data||[];state.selected=d.selected||state.rows[0]||null;state.coverage=d.coverage||null;state.channel=d.channel||null;state.generatedAt=d.generated_at;render()}catch(e){$("summary").textContent="读取失败";clear($("list"));$("list").appendChild(el("div","error",e.message))}}
  $("list").addEventListener("click",function(e){var b=e.target.closest(".row");if(!b)return;state.selected=state.rows.find(function(r){return String(r.product_code||"")===b.dataset.code})||state.selected;render()});
  $("reload").addEventListener("click",load);$("search").addEventListener("keydown",function(e){if(e.key==="Enter")load()});$("state").addEventListener("change",load);
  $("pushBtn").addEventListener("click",function(){alert("SPOT通道未接入：缺 spot_listing_status / spot_order_no / spot_fulfillment_receipt 和外部平台凭证；当前页面只读。")});
  $("openWb").addEventListener("click",function(){var url="/spot-ecommerce";if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",title:"SPOT电商",url:url},location.origin);else window.open("/wb-tabs?open="+encodeURIComponent(url),"_blank","noopener")});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"SPOT电商",url:location.pathname},location.origin);
  load();
})();
