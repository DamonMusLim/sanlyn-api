(function(){
"use strict";
var MAX_TABS=20,FIXED_ID="hy-workbench",STORAGE_KEY="sanlyn.hyTabs.v1";
var PORTS=["上海","青岛","厦门","天津大连","深圳南沙"],CHANNELS=["舱单发送","AFR","AMS","ISF","EM&ACI","VGM","ICS2"],dataLeaves=[];
PORTS.forEach(function(port){CHANNELS.forEach(function(channel){dataLeaves.push(port+"-"+channel)})});
var NAV=[
  item("工作台"),
  item("运价管理"),
  item("发件台",["待发","待回复","已发送","谁未回复","异常卡点","选模板发信"]),
  item("报价管理",["单票报价","费用模板","往来单位"]),
  item("集运订单",["待接单","海运出口","海运进口","空运出口","空运进口","物流园报关","陆运","铁路运输","内贸水运","自拼"]),
  item("数据通道",["船期市场"].concat(dataLeaves)),
  item("费用管理",["外币核销与汇损","对账单-账单","对账单-明细行","对账单-事件流","对账单-异常","集运费用明细","账单管理","开票记录","收付管理","核销管理","提成管理","应收账龄表","应收账龄-数据警告","欠供应商多少","资金缺口(应收+应付)","银行对账-汇总","银行对账-明细","水单↔流水对账","水单↔流水-全部候选","水单认领体检"]),
  item("工资社保",["工资表(柠檬云式)","工资-三家合并","工资-集团审核汇总","工资-银行代发文件","银行代发模板","五险一金费率","个税税率表","个税申报表-字段映射"]),
  item("柠檬云同步",["同步状态","同步运行记录","资金线健康"]),
  item("提单管理"),
  item("报关/箱货/仓储",["订舱平台","在线报关","箱货信息","报关信息","仓储信息","舱单字段规则","盯箱宝","全程货物跟踪","SPOT电商"]),
  // 2026-08-31 待办中心:舱单/VGM 这类"我们自己去外部平台提交"的活,统一变待办
  // 2026-08-31 Damon:「AI员工开始步入我们的hy系统」—— 工位 + 上岗判定
  item("AI员工",["员工工位(我干的/我审的)","上岗判定","能力授权","动作台账","舱单字段规格","委派映射"]),
  item("待办中心",["运维待办","我方待办(舱单·VGM)","我方自办完成度","舱单字段差距","钱进来的缺口"]),
  item("审核管理",["审核提交记录","报价审核","费用模板审核","订单审核","提单审核","费用审核","账单审核","往来公司审核","合同审核"]),
  item("货运保险"),
  item("报表中心",["业务报表","财务报表"]),
  item("自定义导航")
];
var WORKBENCH_LINKS=[
  {title:"海运总表",url:"/ocean",desc:"订单、箱货、费用汇总"},
  {title:"价表总台",url:"/rates",desc:"海运周价与官方港杂"},
  {title:"录入表单",url:"/ship-entry",desc:"发运资料录入"},
  {title:"主表",url:"/ship-grid",desc:"海运主数据表"}
];
var DEDICATED={
  // 2026-09-03 智能邮箱改指真邮件中心(mini:3760,nginx /email/ 已反代)。
  // 那边有 4612 封真邮件 + 收件箱/待审草稿/账单 三个真 tab;
  // 原 /smart-email 只是个统计壳子(模板13/主体2/记录5),没有收件箱,Damon 看不到东西。
  // Damon 0903:「这里我就显示 ob@ 的邮箱,待发,待回」
  // ob-biz 实测 34 封(待发31/待回4);全库4612封里4511封是私人邮箱(gmail3508+qq1003),
  // 不过滤就全混在一起看不清。account_id/needs_reply 参数服务端本就支持,无需改后端。
  // 2026-09-03 二改(Damon:「把邮箱去掉,这个作为后端,前端就显示 待发邮件/内容审核/负责人/已发送/谁未回复」)
  // 前台改指 hy 自己的发件台 /hy/mail.html(六标签,待发行可就地改 收件人/抄送/主题/正文/附件,
  // 改动强制写 mail_outbox.before_edit+edited_fields)。原始邮件中心 /email/ 退居后端,不再摆在菜单第一层。
  // ⛔ 发件台页面【故意没有发送按钮】—— 发送是红线,Damon 审过才发,别加。
  "发件台":"/hy/mail.html#draft",
  "发件台/待发":"/hy/mail.html#draft",
  "发件台/待回复":"/hy/mail.html#reply",
  "发件台/已发送":"/hy/mail.html#sent",
  "发件台/谁未回复":"/hy/mail.html#cold",
  "发件台/异常卡点":"/hy/mail.html#risk",
  "发件台/选模板发信":"/hy/mail.html#new",
  "集运订单/陆运":"/hy/trucking-rates.html",
  "报关/箱货/仓储/订舱平台":"/hy/booking-platform.html",
  "提单管理":"/hy/bl-management.html",
  "报关/箱货/仓储/在线报关":"/hy/online-customs.html",
  "报关/箱货/仓储/报关信息":"/hy/manifest-entry.html",
  "自定义导航":"/hy/custom-nav.html",
  "报关/箱货/仓储/箱货信息":"/hy/cargo-info.html",
  "报关/箱货/仓储/仓储信息":"/hy/warehouse-info.html",
  "报关/箱货/仓储/盯箱宝":"/hy/container-watch.html",
  "报关/箱货/仓储/全程货物跟踪":"/hy/shipment-tracking.html",
  "报关/箱货/仓储/SPOT电商":"/hy/spot-ecommerce.html",
  "工资社保/工资表(柠檬云式)":"v_payroll_lemon_style",
  "工资社保/工资-三家合并":"v_payroll_group_3co",
  "工资社保/工资-集团审核汇总":"v_payroll_group_review",
  "工资社保/工资-银行代发文件":"v_payroll_bank_export",
  "工资社保/银行代发模板":"bank_payment_templates",
  "工资社保/五险一金费率":"hr_insurance_rates",
  "工资社保/个税税率表":"hr_tax_brackets",
  "工资社保/个税申报表-字段映射":"tax_report_field_map",
  "柠檬云同步/同步状态":"v_lemon_sync_status",
  "柠檬云同步/同步运行记录":"v_lemon_sync_runs",
  "柠檬云同步/资金线健康":"v_money_line_health",
  "待办中心/运维待办":"operation_todos",
  "费用管理/外币核销与汇损":"v_fx_settlement",
  "费用管理/对账单-账单":"recon_sheets",
  "费用管理/对账单-明细行":"recon_lines",
  "费用管理/对账单-事件流":"recon_events",
  "费用管理/对账单-异常":"finance_recon_exceptions",
  "费用管理/集运费用明细":"/hy/consolidated-fee-details.html",
  "费用管理/开票记录":"/hy/invoice-records.html",
  "费用管理/收付管理":"/hy/receipt-payment-management.html",
  "费用管理/核销管理":"/hy/settlement-management.html",
  "费用管理/提成管理":"/hy/commission-management.html",
  "报表中心/业务报表":"/hy/business-report.html",
  "报表中心/财务报表":"/hy/financial-report.html"
};
var MODULE_MAP={
  "运价管理":"freight_rates",
  "费用管理/集运费用明细":"freight_supplier_bills",
  "费用管理/账单管理":"freight_bills",
  "费用管理/开票记录":"finance_invoices_in",
  "费用管理/收付管理":"finance_payments",
  "费用管理/核销管理":"finance_settlement_links",
  "货运保险":"insurance_policies",
  "报价管理/费用模板":"local_charges",
  "集运订单/海运出口":"shipping_plans",
  "集运订单/待接单":"orders",
  "报关/箱货/仓储/箱货信息":"order_line_items",
  "报价管理/往来单位":"companies",
  "报价管理/单票报价":"service_rates",
  "数据通道/船期市场":"market_sailings",
  // 2026-08-30 审核流=AI员工(skills)替人审,数据在 ai_business_write_audit(AI改业务的完整留痕:
  // 谁改/哪个模型/改前改后/依据/验证SQL哈希/可回滚)。Damon:「审核流也是我常说的我们的skills,要接替上真人」,
  // 2026-08-30 审核流:每个入口对应真负责人+独立数据源视图(见 hy_audit_registry),⛔不是同一张表换名字
  "审核管理/审核提交记录":"v_hy_audit_all",
  "审核管理/订单审核":"v_hy_audit_order",
  "审核管理/费用审核":"v_hy_audit_fee",
  "审核管理/账单审核":"v_hy_audit_bill",
  "审核管理/报价审核":"v_hy_audit_quote",
  "审核管理/提单审核":"v_hy_audit_bl",
  "审核管理/往来公司审核":"v_hy_audit_company",
  "审核管理/合同审核":"v_hy_audit_contract",
  "审核管理/费用模板审核":"v_hy_audit_fee_template",
  // 2026-08-31 Damon:「以后舱单这些的我们自己来提交和处理会变成待办」
  // 舱单/VGM 在海管家是外部平台人工提交(cangdan.hgj.com),我方节点标 actor_mode='manual_us',
  // gen_hy_manual_todos() 自动开/关待办写 operation_todos。规则来源=海管家官方使用手册+GoodsRules。
  "待办中心/我方待办(舱单·VGM)":"v_hy_manual_todos",
  "待办中心/我方自办完成度":"v_hy_manual_gap",
  "待办中心/舱单字段差距":"v_manifest_field_coverage",
  "待办中心/钱进来的缺口":"v_fin_money_in_todos",
  // 2026-08-31 照海管家账龄表补的;银行流水匹配是他们没有的能力
  "费用管理/应收账龄表":"v_ar_aging",
  "费用管理/应收账龄-数据警告":"v_ar_aging_caveat",
  "费用管理/欠供应商多少":"v_payable_by_supplier",
  "费用管理/资金缺口(应收+应付)":"v_cash_gap",
  // acfin 0831 已建,这里只是接进来,⛔不复制
  "费用管理/银行对账-汇总":"v_bank_recon_sheet",
  "费用管理/银行对账-明细":"v_bank_recon_detail",
  "费用管理/水单↔流水对账":"v_slip_flow_match_unique",
  "费用管理/水单↔流水-全部候选":"v_slip_flow_match",
  "费用管理/水单认领体检":"v_slip_alloc_readiness",
  "AI员工/员工工位(我干的/我审的)":"v_ai_staff_desk",
  "AI员工/上岗判定":"v_ai_staff_onboarding",
  "AI员工/能力授权":"staff_capabilities",
  "AI员工/动作台账":"staff_actions",
  "AI员工/舱单字段规格":"todo_check_specs",
  "AI员工/委派映射":"v_todo_delegate_gap",
  "报关/箱货/仓储/舱单字段规则":"manifest_field_rules"
};
var REMOVED_SHELL_PAGES=[];
var moduleRows=[],moduleSet={},REAL_PATHS=unique(Object.keys(DEDICATED).map(function(k){return pathOnly(DEDICATED[k])}).concat(WORKBENCH_LINKS.map(function(x){return pathOnly(x.url)}),["/hy/grid.html"]));
var DEFAULT_TABS=[{id:FIXED_ID,title:"工作台",url:"",fixed:true,sourceName:"工作台",workbench:true}];
var state=loadState(),tabsEl=$("tabs"),stageEl=$("stage"),navEl=$("sideNav"),toastEl=$("toast"),moduleTitle=$("moduleTitle"),toastTimer=0,dragId="";
var MODULE_STATE={};
var MODULE_BY_NAME={};
var STATUS_LABEL={
  live:"表",
  partial:"部分",
  not_wired:"还没接通",
  blocked_external:"卡外部签约",
  paid_module:"待开通"
};
var STATUS_CLASS={
  partial:"hy-st-partial",
  not_wired:"hy-st-not_wired",
  blocked_external:"hy-st-blocked_external",
  paid_module:"hy-st-paid_module"
};
var STATUS_FALLBACK_NOTE="未登记状态,按未接通处理";
window.SanlynHyShell={nav:NAV,dedicated:DEDICATED,moduleMap:MODULE_MAP,removedShellPages:REMOVED_SHELL_PAGES,workbenchLinks:WORKBENCH_LINKS,topLevelCount:NAV.length,leafCount:countLeaves(NAV),realPageCount:REAL_PATHS.length,stateCounts:stateCounts(),dataTableCount:0,pendingCount:pendingLeaves().length,pendingLeaves:pendingLeaves(),pendingLeavesWithUrl:0};
$("generatedAt").textContent="生成时间 "+new Date().toLocaleString("zh-CN");
renderNav();mountSearch();bindShell();render();loadModules();loadModuleStatus();
function item(name,children){return {name:name,children:(children||[]).map(function(x){return {name:x,parent:name}})}}
function $(id){return document.getElementById(id)}
function leafKey(name,parent){return parent?parent+"/"+name:name}
function dedicatedUrl(name,parent){return DEDICATED[leafKey(name,parent)]||DEDICATED[name]||""}
function mappedModule(name,parent){return MODULE_MAP[leafKey(name,parent)]||MODULE_MAP[name]||""}
function gridUrl(moduleKey){return moduleKey&&moduleSet[moduleKey]?"/hy/grid.html?module="+encodeURIComponent(moduleKey):""}
function navUrl(name,parent,moduleKey){return dedicatedUrl(name,parent)||gridUrl(moduleKey||mappedModule(name,parent))}
function pathOnly(url){try{return new URL(url,location.origin).pathname}catch(e){return ""}}
function getModuleStatus(name,parent){
  if(!MODULE_STATE)return null;
  var row=MODULE_STATE[leafKey(name,parent||"")];
  if(row)return row;
  if(!parent&&MODULE_BY_NAME&&MODULE_BY_NAME[name])return MODULE_BY_NAME[name];
  return null;
}
function statusLabel(row){
  return row&&STATUS_LABEL[row.state]?STATUS_LABEL[row.state]:STATUS_LABEL.not_wired;
}
function pendingStatusText(row){
  return row&&STATUS_LABEL[row.state]?STATUS_LABEL[row.state]:STATUS_FALLBACK_NOTE;
}
function escapeHtml(value){
  return String(value==null?"":value).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
async function loadModuleStatus(){
  try{
    var data=await fetchJson("/api/db/hy-module-status");
    MODULE_STATE={};MODULE_BY_NAME={};
    var modules=Array.isArray(data.modules)?data.modules:[],byName={},nameCount={};
    modules.forEach(function(row){
      if(row&&row.leaf_key)MODULE_STATE[row.leaf_key]=row;
      if(row&&row.module_cn){byName[row.module_cn]=row;nameCount[row.module_cn]=(nameCount[row.module_cn]||0)+1}
    });
    Object.keys(byName).forEach(function(name){
      if(nameCount[name]===1)MODULE_BY_NAME[name]=byName[name];
    });
    Array.prototype.slice.call(stageEl.querySelectorAll(".frame.placeholder")).forEach(function(el){el.remove()});
    renderNav();render();
  }catch(e){console.warn("[hy] 模块状态读取失败："+e.message)}
}
function unique(list){return list.filter(function(v,i){return v&&list.indexOf(v)===i})}
function countLeaves(nav){return nav.reduce(function(sum,node){return sum+(node.children&&node.children.length?node.children.length:1)},0)}
function authHeaders(){var h={},t=localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||"";if(t)h.Authorization="Bearer "+t;return h}
async function fetchJson(url){var r=await fetch(url,{headers:authHeaders()}),j=await r.json().catch(function(){return {}});if(!r.ok||!j.success)throw new Error(j.error||r.statusText);return j}
async function loadModules(){
  try{
    var data=await fetchJson("/api/db/hy-modules");
    moduleRows=Array.isArray(data.modules)?data.modules:[];moduleSet={};
    moduleRows.forEach(function(row){moduleSet[row.module_key]=row});
    appendDataTables();publishDebug();renderNav();render();
  }catch(e){showToast("模块目录读取失败："+e.message)}
}
function appendDataTables(){
  NAV=NAV.filter(function(node){return node.name!=="数据表"});
  var used={};Object.keys(MODULE_MAP).forEach(function(k){used[MODULE_MAP[k]]=true});
  var leaves=moduleRows.filter(function(row){return !used[row.module_key]}).map(function(row){return {name:row.module_key,parent:"数据表",module_key:row.module_key}});
  if(leaves.length)NAV.push({name:"数据表",children:leaves});
}
function publishDebug(){
  var dataTable=NAV.find(function(node){return node.name==="数据表"}),counts=stateCounts();
  window.SanlynHyShell.nav=NAV;window.SanlynHyShell.topLevelCount=NAV.length;window.SanlynHyShell.leafCount=countLeaves(NAV);
  window.SanlynHyShell.stateCounts=counts;window.SanlynHyShell.dataTableCount=dataTable&&dataTable.children?dataTable.children.length:0;
  window.SanlynHyShell.pendingCount=counts.pending;window.SanlynHyShell.pendingLeaves=pendingLeaves();
}
function pendingLeaves(){
  var out=[];walkLeaves(function(leaf,parent){if(leaf.name!=="工作台"&&!navUrl(leaf.name,parent,leaf.module_key))out.push(leaf.name)});
  return out;
}
function stateCounts(){
  var counts={dedicated:0,grid:0,pending:0};
  walkLeaves(function(leaf,parent){
    if(leaf.name==="工作台")return;
    if(dedicatedUrl(leaf.name,parent))counts.dedicated+=1;
    else if(gridUrl(leaf.module_key||mappedModule(leaf.name,parent)))counts.grid+=1;
    else counts.pending+=1;
  });
  return counts;
}
function walkLeaves(fn){NAV.forEach(function(node){(node.children&&node.children.length?node.children:[node]).forEach(function(leaf){fn(leaf,node.children?node.name:"")})})}
function renderNav(){
  navEl.textContent="";
  NAV.forEach(function(node){
    var sec=document.createElement("div"),main=document.createElement("button"),leafs=document.createElement("div"),has=node.children&&node.children.length;
    sec.className="nav-section"+(has?" open":"");main.className="nav-main";main.type="button";
    main.innerHTML='<span class="nav-caret"></span><span class="nav-main-title"></span><span class="nav-status"></span>';
    main.querySelector(".nav-caret").textContent=has?"▾":"";main.querySelector(".nav-main-title").textContent=node.name;setStatus(main,node.name,"",has);
    main.addEventListener("click",function(){has?sec.classList.toggle("open"):openNav(node.name,"",node.module_key)});
    sec.appendChild(main);leafs.className="nav-leaves";
    (node.children||[]).forEach(function(leaf){
      var b=document.createElement("button");b.type="button";b.className="nav-leaf";b.innerHTML='<span class="nav-leaf-title"></span><span class="nav-status"></span>';
      b.querySelector(".nav-leaf-title").textContent=leaf.name;setStatus(b,leaf.name,node.name,false,leaf.module_key);
      b.addEventListener("click",function(){openNav(leaf.name,node.name,leaf.module_key)});leafs.appendChild(b);
    });
    sec.appendChild(leafs);navEl.appendChild(sec);
  });
}
function setStatus(btn,name,parent,hasChildren,moduleKey){
  var ready=!hasChildren&&(name==="工作台"||!!navUrl(name,parent,moduleKey));
  var row=!hasChildren?getModuleStatus(name,parent):null,status=btn.querySelector(".nav-status"),klass=row?STATUS_CLASS[row.state]:"";
  btn.classList.toggle("pending",!hasChildren&&!ready);
  btn.classList.remove("hy-st-partial","hy-st-not_wired","hy-st-blocked_external","hy-st-paid_module");
  if(klass)btn.classList.add(klass);
  status.textContent=hasChildren?"":(row&&row.state==="live"?"表":(row&&STATUS_LABEL[row.state]?STATUS_LABEL[row.state]:(dedicatedUrl(name,parent)?"":(ready?"表":"待建"))));
}
function mountSearch(){if(window.SanlynGlobalSearch)window.SanlynGlobalSearch.mount($("topSearch"),{open:openSearchItem})}
function openSearchItem(item){openTab({title:item.label||"搜索结果",url:item.url})}
function bindShell(){
  window.addEventListener("message",function(event){
    if(event.origin!==location.origin||!trustedFrameSource(event.source))return;
    var d=event.data||{};if(d.type!=="sanlyn:open-tab"&&d.type!=="open-tab")return;
    openTab({id:d.id,title:d.title||d.url,url:d.url,sourceName:d.sourceName||d.title});
  });
  document.querySelector(".float-tools").addEventListener("click",function(e){
    var b=e.target.closest("button");if(!b)return;
    if(b.dataset.tool==="刷新")refreshActive();
    if(b.dataset.tool==="搜索")focusSearch();
    if(b.dataset.tool==="返回首页")openNav("工作台");
  });
  $("noticeBtn").addEventListener("click",function(){showToast("通知模块待建")});
}
function openNav(name,parent,moduleKey){
  if(name==="工作台"){state.activeId=FIXED_ID;saveState();render();return}
  var url=navUrl(name,parent||"",moduleKey);
  if(!url){openPending(name,parent||"");return}
  openTab({title:name,url:url,sourceName:name});
}
function openPending(name,parent){
  var row=getModuleStatus(name,parent||""),label=statusLabel(row),id="pending-"+sanitizeId(leafKey(name,parent||"")),existing=state.tabs.find(function(t){return t.id===id});
  if(existing){state.activeId=existing.id;saveState();render();return}
  if(state.tabs.length>=MAX_TABS)return showToast("最多同时打开 20 个标签页");
  state.tabs.push({id:id,title:name+" · "+label,url:"",pending:true,fixed:false,sourceName:name,parentName:parent||""});
  state.activeId=id;saveState();render();showToast(name+" "+label);
}
function loadState(){
  try{
    var raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");
    if(!raw||!Array.isArray(raw.tabs))return {activeId:FIXED_ID,tabs:DEFAULT_TABS.slice()};
    var tabs=raw.tabs.map(normalizeStoredTab).filter(Boolean).slice(0,MAX_TABS);
    if(!tabs.some(function(t){return t.id===FIXED_ID}))tabs.unshift(DEFAULT_TABS[0]);
    tabs=tabs.map(function(t){return t.id===FIXED_ID?DEFAULT_TABS[0]:t});
    return {activeId:tabs.some(function(t){return t.id===raw.activeId})?raw.activeId:FIXED_ID,tabs:tabs};
  }catch(e){return {activeId:FIXED_ID,tabs:DEFAULT_TABS.slice()}}
}
function normalizeStoredTab(tab){
  if(!tab||typeof tab.id!=="string"||typeof tab.title!=="string")return null;
  if(tab.pending){
    var sourceName=typeof tab.sourceName==="string"?tab.sourceName:tab.title.replace(/ · [^·]+$/,""),parentName=typeof tab.parentName==="string"?tab.parentName:"";
    return {id:sanitizeId(tab.id),title:tab.title,url:"",pending:true,fixed:false,sourceName:sourceName,parentName:parentName};
  }
  var url=normalizeUrl(tab.url);if(!url)return null;
  return {id:sanitizeId(tab.id),title:tab.title,url:url,fixed:!!tab.fixed,sourceName:tab.sourceName||tab.title};
}
function saveState(){localStorage.setItem(STORAGE_KEY,JSON.stringify({activeId:state.activeId,tabs:state.tabs}))}
function render(){
  tabsEl.textContent="";
  state.tabs.forEach(function(tab){
    var btn=document.createElement("div");btn.className="tab";btn.dataset.id=tab.id;btn.draggable=!tab.fixed;btn.setAttribute("role","tab");btn.tabIndex=0;btn.setAttribute("aria-selected",String(tab.id===state.activeId));btn.title=tab.title+(tab.url?" · "+tab.url:"");
    btn.innerHTML='<span class="tab-title"></span><button class="close" type="button" title="关闭">×</button>';
    btn.querySelector(".tab-title").textContent=tab.title;btn.querySelector(".close").hidden=!!tab.fixed;
    btn.onclick=function(){activateTab(tab.id)};btn.onkeydown=function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();activateTab(tab.id)}};
    btn.querySelector(".close").onclick=function(ev){ev.stopPropagation();closeTab(tab.id)};
    btn.addEventListener("dragstart",onDragStart);btn.addEventListener("dragover",onDragOver);btn.addEventListener("drop",onDrop);btn.addEventListener("dragend",onDragEnd);
    tabsEl.appendChild(btn);ensurePane(tab);
  });
  Array.from(stageEl.children).forEach(function(pane){if(!state.tabs.some(function(t){return t.id===pane.dataset.id}))pane.remove()});
  updatePaneVisibility();syncNav();var active=activeTab();moduleTitle.textContent=active?active.sourceName||active.title:"工作台";
}
function ensurePane(tab){
  var pane=stageEl.querySelector('.frame[data-id="'+cssEscape(tab.id)+'"]');if(pane)return;
  if(tab.id===FIXED_ID){pane=document.createElement("section");pane.className="frame hy-workbench";pane.dataset.id=tab.id;renderWorkbenchPane(pane)}
  else if(tab.pending){
    pane=document.createElement("section");pane.className="frame placeholder";pane.dataset.id=tab.id;
    var sourceName=tab.sourceName||tab.title.replace(/ · [^·]+$/,""),row=getModuleStatus(sourceName,tab.parentName||""),statusText=pendingStatusText(row),note=row&&row.note?row.note:STATUS_FALLBACK_NOTE,moduleKey=row&&row.our_module_key?row.our_module_key:"",moduleLine=moduleKey?'<li>我方对应表:'+escapeHtml(moduleKey)+'</li>':"";
    pane.innerHTML='<div class="placeholder-card hgj-card"><h1>'+escapeHtml(sourceName)+'</h1><p>'+escapeHtml(statusText)+'</p><ul><li>原因:'+escapeHtml(note)+'</li>'+moduleLine+'<li>导航：未发生页面跳转</li><li>iframe：未创建</li></ul></div>';
  }else{pane=document.createElement("iframe");pane.className="frame";pane.dataset.id=tab.id;pane.title=tab.title;pane.src=tab.url}
  stageEl.appendChild(pane);
}
function renderWorkbenchPane(pane){
  pane.innerHTML='<section class="workbench-head hgj-card"><h1 class="hgj-panel-title">工作台</h1><p>常用海运入口</p></section><section class="workbench-grid"></section>';
  var grid=pane.querySelector(".workbench-grid");
  WORKBENCH_LINKS.forEach(function(link){
    var card=document.createElement("button");card.type="button";card.className="workbench-card hgj-card";card.innerHTML='<span class="workbench-card-title"></span><span class="workbench-card-url"></span><span class="workbench-card-desc"></span>';
    card.querySelector(".workbench-card-title").textContent=link.title;card.querySelector(".workbench-card-url").textContent=link.url;card.querySelector(".workbench-card-desc").textContent=link.desc;
    card.addEventListener("click",function(){openTab({title:link.title,url:link.url,sourceName:link.title})});grid.appendChild(card);
  });
}
function activeTab(){return state.tabs.find(function(t){return t.id===state.activeId})}
function activateTab(id){if(state.activeId===id)return;state.activeId=id;saveState();render()}
function closeTab(id){var i=state.tabs.findIndex(function(t){return t.id===id});if(i<0||state.tabs[i].fixed)return;state.tabs.splice(i,1);if(state.activeId===id)state.activeId=(state.tabs[i]||state.tabs[i-1]||state.tabs[0]).id;saveState();render()}
function openTab(input){
  var url=normalizeUrl(input.url);if(!url)return showToast("只允许打开本站白名单页面");
  var id=sanitizeId(input.id||url),existing=state.tabs.find(function(t){return t.id===id||t.url===url});
  if(existing){existing.title=String(input.title||existing.title).slice(0,80);existing.sourceName=input.sourceName||existing.sourceName||existing.title;state.activeId=existing.id;saveState();render();return}
  if(state.tabs.length>=MAX_TABS)return showToast("最多同时打开 20 个标签页");
  state.tabs.push({id:id,title:String(input.title||url).slice(0,80),url:url,fixed:false,sourceName:input.sourceName||input.title||url});state.activeId=id;saveState();render();
}
function normalizeUrl(url){if(typeof url!=="string"||!url.trim())return "";var raw=url.trim();if(raw.charAt(0)!=="/"){/* 值不带 / 时必须转成 /hy/grid.html?module=,否则会被 SPA 兜底吞成老 admin 首页,用户会以为 hy 里嵌了老版本。2026-09-05 实测 finance_recon_exceptions 复现。 */raw="/hy/grid.html?module="+encodeURIComponent(raw)}try{var parsed=new URL(raw,location.origin);if(parsed.origin!==location.origin)return "";if(REAL_PATHS.indexOf(parsed.pathname)<0)return "";return parsed.pathname+parsed.search+parsed.hash}catch(e){return ""}}
function trustedFrameSource(source){return !!source&&source!==window&&Array.from(stageEl.querySelectorAll("iframe.frame")).some(function(f){return f.contentWindow===source})}
function updatePaneVisibility(){Array.from(stageEl.children).forEach(function(p){p.classList.toggle("active",p.dataset.id===state.activeId)})}
function refreshActive(){var pane=stageEl.querySelector('.frame[data-id="'+cssEscape(state.activeId)+'"]');if(pane&&pane.contentWindow)pane.contentWindow.location.reload();else showToast("待建模块无页面可刷新")}
function focusSearch(){var input=document.querySelector(".top-search input");if(input)input.focus();else showToast("搜索未加载")}
function syncNav(){var active=activeTab(),name=active&&active.sourceName||"";document.querySelectorAll(".nav-main,.nav-leaf").forEach(function(b){var t=b.querySelector(".nav-main-title,.nav-leaf-title");b.classList.toggle("active",!!t&&t.textContent===name)})}
function sanitizeId(v){return String(v).replace(/\s+/g,"-").replace(/[^A-Za-z0-9_.:\-\u4e00-\u9fff]+/g,"-").replace(/^-+|-+$/g,"").slice(0,120)||"tab-"+Date.now()}
function showToast(msg){toastEl.textContent=msg;toastEl.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(function(){toastEl.classList.remove("show")},2400)}
function onDragStart(ev){dragId=ev.currentTarget.dataset.id;ev.dataTransfer.effectAllowed="move"}
function onDragOver(ev){if(dragId){ev.preventDefault();ev.dataTransfer.dropEffect="move"}}
function onDrop(ev){ev.preventDefault();var target=ev.currentTarget.dataset.id;if(!dragId||dragId===target||target===FIXED_ID)return;var from=state.tabs.findIndex(function(t){return t.id===dragId}),to=state.tabs.findIndex(function(t){return t.id===target});if(from<=0||to<=0)return;var moved=state.tabs.splice(from,1)[0];state.tabs.splice(to,0,moved);saveState();render()}
function onDragEnd(){dragId=""}
function cssEscape(v){return window.CSS&&window.CSS.escape?window.CSS.escape(v):String(v).replace(/["\\]/g,"\\$&")}
})();
