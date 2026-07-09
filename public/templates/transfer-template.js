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
}

function renderTransferRows(containers) {
  const tbody = document.querySelector("#transferTable tbody");
  tbody.innerHTML = containers.map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${esc(row.vessel_voyage)}</td>
      <td>${esc(row.import_arrival_date)}</td>
      <td>${esc(row.import_bl_no)}</td>
      <td>${esc(row.container_type)}</td>
      <td>${esc(row.container_no)}</td>
      <td>${esc(row.seal_no)}</td>
      <td>${esc(row.export_port)}</td>
      <td>${esc(row.export_bl)}</td>
      <td>${esc(row.vessel_voyage)}</td>
      <td class="left">${esc(row.goods_desc)}</td>
      <td>${fmt(row.pieces, 0)}</td>
      <td>${fmt(row.cbm)}</td>
      <td>${fmt(row.gross_weight_kg)}</td>
      <td>${fmt(row.tare_kg)}</td>
      <td>${fmt(row.vgm_kg)}</td>
    </tr>
  `).join("");
}

function renderCutoffRows(products) {
  const exportBl = currentData?.plan?.export_bl || "";
  const tbody = document.querySelector("#cutoffTable tbody");
  tbody.innerHTML = products.map((row, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${esc(exportBl)}</td>
      <td class="left">${esc(row.product)}</td>
      <td>${fmt(row.qty_ctn, 0)}</td>
      <td>${fmt(row.gross_weight_kg)}</td>
      <td>${fmt(row.cbm)}</td>
      <td>${esc(row.container_no)}</td>
      <td>${esc(row.seal_no)}</td>
      <td>${fmt(row.tare_kg)}</td>
      <td>${fmt(row.vgm_kg)}</td>
      <td>${esc(row.hs_code)}</td>
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
window.downloadPng = downloadPng;
window.pickSeal = pickSeal;

document.addEventListener("DOMContentLoaded", init);
