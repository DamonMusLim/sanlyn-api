(function(){
"use strict";
var params=new URLSearchParams(location.search);
var state={module:clean(params.get("module")),page:1,size:50,q:clean(params.get("q")),fields:[],rows:[],total:0,hidden:new Set(),modules:[],busy:false,modalCandidates:[],modalLine:null,detailIndex:null,detailRow:null,detailOriginal:{}};
var els={title:id("title"),moduleSelect:id("moduleSelect"),status:id("status"),stamp:id("stamp"),grid:id("grid"),summary:id("summary"),q:id("q"),page:id("page"),size:id("size"),prev:id("prev"),next:id("next"),cols:id("cols"),colsBtn:id("colsBtn"),colsMenu:id("colsMenu"),form:id("searchForm"),modal:null,detail:id("detailDrawer"),detailClose:id("detailClose"),detailTitle:id("detailTitle"),detailMeta:id("detailMeta"),detailBody:id("detailBody"),detailSave:id("detailSave"),detailError:id("detailError")};
var RECON_LINE_ACTIONS=[
  {key:"confirm",label:"确认",method:"POST",url:function(row){return "/api/db/recon-persist?action=confirm&id="+encodeURIComponent(rowPk(row))},show:function(row){return !row.expected_confirmed_at},confirm:"确认这行的应收付金额？"},
  {key:"settle-suggest",label:"找候选付款",method:"POST",url:function(row){return "/api/db/recon-persist?action=settle-suggest&id="+encodeURIComponent(rowPk(row))},show:function(row){return row.template_key==="ar_customer"},confirm:"查找这行的候选付款？",success:function(data,row){showSettleModal(row,data.candidates||[])}},
  {key:"enter-invoice-no",label:"录入发票号",method:"POST",url:function(row){return "/api/db/recon-persist?action=enter-invoice-no&id="+encodeURIComponent(rowPk(row))},body:function(){var v=prompt("请输入发票号");if(v==null)return null;v=clean(v);if(!v)return null;if(!confirm("确认录入发票号："+v+"？"))return null;return {invoice_no:v}}}
];
var ROW_ACTIONS={
  recon_lines:RECON_LINE_ACTIONS,
  recon_sheet_lines:RECON_LINE_ACTIONS,
  recon_bill_lines:RECON_LINE_ACTIONS,
  finance_recon_lines:RECON_LINE_ACTIONS
};
var DEFAULT_HIDDEN=/^(.*_source_type|.*_source_ref|match_key|field_values|source_payload|template_id|last_event_id|locked_by|locked_at|lock_month|tolerance_amount|created_by|updated_by|visibility_snapshot|meta|raw)$/;
function id(v){return document.getElementById(v)}
function clean(v){return v==null?"":String(v).trim()}
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(json){var h={},t=token();if(t)h.Authorization="Bearer "+t;if(json)h["Content-Type"]="application/json";return h}
function storeKey(){return "sanlyn.hyGrid.cols."+state.module}
function loadHidden(){try{var raw=localStorage.getItem(storeKey());if(raw!=null)return new Set(JSON.parse(raw));return null}catch(e){return null}}
function saveHidden(){localStorage.setItem(storeKey(),JSON.stringify(Array.from(state.hidden)))}
function label(f){return clean(f.label_cn)||clean(f.label)||clean(f.field_key)}
function kind(f){return (clean(f.type)+" "+clean(f.input_kind)).toLowerCase()}
function cls(f){var k=kind(f);if(/number|numeric|decimal|integer|float|money/.test(k))return "num";if(/date|time/.test(k))return "mid";return ""}
function width(f){return Math.max(90,Math.min(360,Number(f.col_span||1)*86))}
function fieldName(f){return clean(f.field_key).toLowerCase()}
function priority(f){
  var name=fieldName(f);
  if(/(^|_)id($|_)|(^|_)uuid($|_)/.test(name))return 9;
  if(/bl_no|shipment_no|order_no|contract_no|提单|单号|编号/.test(name))return 1;
  if(/customer|company|客户|单位|供应商/.test(name))return 2;
  if(/pol|pod|port|港|etd|eta|日期|时间/.test(name))return 3;
  if(/amount|price|cost|sale|费|金额|价/.test(name))return 4;
  return 5;
}
function orderedFields(){
  return state.fields.map(function(f,i){return {field:f,index:i,priority:priority(f)}}).sort(function(a,b){return a.priority-b.priority||a.index-b.index}).map(function(v){return v.field});
}
function detailFields(){
  // 详情页按字段配置原始顺序展示，避免 249 列继续按表格优先级打散。
  return state.fields.slice().sort(function(a,b){return num(a.section_order)-num(b.section_order)||num(a.sort_order)-num(b.sort_order)||String(a.field_key).localeCompare(String(b.field_key))});
}
function num(v){var n=Number(v);return Number.isFinite(n)?n:999999}
function applyDefaultHidden(){
  if(state.hidden!==null&&state.hidden!==undefined)return;
  var h=new Set();
  state.fields.forEach(function(f){var k=clean(f.field_key);if(DEFAULT_HIDDEN.test(k))h.add(f.field_key)});
  state.hidden=h;
}
function visibleFields(){return orderedFields().filter(function(f){return !state.hidden.has(f.field_key)})}
function qs(){return new URLSearchParams({module:state.module,page:String(state.page),size:String(state.size),q:state.q}).toString()}
function syncUrl(){
  var p=new URLSearchParams();
  if(state.module)p.set("module",state.module);
  if(state.q)p.set("q",state.q);
  history.replaceState(null,"","/hy/grid.html"+(p.toString()?"?"+p.toString():""));
}
function readJsonSafe(key){try{return JSON.parse(localStorage.getItem(key)||"null")}catch(e){return null}}
function jwtPayload(){
  var t=token(),part=t.split(".")[1];
  if(!part)return {};
  try{return JSON.parse(atob(part.replace(/-/g,"+").replace(/_/g,"/")))}catch(e){return {}}
}
function roleValues(){
  var p=jwtPayload(),u=readJsonSafe("sanlyn_user")||readJsonSafe("user")||{};
  var vals=[p.role,p.user_role,p.user&&p.user.role,u.role,u.user_role];
  if(Array.isArray(p.roles))vals=vals.concat(p.roles);
  if(Array.isArray(u.roles))vals=vals.concat(u.roles);
  return vals.map(function(v){return clean(v).toLowerCase()}).filter(Boolean);
}
function canWriteFinance(){return roleValues().some(function(r){return r==="admin"||r==="finance"})}
function rowPk(row){var v=row&&(row.__pk!=null?row.__pk:row.id);return (v==null||v==="")?null:String(v)}
function moduleActions(){
  if(ROW_ACTIONS[state.module])return ROW_ACTIONS[state.module];
  var names=new Set(state.fields.map(function(f){return clean(f.field_key)}));
  if(names.has("template_key")&&names.has("expected_confirmed_at")&&names.has("sheet_id"))return RECON_LINE_ACTIONS;
  return [];
}
function rowActions(row){return moduleActions().filter(function(a){return !a.show||a.show(row)})}
async function fetchJson(url){return requestJson(url,{method:"GET"})}
async function requestJson(url,opt){
  var options=opt||{},body=options.body;
  if(body===null)return {success:false,cancelled:true};
  var r=await fetch(url,{method:options.method||"GET",headers:headers(body!==undefined),body:body===undefined?undefined:JSON.stringify(body)});
  var j=await r.json().catch(function(){return {}});
  if(!r.ok||!j.success)throw new Error(j.message||j.error||j.detail||JSON.stringify(j)||r.statusText);
  return j;
}
async function init(){
  bind();
  els.q.value=state.q;
  await loadModules();
  if(!state.module&&state.modules.length)state.module=state.modules[0].module_key;
  if(!state.module){showError("缺少 module 参数");return}
  state.hidden=loadHidden();
  syncModuleSelect();
  await load();
}
function bind(){
  els.form.addEventListener("submit",function(ev){ev.preventDefault();search()});
  els.q.addEventListener("keydown",function(ev){if(ev.key==="Enter"){ev.preventDefault();search()}});
  els.prev.addEventListener("click",function(){if(state.page>1){state.page-=1;load()}});
  els.next.addEventListener("click",function(){if(state.page<pages()){state.page+=1;load()}});
  els.page.addEventListener("change",function(){state.page=Math.max(1,Math.min(pages(),Number(els.page.value)||1));load()});
  els.size.addEventListener("change",function(){state.size=Number(els.size.value)||50;state.page=1;load()});
  els.colsBtn.addEventListener("click",function(){els.cols.classList.toggle("open")});
  els.moduleSelect.addEventListener("change",function(){
    var next=clean(els.moduleSelect.value);if(!next||next===state.module)return;
    state.module=next;state.page=1;state.q="";els.q.value="";state.hidden=loadHidden();closeDetail();
    syncUrl();
    load();
  });
  els.grid.addEventListener("click",onGridClick);
  document.addEventListener("click",function(ev){if(!els.cols.contains(ev.target))els.cols.classList.remove("open")});
  // 详情抽屉独立绑定，避免影响现有候选付款弹窗和表格翻页。
  els.detailClose.addEventListener("click",closeDetail);
  els.detail.addEventListener("click",function(ev){if(ev.target===els.detail)closeDetail()});
  els.detailSave.addEventListener("click",saveDetail);
  els.detailBody.addEventListener("input",markChanged);
  document.addEventListener("keydown",function(ev){if(ev.key==="Escape"&&!els.detail.classList.contains("hidden"))closeDetail()});
}
function search(){state.q=clean(els.q.value);state.page=1;syncUrl();load()}
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
    var data=await fetchJson("/api/db/hy-grid?"+qs());
    state.fields=Array.isArray(data.fields)?data.fields:[];
    applyDefaultHidden();
    state.rows=Array.isArray(data.rows)?data.rows:[];
    state.total=Number(data.total||0);
    state.page=Number(data.page||state.page);
    state.size=Number(data.size||state.size);
    els.title.textContent=state.module;
    syncModuleSelect();
    els.stamp.textContent="v2026.09.07-1 · 生成时间 "+(data.generated_at||"--");
    render();
    refreshOpenDetail();
  }catch(e){showError(e.message)}
}
function render(){
  var extra=moduleActions().length&&!canWriteFinance()?" · 需财务权限":"";
  els.status.textContent=state.fields.length+" 列 · "+state.total+" 行"+extra;
  els.page.value=state.page;els.size.value=String(state.size);
  renderColumns();renderTable();renderPager();
}
function renderColumns(){
  els.colsMenu.textContent="";
  orderedFields().forEach(function(f){
    var row=document.createElement("label"),box=document.createElement("input"),txt=document.createElement("span");
    box.type="checkbox";box.checked=!state.hidden.has(f.field_key);
    box.addEventListener("change",function(){box.checked?state.hidden.delete(f.field_key):state.hidden.add(f.field_key);saveHidden();render()});
    txt.textContent=label(f);row.appendChild(box);row.appendChild(txt);els.colsMenu.appendChild(row);
  });
}
function renderTable(){
  var fields=visibleFields(),actions=moduleActions(),showActionCol=actions.length>0;
  if(!fields.length){els.grid.innerHTML='<div class="empty">没有可显示列</div>';return}
  var colCount=fields.length+(showActionCol?1:0);
  var html='<table><colgroup>'+(showActionCol?'<col style="width:170px">':"")+fields.map(function(f){return '<col style="width:'+width(f)+'px">'}).join("")+'</colgroup><thead><tr>'+(showActionCol?'<th class="mid action-col">操作</th>':"");
  html+=fields.map(function(f){var en=clean(f.field_key)||clean(f.label);var cn=label(f);var tip=(cn!==en?cn+"  ·  "+en:en);return '<th class="'+cls(f)+'" title="'+esc(tip)+'">'+esc(cn)+'</th>'}).join("");
  html+='</tr></thead><tbody>';
  if(!state.rows.length)html+='<tr><td colspan="'+colCount+'" class="empty">没有数据</td></tr>';
  state.rows.forEach(function(row,i){
    // data-row 保留当前页索引，抽屉关闭后不改变列表页码和滚动数据。
    html+='<tr class="data-row" data-row="'+i+'">'+(showActionCol?renderActionCell(row,i):"")+fields.map(function(f){return '<td class="'+cls(f)+'" title="'+esc(value(row[f.field_key]))+'">'+esc(value(row[f.field_key]))+'</td>'}).join("");
    html+="</tr>";
  });
  els.grid.innerHTML=html+"</tbody></table>";
}
function renderActionCell(row,index){
  if(!canWriteFinance())return '<td class="mid action-cell"><span class="muted">需财务权限</span></td>';
  if(rowPk(row)==null)return '<td class="mid action-cell"><span class="muted">无主键</span></td>';
  var buttons=rowActions(row).map(function(a){return '<button class="btn row-action" type="button" data-row="'+index+'" data-action="'+esc(a.key)+'">'+esc(a.label)+'</button>'}).join("");
  return '<td class="mid action-cell">'+(buttons||'<span class="muted">-</span>')+'</td>';
}
function onGridClick(ev){
  var btn=ev.target.closest&&ev.target.closest("button.row-action");
  if(btn){
    if(state.busy)return;
    var row=state.rows[Number(btn.getAttribute("data-row"))],key=btn.getAttribute("data-action");
    if(rowPk(row)==null){alert("该行无主键，无法执行操作");return}
    var action=moduleActions().find(function(a){return a.key===key});
    if(row&&action)runAction(action,row,btn);
    return;
  }
  // 行点击打开详情；操作按钮优先处理，保证 4 个对账模块原动作不变。
  var tr=ev.target.closest&&ev.target.closest("tr.data-row");
  if(tr)openDetail(Number(tr.getAttribute("data-row")));
}
async function runAction(action,row,btn){
  if(action.confirm&&!confirm(action.confirm))return;
  state.busy=true;btn.disabled=true;
  var old=btn.textContent;btn.textContent="处理中";els.status.textContent="处理中";
  try{
    var data=await requestJson(action.url(row),{method:action.method||"POST",body:action.body?action.body(row):{}});
    if(data.cancelled)return;
    if(action.success)action.success(data,row);else alert("操作成功");
    if(!action.success)await load();else render();
  }catch(e){alert(e.message);els.status.textContent=e.message}
  finally{state.busy=false;btn.disabled=false;btn.textContent=old}
}
function openDetail(index){
  var row=state.rows[index];
  if(!row)return;
  state.detailIndex=index;
  state.detailRow=row;
  state.detailOriginal=snapshot(row);
  renderDetail();
  els.detail.classList.remove("hidden");
  els.detail.setAttribute("aria-hidden","false");
}
function closeDetail(){
  els.detail.classList.add("hidden");
  els.detail.setAttribute("aria-hidden","true");
  state.detailIndex=null;state.detailRow=null;state.detailOriginal={};
  els.detailError.textContent="";
}
function snapshot(row){
  var out={};
  state.fields.forEach(function(f){out[f.field_key]=value(row[f.field_key])});
  return out;
}
function refreshOpenDetail(){
  if(state.detailIndex==null||els.detail.classList.contains("hidden"))return;
  var oldPk=rowPk(state.detailRow),next=null,i;
  for(i=0;i<state.rows.length;i++){if(rowPk(state.rows[i])===oldPk){next=state.rows[i];state.detailIndex=i;break}}
  if(!next)next=state.rows[state.detailIndex];
  if(next){state.detailRow=next;state.detailOriginal=snapshot(next);renderDetail()}
}
function renderDetail(){
  var row=state.detailRow,pk=rowPk(row),groups=sectionGroups(),readonly=isDetailReadonly(row);
  els.detailTitle.textContent=state.module+" 行详情";
  els.detailMeta.textContent=readonly?"本表只读(视图或无主键),仅供查看":"主键 "+pk;
  els.detailMeta.style.color="var(--hgj-muted,#667085)";
  els.detailError.textContent="";
  els.detailSave.style.display=readonly?"none":"";
  els.detailSave.disabled=false;
  var docsHtml=(window.HyGridDocs&&window.HyGridDocs.section)?window.HyGridDocs.section(row,{token:token()}):"";
  els.detailBody.innerHTML=docsHtml+(groups.map(function(g){
    return '<section class="detail-section"><div class="detail-section-title">'+esc(g.label)+'</div><div class="detail-grid">'+g.fields.map(function(f){return renderDetailField(f,row,readonly)}).join("")+'</div></section>';
  }).join("")||'<div class="empty">没有字段</div>');
}
function sectionGroups(){
  var map={},list=[];
  detailFields().forEach(function(f){
    // section 配置不存在时落到“其他”，字段不丢失。
    var key=clean(f.section_key)||"__other__",labelText=clean(f.section_label_cn)||clean(f.section_label)||"其他";
    if(!map[key]){map[key]={key:key,label:labelText,order:num(f.section_order),fields:[]};list.push(map[key])}
    map[key].fields.push(f);
  });
  return list.sort(function(a,b){return a.order-b.order||a.label.localeCompare(b.label)});
}
function isDetailReadonly(row){
  // 视图行没有主键列，真表也可能无主键；没有可编辑字段时同样不能保存，必须在 UI 明确只读。
  return rowPk(row)==null||!hasEditableFields();
}
function hasEditableFields(){
  return state.fields.some(function(f){return isEditable(f)});
}
function isEditable(f){
  // 后端白名单是 editable=true 且 input_kind 非空；前端只按同一条件放开输入。
  return truthy(f.editable)&&clean(f.input_kind)!=="";
}
function truthy(v){return v===true||v===1||v==="1"||String(v).toLowerCase()==="true"}
function renderDetailField(f,row,readonly){
  var key=clean(f.field_key),span=Math.max(1,Math.min(6,Number(f.col_span||2))),v=value(row[key]);
  return '<div class="detail-field span-'+span+'"><label class="detail-label" title="'+esc(key)+'">'+esc(label(f))+'</label>'+fieldControl(f,v,readonly)+'</div>';
}
function fieldControl(f,v,readonly){
  var key=clean(f.field_key),k=clean(f.input_kind).toLowerCase();
  if(readonly||!isEditable(f))return '<div class="detail-readonly">'+esc(v)+'</div>';
  if(k==="textarea"||k==="multiline")return '<textarea class="detail-input" data-field="'+esc(key)+'">'+esc(v)+'</textarea>';
  if(k==="select"||k==="enum")return selectControl(f,v);
  if(k==="checkbox"||k==="boolean"||k==="bool")return '<input class="detail-input" data-field="'+esc(key)+'" type="checkbox" '+(truthy(v)?"checked":"")+'>';
  if(k==="date")return '<input class="detail-input" data-field="'+esc(key)+'" type="date" value="'+esc(dateValue(v))+'">';
  if(k==="datetime"||k==="datetime-local")return '<input class="detail-input" data-field="'+esc(key)+'" type="datetime-local" value="'+esc(dateTimeValue(v))+'">';
  if(k==="number"||k==="numeric"||k==="decimal"||k==="integer"||k==="money")return '<input class="detail-input" data-field="'+esc(key)+'" type="number" step="any" value="'+esc(v)+'">';
  // 未知 input_kind 降级 text，保证字段可见可存，不因为新控件类型报错。
  return '<input class="detail-input" data-field="'+esc(key)+'" type="text" value="'+esc(v)+'">';
}
function selectControl(f,v){
  var opts=optionList(f),html='<select class="detail-input" data-field="'+esc(f.field_key)+'">';
  if(!opts.length)opts=[v];
  opts.forEach(function(o){html+='<option value="'+esc(o)+'" '+(String(o)===String(v)?"selected":"")+'>'+esc(o)+'</option>'});
  return html+"</select>";
}
function optionList(f){
  var raw=f.options||f.enum_values||f.choices||f.value_options;
  if(Array.isArray(raw))return raw.map(function(o){return typeof o==="object"?clean(o.value||o.key||o.label):clean(o)}).filter(Boolean);
  if(typeof raw==="string")return raw.split(/[,\n|]/).map(clean).filter(Boolean);
  return [];
}
function dateValue(v){
  v=clean(v);
  if(!v)return "";
  return v.slice(0,10);
}
function dateTimeValue(v){
  v=clean(v);
  if(!v)return "";
  return v.replace(" ","T").slice(0,16);
}
function markChanged(ev){
  var el=ev.target,field=el&&el.getAttribute&&el.getAttribute("data-field");
  if(!field)return;
  if(String(inputValue(el))!==String(state.detailOriginal[field]||""))el.classList.add("changed");else el.classList.remove("changed");
}
function collectChanges(){
  var changes={},inputs=els.detailBody.querySelectorAll("[data-field]");
  Array.prototype.forEach.call(inputs,function(el){
    var field=el.getAttribute("data-field"),next=inputValue(el),old=state.detailOriginal[field];
    if(String(next)!==String(old==null?"":old))changes[field]=next;
  });
  return changes;
}
function inputValue(el){
  if(el.type==="checkbox")return el.checked;
  return el.value;
}
async function saveDetail(){
  if(state.busy)return;
  var row=state.detailRow,pk=rowPk(row),changes=collectChanges();
  if(isDetailReadonly(row)){els.detailError.textContent="本表只读，无法保存";return}
  if(pk==null){els.detailError.textContent="该行无主键，无法保存";return}
  if(!Object.keys(changes).length){els.detailError.textContent="没有改动";return}
  state.busy=true;els.detailSave.disabled=true;els.detailSave.textContent="保存中";els.detailError.textContent="";
  try{
    await requestJson("/api/db/hy-grid-write",{method:"PATCH",body:{module:state.module,id:pk,changes:changes}});
    await refreshAfterSave(pk);
    els.detailError.textContent="已保存";
  }catch(e){
    // 保存失败必须展示后端原文，方便直接看到字段白名单或权限错误。
    els.detailError.textContent=e.message;
    els.status.textContent=e.message;
  }finally{
    state.busy=false;els.detailSave.disabled=isDetailReadonly(state.detailRow);els.detailSave.textContent="保存";
  }
}
async function refreshAfterSave(pk){
  var data=await fetchJson("/api/db/hy-grid?"+qs()),next=null,i;
  state.fields=Array.isArray(data.fields)?data.fields:state.fields;
  state.rows=Array.isArray(data.rows)?data.rows:state.rows;
  state.total=Number(data.total||state.total);
  for(i=0;i<state.rows.length;i++){if(rowPk(state.rows[i])===String(pk)){next=state.rows[i];state.detailIndex=i;break}}
  if(next){state.detailRow=next;state.detailOriginal=snapshot(next)}
  render();
  if(next)renderDetail();
}
function ensureModal(){
  if(els.modal)return els.modal;
  var m=document.createElement("div");
  m.id="actionModal";m.className="modal hidden";
  document.body.appendChild(m);els.modal=m;
  m.addEventListener("click",function(ev){if(ev.target===m||ev.target.classList.contains("modal-close"))hideModal()});
  m.addEventListener("click",onModalClick);
  return m;
}
function hideModal(){if(els.modal)els.modal.classList.add("hidden")}
function showSettleModal(row,candidates){
  state.modalLine=row;state.modalCandidates=Array.isArray(candidates)?candidates:[];
  var m=ensureModal();
  var html='<div class="modal-panel"><div class="modal-head"><strong>候选付款</strong><button class="btn modal-close" type="button">关闭</button></div>';
  if(!state.modalCandidates.length){html+='<div class="empty">没有候选付款</div></div>';m.innerHTML=html;m.classList.remove("hidden");return}
  html+='<div class="candidate-list">'+state.modalCandidates.map(function(c,i){
    var amt=moneyText(c.amount),date=clean(c.paid_date),contract=clean(c.contract_no||c.order_no),customer=clean(c.customer||c.company_code),diff=moneyText(c.diff_amount);
    return '<div class="candidate"><div class="candidate-info"><b>'+esc(amt)+'</b><span>'+esc(date||"无日期")+'</span><span>'+esc(contract||"无合同号")+'</span><span>'+esc(customer||"无客户")+'</span><span>差额 '+esc(diff)+'</span></div><div class="candidate-use"><input type="number" min="0.01" step="0.01" value="'+esc(c.amount)+'" data-amount="'+i+'"><button class="btn primary settle-use" type="button" data-index="'+i+'">用这笔核销</button></div></div>';
  }).join("")+'</div></div>';
  m.innerHTML=html;m.classList.remove("hidden");
}
async function onModalClick(ev){
  var btn=ev.target.closest&&ev.target.closest("button.settle-use");
  if(!btn||state.busy)return;
  var i=Number(btn.getAttribute("data-index")),c=state.modalCandidates[i],row=state.modalLine;
  var input=els.modal.querySelector('input[data-amount="'+i+'"]');
  var amount=Number(input&&input.value);
  if(!c||!row)return;
  if(rowPk(row)==null){alert("该行无主键，无法执行操作");return}
  if(!Number.isFinite(amount)||amount<=0){alert("amount_applied 必须 >0");return}
  if(!confirm("确认用这笔付款核销当前明细行？"))return;
  state.busy=true;btn.disabled=true;btn.textContent="核销中";
  try{
    await requestJson("/api/db/recon-persist?action=settle-confirm&id="+encodeURIComponent(rowPk(row)),{method:"POST",body:{payment_id:c.id,amount_applied:amount}});
    alert("核销成功");hideModal();await load();
  }catch(e){alert(e.message);els.status.textContent=e.message}
  finally{state.busy=false;btn.disabled=false;btn.textContent="用这笔核销"}
}
function moneyText(v){return v==null||v===""?"":String(v)}
function value(v){if(v==null)return "";if(typeof v==="object")return JSON.stringify(v);return v}
function pages(){return Math.max(1,Math.ceil(state.total/state.size))}
function renderPager(){
  var start=state.total?(state.page-1)*state.size+1:0,end=Math.min(state.total,state.page*state.size);
  els.summary.textContent=start+"-"+end+" / "+state.total;
  els.prev.disabled=state.page<=1;els.next.disabled=state.page>=pages();
}
function showError(msg){els.status.textContent="读取失败："+msg;els.grid.innerHTML='<div class="empty">无法加载数据</div>'}
init();
})();
