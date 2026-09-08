(function(){
"use strict";
function clean(v){return v==null?"":String(v).trim()}
function esc(v){return String(v==null?"":v).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
// 视图会把空值渲染成中文占位(❓无提单号/待补/—/未接入/(空)),拿这些去拼URL会打开一张错单。
function validBl(v){
  v=clean(v);
  if(!v)return "";
  var compact=v.replace(/\s+/g,"");
  if(/[❓]/.test(v))return "";
  if(/^(待补|—|-|未接入|\(空\)|（空）)$/.test(compact))return "";
  if(compact.length<6)return "";
  if(!/\d/.test(compact))return "";
  return v;
}
function blNo(row){
  var keys=["bl_no","blNo","BL_NO","mbl_no","提单号"],i,v;
  row=row||{};
  for(i=0;i<keys.length;i++){
    v=validBl(row[keys[i]]);
    if(v)return v;
  }
  return "";
}
function docUrl(bl,type,t){
  var url="/api/db/shipping-plan-pdf?bl="+encodeURIComponent(bl)+"&type="+encodeURIComponent(type);
  if(t)url+="&token="+encodeURIComponent(t);
  return url;
}
function link(label,bl,type,t){
  return '<div class="detail-field span-3"><a target="_blank" rel="noopener" href="'+esc(docUrl(bl,type,t))+'">'+esc(label)+"（"+esc(bl)+"）</a></div>";
}
function section(row,opts){
  var bl=blNo(row),t=clean(opts&&opts.token),html;
  if(!bl)return "";
  html='<section class="detail-section"><div class="detail-section-title">单据</div><div class="detail-grid">';
  html+=link("海运费单",bl,"fob_invoice",t);
  html+=link("港杂单",bl,"fob_portcharge",t);
  if(!t)html+='<div class="detail-field span-6 muted">未登录可能打不开</div>';
  return html+"</div></section>";
}
window.HyGridDocs={section:section};
})();
