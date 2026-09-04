(function(){
"use strict";
var params=new URLSearchParams(location.search);
var state={module:clean(params.get("module")),page:1,size:50,q:"",fields:[],rows:[],total:0,hidden:new Set(),modules:[],missingFields:[],coverage:[],connection:"no_data"};
var els={title:id("title"),moduleSelect:id("moduleSelect"),status:id("status"),stamp:id("stamp"),grid:id("grid"),summary:id("summary"),q:id("q"),page:id("page"),size:id("size"),prev:id("prev"),next:id("next"),cols:id("cols"),colsBtn:id("colsBtn"),colsMenu:id("colsMenu"),form:id("searchForm"),connectivity:id("connectivity")};
function id(v){return document.getElementById(v)}
function clean(v){return v==null?"":String(v).trim()}
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
function storeKey(){return "sanlyn.hyGrid.cols."+state.module}
function loadHidden(){try{return new Set(JSON.parse(localStorage.getItem(storeKey())||"[]"))}catch(e){return new Set()}}
function saveHidden(){localStorage.setItem(storeKey(),JSON.stringify(Array.from(state.hidden)))}
function label(f){return clean(f.label_cn)||clean(f.label)||clean(f.field_key)}
function kind(f){return (clean(f.type)+" "+clean(f.input_kind)).toLowerCase()}
function cls(f){var k=kind(f);if(/number|numeric|decimal|integer|float|money/.test(k))return "num";if(/date|time/.test(k))return "mid";return ""}
function width(f){return Math.max(90,Math.min(360,Number(f.col_span||1)*86))}
function visibleFields(){return state.fields.filter(function(f){return !state.hidden.has(f.field_key)})}
function fieldName(f){return label(f)+(f.db_column&&f.db_column!==f.field_key?" / "+f.db_column:"")}
function pct(v){return v==null?"无样本":Math.round(Number(v)*100)+"%"}
function qs(){
  return new URLSearchParams({module:state.module,page:String(state.page),size:String(state.size),q:state.q}).toString();
}
async function fetchJson(url){
  var r=await fetch(url,{headers:headers()});
  var j=await r.json().catch(function(){return {}});
  if(!r.ok||!j.success)throw new Error(j.error||r.statusText);
  return j;
}
async function init(){
  bind();
  await loadModules();
  if(!state.module&&state.modules.length)state.module=state.modules[0].module_key;
  if(!state.module){showError("缺少 module 参数");return}
  state.hidden=loadHidden();
  syncModuleSelect();
  await load();
}
function bind(){
  els.form.addEventListener("submit",function(ev){ev.preventDefault();state.q=clean(els.q.value);state.page=1;load()});
  els.prev.addEventListener("click",function(){if(state.page>1){state.page-=1;load()}});
  els.next.addEventListener("click",function(){if(state.page<pages()){state.page+=1;load()}});
  els.page.addEventListener("change",function(){state.page=Math.max(1,Math.min(pages(),Number(els.page.value)||1));load()});
  els.size.addEventListener("change",function(){state.size=Number(els.size.value)||50;state.page=1;load()});
  els.colsBtn.addEventListener("click",function(){els.cols.classList.toggle("open")});
  els.moduleSelect.addEventListener("change",function(){
    var next=clean(els.moduleSelect.value);if(!next||next===state.module)return;
    state.module=next;state.page=1;state.q="";els.q.value="";state.hidden=loadHidden();
    history.replaceState(null,"","/hy/grid.html?module="+encodeURIComponent(state.module));
    load();
  });
  document.addEventListener("click",function(ev){if(!els.cols.contains(ev.target))els.cols.classList.remove("open")});
}
async function loadModules(){
  var data=await fetchJson("/api/db/hy-modules");
  state.modules=Array.isArray(data.modules)?data.modules:[];
  renderModuleSelect();
}
function renderModuleSelect(){
  els.moduleSelect.textContent="";
  state.modules.forEach(function(mod){
    var opt=document.createElement("option");
    opt.value=mod.module_key;opt.textContent=mod.module_key+" ("+Number(mod.visible_field_count||0)+" 列)";
    els.moduleSelect.appendChild(opt);
  });
}
function syncModuleSelect(){els.moduleSelect.value=state.module}
async function load(){
  els.status.textContent="加载中";
  try{
    var meta=await fetchJson("/api/db/field-engine?module="+encodeURIComponent(state.module));
    var data=await fetchJson("/api/db/hy-grid?"+qs());
    state.fields=Array.isArray(data.fields)&&data.fields.length?data.fields:meta.fields||[];
    state.rows=Array.isArray(data.rows)?data.rows:[];
    state.total=Number(data.total||0);
    state.missingFields=Array.isArray(data.missing_fields)?data.missing_fields:[];
    state.coverage=Array.isArray(data.coverage)?data.coverage:[];
    state.connection=data.state||"no_data";
    state.page=Number(data.page||state.page);
    state.size=Number(data.size||state.size);
    els.title.textContent=state.module;
    syncModuleSelect();
    els.stamp.textContent="v2026.08.28-1 · 生成时间 "+(data.generated_at||meta.generated_at||"--");
    render();
  }catch(e){showError(e.message)}
}
function render(){
  els.status.textContent=statusText();
  els.page.value=state.page;els.size.value=String(state.size);
  renderConnectivity();renderColumns();renderTable();renderPager();
}
function statusText(){
  if(!state.fields.length)return "未接入 · 缺少可显示真实字段";
  if(!state.rows.length)return "未接入 · 当前筛选无真实样本";
  return state.fields.length+" 列 · "+state.total+" 行";
}
function renderConnectivity(){
  els.connectivity.textContent="";
  var noSample=!state.rows.length,stateMissing=state.missingFields.length;
  els.connectivity.className="connectivity"+(!noSample&&!stateMissing?" ready":"");
  if(!noSample&&!stateMissing)return;
  var title=document.createElement("b"),meta=document.createElement("div"),chips=document.createElement("div");
  title.textContent="未接入";chips.className="chips";
  meta.textContent=reasonText(noSample,stateMissing);
  state.missingFields.slice(0,16).forEach(function(f){var chip=document.createElement("span");chip.textContent="缺字段："+fieldName(f);chips.appendChild(chip)});
  coverageRows().slice(0,16).forEach(function(c){var chip=document.createElement("span");chip.textContent="填充率："+label(c.field)+" "+pct(c.fill_rate);chips.appendChild(chip)});
  if(state.missingFields.length>16){var more=document.createElement("span");more.textContent="缺字段还有 "+(state.missingFields.length-16)+" 项";chips.appendChild(more)}
  els.connectivity.appendChild(title);els.connectivity.appendChild(meta);els.connectivity.appendChild(chips);
}
function reasonText(noSample,stateMissing){
  var parts=[];
  if(noSample)parts.push("当前没有可验证的真实样本，不显示 0");
  if(stateMissing)parts.push("字段定义存在但数据表缺少对应列");
  if(!coverageRows().length)parts.push("填充率无法计算");
  return parts.join("；");
}
function coverageRows(){
  var byKey={};state.coverage.forEach(function(c){byKey[c.field_key]=c});
  return state.fields.map(function(f){var c=byKey[f.field_key]||{};return {field:f,fill_rate:c.fill_rate,filled_count:c.filled_count,total_count:c.total_count}});
}
function renderColumns(){
  els.colsMenu.textContent="";
  state.fields.forEach(function(f){
    var row=document.createElement("label"),box=document.createElement("input"),txt=document.createElement("span");
    box.type="checkbox";box.checked=!state.hidden.has(f.field_key);
    box.addEventListener("change",function(){box.checked?state.hidden.delete(f.field_key):state.hidden.add(f.field_key);saveHidden();render()});
    txt.textContent=label(f);row.appendChild(box);row.appendChild(txt);els.colsMenu.appendChild(row);
  });
}
function renderTable(){
  var fields=visibleFields();
  if(!fields.length){els.grid.innerHTML='<div class="empty">未接入：缺少可显示真实字段</div>';return}
  var html='<table><colgroup>'+fields.map(function(f){return '<col style="width:'+width(f)+'px">'}).join("")+'</colgroup><thead><tr>';
  html+=fields.map(function(f){return '<th class="'+cls(f)+'" title="'+esc(label(f))+'">'+esc(label(f))+'</th>'}).join("");
  html+='</tr></thead><tbody>';
  if(!state.rows.length)html+='<tr><td colspan="'+fields.length+'" class="empty">未接入：当前筛选没有可验证真实样本，缺字段和填充率见上方</td></tr>';
  state.rows.forEach(function(row){
    html+="<tr>"+fields.map(function(f){return '<td class="'+cls(f)+'" title="'+esc(value(row[f.field_key]))+'">'+esc(value(row[f.field_key]))+'</td>'}).join("")+"</tr>";
  });
  els.grid.innerHTML=html+"</tbody></table>";
}
function value(v){
  if(v==null)return "";
  if(typeof v==="object")return JSON.stringify(v);
  return v;
}
function pages(){return Math.max(1,Math.ceil(state.total/state.size))}
function renderPager(){
  var start=state.total?(state.page-1)*state.size+1:0,end=Math.min(state.total,state.page*state.size);
  els.summary.textContent=state.total?start+"-"+end+" / "+state.total:"未接入";
  els.prev.disabled=state.page<=1;els.next.disabled=state.page>=pages();
}
function showError(msg){
  els.status.textContent="读取失败："+msg;
  els.grid.innerHTML='<div class="empty">无法加载数据</div>';
}
init();
})();
