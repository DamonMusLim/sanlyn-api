(function(){
  "use strict";
  var API="/api/db/warehouse-info";
  var state={warehouses:[],selected:null,coverage:null,notConnected:[],generatedAt:null,metrics:null};
  var $=function(id){return document.getElementById(id);};
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||"";}
  function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h;}
  function clear(el){while(el.firstChild)el.removeChild(el.firstChild);}
  function text(el,v,fallback){el.textContent=v===null||v===undefined||v===""?(fallback||"未设置"):String(v);}
  function el(tag,cls,txt){var x=document.createElement(tag);if(cls)x.className=cls;if(txt!==undefined)text(x,txt);return x;}
  function pct(filled,total){if(!total)return "未接入";return Math.round(Number(filled||0)*1000/Number(total))/10+"%";}
  function displayCount(v){return Number(v)>0?Number(v):"未接入";}
  function allFields(){var c=state.coverage||{};return [].concat(c.warehouses||[],c.finished_goods_inventory||[],c.inventory_logs||[]);}
  async function api(q){
    var r=await fetch(API+(q?"?q="+encodeURIComponent(q):""),{headers:headers()});
    var d=await r.json().catch(function(){return {success:false,error:"接口返回异常"};});
    if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
    return d;
  }
  function renderMetrics(){
    var m=state.metrics||{};
    text($("mWarehouses"),displayCount(m.warehouse_count));
    text($("mSkus"),displayCount(m.sku_count));
    text($("mLogs"),displayCount(m.log_count));
    text($("mMissing"),state.warehouses.length?state.warehouses.reduce(function(a,r){return a+Number(r.missing_count||0);},0):"未接入");
    $("summary").textContent="版本 v2026.08.26-1 · 生成时间 "+new Date(state.generatedAt||Date.now()).toLocaleString("zh-CN");
  }
  function title(r){return r.name||r.code||("仓库ID "+r.id);}
  function renderList(){
    var box=$("list");clear(box);text($("listCount"),displayCount(state.warehouses.length));
    if(!state.warehouses.length){box.appendChild(el("div","empty","未接入 · 缺 warehouses 可读取记录；当前填充率 未接入。"));return;}
    state.warehouses.forEach(function(r){
      var b=el("button","row"+(state.selected&&r.id===state.selected.id?" active":""));
      b.type="button";b.dataset.id=r.id;
      b.appendChild(el("strong","",title(r)));
      b.appendChild(el("span","",(r.code||"未设置")+" · SKU "+(Number(r.sku_count)>0?r.sku_count:"未接入")+" · 缺字段 "+(r.missing_count||"无")));
      box.appendChild(b);
    });
  }
  function td(tr,v){var c=document.createElement("td");text(c,v);tr.appendChild(c);}
  function renderDetail(){
    var box=$("detail");clear(box);
    var r=state.selected;
    if(!r){box.appendChild(el("div","empty","未接入 · 缺 warehouses/finished_goods_inventory 真实记录；当前填充率 未接入。"));text($("readyPill"),"未接入");return;}
    var table=document.createElement("table"),body=document.createElement("tbody");
    [
      ["仓库编码",r.code],["仓库名称",r.name],["地址",r.address],["联系人",r.contact_name],
      ["联系电话",r.contact_phone],["状态",r.status],["库存SKU",Number(r.sku_count)>0?r.sku_count:null],
      ["当前库存合计",r.current_stock_sum],["安全库存合计",r.safety_stock_sum],["最近流水时间",r.last_move_at],
    ].forEach(function(pair){var tr=document.createElement("tr");td(tr,pair[0]);td(tr,pair[1]);body.appendChild(tr);});
    table.appendChild(body);box.appendChild(table);
    if(r.missing&&r.missing.length){
      box.appendChild(el("p","muted","缺字段："+r.missing.map(function(x){return x.table+"."+x.name+"("+x.label+")";}).join("、")));
    }
    text($("readyPill"),r.missing_count?"待补字段":"字段已填");
  }
  function renderStock(){
    var box=$("stock");clear(box);
    var rows=(state.selected&&state.selected.stock)||[];
    text($("stockCount"),displayCount(rows.length));
    if(!rows.length){box.appendChild(el("div","empty","未接入 · 缺 finished_goods_inventory 库存记录；当前填充率 未接入。"));return;}
    var table=document.createElement("table"),head=document.createElement("thead"),body=document.createElement("tbody");
    var hr=document.createElement("tr");["SKU","单位","当前库存","安全库存","工厂码","最近变动"].forEach(function(h){var th=document.createElement("th");text(th,h);hr.appendChild(th);});
    head.appendChild(hr);table.appendChild(head);
    rows.forEach(function(r){var tr=document.createElement("tr");[r.sku,r.unit,r.current_stock,r.safety_stock,r.factory_code,r.last_move_at].forEach(function(v){td(tr,v);});body.appendChild(tr);});
    table.appendChild(body);box.appendChild(table);
  }
  function renderCoverage(){
    var box=$("coverage");clear(box);
    var fields=allFields();
    if(!fields.length){box.appendChild(el("div","empty","未接入 · 缺字段清单；当前填充率 未接入。"));return;}
    fields.forEach(function(f){
      var d=el("div","field"),name=el("b","",f.label),meta=el("span","");
      if(f.state==="not_connected")text(meta,"未接入 · 缺 "+f.table+"."+f.name+"；当前填充率 未接入");
      else if(!Number(f.total))text(meta,"未接入 · 缺 "+f.table+" 可读取记录；当前填充率 未接入");
      else text(meta,f.table+"."+f.name+" · "+f.filled+"/"+f.total+" · "+pct(f.filled,f.total));
      d.appendChild(name);d.appendChild(meta);box.appendChild(d);
    });
  }
  function renderNotConnected(){
    var box=$("notConnected");clear(box);
    var missing=allFields().filter(function(f){return f.state==="not_connected";}).map(function(f){return f.table+"."+f.name;});
    if(state.notConnected.length) box.appendChild(el("p","bad",state.notConnected.join("；")));
    box.appendChild(el("p","muted","未接入类条目不提供忽略操作，也不写任何财务或库存事实表。"));
    box.appendChild(el("p","muted","缺字段："+(missing.join("、")||"无缺表字段")+"。当前填充率："+(missing.length?"未接入":"见上方字段卡片")+"。"));
  }
  function render(){renderMetrics();renderList();renderDetail();renderStock();renderCoverage();renderNotConnected();}
  async function load(){
    try{
      var d=await api($("search").value.trim());
      state.warehouses=d.warehouses||[];state.selected=d.selected||state.warehouses[0]||null;state.coverage=d.coverage||null;
      state.notConnected=d.not_connected||[];state.generatedAt=d.generated_at;state.metrics=d.metrics||null;render();
    }catch(e){$("summary").textContent="读取失败";clear($("list"));$("list").appendChild(el("div","error",e.message));}
  }
  $("list").addEventListener("click",function(e){
    var b=e.target.closest(".row");if(!b)return;
    var id=Number(b.dataset.id);state.selected=state.warehouses.find(function(r){return Number(r.id)===id;})||state.selected;render();
  });
  $("reload").addEventListener("click",load);
  $("search").addEventListener("keydown",function(e){if(e.key==="Enter")load();});
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"仓储信息",url:location.pathname},location.origin);
  load();
})();
