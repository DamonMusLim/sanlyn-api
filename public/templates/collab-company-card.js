(function(){
  var API = window.API || "/api/db/booking-collab";
  var token = new URLSearchParams(location.search).get("token") || window.token || "";
  var profile = null, loading = false;
  function esc(v){ return v==null?"":String(v).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }
  function val(id){ var el=document.getElementById(id); return el ? el.value.trim() : ""; }
  function row(k, html){ return '<label style="display:block;margin:8px 0;"><span style="display:block;font-size:11px;font-weight:800;color:#6b7280;margin-bottom:3px;">'+esc(k)+'</span>'+html+'</label>'; }
  function input(k, id, v, ro){
    return row(k, '<input id="'+id+'" value="'+esc(v||'')+'" '+(ro?'disabled':'')+' style="width:100%;box-sizing:border-box;border:1px solid #d1d5db;border-radius:7px;padding:8px 10px;font:inherit;background:'+(ro?'#f8fafc':'#fff')+';">');
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
  async function save(){
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
        fin_contact_phone: val("cc_fin_contact_phone")
      };
      var r = await fetch(API + "/company-profile", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({token:token, profile:patch})});
      var d = await r.json().catch(function(){ return {}; });
      if(!r.ok || !d.ok) throw new Error(d.error || "保存失败");
      profile = d.company;
      alert("资料已保存并锁定");
      openCompanyCard();
    }catch(e){ alert(e.message || "保存失败"); }
    if(btn) btn.disabled=false;
  }
  window.openCompanyCard = async function(){
    var p = await load();
    var m = document.getElementById("companyModal");
    if(!m){ m=document.createElement("div"); m.id="companyModal"; m.onclick=function(){m.style.display="none";}; document.body.appendChild(m); }
    m.style.cssText = "display:block;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:1000;";
    var locked = !!(p && p.profile_locked);
    var body = p ? [
      input("公司名称", "cc_name_cn", p.name_cn, true), input("英文名", "cc_name_en", p.name_en, true),
      input("简称（内部只读）", "cc_short_name", p.short_name, true), input("统一编码（内部只读）", "cc_code", p.code, true),
      input("法定代表人", "cc_legal_representative", p.legal_representative, locked),
      input("地址", "cc_address", p.address, locked), input("营业执照号码", "cc_business_license_no", p.business_license_no || p.customs_reg_code, locked),
      input("营业执照附件", "cc_business_license_url", p.business_license_url, locked),
      locked ? "" : row("上传营业执照附件", '<input id="ccLicenseFile" type="file" accept=".pdf,image/*" style="font:inherit;">'),
      input("业务联系人姓名", "cc_biz_contact_name", p.biz_contact_name || p.contact_name, locked),
      input("业务联系人电话", "cc_biz_contact_phone", p.biz_contact_phone || p.contact_phone, locked),
      input("业务联系人邮箱", "cc_biz_contact_email", p.biz_contact_email || p.contact_email, locked),
      input("财务联系人姓名", "cc_fin_contact_name", p.fin_contact_name, locked),
      input("财务联系人电话", "cc_fin_contact_phone", p.fin_contact_phone, locked)
    ].join("") : '<div style="padding:24px;text-align:center;color:#6b7280;">暂无本方公司档案</div>';
    m.innerHTML = '<div style="position:absolute;left:50%;top:5%;transform:translateX(-50%);width:min(560px,94vw);max-height:88vh;overflow:auto;background:#fff;border-radius:12px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.24);" onclick="event.stopPropagation()">'+
      '<div style="display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px;"><b style="font-size:17px;">公司资料 / 联系人</b><button style="border:0;background:transparent;font-size:20px;cursor:pointer;" onclick="document.getElementById(\'companyModal\').style.display=\'none\'">x</button></div>'+
      (locked?'<div style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;border-radius:8px;padding:8px 10px;font-size:12px;font-weight:800;margin-bottom:10px;">资料已锁定，如需修改请联系 Sanlyn 运营解锁</div>':'')+
      body + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;"><button onclick="document.getElementById(\'companyModal\').style.display=\'none\'" style="padding:8px 14px;border:1px solid #d1d5db;background:#fff;border-radius:7px;font-weight:800;">关闭</button>' +
      (p && !locked ? '<button id="ccSave" onclick="CollabCompanyCard.save()" style="padding:8px 16px;border:0;background:#2563eb;color:#fff;border-radius:7px;font-weight:800;">保存并锁定</button>' : '') + '</div></div>';
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
      b.style.cssText = "position:fixed;right:12px;bottom:28px;z-index:80;border:1px solid #cbd5e1;background:#fff;color:#111827;border-radius:8px;padding:8px 11px;font-size:12px;font-weight:900;box-shadow:0 8px 22px rgba(15,23,42,.12);";
      host.appendChild(b);
    }, 800);
  });
})();
