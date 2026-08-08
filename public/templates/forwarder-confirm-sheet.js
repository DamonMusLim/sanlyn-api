const FWD_SHEET_UI_VERSION = "v2.2.0";
const FWD_SHEET_UI_DATE = "2026-08-08";
const API = "/api/db/booking-collab";
const INVOICE_API = "/api/db/invoice-collab-confirm";
const token = new URLSearchParams(location.search).get("token") || "";
const $ = id => document.getElementById(id);
let state = { sheet: {}, invoice: {}, bill: {}, mode: "ours", uploadZone: "ocean", uploadLabel: "", billLocked: false };
function tr(k, vars){ return window.CollabI18n ? CollabI18n.t(k, vars) : k; }
function i18n(){ if(window.CollabI18n) CollabI18n.apply(); }

function esc(v){
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function scrub(v){
  return String(v == null ? "" : v)
    .replace(/CY\d{5}/gi, "内部号")
    .replace(/\b[a-f0-9]{24}\b/gi, "—");
}
function fmtD(v){
  if(!v) return "—";
  const d = new Date(v);
  if(Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { timeZone:"Asia/Shanghai", day:"2-digit", month:"short", year:"numeric" }).format(d);
}
function fmtDT(v){
  if(!v) return "—";
  const d = new Date(v);
  if(Number.isNaN(d.getTime())) return "—";
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone:"Asia/Shanghai", day:"2-digit", month:"short", year:"numeric",
    hour:"2-digit", minute:"2-digit", hour12:false
  }).formatToParts(d).reduce((m,x)=>{ m[x.type]=x.value; return m; }, {});
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute} (GMT+8)`;
}
function fmtAutoAfterSo(v){
  return v ? fmtDT(v) : "上传 SO 后自动带出";
}

function humanBillHint(state){
  var raw = String((state && (state.invoiceError || state.billError)) || "");
  if (raw) {
    try { console.warn("[bill] " + raw); } catch (e) {}
    return "费用信息暂时取不到，请稍后刷新或联系 Sanlyn 对接人";
  }
  return "费用尚未录入";
}

function money(v, cur){
  const n = Number(v);
  if(!Number.isFinite(n)) return "";
  return n.toLocaleString("zh-CN", { minimumFractionDigits:2, maximumFractionDigits:2 }) + " " + (cur || "CNY");
}
function cntrSummary(s){
  const qty = Number(s.container_qty || 0);
  const type = scrub(s.container_type || "");
  return qty && type ? `${qty}×${type}` : (scrub(s.container_summary || type) || "—");
}
function textParts(parts){ return parts.filter(Boolean).join(" · ") || "—"; }
function identPart(v){ return v && v !== "—" ? `<span>${esc(v)}</span>` : `<span class="muted">—</span>`; }
function toast(msg){
  const old = document.querySelector(".demoflag.runtime");
  if(old) old.remove();
  const div = document.createElement("div");
  div.className = "demoflag runtime";
  div.textContent = msg;
  document.querySelector(".app").insertBefore(div, document.querySelector(".app").children[1]);
  setTimeout(()=>div.remove(), 3600);
}
function fail(msg){
  delete $("fwName").dataset.i18n; delete $("fwSub").dataset.i18n;
  $("fwName").innerHTML = "货代确认单<br>" + esc(tr("common.invalidTitle"));
  $("fwSub").textContent = msg || "链接无效或已过期";
  $("agrTag").className = "flag urgent";
  $("agrTag").textContent = tr("common.invalid");
  $("feeBody").innerHTML = `<div class="pending">${esc(msg || "加载失败")}</div>`;
  i18n();
}
async function fetchJson(url, options){
  const r = await fetch(url, options);
  const d = await r.json().catch(()=>({ ok:false, error:"响应不是 JSON" }));
  if(!r.ok) throw new Error(d.error || "请求失败");
  return d;
}
async function boot(){
  if(!token){ fail("缺少 token"); return; }
  try{
    const [v, inv, bill] = await Promise.all([
      fetchJson(`${API}/validate?token=${encodeURIComponent(token)}`),
      fetchJson(`${INVOICE_API}?token=${encodeURIComponent(token)}`).catch(e => ({ ok:false, error:e.message, data:{} })),
      fetchJson(`${API}/collab-bill-summary?token=${encodeURIComponent(token)}`).catch(e => ({ ok:false, error:e.message, segments:{} }))
    ]);
    if(!v.valid){ fail(v.error || "链接无效或已过期"); return; }
    state.sheet = v.booking_sheet || v.sheet || {};
    state.meta = v.meta || {};
    state.role = v.role || "";
	    state.invoice = inv.ok ? (inv.data || {}) : {};
	    state.factoryProfileAddress = v.factory_profile_address || null;
    state.invoiceError = inv.ok ? "" : inv.error;
    state.bill = bill.ok ? bill : { segments:{} };
    state.billError = bill.ok ? "" : bill.error;
    state.carrierReq = Array.isArray(v.carrier_requirements) ? v.carrier_requirements : [];
    state.segments = (v.portal_scope && Array.isArray(v.portal_scope.segments)) ? v.portal_scope.segments : [];
    state.mode = providerMode(state.sheet);
    state.billLocked = localStorage.getItem(lockKey()) === "1";
    renderAll();
  }catch(e){ fail(e.message || "加载失败"); }
}

function lockKey(){ return "fwd_bill_lock_" + token; }
function providerMode(s){
  const raw = s.logistics_provider_kind || s.provider_kind ||
    (s.raw && (s.raw.logistics_provider_kind || s.raw.provider_kind)) ||
    (s.plan && s.plan.logistics_provider_kind) || "";
  const val = String(raw).toLowerCase();
  return val === "external" || val === "customer" || val === "nom" ? "nom" : "ours";
}
function setMode(m, btn){
  const real = providerMode(state.sheet || {});
  state.mode = real;
  if(m !== real) toast("本票货代安排以系统记录为准，外部链接不能切换写入");
  renderFees();
}
function applyModeButtons(){}
function forwarderName(s){
  if(state.mode === "nom") return "客户指定货代（无价格协议）";
  return scrub(s.forwarder_cn || s.forwarder_en || s.carrier_code || s.shipping_line || "货代");
}
function releaseMeta(v){
  const t = String(v || "").trim();
  if(!t) return { label:"出单方式未定", cls:"muted", doc:"", show:false };
  if(/^SWB$/i.test(t) || /海运单|sea ?way/i.test(t)) return { label:"SWB 海运单 · 保函已备", cls:"oktxt", doc:"SWB 保函", show:true };
  if(/电放|telex/i.test(t)) return { label:"电放 · 电放保函已备", cls:"oktxt", doc:"电放保函", show:true };
  if(/正本|original|OBL/i.test(t)) return { label:"正本提单", cls:"", doc:"", show:false };
  return { label:scrub(t), cls:"", doc:"", show:false };
}
function renderAll(){
  const s = state.sheet;
  applyModeButtons();
  const rel = releaseMeta(s.release_type);
	  const route = [s.pol, s.pod].filter(Boolean).map(scrub).join(" → "), bl = scrub(s.bl_no || s.hbl_no || "");
	  $("fwName").dataset.i18n = "fwd.todoTitle"; $("fwSub").dataset.i18n = "fwd.todoSub";
  $("identityLine").innerHTML = [forwarderName(s), bl, String(rel.label || "").replace(/ · .*/, ""), cntrSummary(s), route].map(identPart).join(" · ");
  $("agrTag").className = state.segments.includes("truck") ? "flag urgent" : "flag";
  $("agrTag").textContent = state.segments.includes("truck") ? tr("fwd.truckDelegated") : tr("fwd.truckReview");
  $("etdV").textContent = fmtD(s.etd);
  $("gateV").textContent = fmtDT(s.cargo_cutoff || s.gate_in_cutoff || s.cutoff_date);
  $("vgmV").textContent = fmtAutoAfterSo(s.vgm_cutoff || s.vgm_deadline);
  $("siV").textContent = fmtAutoAfterSo(s.si_cutoff || s.doc_cutoff);
  $("soNoV").textContent = scrub(s.so_no || "—");
  $("vesselV").textContent = [s.vessel, s.voyage].filter(Boolean).map(scrub).join(" / ") || "—";
  $("cutoffV").textContent = textParts([fmtDT(s.cargo_cutoff), fmtD(s.si_cutoff || s.doc_cutoff || s.cutoff_date)]);
  $("cntrV").innerHTML = renderContainerLines(s);
  $("soHint").textContent = uploadedHint(/(^|[^A-Z])S\/?O([^A-Z]|$)|放舱|订舱确认|舱单|manifest/i, tr("fwd.soHint"));
  $("blHint").textContent = uploadedHint(/\bBL\b|提单/i, tr("fwd.blHint"));
  $("uiVersion").textContent = `UI ${FWD_SHEET_UI_VERSION} · ${FWD_SHEET_UI_DATE}`;
  renderRef();
  renderCarrierReq();
	  renderReceipts(); renderDocs(rel); renderBoxMode(); renderTruck(); renderFees(); renderTodos(); i18n();
	}

function renderBoxMode(){
  const theirTruck = Array.isArray(state.segments) && state.segments.includes("truck");
  const sub = $("boxSub"), badge = $("boxBadge"), acts = $("boxActs");
  if(!acts) return;
  if(theirTruck){
    if(sub) sub.textContent = tr("fwd.truckFill");
    if(badge){ badge.textContent = tr("fwd.truckFill"); badge.className = "sstat wait"; }
    acts.innerHTML = "";
  } else {
    if(sub) sub.textContent = tr("fwd.truckReadonly");
    if(badge){ badge.textContent = tr("fwd.truckReadonly"); badge.className = "sstat ok"; }
    acts.innerHTML = "";
  }
}
function renderCarrierReq(){
  const el = $("carrierReq"); if(!el) return;
  const reqs = Array.isArray(state.carrierReq) ? state.carrierReq : [];
  if(!reqs.length){ el.innerHTML = ""; return; }
  const carrier = scrub(state.sheet.carrier_code || state.sheet.shipping_line || "承运人");
  const pending = reqs.filter(t => t.status === "requested" || t.status === "rejected").length;
  el.innerHTML = `<div class="block" style="border:2px solid #1f4f78;background:#101b26;color:#e5edf5">
    <div class="bh" style="background:#132836;border-bottom-color:#1f4f78;display:flex;align-items:center;gap:9px">
      <input type="checkbox" ${pending ? "" : "checked"} disabled style="width:18px;height:18px">
      <h2 style="flex:1;font-size:15.5px;margin:0;color:#f8fafc">🛡 ${esc(carrier)} 要求 · 放舱前必交</h2>
      <span class="noagr">${pending ? tr("fwd.items", { n:pending }) : tr("common.ok")}</span>
    </div>
    <div class="bb" style="display:flex;flex-direction:column;gap:11px">${reqs.map(reqRow).join("")}</div>
  </div>`;
}
function reqRow(t){
  const map = { requested:"待提交", submitted:"待核", accepted:"已核准", rejected:"需重交" };
  const done = t.status === "accepted";
  return `<div style="border:1px solid var(--line);border-radius:10px;padding:12px;background:var(--row)">
    <div style="display:flex;align-items:center;gap:9px;margin-bottom:${done ? 0 : 9}px">
      <span style="font-size:19px">📄</span>
      <div style="flex:1"><b style="font-size:14px">${esc(scrub(t.label || t.task_type))}</b>${t.signed_by ? `<div style="font-size:11.5px;color:var(--sub)">签署：${esc(t.signed_by)}</div>` : ""}</div>
      <span class="${done ? "sstat ok" : "noagr"}">${esc(map[t.status] || t.status)}</span>
    </div>
    ${done ? "" : `<div class="acts"><button class="btn" onclick="downloadReqTpl(${Number(t.id)})">⬇ ${esc(tr("common.download"))}</button><button class="btn brand" onclick="uploadReqFile(${Number(t.id)})">⬆ ${esc(tr("common.upload"))}</button></div>`}
  </div>`;
}
function downloadReqTpl(taskId){ window.open(`${API}/file?token=${encodeURIComponent(token)}&type=loi_template&task=${taskId}`, "_blank", "noopener"); }
function uploadReqFile(taskId){
  state.reqTaskId = taskId; state._reqUpload = true;
  state.uploadZone = "loi"; state.uploadLabel = "LOI";
  $("fileInput").click();
}
function refValue(){ return state.sheet.so_bl_reference || ""; }
function renderRef(){
  const s = state.sheet, cur = scrub(refValue());
  $("refV").textContent = cur || "SO / B/L Ref.";
  const pend = s.so_bl_ref_pending;
  if(pend && pend.value && pend.value !== cur) $("refHint").textContent = `待我方核对：${scrub(pend.value)}`;
  else if(s.so_bl_reference) $("refHint").textContent = tr("common.confirmed");
  else $("refHint").textContent = tr("fwd.refHint");
}
function copyRef(){
  const t = scrub(refValue());
  if(!t){ toast("请先填写您的 SO 号"); return; }
  if(navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(t).then(()=>toast("已复制：" + t)).catch(()=>toast("复制失败，请手动选择"));
  else toast("请手动选择复制：" + t);
}
async function editRef(){
  const v = prompt("请填写您的 SO 号", refValue());
  if(v == null) return;
  const ref = String(v).trim();
  if(!ref) return;
  try{
    const d = await fetchJson(`${API}/collab-ref-submit`, { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ token, so_bl_reference: ref }) });
    if(d.applied){ state.sheet.so_bl_reference = ref; state.sheet.so_bl_ref_pending = null; toast("引用单号已更新：" + scrub(ref)); }
    else { state.sheet.so_bl_ref_pending = { value: ref, status:"pending" }; toast("已提交，待 Sanlyn 核对"); }
    renderRef();
  }catch(e){ toast("提交失败：" + e.message); }
}
function findUpload(re){
  const ups = Array.isArray(state.sheet.collab_uploads) ? state.sheet.collab_uploads : [];
  return ups.find(u => re.test(String(u.filename || "")));
}
	function uploadedHint(re, fallback){
	  const u = findUpload(re);
	  return u ? tr("fwd.uploaded", { name:scrub(u.filename || "file") }) : fallback;
	}
	function hasUpload(re){ return !!findUpload(re); }
function renderReceipts(){
  const ups = Array.isArray(state.sheet.collab_uploads) ? state.sheet.collab_uploads : [];
  const rows = ups.filter(u => /^\[ocean\]/.test(String(u.filename || "")) || /S\/?O|提单|\bBL\b|放舱|订舱/i.test(String(u.filename || "")));
  $("receiptList").innerHTML = rows.length
    ? rows.map(u => `<div class="receipt"><span>${esc(tr("fwd.receivedFile", { name:scrub(String(u.filename || "file").replace(/\[[^\]]+\]/g, "")) }))}</span><span class="muted">${esc(fmtDT(u.uploaded_at))}</span></div>`).join("")
    : `<div class="pending">${esc(tr("fwd.notReceived"))}</div>`;
}
function renderDocs(rel){
  const certs = [];
  if(state.sheet.has_quarantine || findUpload(/检疫|植检|动检|兽医|quarantine/i)) certs.push(docLine("货物证书 / 检疫资料", "quarantine"));
  const releaseRows = rel.show ? [docLine(rel.doc, rel.doc === "电放保函" ? "telex" : "transfer")] : [];
  $("docGroups").innerHTML = [
    docGroup("抬头资料", [docLine("发货人 / 收货人资料", "pack")]),
    docGroup("本票单据", [docLine("托书 Shipping Instruction", "so"), ...releaseRows]),
    docGroup("货物证书", certs.length ? certs : [`<div class="doc-line"><div class="nm muted">${esc(tr("fwd.noCond"))}</div><span class="na">—</span></div>`])
  ].join("");
}
function docGroup(title, rows){ return `<div class="docgrp"><div class="docgrp-h"><span>${esc(title)}</span><span class="muted">${esc(tr("fwd.items", { n:rows.length }))}</span></div>${rows.join("")}</div>`; }
	function docLine(name, type){ return `<div class="doc-line" style="padding-left:12px;padding-right:12px"><div class="nm">${esc(name)}</div><span class="dl" onclick="previewDoc('${type}')">👁 ${esc(tr("common.view"))}</span><span class="dl" onclick="downloadDoc('${type}')">${esc(tr("common.download"))}</span></div>`; }
	function docUrl(type){ return `${API}/file?token=${encodeURIComponent(token)}&type=${encodeURIComponent(type)}`; }
	function previewDoc(type){ window.open(docUrl(type), "_blank", "noopener"); }
	function downloadDoc(type){ window.open(docUrl(type), "_blank", "noopener"); }
function downloadSI(){ downloadDoc("so"); }
function downloadAllDocs(){ window.open(`${API}/file?token=${encodeURIComponent(token)}&type=pack`, "_blank", "noopener"); }
function renderContainerLines(s){
  const list = Array.isArray(s.containers_detail) && s.containers_detail.length ? s.containers_detail : (Array.isArray(s.containers_live) ? s.containers_live : []);
  if(!list.length) return "—";
  return list.map((c,i)=>{
    const no = scrub(c.container_no || c.cntr || "待回填");
    const seal = scrub(c.seal_no || "待回填");
    return `柜 ${esc(c.seq || i + 1)}：${esc(no)} / ${esc(seal)} ✎`;
  }).join("<br>");
}
	function renderTruck(){
	  const detail = state.sheet.trucking_detail || {};
	  const list = Array.isArray(detail.vehicles) && detail.vehicles.length
	    ? detail.vehicles
	    : (Array.isArray(state.sheet.containers_detail) && state.sheet.containers_detail.length ? state.sheet.containers_detail : []);
	  const peers = list.filter(c => c && (c.loading_address || c.loading_contact));
	  const fac = state.factoryProfileAddress || {};
	  const vehicles = list.map(c => {
	    const ownAddr = c.loading_address || c.factory_loading_address || c.pickup_address || c.loading_addr || c.address || "";
	    const peerAddr = !ownAddr && (peers.find(x => x !== c && x.loading_address) || {}).loading_address;
	    const ownContact = c.loading_contact || c.factory_loading_contact || c.contact || c.factory_contact || "";
	    const peerContact = !ownContact && (peers.find(x => x !== c && x.loading_contact) || {}).loading_contact;
	    const src = ownAddr ? (fac.address && ownAddr === fac.address ? "工厂档案" : "") : (peerAddr ? "同票其他柜" : (fac.address ? "工厂档案" : ""));
	    return { plate:c.plate || c.truck_plate || "", driver:c.driver || c.driver_name || "", driver_phone:c.driver_phone || "", pickup_time:c.pickup_time || "", loading_time:c.loading_time || c.load_time || "", loading_address:ownAddr || peerAddr || fac.address || "", loading_contact:ownContact || peerContact || fac.contact || "", loading_source:src, cntr:c.cntr || c.container_no || "", seal_no:c.seal_no || "", weigh_kg:c.weigh_kg || "", trailer_plate:c.trailer_plate || "", photos:Array.isArray(c.photos) ? c.photos : [] };
	  });
  const sheet = {
    ...state.sheet,
    trucking_detail:{
      ...detail,
      vehicles,
      cargo_summary:detail.cargo_summary || {},
      source:detail.source || (vehicles.length ? "container_bookings" : "")
    }
  };
  CollabTruckBlock.mount($("truckBody"), {
    token,
    sheet,
    data:state,
	    toast,
	    onSubmitted:function(){
	      const badge = $("boxBadge");
	      if(badge){ badge.textContent = tr("common.saved"); badge.className = "sstat ok"; }
	      state.truckSubmitted = true; renderTodos();
	    }
	  });
}

function allowedLine(l){
  const keys = Object.keys(l || {}).join(" ").toLowerCase();
  if(/cost|margin|profit|gross|purchase|local_charges|base/.test(keys)) return false;
  return l && (l.amount != null || l.unit_price != null || l.name || l.cost_category);
}
function groupLines(lines){
  const out = { ocean:[], local:[], truck:[], customs:[], other:[] };
  lines.filter(allowedLine).forEach(l=>{
    const name = String(l.name || l.cost_category || "").toLowerCase();
    if(/ocean|freight|海运/.test(name)) out.ocean.push(l);
    else if(/truck|拖车/.test(name)) out.truck.push(l);
    else if(/custom|报关/.test(name)) out.customs.push(l);
    else if(/local|thc|doc|seal|港杂|文件|铅封|码头/.test(name)) out.local.push(l);
    else out.other.push(l);
  });
  return out;
}
function lineAmount(l){
  const amount = l.amount != null ? l.amount : Number(l.unit_price || 0) * Number(l.qty || 1);
  return money(amount, l.currency);
}
function totalByCurrency(lines){
  const map = {};
  lines.filter(allowedLine).forEach(l=>{
    const cur = l.currency || "CNY";
    const n = Number(l.amount != null ? l.amount : Number(l.unit_price || 0) * Number(l.qty || 1));
    if(Number.isFinite(n)) map[cur] = (map[cur] || 0) + n;
  });
  return Object.keys(map).map(cur => money(map[cur], cur)).join(" + ") || "—";
}
function amountText(v){
  if(!v) return "";
  if(typeof v === "string") return v;
  return Object.keys(v).map(cur => money(v[cur], cur)).join(" + ");
}
function segAmount(key, fallback){
  const seg = state.bill.segments && state.bill.segments[key];
  if(seg && seg.amount) return amountText(seg.amount);
  return totalByCurrency(fallback || []);
}
function segStatus(key, lines){
  const seg = (state.bill.segments || {})[key] || {};
  const s = String(seg.status || ""), a = amountText(seg.amount);
  if(s === "已定") return { cls:"ok", label:tr("fwd.billFixed") };
  if(s === "待确认") return { cls:"", label:tr("fwd.billPending") };
  if(s === "已录入" || lines.length || a) return { cls:"", label:tr("fwd.billEntered") };
  return { cls:"", label:tr("fwd.billNeedInput") };
}
	function renderFees(){
	  const lines = Array.isArray(state.invoice.bill_lines) ? state.invoice.bill_lines.filter(allowedLine) : [];
	  const g = groupLines(lines);
	  g.local = g.local.concat(g.other);
	  $("feeBody").innerHTML = [
	    feeVisible("ocean","ocean",g.ocean) ? feePanel("ocean", "🚢", "海运费 Ocean Freight", cntrSummary(state.sheet), g.ocean, "ocean") : "",
	    feeVisible("truck","trucking",g.truck) ? feePanel("truck", "🚚", "拖车费 Trucking", "报价前请看提货地址", g.truck, "trucking") : "",
    feeAllowed("ocean") ? feePanel("local", "🏗", tr("fwd.localFee"), "请逐项填写贵司报价", g.local, "port_charge", true) : "",
	    feeVisible("customs","customs",g.customs) ? feePanel("customs", "📋", "报关费 Customs", scrub(state.sheet.pol || "—"), g.customs, "customs") : ""
	  ].join("") + billConfirmBox();
	  $("arV").textContent = totalByCurrency(lines);
	  $("arDue").textContent = lines.length ? tr("fwd.billConfirm") : humanBillHint(state);
	}
	function feeAllowed(roleSeg){
	  const scope = Array.isArray(state.segments) && state.segments.length ? state.segments : ["ocean","truck","customs"];
	  return scope.includes(roleSeg);
	}
	function feeVisible(roleSeg, billSeg, lines){
	  if(!feeAllowed(roleSeg)) return false;
	  const seg = (state.bill.segments || {})[billSeg] || {};
	  return lines.length || seg.amount || seg.pending_amount || !/待报|无账单/.test(String(seg.status || ""));
	}
function feePanel(key, icon, title, sub, lines, segKey, editable){
  const value = segAmount(segKey, lines);
  const missing = value === "—" || /待报|待贵司填|无账单/.test(String((state.bill.segments || {})[segKey]?.status || ""));
  const status = segStatus(segKey, lines);
  const rows = lines.length ? lines.map(l=>`<div class="exp-row"><span>${esc(scrub(l.name || l.cost_category || "费用"))}</span><span class="mono">${esc(lineAmount(l) || "未填写金额")}</span></div>`).join("") : "";
  return `<details class="exp">
    <summary class="fee-head"><span class="bi">${icon}</span><div class="bt2"><b>${esc(title)}</b><span>${esc(sub || "—")}</span></div>
      <div class="fee-actions"><span class="fee-chip ${status.cls}">${esc(status.label)}</span><span class="${missing ? "fee-missing" : "bv"}">${missing ? esc(tr("fwd.amountMissing")) : esc(value)}</span><span class="chev">▾</span></div></summary>
    <div class="exp-body">${rows || `<div class="pending">${esc(tr("fwd.amountMissing"))}</div>`}${editable ? feeInputRows() : ""}</div>
  </details>`;
}
function feeInputRows(){
  return `<div class="fee-form">
    <input id="feeName" value="${esc(tr("fwd.localFee"))}" aria-label="fee">
    <select id="feeBasis" aria-label="计价单位"><option value="per_container">每柜 × N</option><option value="per_bl">整票 × 1</option></select>
    <input id="feeUnit" type="number" min="0" step="0.01" placeholder="单价">
    <button class="bdl" onclick="submitLocalFee()">${esc(tr("common.submit"))}</button>
  </div>`;
}
	function billConfirmBox(){
  const ocean = segAmount("ocean", []);
  const truck = segAmount("trucking", []);
  return `<div class="confirmbox on">
    <div><b>${esc(tr("fwd.billConfirm"))}</b><div class="tip">${esc(tr("fwd.billRange", { ocean, truck }))}</div></div>
    <label class="fe-rem"><input id="billCheck" type="checkbox" ${state.billLocked ? "checked disabled" : ""}> ${esc(tr("fwd.billCheck"))}</label>
    <button class="btn ok" onclick="confirmBillLock()" ${state.billLocked ? "disabled" : ""}>${state.billLocked ? esc(tr("fwd.locked")) : esc(tr("fwd.billConfirm"))}</button>
	  </div>`;
	}
	function renderTodos(){
	  const s = state.sheet, tasks = [];
	  const vehs = ((s.trucking_detail && s.trucking_detail.vehicles) || s.containers_detail || []);
	  const missVeh = !state.truckSubmitted && state.segments.includes("truck") && vehs.some(v => !(v.plate || v.truck_plate) || !v.driver_phone);
	  const missCntr = !state.truckSubmitted && state.segments.includes("truck") && vehs.some(v => !(v.cntr || v.container_no) || !v.seal_no);
	  const portSeg = (state.bill.segments || {}).port_charge || {};
	  if(!hasUpload(/(^|[^A-Z])S\/?O([^A-Z]|$)|放舱|订舱确认|舱单|manifest/i)) tasks.push(["待传 SO 订舱确认","sectionUpload"]);
	  if(!hasUpload(/\bBL\b|提单/i)) tasks.push(["待传提单 B/L","sectionUpload"]);
	  if(feeAllowed("ocean") && segAmount("port_charge", []) === "—" && !portSeg.pending_amount) tasks.push(["待填港杂费报价","sectionFees"]);
	  if(!state.billLocked) tasks.push(["待确认本票账单","sectionFees"]);
	  if(missVeh) tasks.push(["待回填车辆与司机","sectionTruck"]);
	  if(missCntr) tasks.push(["待确认箱号封号","sectionTruck"]);
	  $("todoSection").style.display = tasks.length ? "" : "none";
	  $("headFlag").style.display = tasks.length ? "flex" : "none";
	  $("todoBadge").textContent = tr("fwd.todoCount", { n:tasks.length });
	  $("todoBox").innerHTML = tasks.map(t => `<button class="todo-item" onclick="jumpTodo('${t[1]}')">${esc(t[0])}</button>`).join("");
	}
	function jumpTodo(id){ const el = $(id); if(el){ if(el.tagName === "DETAILS") el.open = true; el.scrollIntoView({ behavior:"smooth", block:"start" }); } }
async function submitLocalFee(){
  const name = ($("feeName") && $("feeName").value.trim()) || "港杂费";
  const basis = $("feeBasis") ? $("feeBasis").value : "";
  const unit = $("feeUnit") ? Number($("feeUnit").value || 0) : 0;
  if(!basis){ toast("请选择计价单位"); return; }
  if(!(unit > 0)){ toast("请填写金额"); return; }
  const qty = basis === "per_container" ? Number(state.sheet.container_qty || 0) : 1;
  try{
    await fetchJson(`${API}/collab-bill-submit`, { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ token, action:"add", cost_category:name, charge_basis:basis, currency:"CNY", unit_price:unit, qty, amount:unit * (qty || 1), reason:"forwarder sheet local charge submit" }) });
    toast("港杂费已提交，待 Sanlyn 核价确认");
	    const bill = await fetchJson(`${API}/collab-bill-summary?token=${encodeURIComponent(token)}`).catch(()=>null);
	    if(bill) state.bill = bill;
	    renderFees(); renderTodos();
  }catch(e){ toast("提交失败：" + e.message); }
}
function confirmBillLock(){
  const ck = $("billCheck");
  if(!ck || !ck.checked){ toast("请先勾选已核对金额与柜数无误"); return; }
  localStorage.setItem(lockKey(), "1");
	  state.billLocked = true;
	  toast("账单已锁定");
	  renderFees(); renderTodos();
}

function openInvoice(){ window.open(`/public/invoice-confirm-preview.html?token=${encodeURIComponent(token)}`, "_blank", "noopener"); }
function pickUpload(zone, label){ state.uploadZone = zone; state.uploadLabel = label; $("fileInput").click(); }
async function uploadPickedFile(input){
  const f = input.files && input.files[0];
  input.value = "";
  if(!f) return;
  if(f.size > 8 * 1024 * 1024){ toast("文件需在 8MB 以内"); return; }
  const b64 = await new Promise((ok,no)=>{ const r = new FileReader(); r.onload=()=>ok(r.result); r.onerror=no; r.readAsDataURL(f); });
  const fname = `[${state.uploadZone}][${state.uploadLabel}]${f.name}`;
  try{
    const d = await fetchJson(`${API}/upload`, { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ token, filename:fname, mime:f.type, data_base64:b64 }) });
    if(state._reqUpload && state.reqTaskId){
      state._reqUpload = false;
      const by = (prompt("签署人姓名") || "").trim();
      const title = (prompt("签署人职务（选填）", "") || "").trim();
      await fetchJson(`${API}/collab-requirement-submit`, { method:"POST", headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({ token, task_id:state.reqTaskId, signed_by:by, signed_title:title, company_chop_present:true, evidence_ref:fname, loi_template_version:"v1" }) });
      const t = (state.carrierReq || []).find(x => x.id === state.reqTaskId);
      if(t){ t.status = "submitted"; t.signed_by = by; }
      renderCarrierReq();
      toast("已提交，待 Sanlyn 核对");
      return;
    }
    state.sheet.collab_uploads = (state.sheet.collab_uploads || []).concat(d.file || []);
    renderAll();
    toast("已上传：" + f.name);
  }catch(e){ toast("上传失败：" + e.message); }
}

document.getElementById("sheet").addEventListener("click", e => {
  if(e.target.id === "sheet") e.currentTarget.classList.remove("on");
});
window.onCollabI18nChange = function(){
  if(!state.sheet || !Object.keys(state.sheet).length) return;
  $("agrTag").textContent = state.segments.includes("truck") ? tr("fwd.truckDelegated") : tr("fwd.truckReview");
  $("soHint").textContent = uploadedHint(/(^|[^A-Z])S\/?O([^A-Z]|$)|放舱|订舱确认|舱单|manifest/i, tr("fwd.soHint"));
  $("blHint").textContent = uploadedHint(/\bBL\b|提单/i, tr("fwd.blHint"));
  renderRef(); renderReceipts(); renderDocs(releaseMeta(state.sheet.release_type)); renderCarrierReq(); renderBoxMode(); renderFees(); renderTodos();
};
boot();
