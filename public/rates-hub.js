var VERSION="v2026.08.29-1";
var state={tab:"ocean",expanded:{},data:{ocean:[],ocean_plans:[],ocean_bills:[],tariff:[],matrices:[],matrix_items:[],local:[],truck:[],truck_legacy:[],customs:[],insurance:[]},count:{}};
var cols={
  ocean:[["pol","起运港"],["pod","目的港"],["carrier","船公司"],["forwarder","货代"],["currency","币种"],["gp20","20GP成本","num","money"],["hq40","40HQ成本","num","money"],["customer_gp20","20GP客户价","num","money"],["customer_hq40","40HQ客户价","num","money"],["margin20","20GP毛差","num","margin20"],["margin40","40HQ毛差","num","margin40"],["valid","有效期"],["status","状态","status"],["remarks","备注"]],
  ocean_plans:[["bl_no","提单号"],["pol","起运港"],["pod","目的港"],["carrier_code","船公司"],["forwarder_cn","货代"],["container_type","箱型"],["container_qty","柜量","num"],["etd","开航"],["freight_cost","成本","num","money"],["freight_cost_currency","成本币种"],["freight_sale_usd","卖价","num","money"],["actual_margin","毛差","num","actual_margin"],["shipment_no","订舱号"]],
  ocean_bills:[["bl_no","提单号"],["cost_category","费目"],["currency","币种"],["amount","成本","num","money"],["sale_amount","转客户价","num","money"],["supplier","供应商"],["bill_month","账单月"],["fee_status","费用状态","fee_status"],["remarks","备注"]],
  tariff:[["carrier","船公司"],["port","港口"],["container_type","箱型"],["fee","费目"],["amount_cny","金额CNY","num","money"],["unit_basis","计费单位"],["flag","必收/条件","flag"],["station_name","场站"],["valid","有效期"],["review_status","审核"]],
  matrices:[["code","套餐"],["carrier_code","船公司"],["pol","起运港"],["pod","目的港"],["bl_type","提单"],["free_days_origin","起运免堆","num"],["free_days_dest","目的免堆","num"],["total_cost_20gp","20GP合计","num","money"],["total_cost_40hq","40HQ合计","num","money"],["cost_currency","币种"],["is_active","启用","bool"],["valid","有效期"]],
  matrix_items:[["matrix_code","套餐"],["charge_name","费目"],["container_type","箱型"],["unit_price","单价","num","money"],["qty","数量","num"],["amount","金额","num","money"],["currency","币种"],["unit","单位"],["is_required","必收","bool"]],
  local:[["carrier","船公司"],["pol","起运港"],["pod","目的港"],["company_name","公司"],["container_type","箱型"],["charge_name","费目"],["amount","金额","num","money"],["currency","币种"],["cost_total","成本合计","num","money"],["sell_total","销售合计","num","money"],["markup_cny","加价","num","money"],["free_time","免箱期","free"],["valid","有效期"],["is_active","启用","bool"]],
  truck:[["factory_name","工厂"],["pol","起运港"],["pod","目的港"],["container_type","箱型"],["tier","轻重档","tier"],["rate","价格","num","money"],["currency","币种"],["unit","单位"],["valid","有效期"],["is_active","启用","bool"]],
  customs:[["vendor_cn","报关行"],["pol","口岸"],["base_fee","基础费","num","money"],["max_free_descs","含品名数","num"],["extra_per_desc","超品名加收","num","money"],["billing_rule","计费规则"],["currency","币种"],["notes","备注"],["valid","有效期"]],
  insurance:[["bl_no","提单号"],["pol","起运港"],["pod","目的港"],["insured_name","被保险人"],["policyholder_name","投保人"],["insurance_rate","费率","rate"],["markup_pct","加成","markup"],["invoice_amount","发票金额","num","money"],["insured_amount","保额","num","money"],["check","保额校验"],["currency","币种"],["status","状态"],["insurance_policy_no","保单号"],["insurance_cost","保费","num","money"],["etd","ETD"],["vessel_voyage","船名航次"]]
};
var required={
  ocean:["pol","pod","carrier","forwarder","gp20","hq40","valid_to"],
  ocean_plans:["bl_no","pol","pod","carrier_code","freight_cost","freight_cost_currency","freight_sale_usd"],
  ocean_bills:["bl_no","cost_category","currency","amount","supplier","bill_month"],
  tariff:["carrier","port","container_type","charge_item_name","amount_cny","unit_basis"],
  matrices:["code","carrier_code","pol","pod","total_cost_20gp","total_cost_40hq","cost_currency"],
  local:["carrier","pol","pod","company_name","charge_name","amount","currency"],
  truck:["factory_name","pol","container_type","tier","rate","currency","unit"],
  customs:["vendor_cn","pol","base_fee","max_free_descs","extra_per_desc","currency"],
  insurance:["bl_no","insured_name","policyholder_name","invoice_amount","insured_amount","insurance_rate"]
};
function $(id){return document.getElementById(id);}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];});}
function blank(v){return v===null||v===undefined||v==="";}
function cell(v){return blank(v)?'<span class="na">未设置</span>':esc(v);}
function attr(v){return esc(v).replace(/'/g,"&#39;");}
function openWorkbenchTab(title,url){if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",title:title,url:url},location.origin);else window.open("/wb-tabs?open="+encodeURIComponent(url),"_blank","noopener");}
function money(v){if(blank(v))return '<span class="na">未设置</span>';var n=Number(v);return Number.isFinite(n)?n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2}):esc(v);}
function diff(a,b){if(blank(a)||blank(b))return null;var n=Number(a)-Number(b);return Number.isFinite(n)?n:null;}
function validText(r){var a=r.valid_from||"",b=r.valid_to||r.valid_until||"";return (a||"")+(a||b?" ~ ":"")+(b||"");}
function expired(r){var d=r.valid_to||r.valid_until;return d && d < new Date().toISOString().slice(0,10);}
function feeName(r){return [r.charge_item_code,r.charge_item_name].filter(Boolean).join(" · ");}
function flagText(r){return r.required_flag?"必收":(r.conditional_flag?"条件":"未设置");}
function freeText(v){if(blank(v))return "";if(typeof v==="object")return JSON.stringify(v);return v;}
function statusText(v){return v==="draft"?"草稿":(v||"");}
function feeStatusText(v){return {fee_recorded:"费用已录入",fee_completed:"费用已完成","费用已录入":"费用已录入","费用已完成":"费用已完成"}[v]||v;}
function tierText(v){return {light:"轻柜",heavy:"重柜",xheavy:"超重柜"}[v]||v;}
function ruleText(r){if(blank(r.base_fee)||blank(r.max_free_descs)||blank(r.extra_per_desc))return "";return r.base_fee+"元含"+r.max_free_descs+"个品名，超出每个+"+r.extra_per_desc+"元";}
function rateText(v){if(blank(v))return "";var n=Number(v)*100;return Number.isFinite(n)?n.toFixed(2).replace(/\.?0+$/,"")+"%":v;}
function markupText(v){if(blank(v))return "";var n=Number(v);return Number.isFinite(n)?n+"%(发票额×"+(n/100).toFixed(2).replace(/\.?0+$/,"")+")":v;}
function checkText(r){if(blank(r.insured_amount)||blank(r.invoice_amount)||blank(r.markup_pct))return '<span class="na">未接入：缺 insured_amount / invoice_amount / markup_pct；当前填充率 '+fillRate([r],["insured_amount","invoice_amount","markup_pct"])+"</span>";var want=Number(r.invoice_amount)*Number(r.markup_pct)/100,got=Number(r.insured_amount);if(!Number.isFinite(want)||!Number.isFinite(got))return '<span class="na">未设置</span>';return Math.abs(got-want)<=1?"通过":'<span class="bad">不一致：应为 '+money(want)+"</span>";}
function multiCtn(r){return Number(r.container_qty)>1?'<span class="tag">多柜</span>':"";}
function renderValue(r,c){
  var k=c[0],mode=c[2],mode2=c[3],v=r[k];
  if(k==="valid")return cell(validText(r));
  if(k==="fee")return cell(feeName(r));
  if(k==="flag")return cell(flagText(r));
  if(k==="free_time")return cell(freeText(v));
  if(k==="billing_rule")return cell(ruleText(r));
  if(k==="check")return checkText(r);
  if(k==="actual_margin"){var m=diff(r.freight_sale_usd,r.freight_cost);return (m===null?'<span class="na">未设置</span>':money(m))+multiCtn(r);}
  if(k==="is_active"||k==="is_required"||k==="insurance_required")return v===true?"是":(v===false?"否":'<span class="na">未设置</span>');
  if(k==="status")return cell(statusText(v));
  if(mode==="fee_status")return cell(feeStatusText(v));
  if(mode==="tier")return cell(tierText(v));
  if(mode==="rate")return cell(rateText(v));
  if(mode==="markup")return cell(markupText(v));
  if(mode2==="money")return money(v);
  if(mode2==="margin20")return money(diff(r.customer_gp20,r.gp20));
  if(mode2==="margin40")return money(diff(r.customer_hq40,r.hq40));
  return cell(v);
}
function fillRate(rows,keys){var total=rows.length*keys.length,filled=0;if(!total)return "0%";rows.forEach(function(r){keys.forEach(function(k){if(!blank(r[k]))filled++;});});return Math.round(filled*100/total)+"%";}
function emptyState(key,label,extraRows){
  var keys=required[key]||cols[key].map(function(c){return c[0];});
  return '<div class="empty">未接入：缺少 '+esc(keys.join(" / "))+'；当前填充率 '+fillRate(extraRows||state.data[key]||[],keys)+"。未接入条目不提供忽略操作。</div>";
}
function countText(rows,unit){return rows.length?esc(rows.length+" "+unit):"未接入";}
function panel(title,rows,unit,body){return '<section class="hgj-card section"><div class="section-head"><h2 class="hgj-panel-title">'+esc(title)+'</h2><span class="mini">'+countText(rows,unit)+'</span></div>'+body+"</section>";}
function tableHtml(key,rows,cs,opt){
  var html='<div class="table-wrap"><table><thead><tr>'+cs.map(function(c){return "<th>"+esc(c[1])+"</th>";}).join("")+"</tr></thead><tbody>";
  if(!rows.length)return html+'<tr><td colspan="'+cs.length+'">'+emptyState(key,cs[0][1],rows)+'</td></tr></tbody></table></div>';
  if(opt&&opt.group){
    var last="";
    rows.forEach(function(r){var g=opt.group(r);if(g!==last){last=g;html+='<tr class="group"><td colspan="'+cs.length+'">'+cell(g)+'</td></tr>';}html+=rowHtml(r,cs,opt);});
  }else rows.forEach(function(r){html+=rowHtml(r,cs,opt);});
  return html+"</tbody></table></div>";
}
function rowHtml(r,cs,opt){
  var tr=opt&&opt.rowClass?opt.rowClass(r):"";
  var target=detailTarget(r,cs),attrs=target?' data-title="'+attr(target.title)+'" data-url="'+attr(target.url)+'"':"";
  return "<tr"+(tr?' class="'+tr+'"':"")+attrs+">"+cs.map(function(c){
    var cls=[];if(c[2]==="num")cls.push("num");if(opt&&opt.warn&&opt.warn(r,c[0]))cls.push("warn");
    return '<td'+(cls.length?' class="'+cls.join(" ")+'"':"")+">"+renderValue(r,c)+"</td>";
  }).join("")+"</tr>";
}
function detailTarget(r,cs){
  if(cs===cols.ocean_bills&&r.id)return {title:r.bill_no||r.bl_no||("账单 "+r.id),url:"/rates?bill_id="+encodeURIComponent(r.id)};
  var key=r.shipment_no||r.bl_no||"";
  if(key)return {title:r.bl_no||r.shipment_no,url:"/ship-entry?id="+encodeURIComponent(key)};
  if(r.id)return {title:r.bill_no||("账单 "+r.id),url:"/rates?bill_id="+encodeURIComponent(r.id)};
  if(r.code)return {title:"费率套餐 "+r.code,url:"/rates?matrix_code="+encodeURIComponent(r.code)};
  return null;
}
function oceanWarn(r,k){return ["gp20","hq40","customer_gp20","customer_hq40"].includes(k)&&blank(r[k]);}
function planWarn(r,k){return ["freight_cost","freight_cost_currency","freight_sale_usd"].includes(k)&&blank(r[k]);}
function drawOcean(){
  $("content").innerHTML='<div class="sections">'+panel("价表",state.data.ocean,"行",tableHtml("ocean",state.data.ocean,cols.ocean,{rowClass:function(r){return expired(r)?"expired":(r.status==="draft"?"draft":"");},warn:oceanWarn}))+panel("出运票实际海运费",state.data.ocean_plans,"票",tableHtml("ocean_plans",state.data.ocean_plans,cols.ocean_plans,{warn:planWarn}))+panel("海运费账单明细",state.data.ocean_bills,"行",tableHtml("ocean_bills",state.data.ocean_bills,cols.ocean_bills))+"</div>";
  statParts([["价表",state.data.ocean,"ocean"],["出运票",state.data.ocean_plans,"ocean_plans"],["账单",state.data.ocean_bills,"ocean_bills"]]);
}
function drawCharges(){
  var itemsBy={},mrows=[];
  state.data.matrix_items.forEach(function(i){(itemsBy[i.matrix_code]=itemsBy[i.matrix_code]||[]).push(i);});
  state.data.matrices.forEach(function(m){mrows.push(m);if(state.expanded[m.code])itemsBy[m.code]&&itemsBy[m.code].forEach(function(i){mrows.push(Object.assign({code:"  · "+i.matrix_code,carrier_code:"明细",pol:i.charge_name,pod:i.container_type,bl_type:i.unit,free_days_origin:i.qty,total_cost_20gp:i.unit_price,total_cost_40hq:i.amount,cost_currency:i.currency,is_active:i.is_required,valid_from:"",valid_to:""}));});});
  $("content").innerHTML='<div class="sections">'+panel("官方费率",state.data.tariff,"行",tableHtml("tariff",state.data.tariff,cols.tariff,{group:function(r){return (r.carrier||"未设置")+" / "+(r.port||"未设置");}}))+panel("货代实报套餐",state.data.matrices,"套餐",matrixTable(mrows))+panel("本地费",state.data.local,"行",tableHtml("local",state.data.local,cols.local))+"</div>";
  statParts([["官方",state.data.tariff,"tariff"],["套餐",state.data.matrices,"matrices"],["本地",state.data.local,"local"]]);
}
function matrixTable(rows){
  var cs=cols.matrices,html='<div class="table-wrap"><table><thead><tr>'+cs.map(function(c){return "<th>"+esc(c[1])+"</th>";}).join("")+"</tr></thead><tbody>";
  if(!rows.length)return html+'<tr><td colspan="'+cs.length+'">'+emptyState("matrices","货代实报套餐",rows)+'</td></tr></tbody></table></div>';
  rows.forEach(function(r){var real=state.data.matrices.indexOf(r)>=0;html+="<tr>"+cs.map(function(c,i){var v=renderValue(r,c);if(real&&i===0)v='<button class="linkbtn" data-matrix="'+attr(r.code)+'">'+(state.expanded[r.code]?"收起":"展开")+"</button> "+cell(r.code);return '<td'+(c[2]==="num"?' class="num"':"")+">"+v+"</td>";}).join("")+"</tr>";});
  return html+"</tbody></table></div>";
}
function drawTruck(){
  $("content").innerHTML=panel("service_rates · truck",state.data.truck,"行",tableHtml("truck",state.data.truck,cols.truck,{group:function(r){return r.factory_name||"未设置";}}))+panel("旧表 · 待并入 service_rates",state.data.truck_legacy,"行",legacyTable());
  statParts([["当前",state.data.truck,"truck"],["旧表",state.data.truck_legacy,"truck"]]);
}
function legacyTable(){var rows=state.data.truck_legacy;if(!rows.length)return tableHtml("truck",[],[["x","旧表"]]);var keys=Object.keys(rows[0]);return tableHtml("truck",rows,keys.map(function(k){return [k,k];}));}
function drawCustoms(){ $("content").innerHTML=panel("报关报价",state.data.customs,"行",tableHtml("customs",state.data.customs,cols.customs));statParts([["报关",state.data.customs,"customs"]]);}
function drawInsurance(){ $("content").innerHTML=panel("货运保险",state.data.insurance,"行",tableHtml("insurance",state.data.insurance,cols.insurance));statParts([["保险",state.data.insurance,"insurance"]]);}
function statParts(parts){$("sub").innerHTML=parts.map(function(p){return esc(p[0])+" "+(p[1].length?("<b>"+p[1].length+"</b>"):"<b>未接入</b>")+" · 填充率 "+fillRate(p[1],required[p[2]]||[]);}).join(" / ");}
function draw(){({ocean:drawOcean,charges:drawCharges,truck:drawTruck,customs:drawCustoms,insurance:drawInsurance}[state.tab])();}
function query(){var p=new URLSearchParams();["pol","pod","carrier"].forEach(function(id){var v=$(id).value.trim();if(v)p.set(id,v);});p.set("active_only",$("active").checked?"true":"false");return p.toString();}
async function load(){
  $("sub").textContent="加载中...";
  try{
    var r=await fetch("/api/db/rates-hub?"+query(),{headers:{Authorization:"Bearer "+SanlynTable.token()}});
    var j=await r.json();if(!r.ok||!j.success)throw new Error(j.error||("HTTP "+r.status));
    state.data=Object.assign(state.data,j.data||{});state.count=j.count||{};
    $("stamp").textContent=VERSION+" · 生成时间 "+new Date().toLocaleString("zh-CN");
    draw();
  }catch(e){$("stamp").textContent=VERSION+" · 生成时间 "+new Date().toLocaleString("zh-CN");$("sub").textContent="加载失败";$("content").innerHTML='<section class="hgj-card"><div class="err">读取失败：'+esc(e.message)+"</div></section>";}
}
function csvValue(v){return '"' + String(blank(v)?"":v).replace(/"/g,'""') + '"';}
function rowsForCsv(){
  if(state.tab==="ocean"){var r=[];state.data.ocean.forEach(function(x){r.push(Object.assign({section:"价表"},x));});state.data.ocean_plans.forEach(function(x){r.push(Object.assign({section:"出运票实际海运费"},x));});state.data.ocean_bills.forEach(function(x){r.push(Object.assign({section:"海运费账单明细"},x));});return {cols:[["section","类别"]].concat(cols.ocean,cols.ocean_plans,cols.ocean_bills),rows:r};}
  if(state.tab!=="charges")return {cols:cols[state.tab]||cols.ocean,rows:state.data[state.tab]||[]};
  var rows=[];state.data.tariff.forEach(function(x){rows.push(Object.assign({section:"官方费率"},x));});state.data.matrices.forEach(function(x){rows.push(Object.assign({section:"货代实报套餐"},x));});state.data.matrix_items.forEach(function(x){rows.push(Object.assign({section:"套餐明细"},x));});state.data.local.forEach(function(x){rows.push(Object.assign({section:"本地费"},x));});return {cols:[["section","类别"]].concat(cols.tariff,cols.matrices,cols.matrix_items,cols.local),rows:rows};
}
function exportCsv(){
  var pack=rowsForCsv(),out=[pack.cols.map(function(c){return csvValue(c[1]);}).join(",")];
  pack.rows.forEach(function(r){out.push(pack.cols.map(function(c){var k=c[0];if(k==="valid")return csvValue(validText(r));if(k==="fee")return csvValue(feeName(r));if(k==="flag")return csvValue(flagText(r));if(k==="billing_rule")return csvValue(ruleText(r));if(k==="check")return csvValue(checkText(r).replace(/<[^>]+>/g,""));if(k==="actual_margin")return csvValue(diff(r.freight_sale_usd,r.freight_cost));if(k==="tier")return csvValue(tierText(r[k]));if(k==="insurance_rate")return csvValue(rateText(r[k]));if(k==="markup_pct")return csvValue(markupText(r[k]));if(c[3]==="margin20")return csvValue(diff(r.customer_gp20,r.gp20));if(c[3]==="margin40")return csvValue(diff(r.customer_hq40,r.hq40));return csvValue(k==="free_time"?freeText(r[k]):r[k]);}).join(","));});
  var a=document.createElement("a");a.href=URL.createObjectURL(new Blob(["\ufeff"+out.join("\n")],{type:"text/csv;charset=utf-8"}));a.download="rates-hub-"+state.tab+".csv";a.click();URL.revokeObjectURL(a.href);
}
document.querySelectorAll(".side button").forEach(function(b){b.onclick=function(){state.tab=b.dataset.tab;document.querySelectorAll(".side button").forEach(function(x){x.classList.toggle("on",x===b);});draw();};});
["pol","pod","carrier"].forEach(function(id){$(id).onchange=load;});
$("active").onchange=load;$("search").onclick=load;$("csv").onclick=exportCsv;
$("content").onclick=function(e){var m=e.target.closest("[data-matrix]");if(m){state.expanded[m.dataset.matrix]=!state.expanded[m.dataset.matrix];draw();return;}var row=e.target.closest("tr[data-url]");if(!row||e.target.closest("button"))return;openWorkbenchTab(row.dataset.title,row.dataset.url);};
load();
