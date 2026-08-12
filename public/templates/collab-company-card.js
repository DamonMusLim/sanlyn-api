(function(){
  var API = window.API || "/api/db/booking-collab";
  var token = new URLSearchParams(location.search).get("token") || window.token || "";
  var profile = null, loading = false;
  function esc(v){ return v==null?"":String(v).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }
  function val(id){ var el=document.getElementById(id); return el ? el.value.trim() : ""; }

  // ── ReactBits Pro 暗色令牌（扒自 profile-2：neutral-900 卡 / neutral-800 描边 / blue-600 强调）──
  var C = {
    surface:"#171717", surface2:"rgba(38,38,38,.5)", field:"#0f0f0f",
    line:"#262626", line2:"#404040", ink:"#fafafa", muted:"#a3a3a3",
    accent:"#2563eb", accent2:"#06b6d4", good:"#10b981", warn:"#f59e0b", bad:"#f87171"
  };
  function row(k, html){
    return '<label style="display:block;margin:9px 0;"><span style="display:block;font-size:11.5px;font-weight:700;color:'+C.muted+';margin-bottom:4px;letter-spacing:.2px;">'+esc(k)+'</span>'+html+'</label>';
  }
  function input(k, id, v, ro){
    return row(k, '<input id="'+id+'" value="'+esc(v||'')+'" '+(ro?'disabled':'')+
      ' style="width:100%;box-sizing:border-box;border:1px solid '+C.line2+';border-radius:10px;padding:10px 12px;font:inherit;font-size:13.5px;color:'+C.ink+';background:'+(ro?'rgba(255,255,255,.03)':C.field)+';'+(ro?'opacity:.6;':'')+'">');
  }
  function twoCol(a, b){ return '<div style="display:flex;gap:8px;">'+
    '<div style="flex:1;min-width:0;">'+a+'</div><div style="flex:1;min-width:0;">'+b+'</div></div>'; }
  function group(title, dot, inner){
    return '<div style="background:'+C.surface2+';border:1px solid '+C.line+';border-radius:12px;padding:12px 14px;margin:10px 0;">'+
      '<div style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:'+C.ink+';margin-bottom:2px;">'+
      '<span style="width:8px;height:8px;border-radius:50%;background:'+dot+';box-shadow:0 0 8px '+dot+';"></span>'+esc(title)+'</div>'+inner+'</div>';
  }

  async function load(){
    if(profile || loading || !token) return profile;
    loading = true;
    try{
      var r = await fetch(API + "/company-profile?token=" + encodeURIComponent(token));
      var d = await r.json().catch(function(){ return {}; });
      if(r.ok && d.ok) profile = d.company || null;
    }catch(e){}
    loading = false;
    return profile;
  }
  async function uploadLicense(file){
    var b64 = await new Promise(function(ok,no){ var fr=new FileReader(); fr.onload=function(){ok(fr.result);}; fr.onerror=no; fr.readAsDataURL(file); });
    var r = await fetch(API + "/company-profile", {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({token:token, action:"upload_license", filename:file.name, data_base64:b64})});
    var d = await r.json().catch(function(){ return {}; });
    if(!r.ok || !d.ok) throw new Error(d.error || "上传失败");
    return d.url;
  }
  function toast(msg, bad){
    var t=document.getElementById("ccToast");
    if(!t){ t=document.createElement("div"); t.id="ccToast"; document.body.appendChild(t); }
    t.textContent=msg;
    t.style.cssText="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:1100;background:"+C.field+";border:1px solid "+(bad?C.bad:C.line)+";color:"+(bad?"#ffd7dd":C.ink)+";padding:10px 16px;border-radius:10px;font-size:13.5px;box-shadow:0 8px 22px rgba(0,0,0,.4);";
    clearTimeout(t._h); t._h=setTimeout(function(){ t.style.display="none"; }, 2400); t.style.display="block";
  }
  async function doSave(){
    var btn=document.getElementById("ccSave"); if(btn) btn.disabled=true;
    try{
      var lic = document.getElementById("ccLicenseFile");
      var licenseUrl = val("cc_business_license_url");
      if(lic && lic.files && lic.files[0]) licenseUrl = await uploadLicense(lic.files[0]);
      var patch = {
        legal_representative: val("cc_legal_representative"),
        address: val("cc_address"),
        business_license_no: val("cc_business_license_no"),
        business_license_url: licenseUrl,
        biz_contact_name: val("cc_biz_contact_name"),
        biz_contact_phone: val("cc_biz_contact_phone"),
        biz_contact_email: val("cc_biz_contact_email"),
        fin_contact_name: val("cc_fin_contact_name"),
        fin_contact_phone: val("cc_fin_contact_phone"),
        fin_contact_email: val("cc_fin_contact_email")
      };
      var r = await fetch(API + "/company-profile", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({token:token, profile:patch})});
      var d = await r.json().catch(function(){ return {}; });
      if(!r.ok || !d.ok) throw new Error(d.error || "保存失败");
      profile = d.company;
      toast("资料已保存并锁定");
      openCompanyCard();
    }catch(e){ toast(e.message || "保存失败", true); if(btn) btn.disabled=false; }
  }
  // 保存并锁定 = 两步确认（锁定后要联系运营才能改，等于不可逆）——非原生弹窗
  function save(){
    var btn=document.getElementById("ccSave"); if(!btn) return;
    if(btn.getAttribute("data-arm")==="1"){ doSave(); return; }
    btn.setAttribute("data-arm","1");
    btn.textContent="确认无误·再点保存锁定";
    btn.style.background=C.warn; btn.style.color="#1a1206";
    clearTimeout(btn._t); btn._t=setTimeout(function(){
      btn.removeAttribute("data-arm"); btn.textContent="保存并锁定";
      btn.style.background=C.accent; btn.style.color="#fff";
    }, 4000);
  }

  window.openCompanyCard = async function(){
    var p = await load();
    var m = document.getElementById("companyModal");
    if(!m){ m=document.createElement("div"); m.id="companyModal"; m.onclick=function(){m.style.display="none";}; document.body.appendChild(m); }
    m.style.cssText = "display:block;position:fixed;inset:0;background:rgba(5,10,20,.62);z-index:1000;";
    var locked = !!(p && p.profile_locked);
    var body = p ? [
      group("公司信息", C.muted,
        input("公司名称", "cc_name_cn", p.name_cn, true) + input("英文名", "cc_name_en", p.name_en, true) +
        twoCol(input("简称（内部只读）", "cc_short_name", p.short_name, true), input("统一编码（内部只读）", "cc_code", p.code, true)) +
        input("法定代表人", "cc_legal_representative", p.legal_representative, locked) +
        input("地址", "cc_address", p.address, locked)),
      group("营业执照", C.warn,
        input("营业执照号码", "cc_business_license_no", p.business_license_no || p.customs_reg_code, locked) +
        input("营业执照附件", "cc_business_license_url", p.business_license_url, locked) +
        (locked ? "" : row("上传营业执照附件", '<input id="ccLicenseFile" type="file" accept=".pdf,image/*" style="font:inherit;color:'+C.muted+';font-size:12.5px;">'))),
      group("业务联系人", C.accent,
        twoCol(input("姓名", "cc_biz_contact_name", p.biz_contact_name || p.contact_name, locked), input("电话", "cc_biz_contact_phone", p.biz_contact_phone || p.contact_phone, locked)) +
        input("邮箱", "cc_biz_contact_email", p.biz_contact_email || p.contact_email, locked)),
      group("财务联系人", C.good,
        twoCol(input("姓名", "cc_fin_contact_name", p.fin_contact_name, locked), input("电话", "cc_fin_contact_phone", p.fin_contact_phone, locked)) +
        input("邮箱", "cc_fin_contact_email", p.fin_contact_email, locked))
    ].join("") : '<div style="padding:24px;text-align:center;color:'+C.muted+';">暂无本方公司档案</div>';

    m.innerHTML = '<div style="position:absolute;left:50%;top:4%;transform:translateX(-50%);width:min(560px,94vw);max-height:90vh;overflow:auto;background:'+C.surface+';border:1px solid '+C.line+';border-radius:28px;padding:20px 20px 18px;box-shadow:0 30px 80px rgba(0,0,0,.6);color:'+C.ink+';" onclick="event.stopPropagation()">'+
      '<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:4px;"><b style="font-size:17px;">公司资料 / 联系人</b><button style="border:1px solid '+C.line+';background:transparent;color:'+C.muted+';font-size:15px;cursor:pointer;border-radius:8px;width:30px;height:30px;line-height:1;" onclick="document.getElementById(\'companyModal\').style.display=\'none\'">✕</button></div>'+
      '<div style="font-size:12px;color:'+C.muted+';margin-bottom:6px;">这些联系人（业务/财务）会作为单据自动发信的<b style="color:'+C.accent+';font-weight:600;">抄送</b>对象。</div>'+
      (locked?'<div style="background:rgba(245,182,76,.12);border:1px solid '+C.warn+';color:'+C.warn+';border-radius:10px;padding:9px 11px;font-size:12px;font-weight:600;margin:8px 0;">资料已锁定，如需修改请联系 Sanlyn 运营解锁</div>':'')+
      body + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;"><button onclick="document.getElementById(\'companyModal\').style.display=\'none\'" style="padding:9px 15px;border:1px solid '+C.line+';background:transparent;color:'+C.muted+';border-radius:9px;font-weight:600;cursor:pointer;">关闭</button>' +
      (p && !locked ? '<button id="ccSave" onclick="CollabCompanyCard.save()" style="padding:10px 18px;border:0;background:'+C.accent+';color:#fff;border-radius:10px;font-weight:600;cursor:pointer;">保存并锁定</button>' : '') + '</div></div>';
  };
  window.CollabCompanyCard = { load:load, save:save };
  document.addEventListener("DOMContentLoaded", function(){
    if(!token) return;
    setTimeout(function(){
      var host = document.querySelector(".shell") || document.body;
      if(document.getElementById("companyCardQuick")) return;
      var b = document.createElement("button");
      b.id = "companyCardQuick"; b.type = "button"; b.onclick = window.openCompanyCard;
      b.textContent = "公司资料 / 联系人";
      b.style.cssText = "position:fixed;right:12px;bottom:28px;z-index:80;border:1px solid #404040;background:#171717;color:#fafafa;border-radius:12px;padding:10px 14px;font-size:12px;font-weight:600;box-shadow:0 8px 22px rgba(0,0,0,.5);cursor:pointer;";
      host.appendChild(b);
    }, 800);
  });
})();
