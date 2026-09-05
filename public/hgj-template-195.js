(function(){
"use strict";
var API="/api/db/hgj-template-195";
var VERSION="v2026.08.29-1";
var state={data:null,tab:"mapping"};
var sample=[
  "业务编号：{{shipment_no}}",
  "提单号：{{bl_no}}",
  "船名航次：{{vessel}} / {{voyage}}",
  "起运港-目的港：{{pol}} - {{pod}}",
  "客户：{{customer_name}}",
  "货物：{{declaration_name}} HS {{hs_code}}",
  "申报货值：{{declaration_amount}} {{currency}}",
  "费用：{{fee_name}} {{fee_amount}} {{fee_currency}}"
].join("\n");
function id(v){return document.getElementById(v)}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(json){var h={},t=token();if(t)h.Authorization="Bearer "+t;if(json)h["Content-Type"]="application/json";return h}
function text(el,value){el.textContent=value==null?"":String(value)}
function pct(v){return v==null?"未接入":Math.round(Number(v)*1000)/10+"%"}
function countText(v){return v==null?"未接入":String(v)}
function clear(el){el.textContent=""}
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
    id("mapping").innerHTML='<div class="empty">无法加载映射表</div>';
  }
}
async function preview(){
  if(!state.data)return;
  try{
    var body={record_key:id("recordKey").value.trim(),template_text:id("templateText").value};
    state.data=await fetchJson(API,{method:"POST",headers:headers(true),body:JSON.stringify(body)});
    renderPreview();
    renderMetrics();
  }catch(e){text(id("previewMeta"),"渲染失败："+e.message)}
}
function render(){
  renderMetrics();
  renderTabs();
  renderMapping();
  renderValues();
  renderPreview();
  if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"海管家195模板",url:location.pathname+location.search},location.origin);
}
function renderMetrics(){
  var d=state.data||{}, s=d.summary||{};
  text(id("summary"),(d.template&&d.template.version||VERSION)+" · 生成时间 "+(d.generated_at||"--"));
  text(id("mTotal"),countText(s.total));
  text(id("mReady"),countText(s.ready));
  text(id("mMissing"),countText(s.not_connected));
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
function rowStatus(row){
  if(row.state==="ready")return '<span class="ok">已接入</span>';
  return '<span class="bad">'+HgjTemplateRenderer.esc(HgjTemplateRenderer.missingText(row))+"</span>";
}
function renderMapping(){
  var box=id("mapping"), rows=(state.data&&state.data.mappings)||[];
  if(!rows.length){box.innerHTML='<div class="empty">未接入 · 缺映射清单；当前填充率 未接入</div>';return}
  var html='<table><thead><tr><th>分组</th><th>占位符</th><th>名称</th><th>真实字段</th><th>填充率</th><th>状态</th></tr></thead><tbody>';
  rows.forEach(function(row){
    html+="<tr><td>"+HgjTemplateRenderer.esc(row.group)+"</td><td><code>{{"+HgjTemplateRenderer.esc(row.placeholder)+"}}</code></td><td>"+HgjTemplateRenderer.esc(row.label)+"</td><td>"+HgjTemplateRenderer.esc(row.source_table+"."+row.source_column)+"</td><td>"+HgjTemplateRenderer.esc(HgjTemplateRenderer.fieldRate(row))+"</td><td>"+rowStatus(row)+"</td></tr>";
  });
  box.innerHTML=html+"</tbody></table>";
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
      item.className=row.state==="ready"?"":"missing";
      k.textContent="{{"+row.placeholder+"}}";
      v.textContent=values[row.placeholder]||HgjTemplateRenderer.missingText(row);
      item.appendChild(k);item.appendChild(v);grid.appendChild(item);
    });
    sec.appendChild(grid);box.appendChild(sec);
  });
}
function renderPreview(){
  var html=HgjTemplateRenderer.renderText(id("templateText").value,(state.data&&state.data.values)||{},(state.data&&state.data.mappings)||[]);
  id("preview").innerHTML=html.replace(/\n/g,"<br>");
  var miss=(state.data&&state.data.preview&&state.data.preview.missing_placeholders)||[];
  text(id("previewMeta"),miss.length?"未接入占位符："+miss.join("、"):"只读预览；未接入字段已标注");
}
function empty(msg){var d=document.createElement("div");d.className="empty";d.textContent=msg;return d}
function bind(){
  id("reload").addEventListener("click",load);
  id("renderBtn").addEventListener("click",preview);
  id("templateText").addEventListener("input",renderPreview);
  document.querySelector(".tabs").addEventListener("click",function(e){
    var btn=e.target.closest(".tab");if(!btn)return;state.tab=btn.dataset.tab;renderTabs();
  });
}
bind();
load();
})();
