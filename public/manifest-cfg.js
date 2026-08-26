(function() {
  function getToken() {
    return localStorage.getItem("sanlyn_jwt")
      || localStorage.getItem("sanlyn_token")
      || localStorage.getItem("token")
      || "";
  }

  function extractLayout(data) {
    if (!data) return null;
    if (data.layout_json && typeof data.layout_json === "object") return data.layout_json;
    if (data.data?.layout_json && typeof data.data.layout_json === "object") return data.data.layout_json;
    if (data.sections && Array.isArray(data.sections)) return data;
    return null;
  }

  let currentLayout = null;
  let currentRawText = "";

  const mainContent = document.getElementById("mainContent");
  const statusBar = document.getElementById("statusBar");
  const rawPanel = document.getElementById("rawPanel");
  const reloadBtn = document.getElementById("reloadBtn");
  const rawBtn = document.getElementById("rawBtn");

  function render(layout) {
    if (!layout || !layout.sections || !Array.isArray(layout.sections)) {
      mainContent.innerHTML = '<div class="empty">配置为空或格式不正确</div>';
      return;
    }

    const props = layout.props || {};
    const sections = layout.sections;
    let totalFields = 0;
    sections.forEach((sec) => {
      if (sec.fields) totalFields += sec.fields.length;
    });

    let html = "";
    sections.forEach((section, idx) => {
      html += renderSection(section, idx, props);
    });

    if (window.ManifestChildModules) {
      html += window.ManifestChildModules.renderChildModules(layout.child_modules);
    }

    mainContent.innerHTML = html;
    bindEvents();
    if (window.ManifestChildModules) {
      window.ManifestChildModules.bindChildModuleEvents(mainContent);
    }

    const timeStr = new Date().toTimeString().split(" ")[0];
    const childCount = Array.isArray(layout.child_modules) ? layout.child_modules.length : 0;
    statusBar.textContent = `module_key=manifest · 分区${sections.length}个 · 字段${totalFields}个 · 子表${childCount}个 · 配props ${Object.keys(props).length}个 · 拉取时间${timeStr}`;
  }

  function renderSection(section, idx, props) {
    const sectionKey = section.key || `section_${idx}`;
    const sectionLabel = section.label || sectionKey;
    const fields = section.fields || [];
    const body = fields.map((fieldKey) => renderField(fieldKey, props[fieldKey])).join("");
    return `
      <div class="section" data-section-key="${escapeHtml(sectionKey)}">
        <div class="section-header" data-action="toggle">
          <span>${escapeHtml(sectionLabel)}</span>
          <span class="arrow">▼</span>
        </div>
        <div class="section-body">${body}</div>
      </div>
    `;
  }

  function renderField(fieldKey, fieldProps) {
    const hasProps = !!fieldProps;
    const label = fieldProps?.label || null;
    const displayLabel = label || fieldKey;
    const unlabeledMark = label ? "" : '<span class="unlabeled">未配label</span>';
    const badge = hasProps ? '<span class="badge">配置</span>' : '<span class="badge">默认</span>';
    return `
      <div class="field-item" data-field-key="${escapeHtml(fieldKey)}">
        <div class="field-label">
          <span>${escapeHtml(displayLabel)}</span>
          ${unlabeledMark}
          ${badge}
        </div>
        ${renderControl(fieldKey, fieldProps)}
      </div>
    `;
  }

  function renderControl(fieldKey, fieldProps) {
    const inputKind = fieldProps?.input_kind;
    const reference = fieldProps?.reference;
    if (inputKind === "select" && Array.isArray(fieldProps.options)) {
      const optionsHtml = fieldProps.options.map((opt) => (
        `<div class="select-option" data-value="${escapeHtml(opt)}">${escapeHtml(opt)}</div>`
      )).join("");
      return `
        <div class="select-wrapper">
          <input class="field-control select-input" readonly placeholder="点击选择" value="" data-field="${escapeHtml(fieldKey)}">
          <div class="select-panel">${optionsHtml}</div>
        </div>
      `;
    }
    if (reference && reference.enabled) {
      return `
        <input class="field-control reference-input" autocomplete="off" placeholder="输入以联想"
          data-field="${escapeHtml(fieldKey)}" data-target-table="${escapeHtml(reference.target_table || "")}"
          data-carry-enabled="${reference.carry_enabled ? "true" : "false"}"
          data-carry-fields='${escapeHtml(JSON.stringify(reference.carry_fields || []))}'
          data-display-field="${escapeHtml(reference.target_display_field || "")}"
          data-key-field="${escapeHtml(reference.target_key_field || "")}">
        <div class="reference-hint" data-hint-for="${escapeHtml(fieldKey)}"></div>
      `;
    }
    return `<input class="field-control" type="text" data-field="${escapeHtml(fieldKey)}">`;
  }

  function bindEvents() {
    document.querySelectorAll(".section-header").forEach((header) => {
      header.addEventListener("click", function() {
        this.closest(".section").classList.toggle("collapsed");
      });
    });

    document.querySelectorAll(".select-wrapper").forEach((wrapper) => {
      const input = wrapper.querySelector(".select-input");
      const panel = wrapper.querySelector(".select-panel");
      if (!input || !panel) return;

      input.addEventListener("click", (e) => {
        e.stopPropagation();
        document.querySelectorAll(".select-panel.active").forEach((p) => {
          if (p !== panel) p.classList.remove("active");
        });
        panel.classList.toggle("active");
      });

      panel.querySelectorAll(".select-option").forEach((opt) => {
        opt.addEventListener("click", (e) => {
          e.stopPropagation();
          input.value = opt.getAttribute("data-value") || "";
          panel.classList.remove("active");
        });
      });
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".select-wrapper")) {
        document.querySelectorAll(".select-panel.active").forEach((p) => p.classList.remove("active"));
      }
    });

    document.querySelectorAll(".reference-input").forEach(bindReferenceInput);
  }

  function bindReferenceInput(input) {
    let debounceTimer;
    input.addEventListener("input", function() {
      const query = this.value.trim();
      const fieldKey = this.getAttribute("data-field");
      const targetTable = this.getAttribute("data-target-table");
      const hintEl = document.querySelector(`[data-hint-for="${CSS.escape(fieldKey)}"]`);
      if (!query) {
        if (hintEl) hintEl.textContent = "";
        return;
      }
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        fetchReference(this, query, targetTable, hintEl);
      }, 300);
    });
  }

  function fetchReference(input, query, targetTable, hintEl) {
    fetch(`/api/db/${targetTable}?q=${encodeURIComponent(query)}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => applyReferenceResult(input, data, hintEl))
      .catch(() => {
        if (hintEl) hintEl.textContent = `联想接口未接:${targetTable}`;
      });
  }

  function applyReferenceResult(input, data, hintEl) {
    const list = Array.isArray(data) ? data : (data.data || []);
    if (!list.length) {
      if (hintEl) hintEl.textContent = "无匹配候选";
      return;
    }

    const first = list[0];
    const displayField = input.getAttribute("data-display-field") || "name";
    const displayVal = first[displayField] || first.name || JSON.stringify(first);
    input.value = displayVal;

    if (input.getAttribute("data-carry-enabled") === "true") {
      const carryFields = JSON.parse(input.getAttribute("data-carry-fields") || "[]");
      carryFields.forEach((cf) => {
        const targetVal = first[cf.target_field] || "";
        const targetInput = document.querySelector(`[data-field="${CSS.escape(cf.local_field)}"]`);
        if (targetInput) targetInput.value = targetVal;
      });
    }
    if (hintEl) hintEl.textContent = `已选: ${displayVal}`;
  }

  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    }[m]));
  }

  async function loadConfig() {
    mainContent.innerHTML = '<div class="loading">正在加载配置...</div>';
    statusBar.textContent = "加载中...";
    try {
      const res = await fetch("/api/db/field-layout?module_key=manifest", {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status} ${errText}`);
      }
      const layout = extractLayout(await res.json());
      if (!layout) throw new Error("配置格式无法识别");
      currentLayout = layout;
      currentRawText = JSON.stringify(layout, null, 2);
      render(layout);
      rawPanel.textContent = currentRawText;
    } catch (err) {
      mainContent.innerHTML = `<div class="error">加载失败: ${escapeHtml(err.message)}</div>`;
      statusBar.textContent = "加载失败";
      rawPanel.textContent = "";
    }
  }

  reloadBtn.addEventListener("click", loadConfig);
  rawBtn.addEventListener("click", function() {
    rawPanel.classList.toggle("visible");
    if (rawPanel.classList.contains("visible") && currentRawText) {
      rawPanel.textContent = currentRawText;
    }
  });

  loadConfig();
  if (window.parent !== window) window.parent.postMessage({ type: "sanlyn:module-ready", title: "舱单配置", url: location.pathname + location.search }, location.origin);
})();
