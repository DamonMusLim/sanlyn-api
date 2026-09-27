(function(){
"use strict";
var BASE=(location.pathname.indexOf("/po-test/")===0)?"/po-test":"";
var API=BASE+"/api/db/po-collab/order-request";
var Q=new URLSearchParams(location.search), CFG=null, PRODUCTS=[], BUYERS=[], REQS=[];
var LANG="zh", JWT=ls("order_collab_jwt")||ls("sanlyn_jwt"), buyerCode=Q.get("buyer")||"";
var T={en:{title:"New order request",hint:"Select products, enter quantities, and send the request to Sanlyn.",buyer:"Buyer",arrival:"Requested arrival date",po:"Customer PO",container:"Container",product:"Products",name:"Product",pack:"Pack",price:"Last customer price · reference",qty:"CTN",new:"New item",desc:"Description",remarks:"Remarks",file:"Upload original files",submit:"Send request",mine:"My requests",quoted:"To be quoted",login:"Please log in",user:"Email or account",pass:"Password",go:"Log in",sent:"Sent",err:"Error: "},
zh:{title:"订单申请",hint:"选择产品、填写箱数和要求信息后提交，我方审核后生成后续单据。",buyer:"买方",arrival:"要求到货日期",po:"客户 PO",container:"柜型 / 柜量",product:"产品",name:"品名",pack:"装箱",price:"上票客户价·参考",qty:"箱数",new:"新品",desc:"描述",remarks:"备注",file:"上传原件",submit:"提交申请",mine:"我的申请",quoted:"待报价",login:"请登录账号",user:"邮箱或账号",pass:"密码",go:"登录",sent:"已提交",err:"出错："}};
function $(id){return document.getElementById(id)}
function ls(k){try{return localStorage.getItem(k)||""}catch(e){return ""}}
function setLs(k,v){try{localStorage.setItem(k,v)}catch(e){}}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
function tr(k){return (T[LANG]&&T[LANG][k])||T.en[k]||k}
function toast(m,err){var t=$("toast");t.textContent=m;t.className="toast"+(err?" err":"");t.style.display="block";clearTimeout(t._h);t._h=setTimeout(function(){t.style.display="none"},3000)}
function ah(h){h=h||{};if(JWT)h.Authorization="Bearer "+JWT;return h}
function jfetch(url,opt){opt=opt||{};opt.headers=ah(opt.headers||{});return fetch(url,opt).then(function(r){return r.json().then(function(j){if(r.status===401||j.need_login){showLogin(j.error||"");throw new Error("login")}if(!r.ok||j.ok===false)throw new Error(j.error||("HTTP "+r.status));return j})})}
function setLang(l){LANG=l;setLs("order_request_lang",l);paintText()}
function paintLang(){if(CFG.channel!=="customer"){$("lang").style.display="none";LANG="zh";return}if(!LANG)LANG="en";$("lang").style.display="flex";$("lang").innerHTML=["en","zh"].map(function(l){return '<button type="button" data-l="'+l+'" class="'+(l===LANG?"on":"")+'">'+(l==="zh"?"中":"EN")+"</button>"}).join("")}
function paintText(){
  $("title").textContent=tr("title");$("hint").textContent=tr("hint");$("arrivalLbl").textContent=tr("arrival");$("poLbl").textContent=tr("po");$("containerLbl").textContent=tr("container");
  $("productLbl").textContent=tr("product");$("thName").textContent=tr("name");$("thPack").textContent=tr("pack");$("thPrice").textContent=CFG&&CFG.channel==="factory"?"上次采购价":tr("price");$("thQty").textContent=tr("qty");
  $("addNew").textContent=tr("new");$("remarksLbl").textContent=tr("remarks");$("fileLbl").textContent=tr("file");$("submit").textContent=tr("submit");$("mineTitle").textContent=tr("mine");
  paintLang();renderProducts();renderRequests();
}
function showLogin(msg){
  $("app").style.display="none";$("state").style.display="block";
  $("state").innerHTML='<div class="loginbox"><b>'+esc(tr("login"))+'</b>'+(msg?'<div style="color:var(--miss);font-size:12px">'+esc(msg)+'</div>':"")
    +'<input id="lgU" placeholder="'+esc(tr("user"))+'" autocomplete="username"><input id="lgP" type="password" placeholder="'+esc(tr("pass"))+'" autocomplete="current-password"><button class="btn pri" id="lgB">'+esc(tr("go"))+'</button><div id="lgE" style="color:var(--miss);font-size:12px;margin-top:8px"></div></div>';
  $("lgB").onclick=function(){var u=$("lgU").value.trim(),p=$("lgP").value;if(!u||!p)return;$("lgB").disabled=true;
    fetch(BASE+"/api/db/auth-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:p})}).then(function(r){return r.json()}).then(function(j){
      if(!j.token){$("lgE").textContent=j.error||"Login failed";$("lgB").disabled=false;return}JWT=j.token;setLs("order_collab_jwt",j.token);load();
    }).catch(function(e){$("lgE").textContent=e.message;$("lgB").disabled=false})};
}
function load(){
  LANG=ls("order_request_lang")||"";
  jfetch(API+"/form"+(buyerCode?"?buyer="+encodeURIComponent(buyerCode):"")).then(function(j){
    CFG=j.formConfig||{};PRODUCTS=j.products||[];BUYERS=j.buyers||[];if(!buyerCode&&BUYERS[0])buyerCode=BUYERS[0].code;if(!buyerCode&&CFG.buyer&&CFG.buyer.fixed)buyerCode=CFG.buyer.fixed.code||"";
    $("state").style.display="none";$("app").style.display="grid";$("tag").textContent=(CFG.channel||"")+" · "+(buyerCode||"");
    renderBuyer();applyFields();paintText();loadRequests();
  }).catch(function(e){if(e.message!=="login")$("state").textContent=tr("err")+e.message});
}
function renderBuyer(){
  var box=$("buyerBox"), b=CFG.buyer||{};
  if(CFG.channel==="factory"){box.innerHTML='<label>'+esc(tr("buyer"))+'</label><div class="fixed">厦门巴匕进出口有限公司</div>';return}
  if(CFG.channel==="internal"){box.innerHTML='<label>'+esc(tr("buyer"))+'</label><input id="buyerSearch" list="buyers" value="'+esc(buyerCode)+'" placeholder="输入客户代码或名称"><datalist id="buyers">'+BUYERS.map(function(x){return '<option value="'+esc(x.code)+'">'+esc(x.name||x.code)+'</option>'}).join("")+'</datalist>';$("buyerSearch").onchange=function(){buyerCode=this.value.trim();load()};return}
  var opts=BUYERS.map(function(x){return '<option value="'+esc(x.code)+'" '+(x.code===buyerCode?"selected":"")+'>'+esc(x.name||x.code)+'</option>'}).join("");
  box.innerHTML='<label>'+esc(tr("buyer"))+'</label><select id="buyerSel">'+opts+"</select>";
  $("buyerSel").onchange=function(){buyerCode=this.value;load()};
  if(!BUYERS.length&&b.fixed)box.innerHTML='<label>'+esc(tr("buyer"))+'</label><div class="fixed">'+esc(b.fixed.name||b.fixed.code||buyerCode)+"</div>";
}
function applyFields(){
  var f=(CFG.fields||[]).join(",");
  $("poBox").style.display=f.indexOf("customer_po")>=0?"":"none";
  $("sourceBox").style.display=f.indexOf("source")>=0?"":"none";
  $("readyBox").style.display=f.indexOf("factory_ready_date")>=0?"":"none";
}
function fmtPrice(v){return v==null||v===""?tr("quoted"):Number(v).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:4})}
function renderProducts(){
  if(!CFG)return;var q=($("q").value||"").toLowerCase();
  $("products").innerHTML=PRODUCTS.filter(function(p){return !q||String(p.sku+" "+p.name).toLowerCase().indexOf(q)>=0}).map(function(p){
    return '<tr data-sku="'+esc(p.sku)+'"><td>'+esc(p.sku)+'</td><td>'+esc(p.name||"")+'</td><td>'+esc(p.pack||"")+'</td><td class="r">'+esc(fmtPrice(p.last_price))+'</td><td class="c"><input class="qty" inputmode="numeric" data-qty value=""></td></tr>';
  }).join("")||'<tr><td colspan="5" class="empty">No products</td></tr>';
}
function addNewLine(){var id="n"+Date.now(), row=document.createElement("tr");row.className="newrow";row.innerHTML='<td>'+esc(tr("new"))+'</td><td colspan="2"><input data-desc placeholder="'+esc(tr("desc"))+'"></td><td></td><td class="c"><input class="qty" inputmode="numeric" data-newqty></td>';row.setAttribute("data-new",id);$("newLines").appendChild(row)}
function collect(){
  var lines=[];[].forEach.call(document.querySelectorAll("#products tr[data-sku]"),function(r){var q=r.querySelector("[data-qty]").value.trim();if(!q)return;var p=PRODUCTS.filter(function(x){return String(x.sku)===r.getAttribute("data-sku")})[0]||{};lines.push({sku:p.sku,productName:p.name,qty:Number(q),unitPrice:p.last_price})});
  [].forEach.call(document.querySelectorAll("#newLines tr"),function(r){var d=r.querySelector("[data-desc]").value.trim(),q=r.querySelector("[data-newqty]").value.trim();if(d||q)lines.push({productName:d,description:d,qty:Number(q||0)})});
  return {companyCode:buyerCode,products:lines,requiredArrivalDate:$("requiredArrivalDate").value,customerPO:$("customerPO").value,container:$("container").value,remarks:$("remarks").value,source:$("source").value,factory_ready_date:$("factoryReadyDate").value};
}
function submit(){
  var data=collect(),fs=$("files").files;if(!data.products.length){toast("请至少填写一行箱数",true);return}
  $("submit").disabled=true;
  var opt={method:"POST"}, url=API;
  if(fs&&fs.length){var fd=new FormData();fd.append("payload",JSON.stringify(data));[].slice.call(fs,0,5).forEach(function(f,i){fd.append("file"+i,f)});opt.body=fd;opt.headers=ah({})}
  else{opt.headers=ah({"Content-Type":"application/json"});opt.body=JSON.stringify(data)}
  fetch(url,opt).then(function(r){return r.json().then(function(j){if(!r.ok||j.ok===false)throw new Error(j.error||r.status);return j})}).then(function(){toast(tr("sent"));loadRequests();document.querySelectorAll("input[data-qty],input[data-newqty],[data-desc]").forEach(function(i){i.value=""})}).catch(function(e){toast(e.message,true)}).finally(function(){$("submit").disabled=false});
}
function loadRequests(){jfetch(API).then(function(j){REQS=j.requests||[];renderRequests()}).catch(function(){})}
function renderRequests(){if(!REQS.length){$("requests").innerHTML='<div class="empty">No requests</div>';return}$("requests").innerHTML=REQS.map(function(r){return '<div class="req"><b>#'+esc(r.id)+' · '+esc(r.status||"")+'</b><small>'+esc((r.created_at||"").slice(0,16).replace("T"," "))+'</small>'+(r.return_reason?'<div class="ret">'+esc(r.return_reason)+'</div>':"")+"</div>"}).join("")}
document.addEventListener("click",function(e){var b=e.target.closest("#lang button[data-l]");if(b)setLang(b.getAttribute("data-l"))});
$("q").oninput=renderProducts;$("addNew").onclick=addNewLine;$("submit").onclick=submit;load();
})();
