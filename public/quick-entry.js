(function () {
  const qs = new URLSearchParams(location.search);
  const moduleKey = (qs.get("module") || qs.get("module_key") || "").trim();
  const recordId = (qs.get("record_id") || qs.get("id") || "").trim();
  const commonKeys = (qs.get("common") || "").split(",").map((x) => x.trim()).filter(Boolean);
  const pageVersion = "v2026.08.27-1";
  const state = { sections: [], saved: 0, common: new Set(commonKeys), presets: {} };
  const form = document.getElementById("entryForm");
  const statusEl = document.getElementById("status");
  const metaEl = document.getElementById("meta");
  const titleEl = document.getElementById("title");

  function token() {
    return localStorage.getItem("sanlyn_jwt") || localStorage.getItem("sanlyn_token") || localStorage.getItem("token") || "";
  }
  function text(node, value) { node.textContent = value == null ? "" : String(value); }
  function fieldLabel(f) { return f.label_cn || f.label || f.field_key || f.canonical_key; }
  function isCommon(f) { return f.validation_json?.quick_entry_common === true || f.relationship_json?.quick_entry_common === true; }
  function presetFor(f) { return qs.get(f.canonical_key) ?? qs.get(f.field_key) ?? ""; }
  function inputType(kind) {
    if (["number", "date", "datetime-local", "time", "checkbox"].includes(kind)) return kind;
    if (kind === "textarea" || kind === "select") return kind;
    return "text";
  }
  function optionItems(raw) {
    if (Array.isArray(raw)) return raw.map((x) => typeof x === "object" ? x : { value: x, label: x });
    if (Array.isArray(raw?.options)) return optionItems(raw.options);
    return [];
  }
  function controlAttrs(el, f) {
    el.dataset.canonicalKey = f.canonical_key;
    el.dataset.fieldKey = f.field_key || "";
    el.dataset.moduleKey = f.module_key || moduleKey;
    el.name = f.canonical_key;
    el.disabled = f.editable === false;
    if (f.editable === false && "readOnly" in el) el.readOnly = true;
    const preset = presetFor(f);
    if (preset) {
      if (el.type === "checkbox") el.checked = ["1", "true", "yes"].includes(preset.toLowerCase());
      else el.value = preset;
      state.presets[f.canonical_key] = preset;
    }
  }
  function renderControl(f) {
    const kind = inputType(f.input_kind || f.type || "text");
    const ref = f.relationship_json?.reference;
    const wrap = document.createElement("div");
    if (kind === "textarea") {
      const el = document.createElement("textarea");
      controlAttrs(el, f);
      wrap.appendChild(el);
    } else if (kind === "select") {
      const el = document.createElement("select");
      controlAttrs(el, f);
      const blank = document.createElement("option");
      blank.value = "";
      text(blank, "未填");
      el.appendChild(blank);
      optionItems(f.options_json).forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.value ?? opt.label ?? "";
        text(o, opt.label ?? opt.value ?? "");
        el.appendChild(o);
      });
      wrap.appendChild(el);
    } else {
      wrap.className = ref ? "lookup" : "";
      const el = document.createElement("input");
      el.type = kind;
      if (kind !== "checkbox") el.placeholder = "未填";
      controlAttrs(el, f);
      wrap.appendChild(el);
      if (ref) bindLookup(wrap, el, ref);
    }
    const hint = document.createElement("div");
    hint.className = "hint";
    text(hint, f.editable === false ? "只读" : (f.required_for_completeness ? "完整性字段" : "未填也可保存"));
    wrap.appendChild(hint);
    return wrap;
  }
  function bindLookup(wrap, el, ref) {
    const panel = document.createElement("div");
    panel.className = "suggest";
    wrap.appendChild(panel);
    let timer = null;
    el.addEventListener("input", () => {
      clearTimeout(timer);
      const q = el.value.trim();
      if (!q) { panel.style.display = "none"; return; }
      timer = setTimeout(() => fetchLookup(panel, el, ref, q), 220);
    });
  }
  async function fetchLookup(panel, el, ref, q) {
    const target = ref.target_table || ref.type || ref.source || "";
    const key = ref.target_key_field || ref.key || "";
    const display = ref.target_display_field || ref.display || "";
    const url = `/api/db/field-lookup?target_table=${encodeURIComponent(target)}&q=${encodeURIComponent(q)}&target_key_field=${encodeURIComponent(key)}&target_display_field=${encodeURIComponent(display)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token()}` } });
    const data = await res.json().catch(() => ({}));
    panel.innerHTML = "";
    (data.data || []).forEach((row) => {
      const b = document.createElement("button");
      b.type = "button";
      text(b, row.label || row.value || "");
      b.addEventListener("click", () => {
        el.value = row.value ?? row.label ?? "";
        el.dataset.lookupLabel = row.label || "";
        panel.style.display = "none";
      });
      panel.appendChild(b);
    });
    panel.style.display = panel.childNodes.length ? "block" : "none";
  }
  function render(data) {
    form.innerHTML = "";
    state.sections = data.sections || [];
    titleEl.textContent = `快速录入 · ${data.module_key}`;
    metaEl.textContent = `${pageVersion} · generated_at=${data.generated_at || ""} · module=${data.module_key} · role=${data.role || ""} · 已录入 ${state.saved} 条`;
    if (!data.configured) {
      statusEl.className = "notice error";
      statusEl.textContent = "该模块尚未配置字段定义";
      return;
    }
    statusEl.className = "status";
    statusEl.textContent = recordId ? `更新记录 ${recordId}` : "先建单后补全: 新建时最多只拦截 2 个完整性必填字段";
    state.sections.forEach(renderSection);
  }
  function renderSection(sec) {
    const box = document.createElement("section");
    box.className = "section";
    const h = document.createElement("h2");
    text(h, sec.label || sec.key || "默认");
    box.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "grid";
    (sec.fields || []).forEach((f) => {
      if (isCommon(f)) state.common.add(f.canonical_key);
      const item = document.createElement("div");
      item.className = `field span-${Math.min(4, Math.max(1, Number(f.col_span || 1)))}`;
      const lab = document.createElement("label");
      const name = document.createElement("span");
      text(name, fieldLabel(f));
      const fid = document.createElement("span");
      fid.className = "fid";
      text(fid, f.canonical_key);
      lab.append(name, fid);
      item.append(lab, renderControl(f));
      grid.appendChild(item);
    });
    box.appendChild(grid);
    form.appendChild(box);
  }
  function collect() {
    const values = {};
    form.querySelectorAll("[data-canonical-key]").forEach((el) => {
      const key = el.dataset.canonicalKey;
      values[key] = el.type === "checkbox" ? el.checked : (el.value.trim() || null);
    });
    return values;
  }
  function clearForm() {
    form.querySelectorAll("[data-canonical-key]").forEach((el) => {
      const key = el.dataset.canonicalKey;
      if (state.common.has(key) || Object.prototype.hasOwnProperty.call(state.presets, key)) return;
      if (el.type === "checkbox") el.checked = false;
      else el.value = "";
    });
  }
  async function load() {
    if (!moduleKey) {
      statusEl.className = "notice error";
      statusEl.textContent = "URL 缺少 ?module=xxx";
      return;
    }
    const res = await fetch(`/api/db/quick-entry?module_key=${encodeURIComponent(moduleKey)}`, { headers: { Authorization: `Bearer ${token()}` } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.error || `HTTP ${res.status}`);
    render(data);
  }
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { module_key: moduleKey, record_id: recordId || undefined, values: collect() };
    const res = await fetch("/api/db/quick-entry", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      statusEl.className = "notice error";
      statusEl.textContent = data.errors ? data.errors.join("; ") : (data.error || `HTTP ${res.status}`);
      return;
    }
    state.saved += 1;
    metaEl.textContent = `${pageVersion} · module=${moduleKey} · 本次已录入 ${state.saved} 条`;
    statusEl.className = "status";
    statusEl.textContent = `已保存第 ${state.saved} 条 · payload keys: ${Object.keys(data.payload_by_canonical_key || {}).join(", ")}`;
    clearForm();
  });
  document.getElementById("reloadBtn").addEventListener("click", () => load().catch((err) => {
    statusEl.className = "notice error";
    statusEl.textContent = err.message;
  }));
  load().catch((err) => {
    statusEl.className = "notice error";
    statusEl.textContent = err.message;
  });
  if (window.parent !== window) window.parent.postMessage({ type: "sanlyn:module-ready", title: "快速录入", url: location.pathname + location.search }, location.origin);
})();
