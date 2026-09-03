(function(){
"use strict";
var API_OUTBOX="/api/db/mail-outbox",API_EDIT="/api/db/mail-outbox-edit",API_REPLIES="/api/db/mail-replies";
var TAB_KEYS={draft:1,reply:1,sent:1,cold:1,risk:1,new:1};
var state={tab:"draft",rows:{draft:[],sent:[]},replies:null,loading:false,error:""};
var pane=id("pane"),tabs=id("tabs"),stamp=id("stamp");
function id(v){return document.getElementById(v)}
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function token(){return localStorage.getItem("sanlyn_jwt")||localStorage.getItem("sanlyn_token")||localStorage.getItem("token")||""}
function headers(json){var h={},t=token();if(t)h.Authorization="Bearer "+t;if(json)h["Content-Type"]="application/json";return h}
function arr(v){return Array.isArray(v)?v:[]}
function textList(v){return arr(v).join("\n")}
function parseEmails(v){return String(v||"").split(/[\n,;]+/).map(function(x){return x.trim()}).filter(Boolean)}
// 🔴 2026-09-03 时区坑:后端回的是 ISO(UTC)。原来直接切字符串 -> 显示 09-02 21:13,
// 实际是北京 09-03 05:13(差8小时还退了一天)。同一个坑 portun-sync 日志也踩过(t-0817-portun-log-tz)。
// 必须按 Asia/Shanghai 格式化,别再改回字符串切片。
function fmtTime(v){
  if(!v) return "--";
  var d=new Date(v);
  if(isNaN(d.getTime())) return String(v).replace("T"," ").slice(0,16);
  return d.toLocaleString("sv-SE",{timeZone:"Asia/Shanghai"}).slice(0,16);
}
function attName(a){return a.name||a.filename||a.file_name||a.n||a.title||a.url||"未命名附件"}
function attBlocked(a){return !!(a&&a.no_external)}
function attChecked(a){return !attBlocked(a)&&a.selected!==false}
function rowById(idv){return arr(state.rows.draft).find(function(r){return String(r.id)===String(idv)})}
function mailTime(m){return fmtTime(m.sent_at||m.prepared_at||m.created_at)}
function replyRows(){return arr(state.replies&&state.replies.data)}
function replyReady(){return state.replies&&state.replies.upstream_ok!==false}
function pendingMails(){return replyReady()?replyRows().filter(function(r){return Number(r.pending_count)>0}):[]}
function daysSince(v){var d=new Date(v);return isNaN(d.getTime())?0:Math.max(0,Math.floor((Date.now()-d.getTime())/86400000))}
function tabFromHash(){var tab=location.hash.replace(/^#/,"");return TAB_KEYS[tab]?tab:"draft"}
function syncHash(tab){if(location.hash==="#"+tab)return;history.replaceState(null,"",location.pathname+location.search+"#"+tab)}
async function fetchJson(url,opt){
  var r=await fetch(url,opt||{headers:headers()});
  var j=await r.json().catch(function(){return {}});
  if(!r.ok||j.ok===false)throw new Error(j.error||r.statusText);
  return j;
}
async function load(){
  state.loading=true;state.error="";render();
  try{
    var draft=fetchJson(API_OUTBOX+"?status=draft",{headers:headers()});
    var sent=fetchJson(API_OUTBOX+"?status=sent",{headers:headers()});
    var replies=fetchJson(API_REPLIES,{headers:headers()}).catch(function(e){return {upstream_ok:false,upstream_error:e.message,data:[]}});
    var all=await Promise.all([draft,sent,replies]);
    state.rows.draft=arr(all[0].data).filter(function(r){return r.status==="draft"});
    state.rows.sent=arr(all[1].data).filter(function(r){return r.status==="sent"});
    state.replies=all[2];
    stamp.textContent="v2026.09.03-2 · 生成时间 "+new Date().toLocaleString("zh-CN");
  }catch(e){state.error=e.message;state.rows={draft:[],sent:[]};state.replies={upstream_ok:false,upstream_error:e.message,data:[]}}
  state.loading=false;render();
}
function setTab(tab,skipHash){
  if(!TAB_KEYS[tab])tab="draft";
  state.tab=tab;
  Array.prototype.forEach.call(tabs.querySelectorAll("button"),function(b){b.setAttribute("aria-selected",String(b.dataset.tab===tab))});
  if(!skipHash)syncHash(tab);
  render();
}
function render(){
  setCount("draft",state.rows.draft.length);
  setCount("sent",state.rows.sent.length);
  setCount("reply",replyReady()?pendingMails().length:"取不到");
  setCount("cold",replyReady()?coldPeople().length:"取不到");
  Array.prototype.forEach.call(tabs.querySelectorAll("button[data-wired=false] .cnt"),function(x){x.textContent="未接入"});
  if(state.tab==="draft")return renderDraft();
  if(state.tab==="reply")return renderReply();
  if(state.tab==="sent")return renderSent();
  if(state.tab==="cold")return renderCold();
  var names={reply:["待回复","对方来信 · 等我们回"],sent:["已发送","已发送记录"],cold:["谁未回复","我们发了 · 对方没回"],risk:["异常卡点","需要人介入的邮件"],new:["选模板发信","模板备料入口"]};
  var item=names[state.tab]||names.reply;
  pane.innerHTML='<div class="ph"><h2>'+item[0]+'</h2><span class="sub">'+item[1]+'</span></div><div class="empty"><b>未接入</b>本页先接 mail_outbox 待发草稿，其它标签保留设计稿入口。</div>';
}
function setCount(tab,n){
  var el=tabs.querySelector('button[data-tab="'+tab+'"] .cnt');
  if(el)el.textContent=String(n);
}
function replyHead(title,sub){
  var warn=state.replies&&state.replies.truncated?'<span class="hint warn">⚠ 未查全(上游截断)</span>':'';
  return '<div class="ph"><h2>'+title+'</h2><span class="sub">'+sub+'</span>'+warn+'</div>';
}
function renderReply(){
  var head=replyHead("待回复","mail_replies.pending_count > 0");
  if(state.loading){pane.innerHTML=head+'<div class="empty"><b>加载中</b>正在读取回复状态。</div>';return}
  if(!replyReady())return renderReplyError(head);
  var rows=pendingMails();
  if(!rows.length){pane.innerHTML=head+'<div class="empty"><b>没有待回复邮件</b>当前所有可确认收件人都已回复。</div>';return}
  pane.innerHTML=head+rows.map(replyCard).join("");
}
function renderReplyError(head){
  var msg=state.replies&&state.replies.upstream_error||state.error||"上游未返回可用回复状态";
  pane.innerHTML=head+'<div class="empty badbox"><b>回复状态取不到</b>'+esc(msg)+'</div>';
}
function replyCard(m){
  return '<article class="mail"><div class="mail-head"><div class="ml">'+
    '<div class="subj">'+esc(m.subject||"(无主题)")+'</div><div class="meta">'+
    '<span>提单 <b>'+esc(m.related_bl_no||"--")+'</b></span><span>发出 <b>'+esc(fmtTime(m.sent_at))+'</b></span>'+
    '<span>已回 <b>'+esc(m.replied_count||0)+'</b> / 欠 <b>'+esc(m.pending_count||0)+'</b></span></div></div>'+
    '<aside class="mr"><div class="kv"><span>Outbox</span><span>'+esc(m.outbox_id||"--")+'</span></div><div class="kv"><span>收件人</span><span>'+arr(m.recipients).length+'</span></div></aside></div>'+
    '<details><summary>展开收件人</summary><div class="people">'+arr(m.recipients).map(recipientLine).join("")+'</div></details></article>';
}
function matchLabel(r){
  if(r.match_kind==="bl_fallback")return '<span class="tag weak">弱匹配(按提单号)</span>';
  return r.match_kind?'<span class="tag ok">'+esc(r.match_kind)+'</span>':'';
}
function recipientLine(r){
  var status=r.replied===true?"✅已回":r.replied===false?"⏳未回":"?";
  var extra=r.replied===true?'<span>'+esc(fmtTime(r.replied_at))+'</span>'+matchLabel(r):"";
  return '<div class="person"><span class="addr">'+esc(r.email||"--")+'</span><span class="role">'+esc(r.role||"--")+'</span><span>'+status+'</span>'+extra+'</div>';
}
function coldPeople(){
  if(!replyReady())return [];
  var map={};
  replyRows().forEach(function(m){
    arr(m.recipients).forEach(function(r){
      if(r.replied!==false||!r.email)return;
      var k=String(r.email).toLowerCase(),d=daysSince(m.sent_at);
      if(!map[k])map[k]={email:r.email,count:0,days:0};
      map[k].count++;
      if(d>map[k].days)map[k].days=d;
    });
  });
  return Object.keys(map).map(function(k){return map[k]}).sort(function(a,b){return b.days-a.days||b.count-a.count||a.email.localeCompare(b.email)});
}
function renderCold(){
  var head=replyHead("谁未回复","按收件人聚合 replied=false");
  if(state.loading){pane.innerHTML=head+'<div class="empty"><b>加载中</b>正在统计未回复人。</div>';return}
  if(!replyReady())return renderReplyError(head);
  var rows=coldPeople();
  if(!rows.length){pane.innerHTML=head+'<div class="empty"><b>没有未回复收件人</b>当前没有 replied=false 的收件人。</div>';return}
  pane.innerHTML=head+'<div class="people coldlist">'+rows.map(function(p){
    return '<div class="person"><span class="addr">'+esc(p.email)+'</span><span>欠着 <b>'+p.count+'</b> 封</span><span>最久 <b>'+p.days+'</b> 天</span></div>';
  }).join("")+'</div>';
}
function renderDraft(){
  var head='<div class="ph"><h2>待发</h2><span class="sub">mail_outbox.status=draft</span><span class="hint">只能保存草稿，不发送</span></div>';
  if(state.loading){pane.innerHTML=head+'<div class="empty"><b>加载中</b>正在读取待发队列。</div>';return}
  if(state.error){pane.innerHTML=head+'<div class="empty"><b>读取失败</b>'+esc(state.error)+'</div>';return}
  if(!state.rows.draft.length){pane.innerHTML=head+'<div class="empty"><b>没有待发的邮件</b>mail_outbox 当前没有 draft 行。</div>';return}
  pane.innerHTML=head+state.rows.draft.map(function(m){return card(m,true)}).join("");
  bindForms();
}
function renderSent(){
  var head='<div class="ph"><h2>已发送</h2><span class="sub">mail_outbox.status=sent</span><span class="hint">已发送记录只读</span></div>';
  if(state.loading){pane.innerHTML=head+'<div class="empty"><b>加载中</b>正在读取已发送记录。</div>';return}
  if(state.error){pane.innerHTML=head+'<div class="empty"><b>读取失败</b>'+esc(state.error)+'</div>';return}
  if(!state.rows.sent.length){pane.innerHTML=head+'<div class="empty"><b>没有已发送记录</b>mail_outbox 当前没有 sent 行。</div>';return}
  pane.innerHTML=head+state.rows.sent.map(function(m){return card(m,false)}).join("");
}
function card(m,editable){
  var attachments=arr(m.attachments);
  var chips=attachments.length?attachments.map(function(a){return '<span class="att '+(attBlocked(a)?"risk":"")+'">'+(attBlocked(a)?"⚠ 禁外发 ":"")+esc(attName(a))+'</span>'}).join(""):'<span class="att">无附件</span>';
  var html='<article class="mail" data-id="'+esc(m.id)+'"><div class="mail-head"><div class="ml">'+
    '<div class="subj">'+esc(m.subject||"(无主题)")+'</div><div class="meta">'+
    '<span>收 <b>'+arr(m.to_emails).length+'</b> 人</span><span>抄送 <b>'+arr(m.cc_emails).length+'</b> 人</span>'+
    '<span>提单 <b>'+esc(m.related_bl_no||"--")+'</b></span><span>模板 <b>'+esc(m.tpl_key||"--")+'</b></span></div>'+
    '<div class="atts">'+chips+'</div></div><aside class="mr">'+
    '<div class="kv"><span>状态</span><span>'+esc(m.status)+'</span></div><div class="kv"><span>备料</span><span>'+esc(m.prepared_by||"--")+'</span></div>'+
    '<div class="kv"><span>时间</span><span>'+esc(mailTime(m))+'</span></div><div class="kv"><span>ID</span><span>'+esc(m.id)+'</span></div>'+
    '</aside></div>';
  if(editable)html+='<details><summary>展开编辑</summary>'+form(m)+'</details>';
  return html+'</article>';
}
function form(m){
  return '<form class="form" data-id="'+esc(m.id)+'">'+
    field("to_emails","收件人",textList(m.to_emails),"每行一个邮箱")+
    field("cc_emails","抄送",textList(m.cc_emails),"每行一个邮箱，可空")+
    inputField("subject","主题",m.subject||"")+
    '<div class="fld wide"><label>正文 HTML</label><textarea name="body_html">'+esc(m.body_html||"")+'</textarea></div>'+
    '<div class="fld wide"><label>附件</label><div class="filebox">'+attInputs(m)+'</div></div>'+
    '<div class="acts"><button class="btn pri" type="submit">保存草稿</button><span class="msg" data-msg></span></div></form>';
}
function field(name,label,value,placeholder){
  return '<div class="fld"><label>'+label+'</label><textarea name="'+name+'" placeholder="'+esc(placeholder)+'">'+esc(value)+'</textarea></div>';
}
function inputField(name,label,value){
  return '<div class="fld wide"><label>'+label+'</label><input name="'+name+'" value="'+esc(value)+'"></div>';
}
function attInputs(m){
  var attachments=arr(m.attachments);
  if(!attachments.length)return '<div class="msg">无附件</div>';
  return attachments.map(function(a,i){
    var blocked=attBlocked(a);
    return '<label class="filerow"><input type="checkbox" name="att" value="'+i+'" '+(attChecked(a)?"checked":"")+' '+(blocked?"disabled":"")+'>'+
      '<span class="nm">'+esc(attName(a))+'</span>'+(blocked?'<span class="tag risk">⚠ 禁外发</span>':'')+'</label>';
  }).join("");
}
function bindForms(){
  Array.prototype.forEach.call(pane.querySelectorAll("form"),function(formEl){
    formEl.addEventListener("submit",function(ev){ev.preventDefault();save(formEl)});
  });
}
function collect(formEl,row){
  var fd=new FormData(formEl),attachments=arr(row.attachments);
  var selected={};Array.prototype.forEach.call(formEl.querySelectorAll('input[name="att"]:checked'),function(x){selected[x.value]=true});
  return {
    to_emails:parseEmails(fd.get("to_emails")),
    cc_emails:parseEmails(fd.get("cc_emails")),
    subject:String(fd.get("subject")||"").trim(),
    body_html:String(fd.get("body_html")||""),
    attachments:attachments.map(function(a,i){
      var next=Object.assign({},a);
      next.selected=!attBlocked(a)&&!!selected[i];
      return next;
    })
  };
}
async function save(formEl){
  var msg=formEl.querySelector("[data-msg]"),btn=formEl.querySelector("button"),row=rowById(formEl.dataset.id);
  if(!row)return;
  msg.className="msg";msg.textContent="保存中";btn.disabled=true;
  try{
    var changes=collect(formEl,row);
    var data=await fetchJson(API_EDIT,{method:"PATCH",headers:headers(true),body:JSON.stringify({id:row.id,changes:changes})});
    var next=data.data||data.row||changes;
    Object.assign(row,next);
    msg.textContent="已保存";
    renderDraft();
  }catch(e){msg.className="msg bad";msg.textContent=e.message}
  btn.disabled=false;
}
tabs.addEventListener("click",function(ev){var b=ev.target.closest("button[data-tab]");if(b)setTab(b.dataset.tab)});
window.addEventListener("hashchange",function(){setTab(tabFromHash(),true)});
if(window.parent!==window)window.parent.postMessage({type:"sanlyn:module-ready",title:"发件台",url:location.pathname+location.search},location.origin);
setTab(tabFromHash(),true);
load();
})();
