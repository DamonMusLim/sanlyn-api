/* bl-si-picker.js — 提单确认书生成器: 选受众/柜信息/出单方式/联系方式 → 实时预览 + 一键发送短链。ai域同源,不露API。 */
(function () {
  function qp(k){ try{ return new URLSearchParams(location.search).get(k)||""; }catch(e){ return ""; } }
  // token: URL 优先, 否则读 admin 登录态(同域 localStorage)
  function getToken(){
    var t = qp("token"); if(t) return t;
    var keys=["token","jwt","authToken","sanlyn_token","access_token"];
    for(var i=0;i<keys.length;i++){ try{ var v=localStorage.getItem(keys[i]); if(v&&v.split(".").length===3) return v; }catch(e){} }
    return "";
  }
  var TOKEN = getToken();
  var API = /(?:api|ai)\.sanlyn/.test(location.origin) ? "" : "https://api.sanlyn.cn";
  var GW = 0;   // 货毛重(算VGM用)
  function $(id){ return document.getElementById(id); }
  function st(m){ $("status").textContent = m||""; }
  function num(v){ var n=Number(String(v==null?"":v).replace(/[^\d.\-]/g,"")); return isFinite(n)?n:0; }
  function api(path){ return API+path+(path.indexOf("?")>=0?"&":"?")+"token="+encodeURIComponent(TOKEN); }
  function authH(){ return { Authorization:"Bearer "+TOKEN }; }

  function loadBL(){
    var bl=$("bl").value.trim(); if(!bl){ st("先填提单号"); return; }
    st("加载中…"); $("blInfo").textContent="";
    fetch(api("/api/db/shipping-transfer-data?plan_id="+encodeURIComponent(bl)),{headers:authH()})
      .then(function(r){ return r.json(); }).then(function(d){
        var p=d.plan||{}, cs=d.containers||[], c0=cs[0]||{};
        GW = num(c0.gross_weight_kg);
        var recorded = !!(c0.container_no);
        $("blInfo").innerHTML = (p.export_bl? "船 "+(p.vessel||"")+" / "+(p.voyage||"")+" · "+cs.length+"柜 · 毛重"+GW : "⚠ 未找到该提单");
        // 已录柜→带出并锁; 未录柜→留空可填
        if(recorded){ $("ctn").value=c0.container_no||""; $("seal").value=c0.seal_no||""; $("tare").value=num(c0.tare_kg)||""; }
        calcVgm(); refresh(); st(recorded? "已录柜, 柜信息自动带出" : "未录柜, 可手填柜号/封号/皮重");
      }).catch(function(e){ st("加载失败: "+e.message); });
  }
  function calcVgm(){ var t=num($("tare").value); $("vgm").value = (GW>0&&t>0)? (GW+t).toFixed(2) : ""; }

  function aud(){ var r=document.querySelector('input[name=aud]:checked'); return r?r.value:"internal"; }
  function buildParams(){
    var bl=$("bl").value.trim();
    var p=["plan_id="+encodeURIComponent(bl)];
    p.push("aud="+aud());
    var iss=$("issue").value; if(iss&&iss!=="SWB") p.push("issue="+encodeURIComponent(iss));
    else p.push("issue=SWB");
    if($("ctn").value.trim()) p.push("ctn="+encodeURIComponent($("ctn").value.trim()));
    if($("seal").value.trim()) p.push("seal="+encodeURIComponent($("seal").value.trim()));
    if(num($("tare").value)>0) p.push("tare="+num($("tare").value));
    if(num($("vgm").value)>0) p.push("vgm="+num($("vgm").value));
    if(!$("sc").checked) p.push("sc=0");
    if(!$("cc").checked) p.push("cc=0");
    return p.join("&");
  }
  // 预览用(带token,同域); 发送用(带token,绝对ai域给doc-share存)
  function previewUrl(){ return "/templates/bl-si-template.html?"+buildParams()+"&token="+encodeURIComponent(TOKEN); }
  function absUrl(){ return location.origin+"/templates/bl-si-template.html?"+buildParams()+"&token="+encodeURIComponent(TOKEN); }

  function refresh(){ if(!$("bl").value.trim()){ st("先填提单号"); return; } $("pv").src = previewUrl(); }
  function openNew(){ if(!$("bl").value.trim()){ st("先填提单号"); return; } window.open(previewUrl(),"_blank"); }

  function genLink(){
    var bl=$("bl").value.trim(); if(!bl){ st("先填提单号"); return; }
    st("生成中…"); var out=$("out"); out.className="out"; out.innerHTML="";
    var label = aud()==="carrier"?"船东版":(aud()==="customer"?"客户版":"内部版");
    fetch(api("/api/db/doc-share"),{ method:"POST", headers:Object.assign({"Content-Type":"application/json"},authH()),
      body: JSON.stringify({ docUrl:absUrl(), docName:"提单确认书 "+bl+"("+label+")", contractNo:"", createdBy:"picker", maxDownloads:999, expiresDays:14 }) })
      .then(function(r){ return r.json(); }).then(function(d){
        if(!d.token){ st("生成失败: "+(d.error||d.message||"?")); return; }
        var short = location.origin+"/s/"+d.token+(d.password? "?password="+encodeURIComponent(d.password):"");
        out.className="out show";
        out.innerHTML='<b>'+label+' 发送链接</b>（可重复开·14天）：<br><a href="'+short+'" target="_blank">'+short+'</a>'
          +'<br><button class="copy" id="cp">复制链接</button>';
        $("cp").onclick=function(){ (navigator.clipboard? navigator.clipboard.writeText(short):Promise.reject()).then(function(){ $("cp").textContent="已复制✓"; }).catch(function(){ var t=document.createElement("textarea");t.value=short;document.body.appendChild(t);t.select();document.execCommand("copy");t.remove();$("cp").textContent="已复制✓"; }); };
        st("✅ 已生成");
      }).catch(function(e){ st("生成失败: "+e.message); });
  }

  window.loadBL=loadBL; window.calcVgm=calcVgm; window.refresh=refresh; window.openNew=openNew; window.genLink=genLink;
  document.querySelectorAll('input[name=aud],#issue,#sc,#cc,#ctn,#seal,#tare').forEach(function(el){ el.addEventListener("change", function(){ if($("bl").value.trim()) refresh(); }); });
  // 自动带入 ?bl=
  var pre=qp("bl")||qp("plan_id"); if(pre){ $("bl").value=pre; loadBL(); }
  if(!TOKEN) st("⚠ 未取到登录态, 请从后台打开或在链接加 &token=");
})();
