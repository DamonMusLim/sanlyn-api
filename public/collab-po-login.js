(function(){
"use strict";
function ctx(){return window.__poLogin}
function $(id){return ctx().$(id)}
function esc(s){return ctx().esc(s)}
function errText(id,msg){var el=$(id);if(el)el.textContent=msg||""}
function setWait(btn,sec,label){
  clearInterval(btn._wait);
  var left=sec;
  btn.disabled=true;
  btn.textContent=left+" 秒后可重新发送";
  btn._wait=setInterval(function(){
    left-=1;
    if(left<=0){clearInterval(btn._wait);btn.disabled=false;btn.textContent=label;return}
    btn.textContent=left+" 秒后可重新发送";
  },1000);
}
window.showLogin=function(msg){
  var c=ctx();
  $("wrap").style.display="none";$("swBar").style.display="none";$("state").style.display="";
  $("state").innerHTML='<div class="loginbox"><b style="font-size:15px">请登录贵司账号查看采购单</b>'
    +(msg?'<div style="font-size:12px;color:var(--miss);margin-top:6px">'+esc(msg)+'</div>':'')
    +'<div style="font-size:11.5px;color:var(--dim);margin-top:4px">用邮箱（或账号）和密码登录</div>'
    +'<input id="lgU" placeholder="邮箱或账号" autocomplete="username"><input id="lgP" type="password" placeholder="密码" autocomplete="current-password">'
    +'<button id="lgBtn">登录</button><div id="lgErr" style="color:var(--miss);font-size:12px;margin-top:8px"></div>'
    +'<div class="lgfirst"><a href="#" id="lgFirst">第一次登录 / 忘记密码？用邮箱验证码</a></div></div>';
  var go=function(){
    var u=$("lgU").value.trim(), pw=$("lgP").value;
    if(!u||!pw){errText("lgErr","请填邮箱（或账号）和密码");return}
    $("lgBtn").disabled=true;errText("lgErr","");
    fetch(c.BASE()+"/api/db/auth-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username:u,password:pw})})
      .then(function(r){return r.json()}).then(function(j){
        if(!j.token){errText("lgErr",j.error||"登录失败");$("lgBtn").disabled=false;return}
        try{localStorage.setItem("po_factory_jwt",j.token)}catch(e){}
        c.setFJWT(j.token);$("state").innerHTML="正在读取采购单…";c.load();
      }).catch(function(e){errText("lgErr","登录失败："+e.message);$("lgBtn").disabled=false});
  };
  $("lgBtn").onclick=go;$("lgP").onkeydown=function(e){if(e.key==="Enter")go()};
  $("lgFirst").onclick=function(e){e.preventDefault();window.showPoCodeLogin()};
};
window.showPoCodeLogin=function(){
  var c=ctx();
  $("state").innerHTML='<div class="loginbox"><b style="font-size:15px">用邮箱验证码登录 / 重设密码</b>'
    +'<div style="font-size:11.5px;color:var(--dim);margin-top:4px">请输入我们给贵司发采购单的邮箱。已有账号时，本次验证会重设密码。</div>'
    +'<input id="cdE" type="email" placeholder="邮箱" autocomplete="email"><button id="cdSend">发送验证码</button>'
    +'<div id="cdStep2" style="display:none"><div id="cdSent" style="font-size:12px;color:var(--ok,#2E7D5B);margin-top:8px"></div>'
    +'<input id="cdC" inputmode="numeric" maxlength="6" placeholder="6 位验证码" autocomplete="one-time-code">'
    +'<input id="cdP" type="password" placeholder="设置新密码（至少 8 位）" autocomplete="new-password">'
    +'<button id="cdGo">登录</button></div><div id="cdErr" style="color:var(--miss);font-size:12px;margin-top:8px"></div>'
    +'<div class="lgfirst"><a href="#" id="cdBack">我有密码</a></div></div>';
  var send=function(){
    var em=$("cdE").value.trim();
    if(!em){errText("cdErr","请填写邮箱");return}
    $("cdSend").disabled=true;errText("cdErr","");
    fetch(c.BASE()+"/api/db/po-collab/login-code",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:c.TOKEN(),email:em})})
      .then(function(r){return r.json()}).then(function(j){
        if(!j.ok){$("cdSend").disabled=false;errText("cdErr",j.error||"发送失败");return}
        $("cdSent").textContent="验证码已发送，请查收邮箱（也看看垃圾箱）。";
        $("cdStep2").style.display="";setWait($("cdSend"),60,"重新发送");$("cdC").focus();
      }).catch(function(e){$("cdSend").disabled=false;errText("cdErr","发送失败："+e.message)});
  };
  var go=function(){
    var em=$("cdE").value.trim(), code=$("cdC").value.trim(), pw=$("cdP").value;
    if(!em||!code||!pw){errText("cdErr","请填邮箱、验证码和新密码");return}
    $("cdGo").disabled=true;errText("cdErr","");
    fetch(c.BASE()+"/api/db/po-collab/login-verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:c.TOKEN(),email:em,code:code,password:pw})})
      .then(function(r){return r.json()}).then(function(j){
        if(!j.token){$("cdGo").disabled=false;errText("cdErr",j.error||"登录失败");return}
        try{localStorage.setItem("po_factory_jwt",j.token)}catch(e){}
        c.setFJWT(j.token);$("state").innerHTML="正在读取采购单…";c.load();
      }).catch(function(e){$("cdGo").disabled=false;errText("cdErr","登录失败："+e.message)});
  };
  $("cdSend").onclick=send;$("cdGo").onclick=go;$("cdP").onkeydown=function(e){if(e.key==="Enter")go()};
  $("cdBack").onclick=function(e){e.preventDefault();window.showLogin("")};
};
})();
