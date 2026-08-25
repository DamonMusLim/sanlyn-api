function sensitiveFeeLine(l){
  const name = String((l && (l.name || l.cost_category)) || "").toLowerCase();
  const scope = String((l && l.fob_scope) || "").toLowerCase();
  const cur = String((l && l.currency) || "").toUpperCase();
  return /ocean|freight|海运|运费/.test(name) || scope === "freight" || cur === "USD";
}
function allowedLine(l){
  const keys = Object.keys(l || {}).join(" ").toLowerCase();
  if(/cost|margin|profit|gross|purchase|local_charges|base/.test(keys)) return false;
  if(sensitiveFeeLine(l)) return false;
  return l && (l.amount != null || l.unit_price != null || l.name || l.cost_category);
}
function groupLines(lines){
  const out = { local:[], truck:[], customs:[], other:[] };
  lines.filter(allowedLine).forEach(l=>{
    const name = String(l.name || l.cost_category || "").toLowerCase();
    if(/truck|拖车/.test(name)) out.truck.push(l);
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
  return Object.keys(v).filter(cur => cur !== "USD").map(cur => money(v[cur], cur)).join(" + ");
}
function segAmount(key, fallback){
  const seg = state.bill.segments && state.bill.segments[key];
  if(seg && seg.amount) return amountText(seg.amount) || "—";
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
    feePanel("local", "🏗", tr("fwd.localFee"), "请逐项填写贵司报价", g.local, "port_charge", true),
    feeVisible("truck","trucking",g.truck) ? feePanel("truck", "🚚", "拖车费 Trucking", "报价前请看提货地址", g.truck, "trucking") : "",
    feeVisible("customs","customs",g.customs) ? feePanel("customs", "📋", "报关费 Customs", scrub(state.sheet.pol || "—"), g.customs, "customs") : ""
  ].join("") + billConfirmBox();
  $("arV").textContent = totalByCurrency(lines);
  $("arDue").textContent = lines.length ? tr("fwd.billConfirm") : humanBillHint(state);
}
function feeAllowed(roleSeg){
  const scope = Array.isArray(state.segments) && state.segments.length ? state.segments : ["port_charge"];
  return scope.includes(roleSeg);
}
function feeVisible(roleSeg, billSeg, lines){
  if(!feeAllowed(roleSeg)) return false;
  const seg = (state.bill.segments || {})[billSeg] || {};
  return lines.length || seg.amount || seg.pending_amount || !/待报|无账单|待贵司填/.test(String(seg.status || ""));
}
function segLines(segKey, fallback){
  const seg = (state.bill.segments || {})[segKey] || {};
  if (Array.isArray(seg.lines) && seg.lines.length) return seg.lines.filter(allowedLine);
  return Array.isArray(fallback) ? fallback : [];
}
function basisText(b){
  if (b === "per_container") return tr("fwd.basisPerCntr");
  if (b === "per_bl") return tr("fwd.basisPerBl");
  if (b === "per_declaration") return tr("fwd.basisPerDecl");
  if (b === "per_item") return tr("fwd.basisPerItem");
  return "";
}
function quotePortalRow(){
  const qp = state.bill.quote_portal;
  if (!qp || !qp.url) return "";
  return `<a class="quote-jump" href="${esc(qp.url)}" target="_blank" rel="noopener">`
       + `<span>${esc(tr("fwd.quotePortal"))}</span><span class="qj-arrow">→</span></a>`;
}
function feePanel(key, icon, title, sub, lines, segKey, editable){
  const value = segAmount(segKey, lines);
  const missing = value === "—" || /待报|待贵司填|无账单/.test(String((state.bill.segments || {})[segKey]?.status || ""));
  const status = segStatus(segKey, lines);
  const _ls = segLines(segKey, lines);
  const rows = _ls.length ? _ls.map(l=>{
    const nm = esc(scrub(l.name || l.cost_category || "费用"));
    const bt = basisText(l.charge_basis);
    const calc = (l.qty != null && l.unit_price != null) ? `${esc(String(l.unit_price))} × ${esc(String(l.qty))}` : "";
    const amt = l.amount != null ? money(l.amount, l.currency) : (lineAmount(l) || "");
    return `<div class="exp-row"><span>${nm}${bt ? ` <small class="dim">${esc(bt)}</small>` : ""}</span>`
         + `<span class="mono">${calc ? `<small class="dim">${calc} = </small>` : ""}${esc(amt || tr("fwd.amountMissing"))}</span></div>`;
  }).join("") : "";
  return `<details class="exp">
    <summary class="fee-head"><span class="bi">${icon}</span><div class="bt2"><b>${esc(title)}</b><span>${esc(sub || "—")}</span></div>
      <div class="fee-actions"><span class="fee-chip ${status.cls}">${esc(status.label)}</span><span class="${missing ? "fee-missing" : "bv"}">${missing ? esc(tr("fwd.amountMissing")) : esc(value)}</span><span class="chev">▾</span></div></summary>
    <div class="exp-body">${rows || `<div class="pending">${esc(tr("fwd.amountMissing"))}</div>`}${editable ? feeInputRows() : ""}${quotePortalRow()}</div>
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
  const local = segAmount("port_charge", []);
  const parts = [];
  if(local !== "—") parts.push(`${tr("fwd.localFee")} ${local}`);
  return `<div class="confirmbox on">
    <div><b>${esc(tr("fwd.billConfirm"))}</b><div class="tip">${esc(parts.join(" · ") || tr("fwd.localFee"))}</div></div>
    <label class="fe-rem"><input id="billCheck" type="checkbox" ${state.billLocked ? "checked disabled" : ""}> ${esc(tr("fwd.billCheck"))}</label>
    <button class="btn ok" onclick="confirmBillLock()" ${state.billLocked ? "disabled" : ""}>${state.billLocked ? esc(tr("fwd.locked")) : esc(tr("fwd.billConfirm"))}</button>
  </div>`;
}
