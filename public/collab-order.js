// collab-order.js — 订单协同·客户版页面脚本（从 collab-order.html 拆出，守 500 行上限；GPT 0926 复核）
(function(){
"use strict";
var BASE=(location.pathname.indexOf("/po-test/")===0)?"/po-test":"";
var API=BASE+"/api/db/po-collab";
var Q=new URLSearchParams(location.search);
var TOKEN=Q.get("c")||Q.get("token")||"", SHEETQ=Q.get("sheet")||"";
if(Q.get("pdf")==="1"){document.documentElement.classList.add("pdfmode");document.addEventListener("DOMContentLoaded",function(){document.body.classList.add("pdfmode")})}
function lsGet(k){try{return localStorage.getItem(k)||""}catch(e){return ""}}
function lsSet(k,v){try{localStorage.setItem(k,v)}catch(e){}}
var JWT=lsGet("order_collab_jwt")||lsGet("sanlyn_jwt");
function AH(h){h=h||{};if(JWT)h.Authorization="Bearer "+JWT;return h}
function $(id){return document.getElementById(id)}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function toast(m,err){var t=$("toast");t.textContent=m;t.className="toast"+(err?" err":"");t.style.display="block";clearTimeout(t._h);t._h=setTimeout(function(){t.style.display="none"},2800)}
function num(v){if(v==null||String(v).trim()==="")return null;var n=Number(String(v).replace(/,/g,""));return isFinite(n)?n:null}
function money(v){var n=num(v);return n==null?"":n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}
function price(v){var n=num(v);return n==null?"":n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:4})}

// ── i18n（EN / 中 / BM，照 statement-portal 的做法：字典 + data-t）──
var I={
en:{dl_pdf:"Download PI PDF",print:"Print",title:"PROFORMA INVOICE",subtitle:"ORDER COLLABORATION",submit:"Submit changes",
 s1:"Review the order",s1a:"Change quantity, requested delivery, shipping marks or notes directly in the table if needed.",s1b:"Changes are requests — they take effect after we confirm them.",
 s2:"Confirm the PI",s2b:"Or download the PI PDF, sign/stamp it and upload it here (PDF / image).",or:"or",view:"View",download:"Download",
 seller:"Seller",buyer:"Buyer",req_delivery:"Requested delivery date",marks:"Shipping marks",no:"No.",item:"Item description",qty:"Qty (CTN)",pack:"Pcs/CTN",
 price:"Unit price",amount:"Amount",barcode:"Barcode",note:"Your note",total:"TOTAL",payment:"Payment terms",payee:"Please remit to",remarks:"Remarks",
 seller_sign:"Seller",buyer_sign:"Buyer (company seal)",seal_here:"Company seal",history:"Change history",
 pi_no:"PI No.",date:"Date",currency:"Currency",terms:"Trade terms",port:"Port of destination",cf_delivery:"Confirmed delivery (by us)",
 tbc:"To be confirmed",days:"days",sched:"Schedule",account:"Account No.",bank:"Bank",swift:"SWIFT",bank_addr:"Bank address",holder:"Account name",
 tax:"Tax / Reg. No.",addr:"Address",name:"Company",
 st_todo:"Pending",st_done:"Done",st_signed:"Signed",up_pi:"📎 Upload signed PI",reup:"Upload again",
 seal_ok_t:"Your company seal is registered",seal_ok_d:"Click “Confirm with company seal” to stamp the Buyer box of this PI. You can then view or download it.",
 seal_pend_t:"Company seal under review",seal_pend_d:"We received your seal. Once approved you can confirm with one click. You may upload a signed PI meanwhile.",
 seal_none_t:"No company seal registered yet",seal_none_d:"Upload it once and you can confirm every future PI with one click. PNG / JPG, ≤2 MB, transparent background preferred.",
 seal_flow:"Upload seal → we review (within 1 working day) → then it can be used",btn_seal:"🔏 Confirm with company seal",btn_up:"📤 Upload company seal",btn_change:"🔄 Change company seal",btn_reup:"📤 Upload seal again",
 seal_new_pend:"New seal under review; your current seal can still be used",seal_rej:"Your last seal was not approved: ",
 ask_seal:"Stamp this PI with your registered company seal as your confirmation?",ask_change:"Upload a new seal to replace the current one? The current seal stays in use until we approve the new one.",
 ok:"OK",cancel:"Cancel",sealing:"⏳ Stamping… (about 20 s)",sealed:"Confirmed with your company seal",saved:"Submitted — thank you",nochange:"No changes to submit",
 uploaded:"Uploaded — thank you",seal_uploaded:"Seal uploaded — waiting for our review",all_done:"✅ Confirmed — thank you! We will arrange production.",
 tab_todo:"To confirm",tab_done:"Confirmed",tab_all:"All",login_t:"Please log in with your company account",login_hint:"Log in with your email (or account) and password.",
 user:"Email or account",pass:"Password",login:"Log in",logout:"Log out",logged:"Logged in",
 ship_on:"Shipment collaboration →",ship_off:"Shipment collaboration opens after booking",returned:"We sent this order back for changes: ",
 inner:"You are logged in with an internal account (view only). Confirming and seal changes need the customer's account.",
 req_note:"* Changes requested by the buyer, subject to the seller's confirmation.",
 first_login:"First time here? Log in with your email",first_t:"Log in with your email",first_hint:"Use the email we send your documents to. We will email you a 6-digit code.",email:"Email",send_code:"Send code",resend:"Send again",code_sent:"Code sent to {e}. Check your inbox (and spam).",code6:"6-digit code",new_pw:"Set a password (at least 8 characters)",back_pw:"I have a password",
 notify_emails:"Notification emails",save:"Save",emails_saved:"Notification emails saved",terms_title:"Terms",
 nt_profile:"We currently send notices to: ",nt_custom:"Notices go to: ",nt_none:"No email on file yet — please add one.",
 due_left:"Please confirm or request changes by {d} ({n} left). If we receive no reply by then, this PI is deemed accepted.",
 due_over:"The reply deadline ({d}) has passed.",deemed_on:"This PI was deemed accepted on {d} (no reply within the reply period).",
 days:"days",hours:"hours",
 no_link:"Link is missing. Please open the full link we sent you.",bad_link:"Invalid link",err:"Error: ",unsaved:"Unsaved changes will be lost. Switch?",
 max8:"The file must be 8 MB or smaller.",max2:"The seal image must be 2 MB or smaller.",login_fail:"Login failed",page_title:"Order Collaboration",readonly:"This order has been confirmed by us and is read-only."},
zh:{dl_pdf:"下载 PI PDF",print:"打印",title:"形 式 发 票",subtitle:"订单协同 · PROFORMA INVOICE",submit:"提交修改",
 s1:"核对订单",s1a:"数量、要求交期、唛头、备注如需调整，直接在表格里改。",s1b:"修改是申请，我方确认后才生效。",
 s2:"确认 PI",s2b:"也可以下载 PI PDF，签字或盖章后在这里上传（PDF / 图片）。",or:"或",view:"预览",download:"下载",
 seller:"卖方",buyer:"买方",req_delivery:"要求交货日期",marks:"唛头",no:"序号",item:"品名",qty:"数量（箱）",pack:"每箱数",
 price:"单价",amount:"金额",barcode:"条形码",note:"贵司备注",total:"合计",payment:"付款条款",payee:"收款账户",remarks:"备注",
 seller_sign:"卖方",buyer_sign:"买方（盖章）",seal_here:"公司盖章",history:"修改记录",
 pi_no:"PI 号",date:"日期",currency:"币种",terms:"贸易条款",port:"目的港",cf_delivery:"我方确认交期",
 tbc:"待确认",days:"天",sched:"付款安排",account:"账号",bank:"开户行",swift:"SWIFT",bank_addr:"银行地址",holder:"户名",
 tax:"税号 / 注册号",addr:"地址",name:"公司",
 st_todo:"未完成",st_done:"已完成",st_signed:"已回签",up_pi:"📎 上传签好的 PI",reup:"重新上传",
 seal_ok_t:"贵司已登记公章",seal_ok_d:"点「用贵司公章确认」，盖在 PI「买方（盖章）」处；可预览、下载。",
 seal_pend_t:"公章审核中",seal_pend_d:"已收到贵司公章，我方审核通过后即可一键盖章。等不及可以先上传签好的 PI。",
 seal_none_t:"贵司还没有登记公章",seal_none_d:"上传一次，以后每张 PI 都可以一键盖章确认。PNG / JPG，≤2MB，透明底最好。",
 seal_flow:"上传公章 → 我方审核（1 个工作日内）→ 通过后启用",btn_seal:"🔏 用贵司公章确认",btn_up:"📤 上传公章",btn_change:"🔄 更换公章",btn_reup:"📤 重新上传公章",
 seal_new_pend:"新公章审核中，通过后替换；现在的公章照常能用",seal_rej:"上次上传的公章未通过审核：",
 ask_seal:"用贵司登记的公章盖在本 PI 上，作为贵司的确认？",ask_change:"上传新公章替换现在的公章？我方审核通过后才替换，期间现在的公章照常能用。",
 ok:"确定",cancel:"取消",sealing:"⏳ 盖章中…（约20秒）",sealed:"已用贵司公章确认",saved:"已提交，谢谢",nochange:"没有要提交的修改",
 uploaded:"已上传，谢谢",seal_uploaded:"公章已上传，等我方审核",all_done:"✅ 已确认，谢谢！我们接着安排生产。",
 tab_todo:"待确认",tab_done:"已确认",tab_all:"全部",login_t:"请登录贵司账号",login_hint:"用邮箱（或账号）和密码登录。",
 user:"邮箱或账号",pass:"密码",login:"登录",logout:"退出",logged:"已登录",
 ship_on:"发货协同 →",ship_off:"订舱后开放发货协同",returned:"我方已退回，请修改：",
 inner:"你现在是我方账号，只能查看；确认和换章要客户账号登录。",
 req_note:"* 为买方申请的修改，以卖方确认为准。",
 first_login:"第一次登录？用邮箱登录",first_t:"用邮箱登录",first_hint:"请用我们给贵司发单据的那个邮箱，我们会发 6 位验证码。",email:"邮箱",send_code:"发送验证码",resend:"重新发送",code_sent:"验证码已发到 {e}，请查收（也看看垃圾箱）。",code6:"6 位验证码",new_pw:"设置密码（至少 8 位）",back_pw:"我有密码",
 notify_emails:"通知邮箱",save:"保存",emails_saved:"通知邮箱已保存",terms_title:"条款",
 nt_profile:"目前通知发到：",nt_custom:"通知发到：",nt_none:"还没有邮箱，请填写。",
 due_left:"请在 {d} 前确认或提出修改（还剩 {n}）。逾期未回复，本 PI 视同接受。",
 due_over:"回复期限（{d}）已过。",deemed_on:"本 PI 已于 {d} 视同接受（回复期内未回复）。",
 days:"天",hours:"小时",
 no_link:"链接不完整，请用我们发给您的完整链接打开。",bad_link:"链接无效",err:"出错了：",unsaved:"还有修改没提交，切换会丢掉。确定切换？",
 max8:"文件不能超过 8MB",max2:"公章图片不能超过 2MB",login_fail:"登录失败",page_title:"订单协同",readonly:"这张单我方已确认，只读。"},
ms:{dl_pdf:"Muat turun PDF PI",print:"Cetak",title:"INVOIS PROFORMA",subtitle:"KERJASAMA PESANAN",submit:"Hantar perubahan",
 s1:"Semak pesanan",s1a:"Jika perlu, ubah kuantiti, tarikh penghantaran, tanda penghantaran atau nota terus dalam jadual.",s1b:"Perubahan ialah permohonan — berkuat kuasa selepas kami sahkan.",
 s2:"Sahkan PI",s2b:"Atau muat turun PDF PI, tandatangan/cop dan muat naik di sini (PDF / imej).",or:"atau",view:"Lihat",download:"Muat turun",
 seller:"Penjual",buyer:"Pembeli",req_delivery:"Tarikh penghantaran diminta",marks:"Tanda penghantaran",no:"No.",item:"Keterangan barang",qty:"Kuantiti (KTN)",pack:"Unit/KTN",
 price:"Harga seunit",amount:"Jumlah",barcode:"Kod bar",note:"Nota anda",total:"JUMLAH",payment:"Terma bayaran",payee:"Sila bayar kepada",remarks:"Catatan",
 seller_sign:"Penjual",buyer_sign:"Pembeli (cop syarikat)",seal_here:"Cop syarikat",history:"Sejarah perubahan",
 pi_no:"No. PI",date:"Tarikh",currency:"Mata wang",terms:"Terma perdagangan",port:"Pelabuhan destinasi",cf_delivery:"Penghantaran disahkan (oleh kami)",
 tbc:"Akan disahkan",days:"hari",sched:"Jadual",account:"No. akaun",bank:"Bank",swift:"SWIFT",bank_addr:"Alamat bank",holder:"Nama akaun",
 tax:"No. cukai / pendaftaran",addr:"Alamat",name:"Syarikat",
 st_todo:"Belum",st_done:"Selesai",st_signed:"Ditandatangani",up_pi:"📎 Muat naik PI bertandatangan",reup:"Muat naik semula",
 seal_ok_t:"Cop syarikat anda telah didaftarkan",seal_ok_d:"Klik “Sahkan dengan cop syarikat” untuk mengecop ruangan Pembeli. Anda boleh lihat atau muat turun selepas itu.",
 seal_pend_t:"Cop syarikat sedang disemak",seal_pend_d:"Kami telah terima cop anda. Selepas diluluskan anda boleh sahkan dengan satu klik.",
 seal_none_t:"Tiada cop syarikat didaftarkan",seal_none_d:"Muat naik sekali, kemudian sahkan setiap PI dengan satu klik. PNG / JPG, ≤2 MB.",
 seal_flow:"Muat naik cop → kami semak (1 hari bekerja) → boleh digunakan",btn_seal:"🔏 Sahkan dengan cop syarikat",btn_up:"📤 Muat naik cop",btn_change:"🔄 Tukar cop",btn_reup:"📤 Muat naik cop semula",
 seal_new_pend:"Cop baharu sedang disemak; cop semasa masih boleh digunakan",seal_rej:"Cop terakhir tidak diluluskan: ",
 ask_seal:"Cop PI ini dengan cop syarikat berdaftar anda sebagai pengesahan?",ask_change:"Muat naik cop baharu untuk menggantikan cop semasa?",
 ok:"OK",cancel:"Batal",sealing:"⏳ Mengecop… (±20 saat)",sealed:"Disahkan dengan cop syarikat",saved:"Dihantar — terima kasih",nochange:"Tiada perubahan",
 uploaded:"Dimuat naik — terima kasih",seal_uploaded:"Cop dimuat naik — menunggu semakan",all_done:"✅ Disahkan — terima kasih!",
 tab_todo:"Untuk disahkan",tab_done:"Disahkan",tab_all:"Semua",login_t:"Sila log masuk dengan akaun syarikat anda",login_hint:"Log masuk dengan e-mel (atau akaun) dan kata laluan.",
 user:"E-mel atau akaun",pass:"Kata laluan",login:"Log masuk",logout:"Log keluar",logged:"Log masuk sebagai",
 ship_on:"Kerjasama penghantaran →",ship_off:"Kerjasama penghantaran dibuka selepas tempahan",returned:"Kami menghantar balik pesanan ini untuk diubah: ",
 inner:"Akaun dalaman (lihat sahaja).",
 req_note:"* Perubahan yang diminta oleh pembeli, tertakluk kepada pengesahan penjual.",
 first_login:"Kali pertama? Log masuk dengan e-mel",first_t:"Log masuk dengan e-mel",first_hint:"Gunakan e-mel yang kami hantar dokumen anda. Kami akan hantar kod 6 digit.",email:"E-mel",send_code:"Hantar kod",resend:"Hantar semula",code_sent:"Kod dihantar ke {e}. Semak peti masuk (dan spam).",code6:"Kod 6 digit",new_pw:"Tetapkan kata laluan (sekurang-kurangnya 8 aksara)",back_pw:"Saya ada kata laluan",
 notify_emails:"E-mel pemberitahuan",save:"Simpan",emails_saved:"E-mel pemberitahuan disimpan",terms_title:"Terma",
 nt_profile:"Notis kini dihantar ke: ",nt_custom:"Notis dihantar ke: ",nt_none:"Belum ada e-mel — sila tambah.",
 due_left:"Sila sahkan atau minta perubahan sebelum {d} ({n} lagi). Jika tiada jawapan, PI ini dianggap diterima.",
 due_over:"Tarikh akhir jawapan ({d}) telah lepas.",deemed_on:"PI ini dianggap diterima pada {d} (tiada jawapan dalam tempoh).",
 days:"hari",hours:"jam",
 no_link:"Pautan tidak lengkap. Sila buka pautan penuh yang kami hantar.",bad_link:"Pautan tidak sah",err:"Ralat: ",unsaved:"Perubahan belum dihantar akan hilang. Tukar?",
 max8:"Fail mesti 8 MB atau kurang.",max2:"Imej cop mesti 2 MB atau kurang.",login_fail:"Log masuk gagal",page_title:"Kerjasama Pesanan",readonly:"Pesanan ini telah disahkan oleh kami (baca sahaja)."}
};
var LANG=(function(){var l=Q.get("lang")||lsGet("order_collab_lang")||"en";return I[l]?l:"en"})();
function t(k){return (I[LANG]&&I[LANG][k])||I.en[k]||k}
function applyI18n(){
  document.documentElement.lang=LANG==="zh"?"zh-CN":LANG;
  [].forEach.call(document.querySelectorAll("[data-t]"),function(el){el.textContent=t(el.getAttribute("data-t"))});
  $("lang").innerHTML=["en","zh","ms"].map(function(l){return '<button type="button" data-lang="'+l+'" class="'+(l===LANG?"on":"")+'">'+(l==="zh"?"中":l==="ms"?"BM":"EN")+"</button>"}).join("");
}
document.addEventListener("click",function(e){var b=e.target.closest("#lang button[data-lang]");if(!b)return;LANG=b.getAttribute("data-lang");lsSet("order_collab_lang",LANG);applyI18n();if(D)render()});

var D=null,dirty=false,swTab="todo";
var IS_BUYER=false,WHO="";
function readJwt(){IS_BUYER=false;WHO="";try{var p=JSON.parse(atob((JWT.split(".")[1]||"").replace(/-/g,"+").replace(/_/g,"/")));WHO=p.username||"";IS_BUYER=String(p.role||"").toLowerCase()==="customer"}catch(e){}}

function load(){
  applyI18n();
  if(!TOKEN){$("state").innerHTML="<b>"+esc(t("no_link"))+"</b>";return}
  fetch(API+"/validate?token="+encodeURIComponent(TOKEN)+(SHEETQ?"&sheet="+encodeURIComponent(SHEETQ):""),{headers:AH()})
    .then(function(r){return r.json()}).then(function(j){
      if(j.need_login){showLogin(j.forbidden?j.error:"");return}
      if(!j.valid){$("state").innerHTML="<b>"+esc(j.error||t("bad_link"))+"</b>";return}
      D=j;readJwt();$("state").style.display="none";$("wrap").style.display="";render();
    }).catch(function(e){$("state").innerHTML="<b>"+esc(t("err"))+"</b>"+esc(e.message)});
}
function showLogin(msg){
  $("wrap").style.display="none";$("swBar").style.display="none";$("shipBar").style.display="none";$("state").style.display="";
  $("state").innerHTML='<div class="loginbox"><b style="font-size:15px">'+esc(t("login_t"))+'</b>'
    +(msg?'<div style="font-size:12px;color:var(--miss);margin-top:6px">'+esc(msg)+'</div>':'')
    +'<div style="font-size:11.5px;color:var(--dim);margin-top:4px">'+esc(t("login_hint"))+'</div>'
    +'<input id="lgU" placeholder="'+esc(t("user"))+'" autocomplete="username"><input id="lgP" type="password" placeholder="'+esc(t("pass"))+'" autocomplete="current-password">'
    +'<button id="lgBtn">'+esc(t("login"))+'</button><div id="lgErr" style="color:var(--miss);font-size:12px;margin-top:8px"></div></div>';
  var go=function(){var u=$("lgU").value.trim(),pw=$("lgP").value;if(!u||!pw)return;$("lgBtn").disabled=true;
    fetch(BASE+"/api/db/auth-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:pw})})
      .then(function(r){return r.json()}).then(function(j){
        if(!j.token){$("lgErr").textContent=j.error||t("login_fail");$("lgBtn").disabled=false;return}
        lsSet("order_collab_jwt",j.token);JWT=j.token;$("state").innerHTML="Loading…";load();
      }).catch(function(e){$("lgErr").textContent=e.message;$("lgBtn").disabled=false})};
  $("lgBtn").onclick=go;$("lgP").onkeydown=function(e){if(e.key==="Enter")go()};
  var bx=$("state").querySelector(".loginbox");
  bx.insertAdjacentHTML("beforeend",'<div class="lgfirst"><a href="#" id="lgFirst">'+esc(t("first_login"))+'</a></div>');
  $("lgFirst").onclick=function(e){e.preventDefault();showCodeLogin()};
}
// 第一次登录：邮箱收 6 位码 → 填码 + 设密码 → 建账号并登录（只认我们在档的贵司邮箱）
function showCodeLogin(){
  $("state").innerHTML='<div class="loginbox"><b style="font-size:15px">'+esc(t("first_t"))+'</b>'
    +'<div style="font-size:11.5px;color:var(--dim);margin-top:4px">'+esc(t("first_hint"))+'</div>'
    +'<input id="cdE" type="email" placeholder="'+esc(t("email"))+'" autocomplete="email"><button id="cdSend">'+esc(t("send_code"))+'</button>'
    +'<div id="cdStep2" style="display:none"><div id="cdSent" style="font-size:12px;color:var(--ok,#2E7D5B);margin-top:8px"></div>'
    +'<input id="cdC" inputmode="numeric" maxlength="6" placeholder="'+esc(t("code6"))+'" autocomplete="one-time-code">'
    +'<input id="cdP" type="password" placeholder="'+esc(t("new_pw"))+'" autocomplete="new-password">'
    +'<button id="cdGo">'+esc(t("login"))+'</button></div>'
    +'<div id="cdErr" style="color:var(--miss);font-size:12px;margin-top:8px"></div>'
    +'<div class="lgfirst"><a href="#" id="cdBack">'+esc(t("back_pw"))+'</a></div></div>';
  var send=function(){var em=$("cdE").value.trim();if(!em)return;$("cdSend").disabled=true;$("cdErr").textContent="";
    fetch(API+"/login-code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TOKEN,email:em})})
      .then(function(r){return r.json()}).then(function(j){$("cdSend").disabled=false;
        if(!j.ok){$("cdErr").textContent=j.error||"Error";return}
        $("cdSent").textContent=t("code_sent").replace("{e}",em);$("cdStep2").style.display="";$("cdSend").textContent=t("resend");$("cdC").focus()})
      .catch(function(e){$("cdSend").disabled=false;$("cdErr").textContent=e.message})};
  var go=function(){var em=$("cdE").value.trim(),c=$("cdC").value.trim(),pw=$("cdP").value;if(!em||!c||!pw)return;$("cdGo").disabled=true;$("cdErr").textContent="";
    fetch(API+"/login-verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:TOKEN,email:em,code:c,password:pw})})
      .then(function(r){return r.json()}).then(function(j){
        if(!j.token){$("cdGo").disabled=false;$("cdErr").textContent=j.error||t("login_fail");return}
        lsSet("order_collab_jwt",j.token);JWT=j.token;$("state").innerHTML="Loading…";load()})
      .catch(function(e){$("cdGo").disabled=false;$("cdErr").textContent=e.message})};
  $("cdSend").onclick=send;$("cdGo").onclick=go;$("cdP").onkeydown=function(e){if(e.key==="Enter")go()};
  $("cdBack").onclick=function(e){e.preventDefault();showLogin("")};
}

function eff(l,k){var th=l.theirs||{},o=l.ours||{};return th[k]!=null&&th[k]!==""?th[k]:(o[k]!=null?o[k]:"")}
function kv(rows){return rows.filter(function(r){return r[1]}).map(function(r){return "<span>"+esc(t(r[0]))+"：</span><i class=\"fill\">"+esc(r[1])+"</i>"}).join("")}
var PDF=document.documentElement.classList.contains("pdfmode");
function render(){
  var s=D.sheet,ro=s.status==="adopted";window.READONLY=ro;var fix=ro||PDF;
  document.title="PI "+(s.display_no||"")+" · "+t("page_title");
  $("tag").innerHTML=esc(t("subtitle"))+(WHO?" · "+esc(t("logged"))+" "+esc(WHO)+' · <a href="#" id="bLogout">'+esc(t("logout"))+"</a>":"");
  $("retMsg").style.display=s.return_reason?"":"none";$("retMsg").textContent=t("returned")+(s.return_reason||"");
  var se=s.seller||{},bu=s.buyer||{};
  $("seller").innerHTML=kv([["name",se.name_en],["addr",se.address],["tax",se.tax_id]]);
  $("buyer").innerHTML=kv([["name",bu.name_en],["addr",bu.address],["tax",bu.tax_id||bu.registration_no]]);
  $("sigSeller").textContent=se.name_en||"";$("sigBuyer").textContent=bu.name_en||"";
  $("meta").innerHTML=[["pi_no",s.display_no],["date",s.order_date],["currency",s.currency],["terms",s.trade_terms],["port",s.destination_port],["cf_delivery",s.confirmed_delivery]]
    .map(function(r){return "<div><span>"+esc(t(r[0]))+"</span><b>"+esc(r[1]||"—")+"</b></div>"}).join("");
  var rq=s.request||{};
  $("rqDeliveryTxt").textContent=(rq.delivery||"—")+(PDF&&rq.delivery?" *":"");
  paintDue(s);paintNotify(s);paintTerms(s);
  if($("rqDelivery")){$("rqDelivery").value=rq.delivery||"";$("rqMarks").value=rq.marks!=null?rq.marks:(s.marks||"");$("rqRemarks").value=rq.remarks||"";
  $("rqDelivery").classList.toggle("edited",!!rq.delivery);$("rqMarks").classList.toggle("edited",rq.marks!=null);$("rqRemarks").classList.toggle("edited",!!rq.remarks);}
  $("thPrice").textContent=t("price")+(s.currency?" ("+s.currency+")":"");$("thAmt").textContent=t("amount")+(s.currency?" ("+s.currency+")":"");
  var tq=0,ta=0;
  // PDF 里图片列整列不要（固定列宽下隐藏列会把表格挤窄）
  if(PDF){var th3=document.querySelector("table.items thead th:nth-child(3)");if(th3&&th3.classList.contains("no-print"))th3.remove()}
  $("tb").innerHTML=D.lines.map(function(l){
    var q=num(eff(l,"qty")),p=num(l.ours.price),a=(q!=null&&p!=null)?q*p:num(l.ours.amount);
    tq+=q||0;ta+=a||0;var th=l.theirs||{};
    return '<tr data-id="'+esc(l.id)+'"><td class="c num">'+esc(l.seq)+"</td><td>"+esc(l.product_name)+"</td>"
      +(PDF?"":'<td class="c no-print col-img">'+(l.image_url?'<img src="'+esc(l.image_url)+'" style="width:28px;height:28px;object-fit:cover;border-radius:2px">':"")+"</td>")
      +'<td class="c num'+(th.qty!=null?" edited":"")+'">'+(fix?esc(q==null?"":q)+(PDF&&th.qty!=null?" *":""):'<input class="cq" data-k="qty" value="'+esc(q==null?"":q)+'" inputmode="numeric">')+"</td>"
      +'<td class="c num">'+esc(l.ours.pack||"")+'</td><td class="r num">'+price(p)+'</td><td class="r num">'+money(a)+"</td>"
      +'<td class="c num">'+esc(l.ours.barcode||"")+"</td>"
      +'<td class="col-note'+(th.note?" edited":"")+'">'+(fix?esc(th.note||""):'<input class="cn" data-k="note" value="'+esc(th.note||"")+'">')+"</td></tr>";
  }).join("");
  if(PDF)$("totLbl").colSpan=2;
  $("totQty").textContent=tq;$("totAmt").textContent=money(ta);
  var noimg=!D.lines.some(function(l){return l.image_url});document.querySelector("table.items").classList.toggle("noimg",noimg);
  $("totLbl").colSpan=(PDF||noimg)?2:3;
  var anyNote=D.lines.some(function(l){return (l.theirs||{}).note});
  [].forEach.call(document.querySelectorAll(".col-note"),function(el){el.classList.toggle("empty",!anyNote)});
  var anyReq=D.lines.some(function(l){return (l.theirs||{}).qty!=null})||!!(rq.delivery||rq.marks!=null||rq.remarks);
  $("reqNote").classList.toggle("on",anyReq);
  if(PDF&&!window._pdfFlat){window._pdfFlat=1;[["rqMarks",rq.marks!=null?rq.marks:s.marks],["rqRemarks",rq.remarks]].forEach(function(x){
    var el=$(x[0]),d=document.createElement("div");d.className="pdfval";d.textContent=(x[1]||"—")+((x[0]==="rqMarks"?rq.marks!=null:!!x[1])?" *":"");el.replaceWith(d)})}
  var pm=s.payment||{};
  $("payTerms").innerHTML=(pm.terms||pm.schedule||pm.days!=null)
    ?(pm.terms?"<div>"+esc(pm.terms)+"</div>":"")+(pm.days!=null?"<div>"+esc(pm.days)+" "+esc(t("days"))+"</div>":"")+(pm.schedule&&!pm.terms?"<div>"+esc(t("sched"))+"："+esc(typeof pm.schedule==="string"?pm.schedule:JSON.stringify(pm.schedule))+"</div>":"")
    :'<span class="tbc">'+esc(t("tbc"))+"</span>";
  var py=s.payee;
  $("payee").innerHTML=py?'<div class="kv">'+kv([["holder",py.account_holder],["bank",py.bank_name_en],["account",py.account_no],["swift",py.swift],["bank_addr",py.bank_address]])+"</div>":'<span class="tbc">'+esc(t("tbc"))+"</span>";
  [].forEach.call(document.querySelectorAll("#wrap input,#wrap textarea"),function(el){if(el.type!=="file")el.disabled=ro});
  $("bSave").style.display=ro?"none":"";
  $("histList").innerHTML=(D.history||[]).map(function(h){return "<li>"+esc(String(h.created_at).slice(0,16).replace("T"," "))+" · #"+esc(h.seq)+" "+esc(h.field)+"："+esc(h.old_val==null?"—":h.old_val)+" → "+esc(h.new_val==null?"—":h.new_val)+" · "+esc(h.who)+"</li>"}).join("");
  $("histBox").style.display=(D.history||[]).length?"":"none";
  dirty=false;$("saveHint").textContent=ro?t("readonly"):"";
  paintSteps();renderSwitch();renderShip();
}
function fmtBJ(v){if(!v)return "";var d=new Date(new Date(v).getTime()+8*3600e3);return d.toISOString().slice(0,16).replace("T"," ")+" (GMT+8)"}
function paintDue(s){
  var b=$("dueBar");b.className="duebar no-print";
  if(s.deemed_at){b.classList.add("done");b.textContent=t("deemed_on").replace("{d}",fmtBJ(s.deemed_at));b.style.display="";return}
  if(!s.reply_due_at||["confirmed","adopted"].indexOf(s.status)>=0){b.style.display="none";return}
  var left=new Date(s.reply_due_at).getTime()-Date.now();
  if(left<=0){b.textContent=t("due_over").replace("{d}",fmtBJ(s.reply_due_at));b.style.display="";return}
  var n=left>=864e5?Math.floor(left/864e5)+" "+t("days"):Math.max(1,Math.ceil(left/36e5))+" "+t("hours");
  b.textContent=t("due_left").replace("{d}",fmtBJ(s.reply_due_at)).replace("{n}",n);b.style.display="";
}
function paintNotify(s){
  var nt=s.notify||{},to=nt.to||[];
  if(document.activeElement!==$("ntEmails"))$("ntEmails").value=(nt.custom&&nt.custom.length?nt.custom:to).join(", ");
  $("ntHint").textContent=to.length?(t(nt.source==="customer"?"nt_custom":"nt_profile")+to.join(", ")):t("nt_none");
  $("bNt").disabled=!IS_BUYER||!!window.READONLY;
}
function paintTerms(s){
  var list=s.terms||[];$("piTermsBox").style.display=list.length?"":"none";
  $("piTerms").innerHTML=list.map(function(x){return "<li>"+esc(x.en)+"</li>"}).join("");
}
function paintSteps(){
  var s=D.sheet,cf=s.contract_file,sub=!!s.submitted_at;
  $("stp1").classList.toggle("done",sub);$("st1").textContent=sub?t("st_done"):t("st_todo");
  $("stp2").classList.toggle("done",!!cf);$("st2").textContent=cf?("✓ "+t("st_signed")):t("st_todo");
  $("bSigned").textContent=cf?t("reup"):t("up_pi");$("cfLinks").style.display=cf?"":"none";
  $("bSigned").style.display=window.READONLY?"none":"";
  paintSeal(s.seal||{status:"none"});
  var old=$("steps").querySelector(".alldone");if(old)old.remove();
  if(s.status==="confirmed"||s.status==="adopted"){var d=document.createElement("div");d.className="alldone";d.textContent=t("all_done");$("steps").appendChild(d)}
  var su=(s.seal||{}).url,sp=$("sealSpot"),pi=sp.querySelector("img");if(pi)pi.remove();
  if(su&&(s.seal||{}).status==="active"){var im=document.createElement("img");im.src=su;im.alt="";sp.appendChild(im)}
}
function paintSeal(se){
  var st=se.status,ro=!!window.READONLY,pend=se.pending||(st==="pending"?{url:se.url}:null),showUrl=st==="active"?se.url:(pend&&pend.url);
  $("sealPic").innerHTML=showUrl?'<img alt="" src="'+esc(showUrl)+'">':"—";
  $("sealTitle").textContent=t(st==="active"?"seal_ok_t":st==="pending"?"seal_pend_t":"seal_none_t");
  $("sealDesc").textContent=t(st==="active"?"seal_ok_d":st==="pending"?"seal_pend_d":"seal_none_d");
  var rej=st==="rejected"?se.reason:se.rejected_reason,msg="";
  if(st==="active"&&pend)msg=t("seal_new_pend");else if(rej)msg=t("seal_rej")+rej;
  if(!IS_BUYER)msg=t("inner");
  $("sealMsg").style.display=msg?"block":"none";$("sealMsg").textContent=msg;
  $("bSeal").textContent=t("btn_seal");$("bSeal").style.display=(st==="active"&&!ro)?"":"none";
  $("bSealUp").style.display=(ro||st==="pending"||(st==="active"&&pend))?"none":"";
  $("bSealUp").textContent=st==="active"?t("btn_change"):rej?t("btn_reup"):t("btn_up");
  $("bSeal").disabled=$("bSealUp").disabled=!IS_BUYER;
}
function renderSwitch(){
  var sib=(D.sheet.siblings||[]);if(sib.length<2){$("swBar").style.display="none";return}
  $("swBar").style.display="";
  var todo=sib.filter(function(x){return ["sent","opened","submitted","returned"].indexOf(x.status)>=0}),done=sib.filter(function(x){return ["confirmed","adopted"].indexOf(x.status)>=0});
  $("swTabs").innerHTML=[["todo",t("tab_todo")+" "+todo.length,true],["done",t("tab_done")+" "+done.length],["all",t("tab_all")+" "+sib.length]]
    .map(function(x){return '<button type="button" data-tab="'+x[0]+'" class="'+(swTab===x[0]?"on":"")+(x[2]&&todo.length?" red":"")+'">'+esc(x[1])+"</button>"}).join("");
  var list=swTab==="todo"?todo:swTab==="done"?done:sib;
  $("swList").innerHTML=list.map(function(x){return '<div class="swchip'+(String(x.id)===String(D.sheet.id)?" cur":"")+(todo.indexOf(x)>=0?" todo":"")+'" data-sheet="'+esc(x.id)+'">'+esc(x.no)+(x.total_qty?" · "+esc(x.total_qty)+" CTN":"")+"<small>"+esc(x.company||"")+"</small></div>"}).join("");
}
function renderShip(){
  var sh=D.sheet.shipment||{};$("shipBar").style.display="";
  $("shipBar").innerHTML=sh.available?'<a id="bShip">'+esc(t("ship_on"))+"</a>":'<span class="off">'+esc(t("ship_off"))+"</span>";
}
// 页内确认框（原生 confirm 在内嵌浏览器里直接返回取消）
function ask(msg,fn){var m=document.createElement("div");m.className="askmask no-print";
  m.innerHTML='<div class="askbox" role="dialog"><div class="askmsg"></div><div class="askbtns"><button type="button" class="no"></button><button type="button" class="ok"></button></div></div>';
  m.querySelector(".askmsg").textContent=msg;m.querySelector(".no").textContent=t("cancel");m.querySelector(".ok").textContent=t("ok");
  m.querySelector(".no").onclick=function(){m.remove()};m.onclick=function(e){if(e.target===m)m.remove()};
  m.querySelector(".ok").onclick=function(){m.remove();fn()};document.body.appendChild(m)}
function post(path,body){body=body||{};body.token=TOKEN;body.sheet=D.sheet.id;
  return fetch(API+path,{method:"POST",headers:AH({"Content-Type":"application/json"}),body:JSON.stringify(body)}).then(function(r){return r.json()})}
function sq(){return "?token="+encodeURIComponent(TOKEN)+"&sheet="+encodeURIComponent(D.sheet.id)}
function openPdf(p,dl){var w=dl?null:window.open("","_blank");
  fetch(API+p,{headers:AH()}).then(function(r){if(!r.ok)return r.json().then(function(j){throw new Error(j.error||r.status)});return r.blob()})
    .then(function(b){var u=URL.createObjectURL(b);if(dl||!w){var a=document.createElement("a");a.href=u;a.download="PI-"+(D.sheet.display_no||D.sheet.id)+".pdf";document.body.appendChild(a);a.click();a.remove()}else w.location=u})
    .catch(function(e){if(w)w.close();toast(e.message,true)})}
function readFile(f,cb){var fr=new FileReader();fr.onload=function(){cb(String(fr.result).split(",")[1])};fr.readAsDataURL(f)}

$("wrap").addEventListener("input",function(e){if(e.target.matches("input,textarea")&&e.target.type!=="file"){dirty=true;e.target.closest("td,div").classList&&e.target.classList.add("edited")}});
$("bSave").onclick=function(){
  var lines=[].map.call(document.querySelectorAll("#tb tr[data-id]"),function(tr){var o={id:tr.getAttribute("data-id")};
    [].forEach.call(tr.querySelectorAll("input[data-k]"),function(i){o[i.getAttribute("data-k")]=i.value});return o});
  var b=this;b.disabled=true;
  post("/submit",{lines:lines,request:{delivery:$("rqDelivery").value,marks:$("rqMarks").value,remarks:$("rqRemarks").value}}).then(function(j){
    b.disabled=false;if(!j.ok){toast(j.error||"Error",true);return}toast(j.changed?t("saved"):t("nochange"));load()}).catch(function(e){b.disabled=false;toast(e.message,true)})};
$("bNt").onclick=function(){var b=this;b.disabled=true;
  post("/notify-emails",{emails:$("ntEmails").value}).then(function(j){b.disabled=false;if(!j.ok){toast(j.error||"Error",true);return}toast(t("emails_saved"));load()})
    .catch(function(e){b.disabled=false;toast(e.message,true)})};
$("bPdf").onclick=function(){openPdf("/contract-pdf"+sq())};
$("bPrint").onclick=function(){window.print()};
$("cfView").onclick=function(e){e.preventDefault();openPdf("/contract"+sq())};
$("cfDl").onclick=function(e){e.preventDefault();openPdf("/contract"+sq()+"&dl=1",true)};
$("bSigned").onclick=function(){$("fileInput").value="";$("fileInput").click()};
$("fileInput").onchange=function(){var f=this.files&&this.files[0];if(!f)return;if(f.size>8*1024*1024){toast(t("max8"),true);return}
  readFile(f,function(b64){post("/upload",{kind:"signed_back",filename:f.name,mime:f.type,data_base64:b64}).then(function(j){if(!j.ok){toast(j.error||"Error",true);return}toast(t("uploaded"));load()})})};
$("bSeal").onclick=function(){var b=this;ask(t("ask_seal"),function(){b.disabled=true;b.textContent=t("sealing");
  post("/seal").then(function(j){b.disabled=false;b.textContent=t("btn_seal");if(!j.ok){toast(j.error||"Error",true);return}toast(t("sealed"));load()})
    .catch(function(e){b.disabled=false;b.textContent=t("btn_seal");toast(e.message,true)})})};
$("bSealUp").onclick=function(){var pick=function(){$("sealFile").value="";$("sealFile").click()};
  if((D.sheet.seal||{}).status==="active")ask(t("ask_change"),pick);else pick()};
$("sealFile").onchange=function(){var f=this.files&&this.files[0];if(!f)return;if(f.size>2*1024*1024){toast(t("max2"),true);return}
  readFile(f,function(b64){post("/seal-upload",{filename:f.name,mime:f.type,data_base64:b64}).then(function(j){if(!j.ok){toast(j.error||"Error",true);return}toast(t("seal_uploaded"));load()})})};
document.addEventListener("click",function(e){
  if(e.target.id==="bLogout"){e.preventDefault();try{localStorage.removeItem("order_collab_jwt")}catch(x){}JWT="";showLogin();return}
  if(e.target.id==="bShip"){post("/shipment-link").then(function(j){if(j.ok&&j.url)location.href=j.url;else toast(j.error||t("ship_off"),true)});return}
  var tb=e.target.closest("#swTabs button[data-tab]");if(tb){swTab=tb.getAttribute("data-tab");renderSwitch();return}
  var c=e.target.closest(".swchip[data-sheet]");if(!c||String(c.getAttribute("data-sheet"))===String(D.sheet.id))return;
  var go=function(){Q.set("sheet",c.getAttribute("data-sheet"));location.search=Q.toString()};if(dirty)ask(t("unsaved"),go);else go();
});
load();
})();
