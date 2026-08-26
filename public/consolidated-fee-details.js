(function(){
  var API="/api/db/consolidated-fee-details";
  var $=function(id){return document.getElementById(id);};
  var NF=new Intl.NumberFormat("zh-CN",{maximumFractionDigits:2});
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||sessionStorage.getItem("token")||"";}
  function set(el,v,empty){el.textContent=v===null||v===undefined||v===""?(empty||"未接入"):String(v);}
  function blank(v){return v===null||v===undefined||v==="";}
  function money(v,c){if(blank(v))return"未设置";var n=Number(v);return Number.isFinite(n)?((c?c+" ":"")+NF.format(n)):"未设置";}
  function pct(v){return v===null||v===undefined?"未接入":(Number(v).toFixed(1).replace(/\\.0$/,"")+"%");}
  function clear(el){while(el.firstChild)el.removeChild(el.firstChild);}
  function div(cls,text){var d=document.createElement("div");if(cls)d.className=cls;if(text!==undefined)d.textContent=text;return d;}
  function td(tr,text,cls){var c=document.createElement("td");if(cls)c.className=cls;set(c,text);tr.appendChild(c);return c;}
  function missingText(cov){var miss=(cov&&cov.missing_fields)||[];var rates=((cov&&cov.fields)||[]).map(function(f){return f.name+" "+pct(f.fill_rate_percent);}).join("；")||"填充率 未接入";return"未接入 · 缺 "+(miss.join("、")||"真实匹配行")+"；"+rates;}
  function postReady(){if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"集运费用明细",url:location.pathname+location.search},location.origin);}
  function query(){
    var p=new URLSearchParams();
    ["q","month","supplier","category","status"].forEach(function(id){var v=$(id).value.trim();if(v)p.set(id,v);});
    return p.toString();
  }
  async function api(){
    var h={};var t=token();if(t)h.Authorization="Bearer "+t;
    var r=await fetch(API+"?"+query(),{headers:h});
    var j=await r.json().catch(function(){return{success:false,error:"接口返回异常"};});
    if(!r.ok||j.success===false)throw new Error(j.error||("HTTP "+r.status));
    return j;
  }
  function renderCoverage(cov){
    var box=$("coverage");clear(box);
    if(!cov||!cov.fields||!cov.fields.length){box.appendChild(div("empty","未接入 · 缺 freight_supplier_bills 字段；当前填充率 未接入。"));return;}
    cov.fields.forEach(function(f){box.appendChild(div("pill",f.name+" "+f.filled+"/"+f.total+" · "+pct(f.fill_rate_percent)));});
    if(cov.missing_fields&&cov.missing_fields.length)box.appendChild(div("note","缺字段："+cov.missing_fields.join("、")));
  }
  function renderTotals(summary, connected){
    var box=$("totals");clear(box);
    if(!connected){box.appendChild(div("empty","未接入 · 缺 amount/currency 或真实明细行；当前填充率见上方。"));return;}
    if(!summary.currencies||!summary.currencies.length){box.appendChild(div("empty","未接入 · 金额或币种字段未填，当前填充率见上方。"));return;}
    summary.currencies.forEach(function(x){box.appendChild(div("pill",money(x.amount,x.currency)));});
  }
  function renderRows(rows, cov){
    var box=$("rows");clear(box);
    if(!rows||!rows.length){box.appendChild(div("empty",missingText(cov)));return;}
    var table=document.createElement("table");var thead=document.createElement("thead");var hr=document.createElement("tr");
    ["月份","供应商","BL/柜号","费目","数量","单价","金额","AP/AR","状态","来源"].forEach(function(h){var th=document.createElement("th");set(th,h);hr.appendChild(th);});
    thead.appendChild(hr);table.appendChild(thead);
    var tb=document.createElement("tbody");
    rows.forEach(function(r){
      var tr=document.createElement("tr");
      td(tr,r.bill_month);td(tr,[r.supplier,r.supplier_company_code].filter(Boolean).join(" / "));
      td(tr,[r.bl_no,r.container_no].filter(Boolean).join(" / "));
      td(tr,r.cost_category);td(tr,r.qty,"");td(tr,money(r.unit_price,r.currency));
      td(tr,money(r.amount,r.currency));td(tr,[money(r.ap_paid_amount,r.currency),money(r.ar_paid_amount,r.currency)].join(" / "));
      td(tr,[r.ap_status,r.rebill_status,r.reconciled===true?"已对平":""].filter(Boolean).join(" / "));
      td(tr,[r.bill_file,r.link_plan_id].filter(Boolean).join(" / "));
      tb.appendChild(tr);
    });
    table.appendChild(tb);box.appendChild(table);
  }
  function render(j){
    var connected=j.state==="ready";
    set($("stamp"),(j.version||"v2026.08.26-1")+" · 生成时间 "+new Date(j.generated_at).toLocaleString("zh-CN"));
    set($("mState"),connected?"已接入":"未接入");$("mState").className=connected?"num":"num warn";
    set($("mRows"),connected&&j.summary.row_count?j.summary.row_count:"未接入");
    set($("mBl"),connected&&j.summary.bl_count?j.summary.bl_count:"未接入");
    set($("mSup"),connected&&j.summary.suppliers?j.summary.suppliers:"未接入");
    renderCoverage(j.coverage);renderTotals(j.summary||{},connected);renderRows(j.rows,j.coverage);
  }
  async function load(){try{render(await api());}catch(e){set($("stamp"),"v2026.08.26-1 · 读取失败");["coverage","totals","rows"].forEach(function(id){$(id).replaceChildren(div("empty",e.message));});}}
  $("reload").onclick=load;$("search").onclick=load;
  ["q","month","supplier","category"].forEach(function(id){$(id).addEventListener("keydown",function(e){if(e.key==="Enter")load();});});
  $("status").onchange=load;postReady();load();
})();
