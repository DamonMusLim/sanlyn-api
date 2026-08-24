/* bl-si-collab.js — 客户提单确认件:只读客户白名单接口,保存客户草稿待审核。 */
var TPL_VERSION = "v2026.08.17-1 · 2026-08-17 13:36";
(function () {
  var API = /(?:api|ai)\.sanlyn/.test(location.origin) ? "" : "https://api.sanlyn.cn";
  var TOKEN = qp("token");
  var PLAN = "";
  var ORIGINAL = {};
  var EDITABLE = ["consignee", "notify", "marks", "description", "hs", "vessel_voyage", "pol", "pod"];
  var REVIEW = { vessel_voyage: true, pol: true, pod: true };
  var IDS = {
    shipper: "si-shipper", consignee: "si-consignee", notify: "si-notify",
    vessel_voyage: "si-vessel", pol: "si-pol", pod: "si-pod", marks: "si-marks",
    description: "si-goods", hs: "si-hs"
  };

  function qp(k){ try{ return new URLSearchParams(location.search).get(k) || ""; }catch(e){ return ""; } }
  function url(path){ return API + path + (path.indexOf("?") >= 0 ? "&" : "?") + "token=" + encodeURIComponent(TOKEN); }
  function setT(id, v){ var e = document.getElementById(id); if(e) e.textContent = v == null ? "" : String(v); }
  function getT(id){ var e = document.getElementById(id); return e ? (e.textContent || "").trim() : ""; }
  function num(v){ var n = Number(v); return isFinite(n) ? n : 0; }
  function fmt(n, d){ return Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: d || 0, maximumFractionDigits: d == null ? 3 : d }); }
  function up(s){ return String(s == null ? "" : s).toUpperCase(); }
  function status(m){ setT("siStatus", m); }
  function draftKey(){ return "bl_collab_" + (PLAN || TOKEN || "draft"); }

  window.siPrint = function(){ window.print(); };

  function fillContainers(containers, totals){
    var tb = document.getElementById("si-rows");
    tb.innerHTML = "";
    (containers || []).forEach(function(c, i){
      var tr = document.createElement("tr");
      tr.innerHTML = "<td>"+(i+1)+"</td>"
        + "<td>"+up(c.container_no)+"</td>"
        + "<td>"+up(c.seal_no)+"</td>"
        + "<td>"+up(c.container_type)+"</td>"
        + '<td class="r">'+fmt(c.pieces)+'</td>'
        + "<td>CARTONS</td>"
        + '<td class="r">'+fmt(c.gross_weight, 2)+'</td>'
        + '<td class="r">'+fmt(c.cbm, 3)+'</td>'
        + '<td class="r">'+fmt(c.tare, 2)+'</td>'
        + '<td class="r">'+fmt(c.vgm, 2)+'</td>';
      tb.appendChild(tr);
    });
    setT("si-t-pieces", fmt(totals.pieces));
    setT("si-t-gw", fmt(totals.gross_weight, 2));
    setT("si-t-cbm", fmt(totals.cbm, 3));
    setT("si-t-vgm", fmt(totals.vgm, 2));
    setT("si-pieces", fmt(totals.pieces));
    setT("si-gw", fmt(totals.gross_weight, 2));
    setT("si-cbm", fmt(totals.cbm, 3));
  }

  function setFields(fields) {
    Object.keys(IDS).forEach(function(k){ setT(IDS[k], up(fields[k] || "")); });
    setT("si-delivery", up(fields.pod || ""));
  }

  function collectFields() {
    var fields = {};
    EDITABLE.forEach(function(k){
      var val = getT(IDS[k]);
      fields[k] = REVIEW[k] ? { value: val, edited: val !== (ORIGINAL[k] || "") } : val;
    });
    return fields;
  }

  function saveLocal(fields) {
    try { localStorage.setItem(draftKey(), JSON.stringify({ fields: fields, ts: Date.now() })); } catch(e) {}
  }

  function localDraft() {
    try { return JSON.parse(localStorage.getItem(draftKey()) || "null"); } catch(e) { return null; }
  }

  window.siSaveDraft = function(){
    var btn = document.getElementById("saveBtn");
    var fields = collectFields();
    if (btn) btn.disabled = true;
    status("保存中...");
    fetch(url("/api/db/booking-collab/si-draft"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields: fields, note: "customer_si_collab" })
    }).then(function(r){ return r.json(); }).then(function(j){
      if (!j || !j.ok) throw new Error((j && j.error) || "save failed");
      saveLocal(fields);
      status("已提交修改，等待审核 · " + (j.saved_at || ""));
    }).catch(function(e){
      status("保存失败: " + (e.message || e));
    }).finally(function(){ if (btn) btn.disabled = false; });
  };

  function applyDraft(draft) {
    var fields = draft && draft.fields ? draft.fields : null;
    if (!fields) return false;
    EDITABLE.forEach(function(k){
      if (!(k in fields)) return;
      var v = fields[k] && typeof fields[k] === "object" ? fields[k].value : fields[k];
      setT(IDS[k], up(v || ""));
    });
    return true;
  }

  function boot(){
    setT("tplVer", TPL_VERSION);
    setT("genTime", new Date().toLocaleString("zh-CN"));
    if (!TOKEN) { status("缺少 token"); return; }
    status("加载中...");
    fetch(url("/api/db/booking-collab/si-data")).then(function(r){ return r.json(); }).then(function(d){
      if (!d || !d.ok) throw new Error((d && d.error) || "load failed");
      PLAN = (d.plan && d.plan.bl_no) || "";
      ORIGINAL = {
        consignee: up(d.fields.consignee), notify: up(d.fields.notify), marks: up(d.fields.marks),
        description: up(d.fields.description), hs: up(d.fields.hs),
        vessel_voyage: up(d.fields.vessel_voyage), pol: up(d.fields.pol), pod: up(d.fields.pod)
      };
      setT("si-blno", up(d.plan.bl_no));
      setFields(d.fields || {});
      fillContainers(d.containers || [], d.totals || {});
      if (applyDraft(d.draft)) status("已载入服务器草稿");
      else if (applyDraft(localDraft())) status("已载入本机草稿");
      else status("数据已加载");
    }).catch(function(e){ status("加载失败: " + (e.message || e)); });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
