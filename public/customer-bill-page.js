(function(){
"use strict";

var API_GET="/api/public/customer-bill";
var API_POST="/api/db/customer-bill";
var qs=new URLSearchParams(location.search);
var token=clean(qs.get("token"));
var state={bills:[],busy:false,pendingBill:null};
var app=document.getElementById("app");
var dlg=document.getElementById("nameDialog");
var nameInput=document.getElementById("confirmName");
var nameErr=document.getElementById("nameErr");

function clean(v){return String(v==null?"":v).trim()}
function esc(v){return clean(v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function num(v){var n=Number(v);return Number.isFinite(n)?n:0}
function money(v){return num(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}
function dateText(v){return clean(v).replace("T"," ").slice(0,19)}
function isExw(s){return /exw/i.test(clean(s&&s.doc_type))}
function billSnap(b){return b&&typeof b.snapshot==="object"&&b.snapshot?b.snapshot:{}}
function statusOf(b){return clean(b&&b.status).toLowerCase()}
function isConfirmed(b){return statusOf(b)==="confirmed"}
function pickConfirm(b){
  var s=billSnap(b);
  return {
    name:clean(b.confirmed_by_name||b.confirmed_by||s.confirmed_by_name||s.confirmed_by),
    at:clean(b.confirmed_at||s.confirmed_at)
  };
}
function post(path,body){
  return fetch(API_POST+path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})})
    .then(function(r){return r.json().catch(function(){return {ok:false,error:"bad_response"}}).then(function(j){j._status=r.status;return j})});
}
function showState(title,text){
  app.className="state";
  app.innerHTML="<b>"+esc(title)+"</b>"+esc(text||"");
}
function lineRows(lines){
  if(!Array.isArray(lines)||!lines.length)return '<tr><td colspan="5">No bill lines / 暂无费用行</td></tr>';
  return lines.map(function(l){
    return "<tr><td>"+esc(l.fee_name)+"</td><td class=\"r\">"+esc(l.qty)+"</td><td>"+esc(l.currency)+"</td><td class=\"r\">"+money(l.unit_price)+"</td><td class=\"r\">"+money(l.amount)+"</td></tr>";
  }).join("");
}
function payNote(s){
  var usd=money(s.totals&&s.totals.USD),cny=money(s.totals&&s.totals.CNY),rate=clean(s.fx_rate),d=clean(s.issue_date);
  if(isExw(s)){
    return "EXW bill: pay each currency separately, or pay the whole bill in one converted currency. Both options are acceptable. / EXW 账单：可分币种各付，也可整张折一种币种全额付，两种都可以。";
  }
  return "Pay the full amount in ONE currency: USD "+usd+" or CNY "+cny+" (rate "+rate+" on date "+d+"). / 请任选一种币种全额支付：USD "+usd+" 或 CNY "+cny+"（汇率 "+rate+"，日期 "+d+"）。";
}
function billHtml(b,i){
  var s=billSnap(b), confirmed=isConfirmed(b), c=pickConfirm(b);
  var lockText=c.name||c.at?("Confirmed by "+(c.name||"customer")+(c.at?" at "+dateText(c.at):"")+" · Locked"):"Confirmed · Locked / 已确认锁定";
  return '<section class="bill" data-bill="'+esc(b.id)+'">'+
    '<div class="bill-hd"><div><div class="doc">'+esc(s.doc_no||("Bill #"+(i+1)))+'</div><div class="meta">'+
    '<span>Issue date <b>'+esc(s.issue_date||"")+'</b></span><span>BL <b>'+esc(s.bl_no||"")+'</b></span>'+
    '<span>Vessel/Voyage <b>'+esc(s.vessel_voyage||"")+'</b></span><span>Route <b>'+esc([s.pol,s.pod].filter(Boolean).join(" -> "))+'</b></span>'+
    '</div></div><span class="badge '+(confirmed?"confirmed":"sent")+'">'+(confirmed?"Confirmed / 已确认":"Sent / 待确认")+'</span></div>'+
    '<div class="locked '+(confirmed?"on":"")+'" id="lock_'+esc(b.id)+'">'+esc(lockText)+'<small>按钮已隐藏，账单只读。The bill is read-only.</small></div>'+
    '<div class="sec"><div class="sec-t">Bill lines / 账单明细</div><div class="table-wrap"><table><thead><tr><th>Fee / 费用名</th><th class="r">Qty / 数量</th><th>Currency / 币种</th><th class="r">Unit price / 单价</th><th class="r">Amount / 金额</th></tr></thead><tbody>'+
    lineRows(s.lines)+'</tbody></table></div><div class="totals"><div class="total"><label>Total USD</label><b>USD '+money(s.totals&&s.totals.USD)+'</b></div><div class="total"><label>Total CNY</label><b>CNY '+money(s.totals&&s.totals.CNY)+'</b></div></div><div class="note">'+esc(payNote(s))+'</div></div>'+
    '<div class="sec"><div class="actions">'+confirmBox(b,confirmed)+commentBox(b)+'</div></div></section>';
}
function confirmBox(b,confirmed){
  if(confirmed)return '<div class="note">This bill is locked. / 账单已锁定。</div>';
  return '<div><button class="btn primary" data-confirm="'+esc(b.id)+'">Confirm this bill / 确认账单</button><div class="hint">After confirmation, this bill will be locked.</div><div class="msg" id="confirm_msg_'+esc(b.id)+'"></div></div>';
}
function commentBox(b){
  return '<div><textarea id="comment_'+esc(b.id)+'" placeholder="Question about this bill? / 对账单有疑问？"></textarea><button class="btn" data-comment="'+esc(b.id)+'">Send message / 留言</button><div class="msg" id="comment_msg_'+esc(b.id)+'"></div></div>';
}
function render(){
  if(!state.bills.length){showState("No bill found / 未找到账单","Please contact your Sanlyn contact. / 请联系 Sanlyn 对接人。");return}
  app.className="";
  app.innerHTML=state.bills.map(billHtml).join("");
}
function setMsg(kind,id,cls,text){
  var el=document.getElementById(kind+"_msg_"+id);
  if(el){el.className="msg "+(cls||"");el.textContent=text||""}
}
function billById(id){return state.bills.filter(function(b){return clean(b.id)===clean(id)})[0]}
function markConfirmed(id,name,at){
  var b=billById(id); if(!b)return;
  b.status="confirmed"; b.confirmed_by_name=name||b.confirmed_by_name; b.confirmed_at=at||new Date().toISOString();
  render();
}
function openConfirm(id){
  state.pendingBill=id; nameInput.value=""; nameErr.textContent="";
  if(dlg.showModal)dlg.showModal(); else submitConfirm(id,prompt("Confirm name / 确认人姓名")||"");
  setTimeout(function(){nameInput.focus()},40);
}
function submitConfirm(id,name){
  name=clean(name);
  if(!name){nameErr.textContent="Name is required / 请填写姓名";return}
  setMsg("confirm",id,"","Submitting... / 提交中...");
  post("/confirm",{token:token,bill_id:Number(id),name:name}).then(function(j){
    if(j.ok||j.error==="already_final"||j._status===409){markConfirmed(id,name,new Date().toISOString());return}
    setMsg("confirm",id,"err",j.error||"Submit failed / 提交失败");
  }).catch(function(e){setMsg("confirm",id,"err",e.message||"Submit failed / 提交失败")});
}
function sendComment(id){
  var box=document.getElementById("comment_"+id),text=clean(box&&box.value);
  if(!text){setMsg("comment",id,"err","Please enter a message / 请先填写留言");return}
  setMsg("comment",id,"","Sending... / 发送中...");
  post("/comment",{token:token,bill_id:Number(id),text:text}).then(function(j){
    if(!j.ok){setMsg("comment",id,"err",j.error||"Send failed / 发送失败");return}
    if(box)box.value="";
    setMsg("comment",id,"ok","已收到，我们会联系你。Received. We will contact you.");
  }).catch(function(e){setMsg("comment",id,"err",e.message||"Send failed / 发送失败")});
}
app.addEventListener("click",function(e){
  var c=e.target.closest("[data-confirm]"),m=e.target.closest("[data-comment]");
  if(c)openConfirm(c.getAttribute("data-confirm"));
  if(m)sendComment(m.getAttribute("data-comment"));
});
document.getElementById("nameOk").addEventListener("click",function(e){
  e.preventDefault();
  var id=state.pendingBill;
  if(!id)return;
  var name=clean(nameInput.value);
  if(!name){nameErr.textContent="Name is required / 请填写姓名";return}
  dlg.close("ok");
  submitConfirm(id,name);
});
function load(){
  if(!token){showState("链接已失效，请联系 Sanlyn 对接人","Invalid or expired link.");return}
  fetch(API_GET+"?token="+encodeURIComponent(token)).then(function(r){
    return r.json().catch(function(){return {ok:false,error:"bad_response"}}).then(function(j){j._status=r.status;return j});
  }).then(function(j){
    if(!j.ok){showState("链接已失效，请联系 Sanlyn 对接人",j.error==="invalid_token"?"Invalid or expired link.":"Please contact Sanlyn.");return}
    state.bills=Array.isArray(j.bills)?j.bills:[];
    render();
  }).catch(function(e){showState("加载失败 / Load failed",e.message||"Please try again later.")});
}
load();
})();
