(function(){
"use strict";
var API="/api/db/hgj-template-195";
var VERSION="v2026.09.15-1";
var GENERATED_AT="2026-09-15T00:00:00Z";
var state={data:null,tab:"mapping",previewTemplate:""};
var sample=[
  "订单编号：{{ocean_order_no}}",
  "主单号：{{ocean_bl_no}}",
  "SO号：{{order_so_no}}",
  "起运港-目的港：{{ocean_pol}} - {{ocean_pod}}",
  "委托单位：{{ocean_principal}}",
  "报关单号：{{customs_customs_no}}",
  "费用：{{fee_fee_name}} {{fee_amount}} {{fee_currency}}",
  "账单金额：{{bill_bill_amount}} {{bill_currency}}"
].join("\n");
function id(v){return document.getElementById(v)}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(json){var h={},t=token();if(t)h.Authorization="Bearer "+t;if(json)h["Content-Type"]="application/json";return h}
function text(el,value){el.textContent=value==null?"":String(value)}
function pct(v){var n=Number(v);return v==null||!Number.isFinite(n)?"未接入":Math.round(n*1000)/10+"%"}
function clear(el){el.textContent=""}
function replaceEmpty(el,msg){clear(el);el.appendChild(empty(msg))}
function cell(textValue,tag){
  var el=document.createElement(tag||"td");
  el.textContent=textValue==null?"":String(textValue);
  return el;
}
function codeCell(row){
  var td=document.createElement("td"), c=document.createElement("code");
  c.textContent="{{"+row.placeholder+"}}";
  td.appendChild(c);
  return td;
}
function statusCell(row){
  var td=document.createElement("td"), span=document.createElement("span");
  span.className=row.state==="ready"?"ok":"bad";
  span.textContent=row.state==="ready"?"已接入":HgjTemplateRenderer.missingText(row);
  td.appendChild(span);
  return td;
}
function missingPreviewText(item){
  if(typeof item==="string")return item;
  var source=item.source_table&&item.source_column?" · "+item.source_table+"."+item.source_column:"";
  return item.placeholder+source+"："+(item.reason||("缺占位符 "+item.placeholder+" 的映射字段"))+"；当前填充率 "+HgjTemplateRenderer.fieldRate(item);
}
function metricCount(v,fallback){return v==null?fallback:String(v)}
function readyCountText(s){return !s||!s.ready?"未接入":String(s.ready)}
function firstMissing(rows){
  return (rows||[]).find(function(row){return row.state!=="ready"})||null;
}
function missingMetricNote(row, field){
  if(row)return HgjTemplateRenderer.missingText(row);
  return "未接入 · 缺 "+field+"；当前填充率 未接入";
}
function missingSummaryNote(s, miss){
  if(s.not_connected==null)return missingMetricNote(miss,"summary.not_connected");
  if(s.not_connected>0)return missingMetricNote(miss,"mappings.state");
  return "无未接入字段；当前映射覆盖率 "+pct(s.mapping_fill_rate);
}
function dataRateNote(s, miss){
  if(s.data_fill_rate==null)return missingMetricNote(miss,"summary.data_fill_rate");
  return "真实字段 "+s.data_filled_count+"/"+s.data_total_count+"；当前填充率 "+pct(s.data_fill_rate);
}
function sourceText(row){
  return row&&row.source_table&&row.source_column ? row.source_table+"."+row.source_column : HgjTemplateRenderer.missingText(row);
}
function summaryText(d, extra){
  var version=(d&&d.template&&d.template.version)||VERSION;
  var generated=d&&d.generated_at ? d.generated_at : GENERATED_AT;
  return version+" · 生成时间 "+generated+(extra?" · "+extra:"");
}
function templateInfo(){
  var d=state.data||{};
  return {
    version:(d.template&&d.template.version)||VERSION,
    generated_at:d.generated_at||GENERATED_AT
  };
}
function notifyReady(){
  var info=templateInfo();
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",protocol:"sanlyn:open-tab",module:"hgj-template-195",title:"海管家195模板",url:location.pathname+location.search,version:info.version,generated_at:info.generated_at,accepts:["sanlyn:module-refresh"]},location.origin);
}
async function fetchJson(url,opts){
  var r=await fetch(url,opts||{headers:headers()});
  var j=await r.json().catch(function(){return {}});
  if(!r.ok||!j.success)throw new Error(j.error||r.statusText);
  return j;
}
async function load(){
  text(id("summary"),summaryText(state.data,"加载中"));
  try{
    var params=new URLSearchParams();
    if(id("recordKey").value.trim())params.set("record_key",id("recordKey").value.trim());
    state.data=await fetchJson(API+"?"+params.toString(),{headers:headers()});
    state.previewTemplate="";
    if(!id("templateText").value.trim())id("templateText").value=sample;
    render();
  }catch(e){
    text(id("summary"),summaryText(state.data,"读取失败："+e.message));
    replaceEmpty(id("mapping"),"无法加载映射表 · 缺 API 返回；当前填充率 未接入");
    replaceEmpty(id("values"),"未接入 · 缺值映射 API 返回；当前填充率 未接入");
    replaceEmpty(id("preview"),"未接入 · 缺渲染 API 返回；当前填充率 未接入");
    replaceEmpty(id("contract"),"未接入 · 缺 renderer_contract；当前填充率 未接入");
    replaceEmpty(id("mappingContract"),"未接入 · 缺 mapping_contract；当前填充率 未接入");
    notifyReady();
  }
}
async function preview(){
  if(!state.data)return;
  try{
    var body={record_key:id("recordKey").value.trim(),template_text:id("templateText").value};
    state.data=await fetchJson(API,{method:"POST",headers:headers(true),body:JSON.stringify(body)});
    state.previewTemplate=body.template_text;
    renderPreview();
    renderMetrics();
  }catch(e){
    text(id("previewMeta"),"未接入 · 缺渲染 API 返回；当前填充率 未接入");
    replaceEmpty(id("preview"),"未接入 · 渲染失败："+e.message+"；当前填充率 未接入");
  }
}
function render(){
  renderMetrics();
  renderTabs();
  renderMapping();
  renderValues();
  renderPreview();
  notifyReady();
}
function renderMetrics(){
  var d=state.data||{}, s=d.summary||{}, rows=d.mappings||[], miss=firstMissing(rows);
  text(id("summary"),summaryText(d));
  text(id("mTotal"),metricCount(s.total,"未接入"));
  text(id("mReady"),readyCountText(s));
  text(id("mMissing"),metricCount(s.not_connected,"未接入"));
  text(id("mRate"),pct(s.data_fill_rate));
  text(id("mTotalNote"),s.total!=null?"字段数来自映射表；映射覆盖率 "+pct(s.mapping_fill_rate):"未接入 · 缺 summary.total；当前填充率 未接入");
  text(id("mReadyNote"),s.ready?"已通过 information_schema 校验":missingMetricNote(miss,"ready 映射"));
  text(id("mMissingNote"),missingSummaryNote(s,miss));
  text(id("mRateNote"),dataRateNote(s,miss));
}
function renderTabs(){
  Array.prototype.forEach.call(document.querySelectorAll(".tab"),function(btn){
    btn.classList.toggle("active",btn.dataset.tab===state.tab);
  });
  Array.prototype.forEach.call(document.querySelectorAll(".pane"),function(pane){
    pane.hidden=pane.id!==state.tab;
  });
}
function renderMapping(){
  var box=id("mapping"), rows=(state.data&&state.data.mappings)||[];
  if(!rows.length){replaceEmpty(box,"未接入 · 缺映射清单；当前填充率 未接入");return}
  clear(box);
  var table=document.createElement("table"), thead=document.createElement("thead"), tr=document.createElement("tr"), tbody=document.createElement("tbody");
  ["序号","分组","占位符","名称","真实字段","填充率","状态"].forEach(function(label){tr.appendChild(cell(label,"th"))});
  thead.appendChild(tr);table.appendChild(thead);
  rows.forEach(function(row){
    var item=document.createElement("tr");
    item.appendChild(cell(row.seq));
    item.appendChild(cell(row.group));
    item.appendChild(codeCell(row));
    item.appendChild(cell(row.label));
    item.appendChild(cell(sourceText(row)));
    item.appendChild(cell(HgjTemplateRenderer.fieldRate(row)));
    item.appendChild(statusCell(row));
    tbody.appendChild(item);
  });
  table.appendChild(tbody);box.appendChild(table);
}
function renderValues(){
  var box=id("values"), rows=(state.data&&state.data.mappings)||[], values=(state.data&&state.data.values)||{}, opts={tableHits:(state.data&&state.data.table_hits)||{}};
  clear(box);
  if(!rows.length){box.appendChild(empty("未接入 · 缺值映射；当前填充率 未接入"));return}
  HgjTemplateRenderer.groups(rows).forEach(function(group){
    var sec=document.createElement("section"), h=document.createElement("h3"), grid=document.createElement("div");
    sec.className="group hgj-card";h.className="hgj-panel-title";grid.className="kv";
    h.textContent=group.key;sec.appendChild(h);
    group.rows.forEach(function(row){
      var item=document.createElement("div"), k=document.createElement("b"), v=document.createElement("span");
      k.textContent="{{"+row.placeholder+"}}";
      v.textContent=HgjTemplateRenderer.valueText(row,values[row.placeholder],opts);
      item.className=v.textContent.indexOf("未接入")===0?"missing":"";
      item.appendChild(k);item.appendChild(v);grid.appendChild(item);
    });
    sec.appendChild(grid);box.appendChild(sec);
  });
}
function renderPreview(){
  var values=(state.data&&state.data.values)||{}, mappings=(state.data&&state.data.mappings)||[], tpl=id("templateText").value;
  var opts={tableHits:(state.data&&state.data.table_hits)||{}};
  HgjTemplateRenderer.renderInto(id("preview"),tpl,values,mappings,opts);
  var serverMiss=state.data&&state.data.preview&&state.previewTemplate===tpl?state.data.preview.missing_placeholders:null;
  var miss=serverMiss||HgjTemplateRenderer.missingInText(tpl,values,mappings,opts);
  text(id("previewMeta"),miss.length?"未接入占位符："+miss.map(missingPreviewText).join("；"):"只读预览；未接入字段已标注");
  renderContract();
}
function appendContractRows(box, data, keys){
  keys.forEach(function(key){
    var row=document.createElement("div"), span=document.createElement("span");
    row.textContent=key+"：";
    span.textContent=data&&data[key]!=null&&data[key]!==""?data[key]:"未接入 · 缺 "+key+"；当前填充率 未接入";
    row.appendChild(span);box.appendChild(row);
  });
}
function renderContract(){
  var box=id("contract"), c=state.data&&state.data.renderer_contract;
  var mapBox=id("mappingContract"), m=state.data&&state.data.mapping_contract;
  clear(box);
  clear(mapBox);
  if(!c){box.appendChild(empty("未接入 · 缺 renderer_contract；当前填充率 未接入"));return}
  appendContractRows(box,c,["syntax","placeholder_pattern","max_template_chars","missing_policy","escaping"]);
  if(!m){mapBox.appendChild(empty("未接入 · 缺 mapping_contract；当前填充率 未接入"));return}
  appendContractRows(mapBox,m,["template_code","source","placeholder_count","table_count","connected_column_count","mapped_count","ui_only_count","not_mapped_count","source_policy","ignore_policy"]);
}
function empty(msg){var d=document.createElement("div");d.className="empty";d.textContent=msg;return d}
function openWorkbench(){
  var url="/hgj-template-195", title="海管家195模板";
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:open-tab",protocol:"sanlyn:open-tab",title:title,url:url,module:"hgj-template-195"},location.origin);
  else window.open("/wb-tabs?open="+encodeURIComponent(url)+"&title="+encodeURIComponent(title),"_blank","noopener");
}
function bind(){
  id("reload").addEventListener("click",load);
  id("renderBtn").addEventListener("click",preview);
  id("openWb").addEventListener("click",openWorkbench);
  id("templateText").addEventListener("input",renderPreview);
  window.addEventListener("message",function(event){
    if(event.origin!==location.origin||!event.data||event.data.type!=="sanlyn:module-refresh")return;
    if(event.data.record_key!=null)id("recordKey").value=String(event.data.record_key).slice(0,180);
    if(event.data.template_text!=null)id("templateText").value=String(event.data.template_text);
    load();
  });
  document.querySelector(".tabs").addEventListener("click",function(e){
    var btn=e.target.closest(".tab");if(!btn)return;state.tab=btn.dataset.tab;renderTabs();
  });
}
bind();
load();
})();
