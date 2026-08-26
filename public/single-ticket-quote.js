(function(){
  var $=function(id){return document.getElementById(id);};
  var NF=new Intl.NumberFormat("zh-CN",{maximumFractionDigits:2});
  function token(){return localStorage.getItem("token")||localStorage.getItem("sanlyn_token")||sessionStorage.getItem("token")||"";}
  function text(el,v){el.textContent=v==null||v===""?"未接入":String(v);}
  function blank(v){return v===null||v===undefined||v==="";}
  function fmt(v){return blank(v)?"未接入":String(v);}
  function money(v){return blank(v)?"未设置":NF.format(Number(v));}
  function pct(v){return v===null||v===undefined?"未接入":Number(v).toFixed(1).replace(/\.0$/,"")+"%";}
  function kv(name,value){var d=document.createElement("div");d.className="kv";var a=document.createElement("span");var b=document.createElement("span");text(a,name);text(b,value);d.append(a,b);return d;}
  function clear(el){while(el.firstChild)el.removeChild(el.firstChild);}
  function empty(msg){var d=document.createElement("div");d.className="empty";d.textContent=msg;return d;}
  function postReady(){if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"单票报价",url:location.pathname+location.search},location.origin);}
  function fillMetrics(j){
    text($("mTicket"),pct(j.coverage&&j.coverage.ticket&&j.coverage.ticket.fill_rate));
    text($("mLines"),j.coverage&&j.coverage.line_items&&j.coverage.line_items.rows?j.coverage.line_items.rows:"未接入");
    text($("mRates"),j.coverage&&j.coverage.rates&&j.coverage.rates.rows?j.coverage.rates.rows:"未接入");
  }
  function drawTicket(plan){
    var box=$("ticket");clear(box);
    [["BL",plan.bl_no],["订舱号",plan.shipment_no],["订单号",(plan.order_nos||plan.contract_nos||[]).join(", ")],["客户",plan.customer_cn||plan.customer_en||plan.customer||plan.company_code],["航线",[plan.pol,plan.pod].filter(Boolean).join(" → ")],["船公司",plan.carrier_code],["箱型/柜量",[plan.container_type,plan.container_qty].filter(Boolean).join(" / ")],["ETD",plan.etd]].forEach(function(x){box.appendChild(kv(x[0],x[1]));});
  }
  function drawCoverage(cov){
    var box=$("coverage");clear(box);
    if(!cov){box.appendChild(empty("未接入 · 缺 coverage 统计，当前填充率 未接入。"));return;}
    box.appendChild(kv("shipping_plans",pct(cov.ticket&&cov.ticket.fill_rate)));
    box.appendChild(kv("order_line_items",cov.line_items&&cov.line_items.rows?("已接入 "+cov.line_items.rows+" 行"):"未接入 · 缺可匹配 order_id，当前填充率 未接入"));
    box.appendChild(kv("freight_rates",cov.rates&&cov.rates.rows?("已接入 "+cov.rates.rows+" 行"):"未接入 · 缺 pol/pod 匹配价表，当前填充率 未接入"));
  }
  function drawQuote(q){
    var box=$("quoteFields");clear(box);var ready=0;
    (q.plan_fields||[]).forEach(function(f){var d=document.createElement("div");d.className="field";var b=document.createElement("b");var s=document.createElement("span");text(b,{freight_sale_usd:"海运卖价 USD",freight_sale_cny:"海运卖价 CNY",customs_cost_total:"报关费",trucking_cost_total:"拖车费"}[f.name]||f.name);text(s,f.state==="ready"?money(f.value):"未设置 · 缺 shipping_plans."+f.name);d.append(b,s);box.appendChild(d);if(f.state==="ready")ready++;});
    text($("mQuote"),ready?("已设置 "+ready+" 项"):"未设置");
  }
  function drawRates(rows){
    var box=$("rates");clear(box);
    if(!rows||!rows.length){box.appendChild(empty("未接入 · 缺 freight_rates 中当前 POL/POD 的有效客户价，当前填充率 未接入。"));return;}
    var table=document.createElement("table");var thead=document.createElement("thead");var tr=document.createElement("tr");
    ["船公司","货代","航线","20GP客户价","40HQ客户价","船期"].forEach(function(h){var th=document.createElement("th");text(th,h);tr.appendChild(th);});thead.appendChild(tr);table.appendChild(thead);
    var tb=document.createElement("tbody");rows.forEach(function(r){var row=document.createElement("tr");[r.carrier,r.forwarder,[r.route_code,r.via].filter(Boolean).join(" / "),money(r.customer_gp20),money(r.customer_hq40),r.next_sailing].forEach(function(v){var td=document.createElement("td");text(td,v);row.appendChild(td);});tb.appendChild(row);});table.appendChild(tb);box.appendChild(table);
  }
  function drawLines(rows){
    var box=$("lines");clear(box);
    if(!rows||!rows.length){box.appendChild(empty("未接入 · 缺 order_line_items 可匹配明细，当前填充率 未接入。"));return;}
    var table=document.createElement("table");var head=document.createElement("tr");
    ["品名","SKU","箱数","毛重","CBM","工厂金额"].forEach(function(h){var th=document.createElement("th");text(th,h);head.appendChild(th);});var thead=document.createElement("thead");thead.appendChild(head);table.appendChild(thead);
    var tb=document.createElement("tbody");rows.forEach(function(r){var tr=document.createElement("tr");[r.product_name,r.sku,r.qty_ctn,r.gw_kg,r.cbm,money(r.factory_subtotal)].forEach(function(v){var td=document.createElement("td");text(td,v);tr.appendChild(td);});tb.appendChild(tr);});table.appendChild(tb);box.appendChild(table);
  }
  async function load(){
    var q=$("q").value.trim();if(!q){$("ticket").replaceChildren(empty("请输入 BL / 订舱号 / 订单号 / 票ID"));return;}
    $("sub").textContent="加载中";
    try{
      var r=await fetch("/api/db/single-ticket-quote?q="+encodeURIComponent(q),{headers:{Authorization:"Bearer "+token()}});
      var j=await r.json();if(!r.ok||!j.success)throw new Error(j.error||("HTTP "+r.status));
      if(j.state==="not_connected"){throw new Error("未接入 · 缺 "+(j.missing||"真实表")+"，当前填充率 未接入。");}
      fillMetrics(j);text($("state"),"已读取");drawTicket(j.data.plan||{});drawCoverage(j.coverage);drawQuote(j.data.quote||{});drawRates((j.data.quote||{}).freight_rate_matches||[]);drawLines(j.data.line_items||[]);
      $("sub").textContent="版本 v2026.08.26-1 · 生成时间 "+new Date(j.generated_at).toLocaleString("zh-CN");
    }catch(e){$("sub").textContent="读取失败";text($("state"),"未接入");["ticket","coverage","quoteFields","rates","lines"].forEach(function(id){$(id).replaceChildren(empty(e.message));});}
  }
  $("load").onclick=load;$("q").addEventListener("keydown",function(e){if(e.key==="Enter")load();});
  var init=new URLSearchParams(location.search).get("q")||"";if(init){$("q").value=init;load();}else $("ticket").appendChild(empty("请输入查询条件。零数据不会显示 0。"));
  postReady();
})();
