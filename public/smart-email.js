(function(){
"use strict";
var VERSION="v2026.08.26-1";
var API={templates:"/api/db/email-templates",senders:"/api/db/email-senders",logs:"/api/db/email-message-log?page_size=50"};
var state={tab:"compose",templates:null,senders:null,logs:null,errors:{}};
function $(id){return document.getElementById(id)}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(){var h={},t=token();if(t)h.Authorization="Bearer "+t;return h}
function row(title,meta,action){
  var r=document.createElement("article"),main=document.createElement("div"),t=document.createElement("div"),m=document.createElement("div"),a=document.createElement("div");
  r.className="row";t.className="rowTitle";m.className="pillbar";t.textContent=title||"未设置";
  (meta||[]).forEach(function(x){var p=document.createElement("span");p.className="pill";p.textContent=x==null||x===""?"未设置":String(x);m.appendChild(p)});
  main.appendChild(t);main.appendChild(m);if(action)a.appendChild(action);r.appendChild(main);r.appendChild(a);return r;
}
function empty(text){var d=document.createElement("div");d.className="empty";d.textContent=text;return d}
function safeCount(arr,missing){return Array.isArray(arr)&&arr.length?String(arr.length):"未接入"}
function fillRate(rows,fields){
  if(!Array.isArray(rows)||!rows.length)return "0/0";
  var total=rows.length*fields.length,filled=0;
  rows.forEach(function(r){fields.forEach(function(f){if(r&&r[f]!=null&&String(r[f]).trim()!=="")filled++})});
  return filled+"/"+total;
}
function missingText(name,rows,fields){
  return "未接入 · 缺 "+name+"."+fields.join("/")+"；当前填充率 "+fillRate(rows,fields);
}
async function getJson(url){
  var r=await fetch(url,{headers:headers()}),d=await r.json().catch(function(){return{error:"接口返回异常"}});
  if(!r.ok||d.success===false)throw new Error(d.error||"请求失败");
  return d;
}
async function load(){
  state.errors={};
  await Promise.all([
    getJson(API.templates).then(function(d){state.templates=d.data||[]}).catch(function(e){state.templates=[];state.errors.templates=e.message}),
    getJson(API.senders).then(function(d){state.senders=d.data||[]}).catch(function(e){state.senders=[];state.errors.senders=e.message}),
    getJson(API.logs).then(function(d){state.logs=d.data||[]}).catch(function(e){state.logs=[];state.errors.logs=e.message})
  ]);
  render();
}
function setText(id,text){$(id).textContent=text}
function renderMetrics(){
  var ts=new Date().toLocaleString("zh-CN");
  setText("stamp",VERSION+" · 生成时间 "+ts);
  setText("mTemplates",safeCount(state.templates));
  setText("mTemplatesNote",Array.isArray(state.templates)&&state.templates.length?"字段填充率 "+fillRate(state.templates,["tpl_key","subject","html"]):missingText("email_templates",state.templates,["tpl_key","subject","html"]));
  setText("mSenders",safeCount(state.senders));
  setText("mSendersNote",Array.isArray(state.senders)&&state.senders.length?"字段填充率 "+fillRate(state.senders,["sender_key","email"]):missingText("email_senders",state.senders,["sender_key","email"]));
  setText("mLogs",safeCount(state.logs));
  setText("mLogsNote",Array.isArray(state.logs)&&state.logs.length?"字段填充率 "+fillRate(state.logs,["recipient_email","subject","status"]):missingText("email_message_log",state.logs,["recipient_email","subject","status"]));
  var risky=(state.logs||[]).filter(function(r){return r.status==="failed"||r.status==="pending"});
  setText("mRisk",risky.length?String(risky.length):"未接入");
  setText("mRiskNote",risky.length?"依据 email_message_log.status":"未接入 · 缺 failed/pending status；当前填充率 "+fillRate(state.logs,["status"]));
}
function optText(v,fallback){return v==null||String(v).trim()===""?fallback:String(v)}
function fillSelects(){
  var tpl=$("tpl"),sender=$("sender");tpl.textContent="";sender.textContent="";
  if(!state.templates.length){var o=document.createElement("option");o.textContent="未接入 · 缺 email_templates.tpl_key";tpl.appendChild(o)}
  state.templates.forEach(function(t){var o=document.createElement("option");o.value=t.id;o.textContent=optText(t.name,t.tpl_key||"未设置");tpl.appendChild(o)});
  if(!state.senders.length){var so=document.createElement("option");so.textContent="未接入 · 缺 email_senders.sender_key";sender.appendChild(so)}
  state.senders.forEach(function(s){var o=document.createElement("option");o.value=s.sender_key;o.textContent=optText(s.company_name_en,s.sender_key||"未设置");sender.appendChild(o)});
  syncTemplate();
}
function currentTpl(){var id=String($("tpl").value);return (state.templates||[]).find(function(t){return String(t.id)===id})}
function syncTemplate(){
  var t=currentTpl();
  if(!t){$("subject").value="";$("body").value="";setText("preview","未接入 · 缺模板正文；当前填充率 "+fillRate(state.templates,["html"]));return}
  $("subject").value=optText(t.subject,"未接入");
  $("body").value=optText(t.html,"未接入");
  renderPreview();
}
function renderPreview(){
  var lines=[],sender=$("sender").value||"未设置",to=$("to").value||"未设置";
  lines.push("From: "+sender);lines.push("To: "+to);lines.push("Subject: "+($("subject").value||"未接入"));lines.push("");
  lines.push($("body").value||"未接入 · 缺模板正文；当前填充率 "+fillRate(state.templates,["html"]));
  setText("preview",lines.join("\n"));
}
function renderTemplates(){
  var box=$("templateList");box.textContent="";
  setText("templateBasis",state.templates.length?"数据源 email_templates":"缺 email_templates.tpl_key/name/subject/html；当前填充率 "+fillRate(state.templates,["tpl_key","name","subject","html"]));
  if(!state.templates.length){box.appendChild(empty(missingText("email_templates",state.templates,["tpl_key","name","subject","html"])));return}
  state.templates.forEach(function(t){
    box.appendChild(row(t.name||t.tpl_key,["key "+optText(t.tpl_key,"未设置"),"分类 "+optText(t.category,"未设置"),"主题 "+optText(t.subject,"未接入"),t.is_active===false?"停用":"启用"]));
  });
}
function renderLogs(){
  var box=$("logList");box.textContent="";
  setText("logBasis",state.logs.length?"数据源 email_message_log":"缺 email_message_log.recipient_email/subject/status；当前填充率 "+fillRate(state.logs,["recipient_email","subject","status"]));
  if(!state.logs.length){box.appendChild(empty(missingText("email_message_log",state.logs,["recipient_email","subject","status"])));return}
  state.logs.forEach(function(l){
    box.appendChild(row(l.subject||"未接入",["状态 "+optText(l.status,"未接入"),"收件人 "+optText(l.recipient_email,"未接入"),"模板 "+optText(l.tpl_key||l.template_name,"未设置"),"时间 "+optText(l.sent_at||l.created_at,"未设置")]));
  });
}
function renderWiring(){
  var box=$("wiringList");box.textContent="";
  [
    ["模板库",state.templates,["tpl_key","name","subject","html"],state.errors.templates],
    ["发件主体",state.senders,["sender_key","company_name_en","email"],state.errors.senders],
    ["邮件记录",state.logs,["recipient_email","subject","status","created_at"],state.errors.logs]
  ].forEach(function(x){
    var ok=Array.isArray(x[1])&&x[1].length&&!x[3];
    box.appendChild(row(x[0],[ok?"已接入":"未接入","字段 "+x[2].join("/"),"填充率 "+fillRate(x[1],x[2]),x[3]?"错误 "+x[3]:"接口可访问"]));
  });
}
function renderTabs(){
  document.querySelectorAll(".tab").forEach(function(b){b.classList.toggle("active",b.dataset.tab===state.tab)});
  ["compose","templates","logs","wiring"].forEach(function(k){$(k+"Panel").classList.toggle("hidden",state.tab!==k)});
}
function render(){renderMetrics();fillSelects();renderTemplates();renderLogs();renderWiring();renderTabs()}
$("reload").onclick=load;
$("tpl").onchange=syncTemplate;
$("to").oninput=renderPreview;$("subject").oninput=renderPreview;$("body").oninput=renderPreview;$("sender").onchange=renderPreview;
$("draftBtn").onclick=renderPreview;
$("openTemplates").onclick=function(){state.tab="templates";renderTabs()};
document.querySelector(".tabs").onclick=function(e){var b=e.target.closest(".tab");if(!b)return;state.tab=b.dataset.tab;renderTabs()};
if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"智能邮箱",url:location.pathname+location.search},location.origin);
load();
})();
