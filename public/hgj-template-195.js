(function(){
"use strict";
var API="/api/db/hgj-template-195";
var VERSION="v2026.09.28-1";
var state={data:null,tab:"mapping",previewText:""};
var sample=[
  "订单编号：{{shipping_order_nos}}",
  "提单号：{{bl_no}}",
  "船名航次：{{vessel}} / {{voyage}}",
  "起运港-目的港：{{pol}} - {{pod}}",
  "委托单位：{{shipping_customer}}",
  "申报货值：{{declaration_amount}} {{declaration_currency}}",
  "费用：{{fee_name}} {{fee_amount}} {{fee_currency}}",
  "发票：{{invoice_no}} {{invoice_amount}}",
  "HGJ账单发票号：{{hgj_invoice_no_on_bill}}"
].join("\n");
function id(v){return document.getElementById(v)}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(json){var h={},t=token();if(t)h.Authorization="Bearer "+t;if(json)h["Content-Type"]="application/json";return h}
function text(el,value){el.textContent=value==null?"":String(value)}
function pct(v){return v==null||Number(v)<=0?"未接入":Math.round(Number(v)*1000)/10+"%"}
function countText(v,zeroLabel){return v==null||Number(v)===0?(zeroLabel||"未接入"):String(v)}
function clear(el){el.textContent=""}
function missingPreviewText(item){
  if(typeof item==="string")return item;
  return item.placeholder+"："+(item.status||"未接入")+" · "+(item.reason||"缺映射字段")+"；当前填充率 "+HgjTemplateRenderer.fieldRate(item);
}
async function fetchJson(url,opts){
  var r=await fetch(url,opts||{headers:headers()});
  var j=await r.json().catch(function(){return {}});
  if(!r.ok||!j.success)throw new Error(j.error||r.statusText);
  return j;
}
async function load(){
  text(id("summary"),"加载中");
  try{
    var params=new URLSearchParams();
    if(id("recordKey").value.trim())params.set("record_key",id("recordKey").value.trim());
    state.data=await fetchJson(API+"?"+params.toString(),{headers:headers()});
    if(!id("templateText").value.trim())id("templateText").value=sample;
    render();
  }catch(e){
    text(id("summary"),"读取失败："+e.message);
    clear(id("mapping"));
    id("mapping").appendChild(empty("未接入 · 缺 /api/db/hgj-template-195 返回；当前填充率 未接入"));
  }
}
async function preview(){
  if(!state.data)return;
  try{
    var body={record_key:id("recordKey").value.trim(),template_text:id("templateText").value};
    state.data=await fetchJson(API,{method:"POST",headers:headers(true),body:JSON.stringify(body)});
    state.previewText=body.template_text;
    render();
  }catch(e){text(id("previewMeta"),"渲染失败："+e.message)}
}
function render(){
  renderMetrics();
  renderTabs();
  renderMapping();
  renderValues();
  renderPreview();
  postReady();
}
function postReady(){
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",protocol:"sanlyn:open-tab",module:"hgj-template-195",title:"海管家195模板",url:location.pathname+location.search,accepts:["sanlyn:module-refresh"]},location.origin);
}
function applyOpenParams(data){
  if(!data)return false;
  var changed=false;
  if(data.record_key!=null){id("recordKey").value=String(data.record_key).trim();changed=true}
  if(data.template_text!=null){id("templateText").value=String(data.template_text);changed=true}
  return changed;
}
function renderMetrics(){
  var d=state.data||{}, s=d.summary||{};
  text(id("summary"),(d.template&&d.template.version||VERSION)+" · 生成时间 "+(d.generated_at||"--"));
  text(id("mTotal"),countText(s.total));
  text(id("mReady"),countText(s.ready));
  text(id("mMissing"),countText(Number(s.not_connected||0)+Number(s.not_configured||0)));
  text(id("mRate"),pct(s.fill_rate));
}
function renderTabs(){
  Array.prototype.forEach.call(document.querySelectorAll(".tab"),function(btn){
    btn.classList.toggle("active",btn.dataset.tab===state.tab);
  });
  Array.prototype.forEach.call(document.querySelectorAll(".pane"),function(pane){
    pane.hidden=pane.id!==state.tab;
  });
}
function cell(tag,value,cls){
  var n=document.createElement(tag);
  if(cls)n.className=cls;
  text(n,value);
  return n;
}
function appendStatus(parent,row){
  var span=document.createElement("span");
  span.className=row.state==="ready"?"ok":"bad";
  text(span,row.state==="ready"?"已接入":HgjTemplateRenderer.missingText(row));
  parent.appendChild(span);
}
function sourceText(row){
  return row.source_table&&row.source_column?row.source_table+"."+row.source_column:"未接入 · 缺映射字段 "+row.module+"."+row.label;
}
function renderMapping(){
  var box=id("mapping"), rows=(state.data&&state.data.mappings)||[];
  clear(box);
  if(!rows.length){box.appendChild(empty("未接入 · 缺映射清单；当前填充率 未接入"));return}
  var table=document.createElement("table"), thead=document.createElement("thead"), tr=document.createElement("tr"), tbody=document.createElement("tbody");
  ["分组","海管家字段","占位符","真实字段","填充样本","状态"].forEach(function(label){tr.appendChild(cell("th",label))});
  thead.appendChild(tr);table.appendChild(thead);
  rows.forEach(function(row){
    var r=document.createElement("tr"), ph=document.createElement("code"), status=cell("td","");
    ph.textContent="{{"+row.placeholder+"}}";
    r.appendChild(cell("td",row.group));
    r.appendChild(cell("td",row.module+" / "+row.label));
    var phCell=cell("td","");phCell.appendChild(ph);r.appendChild(phCell);
    r.appendChild(cell("td",sourceText(row)));
    r.appendChild(cell("td",row.total_count?"真实字段 "+row.filled_count+"/"+row.total_count+" · "+HgjTemplateRenderer.fieldRate(row):HgjTemplateRenderer.missingText(row)));
    appendStatus(status,row);r.appendChild(status);tbody.appendChild(r);
  });
  table.appendChild(tbody);box.appendChild(table);
}
function renderValues(){
  var box=id("values"), rows=(state.data&&state.data.mappings)||[], values=(state.data&&state.data.values)||{};
  clear(box);
  if(!rows.length){box.appendChild(empty("未接入 · 缺值映射；当前填充率 未接入"));return}
  HgjTemplateRenderer.groups(rows).forEach(function(group){
    var sec=document.createElement("section"), h=document.createElement("h3"), grid=document.createElement("div");
    sec.className="group hgj-card";h.className="hgj-panel-title";grid.className="kv";
    h.textContent=group.key;sec.appendChild(h);
    group.rows.forEach(function(row){
      var item=document.createElement("div"), k=document.createElement("b"), v=document.createElement("span");
      var value=values[row.placeholder], isMissing=HgjTemplateRenderer.isUnsetValue(row,value);
      item.className=isMissing?"missing":"";
      k.textContent="{{"+row.placeholder+"}}";
      v.textContent=isMissing?HgjTemplateRenderer.missingText(row):value+" · "+row.module+"/"+row.label;
      item.appendChild(k);item.appendChild(v);grid.appendChild(item);
    });
    sec.appendChild(grid);box.appendChild(sec);
  });
}
function renderPreview(){
  var data=state.data||{}, values=data.values||{}, mappings=data.mappings||[], tpl=id("templateText").value;
  var serverHtml=data.preview&&data.preview.rendered_html&&state.previewText===tpl?data.preview.rendered_html:"";
  var html=serverHtml||HgjTemplateRenderer.renderText(tpl,values,mappings);
  id("preview").innerHTML=html.replace(/\n/g,"<br>");
  var miss=HgjTemplateRenderer.missingInText(tpl,values,mappings);
  text(id("previewMeta"),miss.length?"未接入/未设置占位符："+miss.map(missingPreviewText).join("；"):"只读预览；未接入/未设置字段已标注");
}
function empty(msg){var d=document.createElement("div");d.className="empty";d.textContent=msg;return d}
function bind(){
  id("reload").addEventListener("click",load);
  id("renderBtn").addEventListener("click",preview);
  id("recordKey").addEventListener("keydown",function(e){if(e.key==="Enter")load()});
  id("templateText").addEventListener("input",renderPreview);
  window.addEventListener("message",function(e){
    var d=e.data||{};
    if(e.origin!==location.origin||!d)return;
    if(d.type==="sanlyn:module-refresh"){load();return}
    if(d.type==="sanlyn:module-open"&&(!d.module||d.module==="hgj-template-195")){
      if(applyOpenParams(d.payload||d))load();
    }
  });
  document.querySelector(".tabs").addEventListener("click",function(e){
    var btn=e.target.closest(".tab");if(!btn)return;state.tab=btn.dataset.tab;renderTabs();
  });
}
bind();
applyOpenParams(Object.fromEntries(new URLSearchParams(location.search).entries()));
postReady();
load();
})();
