(function() {
  const state = new Map();
  let activeModules = [];

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#39;",
    }[m]));
  }

  function injectStyles() {
    if (document.getElementById("manifestChildModuleStyles")) return;
    const style = document.createElement("style");
    style.id = "manifestChildModuleStyles";
    style.textContent = `
      .child-modules { margin-top: 20px; }
      .child-module {
        border: 1px solid #d1d5db;
        border-radius: 4px;
        background: #ffffff;
        margin-bottom: 20px;
      }
      .child-module-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 10px 12px;
        border-bottom: 1px solid #e5e7eb;
        background: #f8fafc;
      }
      .child-module-title {
        min-width: 0;
        font-size: 14px;
        font-weight: 600;
        color: #111827;
      }
      .child-module-meta {
        display: block;
        margin-top: 2px;
        font-size: 11px;
        font-weight: 400;
        color: #6b7280;
      }
      .child-module-tools {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      .child-module-count {
        font-size: 12px;
        color: #6b7280;
      }
      .child-table-wrap {
        overflow-x: auto;
      }
      .child-table {
        width: 100%;
        min-width: 720px;
        border-collapse: collapse;
        table-layout: fixed;
      }
      .child-table th,
      .child-table td {
        border-bottom: 1px solid #e5e7eb;
        border-right: 1px solid #f3f4f6;
        padding: 6px;
        vertical-align: top;
      }
      .child-table th {
        background: #ffffff;
        color: #374151;
        font-size: 12px;
        font-weight: 600;
        text-align: left;
        white-space: nowrap;
      }
      .child-table tr:last-child td {
        border-bottom: 0;
      }
      .child-cell-input {
        width: 100%;
        height: 30px;
        border: 1px solid #d7dbe0;
        border-radius: 2px;
        padding: 0 8px;
        font-size: 13px;
        color: #111827;
        background: #ffffff;
        outline: none;
      }
      .child-cell-input:focus {
        border-color: #6b74a8;
      }
      .child-row-index {
        width: 44px;
        color: #6b7280;
        font-size: 12px;
        text-align: center;
        padding-top: 12px;
      }
      .child-row-actions {
        width: 62px;
        text-align: center;
      }
      .child-empty {
        padding: 18px;
        color: #6b7280;
        font-size: 13px;
        text-align: center;
        border-top: 1px solid #e5e7eb;
      }
      .child-required {
        color: #b91c1c;
      }
      @media (max-width: 768px) {
        .child-module-header {
          align-items: flex-start;
          flex-direction: column;
        }
      }
    `;
    document.head.appendChild(style);
  }

  function normalizeModules(childModules) {
    return Array.isArray(childModules) ? childModules : [];
  }

  function makeEmptyRow(columns) {
    return columns.reduce((row, column) => {
      row[column.field] = "";
      return row;
    }, {});
  }

  function ensureModuleState(moduleConfig) {
    const key = String(moduleConfig.key || "");
    const columns = Array.isArray(moduleConfig.columns) ? moduleConfig.columns : [];
    const minRows = Number.isFinite(Number(moduleConfig.min_rows))
      ? Math.max(0, Number(moduleConfig.min_rows))
      : 0;
    const existing = state.get(key);
    if (existing && existing.config === moduleConfig) return existing;

    const rows = existing ? existing.rows : [];
    while (rows.length < minRows) rows.push(makeEmptyRow(columns));
    const next = { config: moduleConfig, rows };
    state.set(key, next);
    return next;
  }

  function renderColumnHeader(column) {
    const width = Number(column.width) > 0 ? ` style="width:${Number(column.width)}px"` : "";
    const required = column.required ? ' <span class="child-required">*</span>' : "";
    return `<th${width}>${escapeHtml(column.label)}${required}</th>`;
  }

  function inputType(inputKind) {
    if (inputKind === "number") return "number";
    if (inputKind === "date") return "date";
    return "text";
  }

  function renderCell(moduleKey, rowIndex, column, row) {
    const field = String(column.field || "");
    const value = row[field] ?? "";
    const attrs = [
      `class="child-cell-input"`,
      `data-child-action="edit-cell"`,
      `data-module-key="${escapeHtml(moduleKey)}"`,
      `data-row-index="${rowIndex}"`,
      `data-field="${escapeHtml(field)}"`,
      `value="${escapeHtml(value)}"`,
    ];
    if (column.required) attrs.push("required");

    if (column.input_kind === "select" && Array.isArray(column.options)) {
      const options = column.options.map((option) => {
        const selected = String(option) === String(value) ? " selected" : "";
        return `<option value="${escapeHtml(option)}"${selected}>${escapeHtml(option)}</option>`;
      }).join("");
      return `<select ${attrs.join(" ")}><option value=""></option>${options}</select>`;
    }

    attrs.push(`type="${inputType(column.input_kind)}"`);
    return `<input ${attrs.join(" ")}>`;
  }

  function renderRows(moduleConfig, moduleState) {
    const moduleKey = String(moduleConfig.key || "");
    const columns = Array.isArray(moduleConfig.columns) ? moduleConfig.columns : [];
    const minRows = Number(moduleConfig.min_rows || 0);
    return moduleState.rows.map((row, rowIndex) => {
      const cells = columns.map((column) => (
        `<td>${renderCell(moduleKey, rowIndex, column, row)}</td>`
      )).join("");
      const deleteDisabled = moduleState.rows.length <= minRows ? " disabled" : "";
      return `
        <tr>
          <td class="child-row-index">${rowIndex + 1}</td>
          ${cells}
          <td class="child-row-actions">
            <button class="btn" data-child-action="delete-row" data-module-key="${escapeHtml(moduleKey)}" data-row-index="${rowIndex}"${deleteDisabled}>删除</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  function renderModule(moduleConfig) {
    const moduleKey = String(moduleConfig.key || "");
    const columns = Array.isArray(moduleConfig.columns) ? moduleConfig.columns : [];
    const moduleState = ensureModuleState(moduleConfig);
    const maxRows = Number.isFinite(Number(moduleConfig.max_rows))
      ? Number(moduleConfig.max_rows)
      : 999;
    const addDisabled = moduleState.rows.length >= maxRows ? " disabled" : "";
    const headers = columns.map(renderColumnHeader).join("");
    const rows = renderRows(moduleConfig, moduleState);
    const empty = rows ? "" : '<div class="child-empty">暂无明细行</div>';

    return `
      <div class="child-module" data-child-module="${escapeHtml(moduleKey)}">
        <div class="child-module-header">
          <div class="child-module-title">
            ${escapeHtml(moduleConfig.label || moduleKey)}
            <span class="child-module-meta">${escapeHtml(moduleConfig.table)} · ${escapeHtml(moduleConfig.parent_key)}</span>
          </div>
          <div class="child-module-tools">
            <span class="child-module-count">${moduleState.rows.length}/${maxRows}</span>
            <button class="btn" data-child-action="add-row" data-module-key="${escapeHtml(moduleKey)}"${addDisabled}>新增行</button>
          </div>
        </div>
        <div class="child-table-wrap">
          <table class="child-table">
            <thead>
              <tr>
                <th style="width:44px">#</th>
                ${headers}
                <th style="width:62px">操作</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          ${empty}
        </div>
      </div>
    `;
  }

  function renderChildModules(childModules) {
    injectStyles();
    const modules = normalizeModules(childModules);
    activeModules = modules;
    if (!modules.length) return "";
    return `<div class="child-modules" data-child-modules-root>${modules.map(renderModule).join("")}</div>`;
  }

  function rerenderRoot(root) {
    const host = root.querySelector("[data-child-modules-root]");
    if (!host) return;
    host.outerHTML = renderChildModules(activeModules);
    bindChildModuleEvents(root);
  }

  function bindChildModuleEvents(root) {
    const host = root.querySelector("[data-child-modules-root]");
    if (!host || host.dataset.bound === "true") return;
    host.dataset.bound = "true";
    host.addEventListener("click", (event) => {
      const target = event.target.closest("[data-child-action]");
      if (!target) return;
      const action = target.dataset.childAction;
      const moduleKey = target.dataset.moduleKey;
      const entry = state.get(moduleKey);
      if (!entry) return;
      const columns = Array.isArray(entry.config.columns) ? entry.config.columns : [];
      if (action === "add-row") {
        const maxRows = Number.isFinite(Number(entry.config.max_rows))
          ? Number(entry.config.max_rows)
          : 999;
        if (entry.rows.length >= maxRows) return;
        entry.rows.push(makeEmptyRow(columns));
        rerenderRoot(root);
      }
      if (action === "delete-row") {
        const rowIndex = Number(target.dataset.rowIndex);
        const minRows = Number(entry.config.min_rows || 0);
        if (Number.isInteger(rowIndex) && entry.rows.length > minRows) {
          entry.rows.splice(rowIndex, 1);
          rerenderRoot(root);
        }
      }
    });
    function updateCell(event) {
      const target = event.target.closest('[data-child-action="edit-cell"]');
      if (!target) return;
      const entry = state.get(target.dataset.moduleKey);
      const rowIndex = Number(target.dataset.rowIndex);
      const field = target.dataset.field;
      if (!entry || !Number.isInteger(rowIndex) || !field || !entry.rows[rowIndex]) return;
      entry.rows[rowIndex][field] = target.value;
    }
    host.addEventListener("input", updateCell);
    host.addEventListener("change", updateCell);
  }

  function getState() {
    return Array.from(state.entries()).reduce((all, [key, entry]) => {
      all[key] = entry.rows.map((row) => ({ ...row }));
      return all;
    }, {});
  }

  window.ManifestChildModules = {
    renderChildModules,
    bindChildModuleEvents,
    getState,
  };
})();
