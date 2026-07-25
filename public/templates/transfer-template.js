// TPL_VERSION: 每次改模版必改;= canonical git 短哈希 + 日期,单据页脚显示,旧版一眼现形
var TPL_VERSION = "v4 · 2026-07-14 02:31";
const qs = new URLSearchParams(location.search);
const planId = qs.get("plan_id") || qs.get("id");
const token = qs.get("token") || "";
const draftKey = `sanlyn-transfer-template:${planId || "unknown"}`;

let mode = "transfer";
let currentData = null;

function el(id) {
  return document.getElementById(id);
}

function setStatus(message) {
  const node = el("status");
  if (node) node.textContent = message || "";
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function fmt(value, digits = 3) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

function fmtDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function setT(id, value) {
  const node = el(id);
  if (!node) return;
  if (!node.textContent.trim()) node.textContent = value == null ? "" : String(value);
}

function renderHeader(plan) {
  setT("vesselVoyage", [plan.vessel, plan.voyage].filter(Boolean).join(" / "));
  setT("exportBl", plan.export_bl || "");
  setT("etd", fmtDate(plan.etd));
  setT("shipmentNo", plan.shipment_no || "");
  setT("tplVer", TPL_VERSION);
  setT("genTime", new Date().toLocaleString("zh-CN"));
}

function renderTransferRows(containers) {
  const tbody = document.querySelector("#transferTable tbody");
  tbody.innerHTML = containers.map((row, index) => `
    <tr>
      <td data-field="seq" data-row="${index}">${index + 1}</td>
      <td data-field="import_vessel_voyage" data-row="${index}">${esc(row.vessel_voyage)}</td>
      <td data-field="import_arrival_date" data-row="${index}">${esc(row.import_arrival_date)}</td>
      <td data-field="import_bl_no" data-row="${index}">${esc(row.import_bl_no)}</td>
      <td data-field="container_type" data-row="${index}">${esc(row.container_type)}</td>
      <td data-field="container_no" data-row="${index}">${esc(row.container_no)}</td>
      <td data-field="seal_no" data-row="${index}">${esc(row.seal_no)}</td>
      <td data-field="export_port" data-row="${index}">${esc(row.export_port)}</td>
      <td data-field="export_bl" data-row="${index}">${esc(row.export_bl)}</td>
      <td data-field="export_vessel_voyage" data-row="${index}">${esc(row.vessel_voyage)}</td>
      <td class="left" data-field="goods_desc" data-row="${index}">${esc(row.goods_desc)}</td>
      <td data-field="pieces" data-row="${index}">${fmt(row.pieces, 0)}</td>
      <td data-field="cbm" data-row="${index}">${fmt(row.cbm)}</td>
      <td data-field="gross_weight" data-row="${index}">${fmt(row.gross_weight_kg)}</td>
      <td data-field="tare" data-row="${index}">${fmt(row.tare_kg)}</td>
      <td data-field="vgm" data-row="${index}">${fmt(row.vgm_kg)}</td>
    </tr>
  `).join("");
}

function renderCutoffRows(products) {
  const exportBl = currentData?.plan?.export_bl || "";
  const tbody = document.querySelector("#cutoffTable tbody");
  tbody.innerHTML = products.map((row, index) => `
    <tr>
      <td data-field="seq" data-row="${index}">${index + 1}</td>
      <td data-field="bl_no" data-row="${index}">${esc(exportBl)}</td>
      <td class="left" data-field="product" data-row="${index}">${esc(row.product)}</td>
      <td data-field="ctns" data-row="${index}">${fmt(row.qty_ctn, 0)}</td>
      <td data-field="gross_weight" data-row="${index}">${fmt(row.gross_weight_kg)}</td>
      <td data-field="cbm" data-row="${index}">${fmt(row.cbm)}</td>
      <td data-field="container_no" data-row="${index}">${esc(row.container_no)}</td>
      <td data-field="seal_no" data-row="${index}">${esc(row.seal_no)}</td>
      <td data-field="tare" data-row="${index}">${fmt(row.tare_kg)}</td>
      <td data-field="vgm" data-row="${index}">${fmt(row.vgm_kg)}</td>
      <td data-field="hs_code" data-row="${index}">${esc(row.hs_code)}</td>
    </tr>
  `).join("");
}

function loadDraft() {
  const html = localStorage.getItem(draftKey);
  if (!html) return false;

  const doc = el("doc");
  if (doc) {
    doc.innerHTML = html;
    setStatus("已恢复本地草稿");
    return true;
  }

  return false;
}

function saveDraft() {
  const doc = el("doc");
  if (!doc) return;

  localStorage.setItem(draftKey, doc.innerHTML);
  setStatus(`草稿已保存 ${new Date().toLocaleTimeString()}`);
}

function toggleMode() {
  mode = mode === "transfer" ? "cutoff" : "transfer";

  el("transferView").hidden = mode !== "transfer";
  el("cutoffView").hidden = mode !== "cutoff";

  const btn = el("modeBtn");
  if (btn) btn.textContent = mode === "transfer" ? "切到截单明细" : "切到装箱汇总";
}

function togglePreview() {
  document.body.classList.toggle("preview");
  const btn = el("previewBtn");
  if (btn) btn.textContent = document.body.classList.contains("preview") ? "编辑" : "预览";
}

async function downloadPng() {
  const doc = el("doc");
  if (!doc || !window.html2canvas) return;

  setStatus("正在生成 PNG...");
  const canvas = await html2canvas(doc, {
    scale: 2,
    backgroundColor: "#ffffff",
    useCORS: true,
  });

  const a = document.createElement("a");
  const plan = currentData?.plan || {};
  const name = plan.export_bl || plan.plan_id || planId || "transfer";
  a.download = `装箱资料-${name}.png`;
  a.href = canvas.toDataURL("image/png");
  a.click();
  setStatus("PNG 已生成");
}

function pickSeal() {
  if (typeof window.insertSeal === "function") {
    window.insertSeal();
    return;
  }

  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = () => {
      let img = document.querySelector("#doc img.seal");
      if (!img) {
        img = document.createElement("img");
        img.className = "seal";
        el("doc").appendChild(img);
      }
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  };
  input.click();
}

async function init() {
  if (!planId) {
    setStatus("缺少 plan_id");
    return;
  }

  try {
    const params = new URLSearchParams({ plan_id: planId });
    if (token) params.set("token", token);

    setStatus("正在加载数据...");
    const resp = await fetch(`/api/db/shipping-transfer-data?${params.toString()}`);
    const data = await resp.json();

    if (!resp.ok) throw new Error(data.error || "加载失败");

    currentData = data;
    renderHeader(data.plan || {});
    renderTransferRows(data.containers || []);
    renderCutoffRows(data.products || []);
    loadDraft();

    mode = "transfer";
    el("transferView").hidden = false;
    el("cutoffView").hidden = true;
    setStatus("数据已加载");
  } catch (err) {
    setStatus(err.message || "加载失败");
  }
}

window.init = init;
window.saveDraft = saveDraft;
window.loadDraft = loadDraft;
window.toggleMode = toggleMode;
window.togglePreview = togglePreview;
// [2026-07-10] 补 PDF/Excel 下载(自托管库,和其它模版一致) —— 装箱资料原来只有 PNG。
function _tLoad(src, cb){ var ex=document.querySelector('script[data-v="'+src+'"]'); if(ex){ if(ex.getAttribute('data-ok')==='1')return cb(); ex.addEventListener('load',cb); return; } var el=document.createElement('script'); el.src=src; el.setAttribute('data-v',src); el.onload=function(){ el.setAttribute('data-ok','1'); cb(); }; el.onerror=function(){ alert('库加载失败: '+src); }; document.head.appendChild(el); }
function _tEnsure(name, file, cb){ if(window[name])return cb(); _tLoad('/templates/vendor/'+file, cb); }
function _tJsPDF(){ return (window.jspdf&&window.jspdf.jsPDF)||window.jsPDF||null; }
function _tName(){ return '装箱资料-' + ((currentData&&currentData.plan&&currentData.plan.export_bl)||'draft'); }
async function downloadPdf(){
  var doc=document.querySelector('#doc'); if(!doc)return;
  var tb=document.querySelector('.toolbar'); if(tb)tb.style.display='none';
  var restore=function(){ if(tb)tb.style.display=''; };
  _tEnsure('html2canvas','html2canvas.min.js', function(){ _tEnsure('jspdf','jspdf.umd.min.js', async function(){
    try{
      var canvas=await window.html2canvas(doc,{scale:2,useCORS:true,backgroundColor:'#fff'});
      var JsPDF=_tJsPDF(); if(!JsPDF){ restore(); window.print(); return; }
      var pdf=new JsPDF('l','mm','a4'), pw=pdf.internal.pageSize.getWidth(), ph=pdf.internal.pageSize.getHeight();
      var imgW=pw, imgH=canvas.height*pw/canvas.width, img=canvas.toDataURL('image/jpeg',0.95);
      if(imgH<=ph){ pdf.addImage(img,'JPEG',0,0,imgW,imgH); }
      else{ var pos=0; while(pos<imgH-0.5){ pdf.addImage(img,'JPEG',0,-pos,imgW,imgH); pos+=ph; if(pos<imgH-0.5)pdf.addPage(); } }
      pdf.save(_tName()+'.pdf'); restore();
    }catch(e){ restore(); window.print(); }
  }); });
}
function exportExcel(){
  _tEnsure('XLSX','xlsx.full.min.js', function(){
    try{
      var aoa=[];
      document.querySelectorAll('#doc table').forEach(function(tbl){
        if(tbl.offsetParent===null)return; // 只导当前可见视图的表
        [].forEach.call(tbl.rows,function(tr){ aoa.push([].map.call(tr.cells,function(td){ return (td.textContent||'').replace(/\s+/g,' ').trim(); })); });
        aoa.push([]);
      });
      var wb=window.XLSX.utils.book_new(), ws=window.XLSX.utils.aoa_to_sheet(aoa);
      window.XLSX.utils.book_append_sheet(wb,ws,'装箱资料');
      window.XLSX.writeFile(wb, _tName()+'.xlsx');
    }catch(e){ alert('导出失败: '+e.message); }
  });
}
window.downloadPdf=downloadPdf; window.exportExcel=exportExcel;
window.downloadPng = downloadPng;
window.pickSeal = pickSeal;

document.addEventListener("DOMContentLoaded", init);
