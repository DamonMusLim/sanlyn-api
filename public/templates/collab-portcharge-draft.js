(function(){
  function esc(v){ return v==null?"":String(v).replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;"); }
  var oldFetch = window.fetchBillSummary;
  if(oldFetch) window.fetchBillSummary = async function(){
    await oldFetch();
    try{
      var t = new URLSearchParams(location.search).get("token") || "";
      var r = await fetch("/api/db/booking-collab/port-charge-draft?token=" + encodeURIComponent(t));
      var d = await r.json().catch(function(){ return {}; });
      if(r.ok && d.ok) window._portChargeDraft = d.draft || null;
    }catch(e){}
  };
  var oldEditor = window.portChargeEditor;
  if(oldEditor) window.portChargeEditor = function(){
    return oldEditor() + window.CollabPortChargeDraft.banner();
  };
  var oldDocRow = window.docRow;
  if(oldDocRow) window.docRow = function(icon, label, href, source){
    var html = oldDocRow(icon, label, href, source);
    var docKey = href.indexOf("type=booking_note")>=0 ? "booking_note" : href.indexOf("type=bl_sample")>=0 ? "bl_sample" : href.indexOf("type=telex")>=0 ? "telex" : "";
    var sent = docKey ? (window._docSends || []).filter(function(x){ return String(x.doc_type||"") === docKey; }) : [];
    if(!sent.length) return html;
    var note = '<div style="font-size:10px;color:var(--good);font-weight:800;margin-top:2px;">已发送到邮箱 '+esc(sent.map(function(x){return x.email;}).filter(Boolean).join(" / "))+' · '+esc((window.bjTime && bjTime(sent[sent.length-1].sent_at)) || "")+'</div>';
    return html.replace('</div>\n    <div class="doc-actions">', note + '</div>\n    <div class="doc-actions">');
  };
  var oldRenderDocs = window.renderOurDocs;
  if(oldRenderDocs) window.renderOurDocs = function(s){
    window._docSends = Array.isArray(s && s.doc_sends) ? s.doc_sends : [];
    return oldRenderDocs(s);
  };
  window.CollabPortChargeDraft = {
    apply:function(){
      var d = window._portChargeDraft;
      if(!d || !Array.isArray(d.lines) || !window.addPortChargeRow) return;
      d.lines.forEach(function(x){
        window.addPortChargeRow();
        var tr = document.getElementById("portChargeRows")?.lastElementChild;
        if(!tr) return;
        var ins = tr.querySelectorAll("input"), sel = tr.querySelector("select");
        if(ins[0]) ins[0].value = x.cost_category || "港杂费";
        if(sel) sel.value = x.charge_basis || "per_bl";
        if(ins[1] && x.unit_price != null) ins[1].value = x.unit_price;
        if(ins[2] && x.amount != null) ins[2].value = x.amount;
      });
    },
    banner:function(){
      var d = window._portChargeDraft;
      if(!d || !Array.isArray(d.lines) || !d.lines.length) return "";
      return '<div style="margin:8px 0;padding:8px 10px;border:1px dashed var(--accent);border-radius:8px;background:var(--surface2);font-size:11px;color:var(--ink2);font-weight:800;">已按同船东最近港杂生成草稿来源 '+esc(d.source_bl_no||"")+
        ' <button class="btn btn-ghost btn-sm" type="button" onclick="CollabPortChargeDraft.apply()">带入草稿</button></div>';
    }
  };
})();
