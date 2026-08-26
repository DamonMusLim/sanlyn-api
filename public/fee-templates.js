const API = "/api/db/fee-templates";
const state = { source: "local", sources: [] };
const $ = (id) => document.getElementById(id);

function token() {
  return localStorage.getItem("sanlyn_jwt") || localStorage.getItem("sanlyn_token") || localStorage.getItem("token") || "";
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function display(v, fallback = "未设置") {
  return v === null || v === undefined || v === "" ? fallback : String(v);
}

function money(v, c) {
  if (v === null || v === undefined || v === "") return "未设置";
  const n = Number(v);
  if (!Number.isFinite(n)) return "未设置";
  return `${display(c, "")} ${n.toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`.trim();
}

function openTab(title, url) {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "sanlyn:open-tab", title, url }, location.origin);
  } else {
    window.open(url, "_blank", "noopener");
  }
}

async function api() {
  const p = new URLSearchParams({
    source: state.source,
    carrier: $("carrier").value.trim(),
    pol: $("pol").value.trim(),
    pod: $("pod").value.trim(),
  });
  const h = {};
  const t = token();
  if (t) h.Authorization = "Bearer " + t;
  const r = await fetch(`${API}?${p.toString()}`, { headers: h });
  const d = await r.json().catch(() => ({ success: false, error: "接口返回异常" }));
  if (!r.ok || d.success === false) throw new Error(d.error || "请求失败");
  return d;
}

function renderTabs(data) {
  const box = $("tabs");
  box.textContent = "";
  state.sources = data.sources || state.sources;
  state.sources.forEach((s) => {
    const b = el("button", "tab hgj-tabbtn" + (s.key === state.source ? " active" : ""), s.label);
    b.onclick = () => { state.source = s.key; load(); };
    box.appendChild(b);
  });
}

function renderCoverage(cov) {
  const box = $("coverage");
  box.textContent = "";
  if (!cov || !cov.fields || !cov.fields.length) {
    box.appendChild(el("div", "empty", "未接入 · 缺少字段或没有真实行；当前填充率 未接入"));
    return;
  }
  cov.fields.forEach((f) => {
    box.appendChild(el("span", "pill", `${f.name} ${f.filled}/${f.total} · ${f.fill_rate_percent}%`));
  });
  if (cov.missing_fields && cov.missing_fields.length) {
    box.appendChild(el("div", "muted", "缺字段：" + cov.missing_fields.join("、")));
  }
}

function cell(tr, text, cls) {
  const td = el("td", cls || "", text);
  tr.appendChild(td);
  return td;
}

function renderRows(rows, source) {
  const box = $("rows");
  box.textContent = "";
  if (!rows || !rows.length) {
    box.appendChild(el("div", "empty", "未接入 · 没有可展示的真实模板行"));
    return;
  }
  const t = el("table");
  const hr = el("tr");
  ["范围", "费目", "计费", "成本", "销售", "有效期"].forEach((x) => hr.appendChild(el("th", "", x)));
  t.appendChild(el("thead")).appendChild(hr);
  const tb = el("tbody");
  rows.forEach((r) => {
    const tr = el("tr");
    const scope = [r.carrier, r.pol, r.pod, r.container_type].map((x) => display(x, "")).filter(Boolean).join(" / ");
    const a = cell(tr, scope || "未设置", "rowlink");
    a.onclick = () => openTab(source.label + " " + display(r.id), "/rates");
    cell(tr, display(r.fee_name));
    cell(tr, display(r.basis));
    cell(tr, money(r.cost_amount, r.currency));
    cell(tr, money(r.sale_amount, r.currency));
    cell(tr, [display(r.valid_from, ""), display(r.valid_to, "")].filter(Boolean).join(" 至 ") || "未设置");
    tb.appendChild(tr);
  });
  t.appendChild(tb);
  box.appendChild(t);
}

function render(data) {
  renderTabs(data);
  $("stamp").textContent = `${data.version || "v2026.08.26-1"} · 生成时间 ${new Date(data.generated_at).toLocaleString("zh-CN")}`;
  $("stateText").textContent = data.state === "ready" ? "已接入" : "未接入";
  $("rowCount").textContent = data.coverage?.total_rows ? String(data.coverage.total_rows) : "未接入";
  $("missingCount").textContent = data.coverage?.missing_fields?.length ? String(data.coverage.missing_fields.length) : "未接入";
  const missing = data.coverage?.missing_fields || [];
  const rate = data.coverage?.fields?.map((f) => `${f.name} ${f.fill_rate_percent}%`).join("；") || "当前填充率 未接入";
  $("basis").textContent = data.state === "ready"
    ? `数据源 ${data.source.table}；${rate}`
    : `未接入：缺 ${missing.join("、") || "真实数据行"}；${rate}`;
  renderCoverage(data.coverage);
  renderRows(data.rows, data.source);
}

async function load() {
  try {
    const data = await api();
    render(data);
  } catch (e) {
    $("stamp").textContent = "v2026.08.26-1 · 读取失败";
    $("rows").textContent = "";
    $("rows").appendChild(el("div", "err", e.message));
  }
}

$("reload").onclick = load;
$("search").onclick = load;
["carrier", "pol", "pod"].forEach((id) => $(id).addEventListener("keydown", (e) => {
  if (e.key === "Enter") load();
}));
if (window.parent !== window) window.parent.postMessage({ type: "sanlyn:module-ready", title: "费用模板", url: location.pathname + location.search }, location.origin);
load();
