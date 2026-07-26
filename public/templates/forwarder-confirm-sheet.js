const API = "/api/db/booking-collab";
const INVOICE_API = "/api/db/invoice-collab-confirm";
const token = new URLSearchParams(location.search).get("token") || "";
const $ = id => document.getElementById(id);
let state = { sheet: {}, invoice: {}, mode: "ours", uploadZone: "ocean", uploadLabel: "" };

function esc(v){
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
function fmtD(v){
  if(!v) return "—";
  try{ return new Date(v).toLocaleDateString("sv-SE",{timeZone:"Asia/Shanghai"}); }
  catch(_){ return String(v).slice(0,10) || "—"; }
}
function fmtDT(v){
  if(!v) return "—";
  try{
    return new Date(v).toLocaleString("zh-CN",{
      timeZone:"Asia/Shanghai",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false
    }).replace(/\//g,"-");
  }catch(_){ return String(v).slice(5,16) || "—"; }
}
function money(v, cur){
  const n = Number(v);
  if(!Number.isFinite(n)) return "";
  return (cur || "CNY") + " " + n.toLocaleString("zh-CN",{maximumFractionDigits:2});
}
function cntrSummary(s){
  const qty = Number(s.container_qty || 0);
  const type = s.container_type || "";
  return qty && type ? `${qty}×${type}` : (s.container_summary || type || "—");
}
function textParts(parts){ return parts.filter(Boolean).join(" · ") || "—"; }
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
  $("fwName").innerHTML = "订舱协同<br>链接不可用";
  $("fwSub").textContent = msg || "链接无效或已过期";
  $("agrTag").className = "flag urgent";
  $("agrTag").textContent = "请联系 Sanlyn 对接人";
  $("feeBody").innerHTML = `<div class="pending">${esc(msg || "加载失败")}</div>`;
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
    const [v, inv] = await Promise.all([
      fetchJson(`${API}/validate?token=${encodeURIComponent(token)}`),
      fetchJson(`${INVOICE_API}?token=${encodeURIComponent(token)}`).catch(e => ({ ok:false, error:e.message, data:{} }))
    ]);
    if(!v.valid){ fail(v.error || "链接无效或已过期"); return; }
    state.sheet = v.booking_sheet || v.sheet || {};
    state.meta = v.meta || {};
    state.role = v.role || "";
    state.invoice = inv.ok ? (inv.data || {}) : {};
    state.invoiceError = inv.ok ? "" : inv.error;
    state.mode = providerMode(state.sheet);
    renderAll();
  }catch(e){ fail(e.message || "加载失败"); }
}

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
  document.querySelectorAll(".modesw button").forEach(b=>b.classList.remove("on"));
  const idx = real === "nom" ? 1 : 0;
  const target = document.querySelectorAll(".modesw button")[idx] || btn;
  if(target) target.classList.add("on");
  if(m !== real) toast("本票货代安排以系统记录为准，外部链接不能切换写入");
  renderFees();
}
function applyModeButtons(){
  const btns = document.querySelectorAll(".modesw button");
  btns.forEach(b=>b.classList.remove("on"));
  const i = state.mode === "nom" ? 1 : 0;
  if(btns[i]) btns[i].classList.add("on");
}

function renderAll(){
  const s = state.sheet;
  applyModeButtons();
  const route = [s.pol, s.pod].filter(Boolean).join(" → ");
  $("fwName").innerHTML = `${esc(s.shipment_no || "—")} — 订舱协同<br>${esc(forwarderName(s))}`;
  $("fwSub").textContent = textParts([route, cntrSummary(s), [s.vessel,s.voyage].filter(Boolean).join(" / ")]);
  $("etdV").textContent = fmtD(s.etd);
  $("soNoV").textContent = s.so_no || "—";
  $("vesselV").textContent = [s.vessel, s.voyage].filter(Boolean).join(" / ") || "—";
  $("cutoffV").textContent = textParts([fmtDT(s.cargo_cutoff), fmtD(s.si_cutoff || s.doc_cutoff || s.cutoff_date)]);
  $("cntrV").innerHTML = renderContainerLines(s);
  $("soHint").textContent = uploadedHint(/(^|[^A-Z])S\/?O([^A-Z]|$)|放舱|订舱确认|舱单|manifest/i, "放舱后请上传");
  $("blHint").textContent = uploadedHint(/\bBL\b|提单/i, "草稿与正式提单");
  renderRef();
  renderStatus();
  renderFees();
}
function refValue(){
  const s = state.sheet;
  return s.so_bl_reference || s.shipment_no || "—";
}
function renderRef(){
  const s = state.sheet;
  const cur = refValue();
  $("refV").textContent = cur;
  const pend = s.so_bl_ref_pending;
  if(pend && pend.value && pend.value !== cur) $("refHint").textContent = `待我方核对：${pend.value}`;
  else if(s.so_bl_reference) $("refHint").textContent = "已确认引用单号";
  else $("refHint").textContent = "默认=我方内部号，可改";
}
function copyRef(){
  const t = refValue();
  if(navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(t).then(()=>toast("已复制：" + t)).catch(()=>toast("复制失败，请手动选择"));
  else toast("请手动选择复制：" + t);
}
async function editRef(){
  const v = prompt("SO / 提单引用单号（默认=我方内部号，可改为客户 PO 等）", refValue());
  if(v == null) return;
  const ref = String(v).trim();
  if(!ref) return;
  try{
    const d = await fetchJson(`${API}/collab-ref-submit`, { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ token, so_bl_reference: ref }) });
    if(d.applied){ state.sheet.so_bl_reference = ref; state.sheet.so_bl_ref_pending = null; toast("引用单号已更新：" + ref); }
    else { state.sheet.so_bl_ref_pending = { value: ref, status:"pending" }; toast("已提交，待 Sanlyn 核对"); }
    renderRef();
  }catch(e){ toast("提交失败：" + e.message); }
}
function forwarderName(s){
  if(state.mode === "nom") return "客户指定货代（无价格协议）";
  return s.forwarder_cn || s.forwarder_en || s.carrier_code || s.shipping_line || "货代";
}
function renderStatus(){
  const s = state.sheet;
  const days = daysLeft(s.cargo_cutoff || s.si_cutoff || s.etd);
  const prefix = days == null ? "待处理" : (days < 0 ? "已到截单期" : `截单剩 ${days} 天`);
  const hasSo = !!(s.so_no || findUpload(/(^|[^A-Z])S\/?O([^A-Z]|$)|放舱|订舱确认|舱单|manifest/i));
  $("agrTag").className = state.mode === "ours" ? "flag urgent" : "noagr";
  $("agrTag").textContent = state.mode === "ours"
    ? `⏰ ${prefix} · ${hasSo ? "SO 已有记录" : "待传 SO"}`
    : `⏰ ${prefix} · ${hasSo ? "SO 已有记录" : "待传 SO"} · 待报价`;
}
function daysLeft(v){
  if(!v) return null;
  const d = new Date(v);
  if(Number.isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}
function findUpload(re){
  const ups = Array.isArray(state.sheet.collab_uploads) ? state.sheet.collab_uploads : [];
  return ups.find(u => re.test(String(u.filename || "")));
}
function uploadedHint(re, fallback){
  const u = findUpload(re);
  return u ? `已上传：${u.filename || "文件"}` : fallback;
}
function renderContainerLines(s){
  const list = Array.isArray(s.containers_detail) && s.containers_detail.length
    ? s.containers_detail
    : (Array.isArray(s.containers_live) ? s.containers_live : []);
  if(!list.length) return "—";
  return list.map((c,i)=>{
    const no = c.container_no || c.cntr || "待回填";
    const seal = c.seal_no || "待回填";
    return `柜 ${esc(c.seq || i + 1)}：${esc(no)} / ${esc(seal)} ✎`;
  }).join("<br>");
}

function allowedLine(l){
  const keys = Object.keys(l || {}).join(" ").toLowerCase();
  if(/cost|margin|profit|gross|purchase/.test(keys)) return false;
  return l && (l.amount != null || l.unit_price != null || l.name);
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
function renderFees(){
  const lines = Array.isArray(state.invoice.bill_lines) ? state.invoice.bill_lines.filter(allowedLine) : [];
  const g = groupLines(lines);
  $("feeBody").innerHTML = state.mode === "ours" ? feeOurs(g) : feeNom(g);
  $("auditWrap").innerHTML = "";
  $("arV").textContent = totalByCurrency(lines);
  $("arDue").textContent = lines.length ? "以账单确认为准" : (state.invoiceError || "费用尚未录入");
}
function feeOurs(g){
  return [
    feeBill("🚢","海运费 Ocean Freight", cntrSummary(state.sheet), g.ocean, true),
    localDetails(g.local.concat(g.other)),
    quoteBill("🚚","拖车费 Trucking","报价前请看提货地址","truck"),
    pickupBlock(),
    quoteBill("📋","报关费 Customs", `${state.sheet.pol || "—"} · ${cntrSummary(state.sheet)}`, "customs"),
    `<a class="invoice-cta" href="/public/invoice-confirm-preview.html?token=${encodeURIComponent(token)}">💰 打开账单 · 改价 · 开票 <small>可议价改单价 · 我方代开/对方自开</small></a>`
  ].join("");
}
function feeNom(g){
  const rows = g.local.concat(g.other);
  const body = rows.length ? rows.map((l,i)=>`<tr><td>${esc(l.name || "费用")}</td><td class="r"><input type="number" value="${esc(Number(l.amount || 0))}" data-bill-id="${esc(l.id || "")}" oninput="sumFee()"></td></tr>`).join("")
    : `<tr><td>新增费目</td><td class="r"><input type="number" value="0" oninput="sumFee()"></td></tr>`;
  return `
  <div class="bill"><span class="bi">🚢</span><div class="bt2"><b>海运费 Ocean Freight</b><span>客户与贵司直接结算</span></div><span class="na">不经我方 · 无需填写</span></div>
  <div class="block" style="border-radius:11px"><div class="bh"><h2 style="font-size:14.5px">港杂费 Local Charges</h2><p>请逐项填写贵司报价</p></div>
    <div class="bb"><table class="fee-in"><thead><tr><th>费目</th><th class="r">金额 CNY</th></tr></thead><tbody>${body}<tr class="sum"><td>合计</td><td class="r" id="feeSum">—</td></tr></tbody></table>
      <button class="addfee" onclick="addFee()">+ 新增费目</button><div class="pending">提交后由 Sanlyn 核价确认</div></div></div>
  ${quoteBill("🚚","拖车费 Trucking","报价前请看提货地址","truck")}${pickupBlock()}
  ${quoteBill("📋","报关费 Customs",`${state.sheet.pol || "—"} · 如由贵司安排`,"customs")}`;
}
function feeBill(icon, title, sub, lines, withDownload){
  const value = totalByCurrency(lines);
  return `<div class="bill"><span class="bi">${icon}</span><div class="bt2"><b>${title}</b><span>${esc(sub || "—")}</span></div><div class="bv">${esc(value)}</div>${withDownload ? '<button class="bdl" onclick="openInvoice()">下载</button>' : ""}</div>`;
}
function localDetails(lines){
  if(!lines.length) return feeBill("🏗","港杂费 Local Charges","费用尚未录入",[],false);
  const rows = lines.map(l=>`<div class="exp-row"><span>${esc(l.name || "费用")}</span><span class="mono">${esc(lineAmount(l))}</span></div>`).join("");
  return `<details class="exp"><summary><span class="bi">🏗</span><div class="bt2"><b>港杂费 Local Charges</b><span>点开看明细</span></div><div class="bv">${esc(totalByCurrency(lines))}</div><span class="chev">▾</span></summary><div class="exp-body">${rows}<div class="exp-row"><span>合计</span><span class="mono">${esc(totalByCurrency(lines))}</span></div></div></details>`;
}
function quoteBill(icon, title, sub, segment){
  return `<div class="bill"><span class="bi">${icon}</span><div class="bt2"><b>${title}</b><span>${esc(sub)}</span></div><span class="fillin" onclick="submitQuote('${segment}')">填写报价 ✎</span></div>`;
}
function pickupBlock(){
  const c = (state.sheet.containers_detail || [])[0] || {};
  return `<div class="pickup"><div class="pl">提货地址 PICK-UP</div><div class="pc">${esc(c.loading_contact || state.sheet.trucking_company_cn || "—")}</div><div class="pa">${esc(c.loading_address || "—")}</div><div class="pr">→ ${esc(state.sheet.pol || "—")} · ${esc(cntrSummary(state.sheet))} · 装柜 ${esc(fmtD(c.pickup_time || c.loading_time))}</div></div>`;
}
function sumFee(){
  let t = 0;
  document.querySelectorAll(".fee-in input").forEach(input => { t += Number(input.value || 0) || 0; });
  const el = $("feeSum");
  if(el) el.textContent = "CNY " + t.toLocaleString("zh-CN",{maximumFractionDigits:2});
  $("arV").textContent = el ? `${el.textContent}（待核价）` : "—";
  $("arDue").textContent = "核价确认后计";
}
function addFee(){
  const tbody = document.querySelector(".fee-in tbody");
  if(!tbody) return;
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><input style="text-align:left;width:120px" value="新增费目"></td><td class="r"><input type="number" value="0" oninput="sumFee()"></td>`;
  tbody.insertBefore(tr, tbody.querySelector(".sum"));
}

function openInvoice(){
  window.open(`/public/invoice-confirm-preview.html?token=${encodeURIComponent(token)}`, "_blank", "noopener");
}
function downloadSI(){
  window.open(`${API}/file?token=${encodeURIComponent(token)}&type=so`, "_blank", "noopener");
}
function pickUpload(zone, label){
  state.uploadZone = zone;
  state.uploadLabel = label;
  $("fileInput").click();
}
async function uploadPickedFile(input){
  const f = input.files && input.files[0];
  input.value = "";
  if(!f) return;
  if(f.size > 8 * 1024 * 1024){ toast("文件需在 8MB 以内"); return; }
  const b64 = await new Promise((ok,no)=>{ const r = new FileReader(); r.onload=()=>ok(r.result); r.onerror=no; r.readAsDataURL(f); });
  try{
    const d = await fetchJson(`${API}/upload`, { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ token, filename:`[${state.uploadZone}][${state.uploadLabel}]${f.name}`, mime:f.type, data_base64:b64 }) });
    state.sheet.collab_uploads = (state.sheet.collab_uploads || []).concat(d.file || []);
    renderAll();
    toast("已上传：" + f.name);
  }catch(e){ toast("上传失败：" + e.message); }
}
async function confirmContainers(){
  const vehicles = (state.sheet.containers_detail || []).map(c => ({
    cntr:c.container_no || "", seal_no:c.seal_no || "", plate:c.plate || "",
    driver:c.driver_name || "", driver_phone:c.driver_phone || "", pickup_time:c.pickup_time || ""
  })).filter(v => v.cntr || v.seal_no || v.plate || v.driver_phone);
  try{
    const d = await fetchJson(`${API}/trucking-submit`, { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ token, vehicles, remarks:"forwarder sheet container/seal confirm" }) });
    toast(d.ok ? "箱封号确认已提交" : "提交完成");
  }catch(e){ toast("确认失败：" + e.message); }
}
async function editContainers(){
  const cntr = prompt("请输入柜号（多柜请在 Sanlyn 协助中提交明细）", "");
  if(!cntr) return;
  const seal = prompt("请输入封号", "");
  try{
    await fetchJson(`${API}/trucking-submit`, { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ token, vehicles:[{ cntr, seal_no:seal || "", plate:"待补" }], remarks:"forwarder sheet container/seal edit" }) });
    toast("箱封号修改已提交");
  }catch(e){ toast("提交失败：" + e.message); }
}
async function submitQuote(segment){
  const amount = prompt(segment === "truck" ? "请输入拖车报价金额" : "请输入报关报价金额", "");
  if(amount == null || amount === "") return;
  // 货代报的是「自己的收费」(=我方成本), 一律进 staging 待 Sanlyn 核价, 绝不直接写我方销售价。
  const quotes = [{ segment, amount:Number(amount), currency:"CNY" }];
  document.querySelectorAll(".fee-in tbody tr").forEach(tr=>{
    if(tr.classList.contains("sum")) return;
    const inp = tr.querySelector("input[type=number]");
    const v = inp ? Number(inp.value || 0) : 0;
    const nm = (tr.querySelector("td") && tr.querySelector("td").textContent || "").trim();
    if(v > 0) quotes.push({ segment:"local", name:nm || "港杂费", amount:v, currency:"CNY" });
  });
  try{
    await fetchJson(`${API}/collab-quote-submit`, { method:"POST", headers:{ "Content-Type":"application/json" },
      body: JSON.stringify({ token, quotes }) });
    toast("报价已提交，待 Sanlyn 核价确认");
  }catch(e){ toast("报价提交失败：" + e.message); }
}

document.getElementById("sheet").addEventListener("click", e => {
  if(e.target.id === "sheet") e.currentTarget.classList.remove("on");
});
boot();
