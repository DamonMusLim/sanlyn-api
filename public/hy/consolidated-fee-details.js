(function(){
  var API="/api/db/consolidated-fee-details";
  var $=function(id){return document.getElementById(id);};
  var NF=new Intl.NumberFormat("zh-CN",{maximumFractionDigits:2});
  function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||sessionStorage.getItem("token")||"";}
  function set(el,v,empty){el.textContent=v===null||v===undefined||v===""?(empty||"未接入"):String(v);}
  function blank(v){return v===null||v===undefined||v==="";}
  function money(v,c,empty){if(blank(v))return empty||"未记录";var n=Number(v);return Number.isFinite(n)?((c?c+" ":"")+NF.format(n)):(empty||"未记录");}
  function feeStatus(v){return {fee_recorded:"费用已录入",fee_completed:"费用已完成","费用已录入":"费用已录入","费用已完成":"费用已完成"}[v]||v;}
  function pct(v){return v===null||v===undefined?"未接入":(Number(v).toFixed(1).replace(/\\.0$/,"")+"%");}
  function clear(el){while(el.firstChild)el.removeChild(el.firstChild);}
  function div(cls,text){var d=document.createElement("div");if(cls)d.className=cls;if(text!==undefined)d.textContent=text;return d;}
  function td(tr,text,cls){var c=document.createElement("td");if(cls)c.className=cls;set(c,text);tr.appendChild(c);return c;}
  function missingText(cov){var miss=(cov&&cov.missing_fields)||[];var rates=((cov&&cov.fields)||[]).map(function(f){return f.name+" "+pct(f.fill_rate_percent);}).join("；")||"填充率 未接入";return"未接入 · 缺 "+(miss.join("、")||"真实匹配行")+"；"+rates;}
  function hasCol(src,name){return ((src&&src.tax_columns_present)||[]).indexOf(name)>=0;}
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
  function marginText(r){
    var m=r.ticket_margin;
    if(!r.bl_no)return{txt:"缺 bl_no，无法按票计算",bad:false};
    if(!m)return{txt:"未查到该票毛利汇总",bad:false};
    if(m.missing_sale_column)return{txt:"缺 sale_amount 列，毛利不可算",bad:false};
    var parts=(m.currencies||[]).map(function(x){
      if(!x.complete){
        var notes=[];
        if(x.unpriced_count)notes.push("含未定价行 "+x.unpriced_count+" 行");
        if(x.missing_cost_count)notes.push("含成本未录入行 "+x.missing_cost_count+" 行");
        return x.currency+" 毛利不完整（"+notes.join("；")+"）";
      }
      return money(x.profit,x.currency)+"（收入 "+money(x.sale_sum,x.currency)+" - 成本 "+money(x.cost_sum,x.currency)+"）";
    });
    var bad=(m.currencies||[]).some(function(x){return x.complete&&Number(x.profit)<0;});
    return{txt:parts.join("；")||"该票无可汇总币种",bad:bad};
  }
  function payText(r){
    function one(side,total,paid){
      var lines=[side+"已核销 "+money(paid,r.currency,"系统未记录")];
      if(blank(total))lines.push(side+"未核销：总额未记录，不能确认");
      else if(blank(paid))lines.push(side+"未核销：系统未记录收付金额，不能确认");
      else lines.push(side+"未核销 "+money(Number(total)-Number(paid),r.currency));
      return lines.join(" / ");
    }
    return one("AP",r.amount,r.ap_paid_amount)+"；"+one("AR",r.sale_amount,r.ar_paid_amount);
  }
  function taxText(r,src){
    var out=[];
    out.push(hasCol(src,"tax_rate")?("税率 "+money(r.tax_rate,null,"未录入")):"税率列不存在");
    out.push(hasCol(src,"tax_amount")?("税金 "+money(r.tax_amount,r.currency,"未录入")):"税金列不存在");
    out.push(hasCol(src,"total_price")?("不含税总价 "+money(r.total_price,r.currency,"未录入")):"不含税总价列不存在");
    return out.join(" / ");
  }
  function fxText(r){
    var fx=r.fx_snapshot;
    var rate=fx&&!blank(fx.rate)?("冻结汇率 "+fx.rate):"未冻结汇率";
    var meta=fx?[fx.date,fx.source].filter(Boolean).join(" · "):"";
    return "折本币总价无独立字段，未折算 / "+rate+(meta?"（"+meta+"）":"");
  }
  function partyText(r){
    var payer="委托单位 "+(r.payer_company_code||"未记录");
    var supplier="结算单位 "+(r.supplier||"未记录供应商文本");
    var code=r.supplier_company_code?("供应商码 "+r.supplier_company_code):"供应商未挂码(纯文本)";
    return payer+"；"+supplier+"；"+code;
  }
  function renderRows(rows, cov, src){
    var box=$("rows");clear(box);
    if(!rows||!rows.length){box.appendChild(div("empty",missingText(cov)));return;}
    box.appendChild(div("note",(src&&src.payment_time_note)||"系统尚未记录收付时间,这里是\"没有记录\"不是\"确认没核销\""));
    var table=document.createElement("table");var thead=document.createElement("thead");var hr=document.createElement("tr");
    ["月份","委托/结算单位","BL/柜号","费目","单票含税毛利","数量/单价","成本/售价","已核销/未核销","费用状态","税率/税金/不含税","折本币/汇率","状态/来源"].forEach(function(h){var th=document.createElement("th");set(th,h);hr.appendChild(th);});
    thead.appendChild(hr);table.appendChild(thead);
    var tb=document.createElement("tbody");
    rows.forEach(function(r){
      var margin=marginText(r);
      var tr=document.createElement("tr");
      td(tr,r.bill_month);td(tr,partyText(r));
      td(tr,[r.bl_no,r.container_no].filter(Boolean).join(" / "));
      td(tr,r.cost_category||"费目未记录");
      td(tr,margin.txt,margin.bad?"bad":"");
      td(tr,[money(r.qty,null,"数量未记录"),money(r.unit_price,r.currency,"单价未记录"),r.charge_basis].filter(Boolean).join(" / "));
      td(tr,["成本 "+money(r.amount,r.currency,"未记录"),"售价 "+money(r.sale_amount,r.currency,"未定价")].join(" / "));
      td(tr,payText(r));
      td(tr,feeStatus(r.fee_status)||"费用状态未记录");
      td(tr,taxText(r,src));
      td(tr,fxText(r));
      td(tr,[r.ap_status||"AP状态未记录",r.ar_status||"AR状态未记录",r.rebill_status||"账单状态未记录",r.reconciled===true?"已对平":"未记录对平",r.bill_file,r.link_plan_id].filter(Boolean).join(" / "));
      tb.appendChild(tr);
    });
    table.appendChild(tb);box.appendChild(table);
  }
  function render(j){
    var connected=j.state==="ready";
    set($("stamp"),(j.version||"v2026.09.05-1")+" · 生成时间 "+new Date(j.generated_at).toLocaleString("zh-CN"));
    set($("mState"),connected?"已接入":"未接入");$("mState").className=connected?"num":"num warn";
    set($("mRows"),connected&&j.summary.row_count?j.summary.row_count:"未接入");
    set($("mBl"),connected&&j.summary.bl_count?j.summary.bl_count:"未接入");
    set($("mSup"),connected&&j.summary.suppliers?j.summary.suppliers:"未接入");
    renderCoverage(j.coverage);renderTotals(j.summary||{},connected);renderRows(j.rows,j.coverage,j.source||{});
  }
  async function load(){try{render(await api());}catch(e){set($("stamp"),"v2026.09.05-1 · 读取失败");["coverage","totals","rows"].forEach(function(id){$(id).replaceChildren(div("empty",e.message));});}}
  $("reload").onclick=load;$("search").onclick=load;
  ["q","month","supplier","category"].forEach(function(id){$(id).addEventListener("keydown",function(e){if(e.key==="Enter")load();});});
  $("status").onchange=load;postReady();load();
})();
