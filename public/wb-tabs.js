(function(){
"use strict";
var MAX_TABS=20,FIXED_ID="workbench",STORAGE_KEY="sanlyn.wbTabs.v2";
// 新增页面要同时加 nginx location 和这里；否则会被转成待建占位，避免落进 SPA 兜底页。
var KNOWN_REAL_PATHS=[
  "/wb","/wb-tabs","/ocean","/rates","/ship-grid","/ship-entry","/order-entry","/manifest","/manifest-send","/manifest-cfg","/kb",
  "/ops-alerts","/fee-alerts","/biz-alerts","/ops-todos","/global-search",
  "/agent","/center","/check","/client","/dv","/email","/empty-shelf","/health","/html","/login","/me","/my","/one","/petwatch","/restock","/si","/sources","/staff-tasks","/trip"
];
var BUILT={
  "工作台":"/wb","运价管理":"/rates","海运出口":"/ship-grid","订单录入":"/order-entry",
  "上海-舱单发送":"/manifest-send","账单管理":"/ocean","审核提交记录":"/ops-todos"
};
var NAV=[
  n("工作台"),n("运价管理"),n("智能邮箱"),
  n("报价管理",["单票报价","费用模板"]),
  n("集运订单",["待接单","订单录入","海运出口","海运进口","空运出口","空运进口","物流园报关","陆运","铁路运输","内贸水运","自拼"]),
  n("数据通道",["上海-舱单发送","青岛-舱单发送","厦门-舱单发送","天津/大连-舱单","深圳/南沙-舱单","AFR发送","AMS发送","ISF发送","EM&ACI发送","订舱平台","在线报关","VGM发送","盯箱宝","全程货物跟踪","SPOT电商","ICS2"]),
  n("费用管理",["集运费用明细","账单管理","开票记录","收付管理","核销管理","提成管理"]),
  n("提单管理"),
  n("报关/箱货/仓储",["箱货信息","报关信息","仓储信息"]),
  n("审核管理",["审核提交记录","报价审核","费用模板审核","订单审核","提单审核","费用审核","账单审核","往来公司审核","合同审核"]),
  n("货运保险"),n("报表中心",["业务报表","财务报表"])
];
var MENUS={settings:["参数设置","成员与权限"],help:["吐槽产品","新手教程","小程序","海管家二维码","货代Q宝"],resource:["企业资源"]};
var DEFAULT_TABS=[{id:FIXED_ID,title:"工作台",url:"/wb",fixed:true}];
var state=loadState(),tabsEl=$("tabs"),stageEl=$("stage"),navEl=$("sideNav"),toastEl=$("toast"),moduleTitle=$("moduleTitle"),toastTimer=0,dragId="";
$("generatedAt").textContent="生成时间 "+new Date().toLocaleString("zh-CN");
renderNav();renderMenus();mountSearch();bindShell();render();
function n(name,children){return {name:name,children:(children||[]).map(function(x){return {name:x}})}}
function $(id){return document.getElementById(id)}
function builtUrl(name){return BUILT[name]||""}
function pendingUrl(name){return "/wb-tabs-placeholder?module="+encodeURIComponent(name)}
function openNav(name){var url=builtUrl(name);openTab({title:url?name:name+" · 待建",url:url||pendingUrl(name),pending:!url,sourceName:name})}
function renderNav(){
  navEl.textContent="";
  NAV.forEach(function(item){
    var sec=document.createElement("div"),main=document.createElement("button"),leafs=document.createElement("div"),has=item.children.length;
    sec.className="nav-section"+(has?" open":"");main.className="nav-main";main.type="button";
    main.innerHTML='<span class="nav-caret"></span><span class="nav-main-title"></span>';
    main.querySelector(".nav-caret").textContent=has?"▾":"";
    main.querySelector(".nav-main-title").textContent=item.name;
    main.classList.toggle("pending",!has&&!builtUrl(item.name));
    main.addEventListener("click",function(){has?sec.classList.toggle("open"):openNav(item.name)});
    sec.appendChild(main);leafs.className="nav-leaves";
    item.children.forEach(function(leaf){
      var b=document.createElement("button");b.type="button";b.className="nav-leaf"+(builtUrl(leaf.name)?"":" pending");b.textContent=leaf.name;
      b.addEventListener("click",function(){openNav(leaf.name)});leafs.appendChild(b);
    });
    sec.appendChild(leafs);navEl.appendChild(sec);
  });
}
function renderMenus(){
  Object.keys(MENUS).forEach(function(key){var box=$("menu-"+key);box.textContent="";MENUS[key].forEach(function(label){var b=document.createElement("button");b.type="button";b.textContent=label;b.addEventListener("click",function(){hideMenus();openNav(label)});box.appendChild(b)})});
}
function mountSearch(){
  if(window.SanlynGlobalSearch)window.SanlynGlobalSearch.mount($("topSearch"),{open:openSearchItem});
}
function openSearchItem(item){openTab({title:item.label||"搜索结果",url:item.url})}
function bindShell(){
  window.addEventListener("message",function(event){if(event.origin!==location.origin||!trustedFrameSource(event.source))return;var d=event.data||{};if(d.type!=="sanlyn:open-tab"&&d.type!=="open-tab")return;openTab({id:d.id,title:d.title||d.url,url:d.url,sourceName:d.sourceName})});
  document.addEventListener("click",function(e){var m=e.target.closest("[data-menu]");if(m){toggleMenu(m.dataset.menu);return}if(!e.target.closest(".menu-wrap"))hideMenus()});
  $("noticeBtn").onclick=function(){openNav("通知")};$("customNav").onclick=function(){openNav("自定义导航")};
  $("assistantFab").onclick=function(){$("assistantPanel").hidden=false};$("assistantClose").onclick=function(){$("assistantPanel").hidden=true};
  document.querySelector(".float-tools").onclick=function(e){var b=e.target.closest("button");if(!b)return;if(b.dataset.tool==="刷新")refreshActive();if(b.dataset.tool==="搜索")focusSearch();if(b.dataset.tool==="返回首页")openNav("工作台")};
}
function toggleMenu(key){["settings","help","resource"].forEach(function(k){$("menu-"+k).hidden=k!==key?!0:!$("menu-"+k).hidden})}
function hideMenus(){["settings","help","resource"].forEach(function(k){$("menu-"+k).hidden=true})}
function focusSearch(){var input=document.querySelector(".top-search input");if(input)input.focus()}
function loadState(){try{var raw=JSON.parse(localStorage.getItem(STORAGE_KEY)||"null");if(!raw||!Array.isArray(raw.tabs))return {activeId:FIXED_ID,tabs:DEFAULT_TABS.slice()};var tabs=raw.tabs.map(normalizeTab).filter(validTab).slice(0,MAX_TABS);if(!tabs.some(function(t){return t.id===FIXED_ID}))tabs.unshift(DEFAULT_TABS[0]);tabs=tabs.map(function(t){return t.id===FIXED_ID?DEFAULT_TABS[0]:t});return {activeId:tabs.some(function(t){return t.id===raw.activeId})?raw.activeId:FIXED_ID,tabs:tabs}}catch(e){return {activeId:FIXED_ID,tabs:DEFAULT_TABS.slice()}}}
function validTab(t){return t&&typeof t.id==="string"&&typeof t.title==="string"&&typeof t.url==="string"&&!!normalizeUrl(t.url)}
function saveState(){localStorage.setItem(STORAGE_KEY,JSON.stringify({activeId:state.activeId,tabs:state.tabs}))}
function render(){
  tabsEl.textContent="";
  state.tabs.forEach(function(tab){var btn=document.createElement("div");btn.className="tab";btn.dataset.id=tab.id;btn.draggable=!tab.fixed;btn.setAttribute("role","tab");btn.tabIndex=0;btn.setAttribute("aria-selected",String(tab.id===state.activeId));btn.title=tab.title+" · "+tab.url;btn.innerHTML='<span class="tab-title"></span><button class="close" type="button" title="关闭">×</button>';btn.querySelector(".tab-title").textContent=tab.title;btn.querySelector(".close").hidden=!!tab.fixed;btn.onclick=function(){activateTab(tab.id)};btn.onkeydown=function(ev){if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();activateTab(tab.id)}};btn.querySelector(".close").onclick=function(ev){ev.stopPropagation();closeTab(tab.id)};btn.addEventListener("dragstart",onDragStart);btn.addEventListener("dragover",onDragOver);btn.addEventListener("drop",onDrop);btn.addEventListener("dragend",onDragEnd);tabsEl.appendChild(btn);ensureFrame(tab)});
  Array.from(stageEl.children).forEach(function(frame){if(!state.tabs.some(function(t){return t.id===frame.dataset.id}))frame.remove()});
  updateFrameVisibility();syncNav();var active=state.tabs.find(function(t){return t.id===state.activeId});moduleTitle.textContent=active?active.title:"工作台";
}
function ensureFrame(tab){
  var frame=stageEl.querySelector('.frame[data-id="'+cssEscape(tab.id)+'"]');if(frame){frame.title=tab.title;return}
  if(tab.url.indexOf("/wb-tabs-placeholder?")===0){frame=document.createElement("section");frame.className="frame placeholder";frame.dataset.id=tab.id;frame.innerHTML='<div class="placeholder-card hgj-card"><h1></h1><p></p></div>';frame.querySelector("h1").textContent=(tab.sourceName||tab.title.replace(/ · 待建$/,""))+" · 待建";frame.querySelector("p").textContent="此模块尚未开发。海管家对应功能："+(tab.sourceName||tab.title.replace(/ · 待建$/,""))+"。"}else{frame=document.createElement("iframe");frame.className="frame";frame.src=tab.url;frame.title=tab.title;frame.dataset.id=tab.id}
  stageEl.appendChild(frame);
}
function trustedFrameSource(source){return !!source&&source!==window&&Array.from(stageEl.querySelectorAll("iframe.frame")).some(function(f){return f.contentWindow===source})}
function updateFrameVisibility(){Array.from(stageEl.children).forEach(function(f){f.classList.toggle("active",f.dataset.id===state.activeId)})}
function openTab(input){
  var tab=normalizeTab(input);if(!tab.url)return showToast("只允许打开本站页面");var url=tab.url,id=sanitizeId(tab.id||url),existing=state.tabs.find(function(t){return t.id===id||t.url===url});
  if(existing){existing.title=String(tab.title||existing.title).slice(0,80);state.activeId=existing.id;saveState();render();return}
  if(state.tabs.length>=MAX_TABS)return showToast("最多同时打开 20 个标签页");
  state.tabs.push({id:id,title:String(tab.title||url).slice(0,80),url:url,fixed:false,sourceName:tab.sourceName||tab.title||""});state.activeId=id;saveState();render();
}
function activateTab(id){if(state.activeId===id)return;state.activeId=id;saveState();render()}
function closeTab(id){var i=state.tabs.findIndex(function(t){return t.id===id});if(i<0||state.tabs[i].fixed)return;state.tabs.splice(i,1);if(state.activeId===id)state.activeId=(state.tabs[i]||state.tabs[i-1]||state.tabs[0]).id;saveState();render()}
function refreshActive(){var frame=stageEl.querySelector('.frame[data-id="'+cssEscape(state.activeId)+'"]');if(frame&&frame.contentWindow)frame.contentWindow.location.reload()}
function normalizeUrl(url){if(typeof url!=="string"||!url.trim())return "";try{var p=new URL(url,location.origin);if(p.origin!==location.origin)return "";return p.pathname+p.search+p.hash}catch(e){return ""}}
function normalizeTab(input){
  var url=normalizeUrl(input.url),title=String(input.title||url||"待建页面"),sourceName=input.sourceName||input.title||title;
  if(!url)return {url:""};
  try{var p=new URL(url,location.origin);if(p.pathname.indexOf("/wb-tabs-placeholder")===0||KNOWN_REAL_PATHS.indexOf(p.pathname)>=0)return {id:input.id,title:title,url:url,sourceName:sourceName};return {id:input.id,title:title.replace(/ · 待建$/,"")+" · 待建",url:pendingUrl(title+"（原路径 "+p.pathname+"）"),sourceName:title}}catch(e){return {url:""}}
}
function sanitizeId(v){return String(v).replace(/[^A-Za-z0-9_.:-]+/g,"-").slice(0,120)||"tab-"+Date.now()}
function showToast(msg){toastEl.textContent=msg;toastEl.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(function(){toastEl.classList.remove("show")},2400)}
function syncNav(){var active=state.tabs.find(function(t){return t.id===state.activeId});var title=active&&active.sourceName||active&&active.title||"";document.querySelectorAll(".nav-main,.nav-leaf").forEach(function(b){b.classList.toggle("active",b.textContent===title)})}
function onDragStart(ev){dragId=ev.currentTarget.dataset.id;ev.dataTransfer.effectAllowed="move"}
function onDragOver(ev){if(dragId){ev.preventDefault();ev.dataTransfer.dropEffect="move"}}
function onDrop(ev){ev.preventDefault();var target=ev.currentTarget.dataset.id;if(!dragId||dragId===target||target===FIXED_ID)return;var from=state.tabs.findIndex(function(t){return t.id===dragId}),to=state.tabs.findIndex(function(t){return t.id===target});if(from<=0||to<=0)return;var moved=state.tabs.splice(from,1)[0];state.tabs.splice(to,0,moved);saveState();render()}
function onDragEnd(){dragId=""}
function cssEscape(v){return window.CSS&&CSS.escape?CSS.escape(v):String(v).replace(/["\\]/g,"\\$&")}
})();
