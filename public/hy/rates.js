(function () {
  var state = { rows: [], units: [], total: 0, expanded: {}, selected: {} };
  var els = {};

  function $(id) { return document.getElementById(id); }
  function val(id) { return ($(id).value || "").replace(/^\s+|\s+$/g, ""); }
  function dash(v) { return v == null || v === "" ? "-" : String(v); }
  function esc(value) {
    return dash(value).replace(/[&<>"']/g, function (ch) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch];
    });
  }
  function attr(value) { return esc(value); }
  function dateOnly(value) { return value ? String(value).slice(0, 10) : ""; }
  function price(value) { return value == null || value === "" ? "-" : value; }
  function token() { return localStorage.getItem("sanlyn_jwt") || localStorage.getItem("sanlyn_token") || localStorage.getItem("token") || ""; }
  function headers() { var h = {}, t = token(); if (t) h.Authorization = "Bearer " + t; return h; }

  function params() {
    var pairs = [["limit", "200"], ["offset", "0"]];
    [["pol", val("pol")], ["pod", val("pod")], ["carrier", val("carrier")],
      ["unit", val("unit")], ["expired", val("expired")]].forEach(function (item) {
      if (item[1]) pairs.push(item);
    });
    return pairs.map(function (item) {
      return encodeURIComponent(item[0]) + "=" + encodeURIComponent(item[1]);
    }).join("&");
  }

  function firstFee(row) {
    var fees = row.fees || [];
    if (!fees.length) return null;
    return fees.slice().sort(function (a, b) {
      return Number(a.seq || 0) - Number(b.seq || 0);
    })[0];
  }

  function syncUnitOptions(units) {
    var keep = val("unit");
    var html = '<option value="">全部</option>';
    units.forEach(function (unit) {
      html += '<option value="' + attr(unit) + '">' + esc(unit) + '</option>';
    });
    els.unit.innerHTML = html;
    els.unit.value = keep;
  }

  function renderHead() {
    var html = "<thead><tr>";
    var span = state.units.length || 1;
    html += '<th class="mid" rowspan="2">勾选</th>';
    html += '<th class="mid" rowspan="2"></th>';
    html += '<th class="mid" rowspan="2">序号</th>';
    html += '<th rowspan="2">起运港</th><th rowspan="2">目的港</th><th rowspan="2">中转港</th>';
    html += '<th rowspan="2">船公司</th><th class="mid" colspan="' + span + '">运价</th>';
    html += '<th rowspan="2">航程</th><th rowspan="2">有效期结束</th><th rowspan="2">备注</th>';
    html += '</tr><tr class="sub">';
    if (state.units.length) {
      state.units.forEach(function (unit) { html += '<th class="mid">' + esc(unit) + '</th>'; });
    } else {
      html += '<th class="mid">-</th>';
    }
    html += "</tr></thead>";
    return html;
  }

  function rateCells(fee) {
    var html = "";
    state.units.forEach(function (unit) {
      var cell = fee && fee.cells ? fee.cells[unit] : null;
      var hasMargin = fee ? fee.has_margin !== false : true;
      var cls = hasMargin ? "cell-sell" : "cell-cost";
      var title = hasMargin ? "卖价" : "成本价";
      html += '<td class="num ' + cls + '" title="' + title + '">' + esc(cell ? price(cell.sell) : "-") + "</td>";
    });
    if (!state.units.length) html += '<td class="mid">-</td>';
    return html;
  }

  function renderDetail(row) {
    var colCount = 10 + (state.units.length || 1);
    var html = '<tr class="detail"><td colspan="' + colCount + '"><table><thead><tr>';
    html += '<th>费用名称</th><th>币种</th><th class="mid">序号</th>';
    state.units.forEach(function (unit) { html += '<th class="mid">' + esc(unit) + '</th>'; });
    html += '</tr></thead><tbody>';
    (row.fees || []).forEach(function (fee) {
      html += "<tr><td>" + esc(fee.fee_name) + "</td><td>" + esc(fee.currency) + "</td><td class=\"mid\">" + esc(fee.seq) + "</td>";
      state.units.forEach(function (unit) {
        var cell = fee.cells ? fee.cells[unit] : null;
        var hasMargin = fee.has_margin !== false;
        var cls = hasMargin ? "cell-sell" : "cell-cost";
        var title = hasMargin ? "卖价" : "成本价";
        html += '<td class="num ' + cls + '" title="' + title + '">' + esc(cell ? price(cell.sell) : "-") + "</td>";
      });
      html += "</tr>";
    });
    if (!(row.fees || []).length) html += '<tr><td colspan="' + (3 + state.units.length) + '">没有费用明细</td></tr>';
    html += "</tbody></table></td></tr>";
    return html;
  }

  function renderBody() {
    var html = "<tbody>";
    state.rows.forEach(function (row, idx) {
      var fee = firstFee(row);
      var rowClass = row.expired ? ' class="row-expired"' : "";
      var checked = state.selected[row.id] ? " checked" : "";
      var expanded = state.expanded[row.id];
      html += "<tr" + rowClass + ">";
      html += '<td class="mid"><input type="checkbox" class="sel" data-id="' + attr(row.id) + '"' + checked + "></td>";
      html += '<td class="mid"><button class="expand" type="button" data-id="' + attr(row.id) + '">' + (expanded ? "v" : ">") + "</button></td>";
      html += '<td class="mid">' + esc(idx + 1) + "</td>";
      html += "<td>" + esc(row.pol) + "</td><td>" + esc(row.pod) + "</td><td>" + esc(row.via) + "</td>";
      html += "<td>" + esc(row.carrier) + "</td>" + rateCells(fee);
      html += "<td>" + esc(row.transit_days) + "</td><td>" + esc(dateOnly(row.valid_to)) + "</td><td>" + esc(row.remarks) + "</td>";
      html += "</tr>";
      if (expanded) html += renderDetail(row);
    });
    html += "</tbody>";
    return html;
  }

  function render() {
    els.count.textContent = "共 " + state.total + " 条";
    if (!state.rows.length) {
      els.grid.innerHTML = '<div class="empty">没有数据</div>';
      return;
    }
    els.grid.innerHTML = "<table>" + renderHead() + renderBody() + "</table>";
  }

  function load() {
    els.msg.textContent = "";
    els.grid.innerHTML = '<div class="empty">加载中</div>';
    fetch("/api/db/hy-rates?" + params(), { credentials: "same-origin", headers: headers() })
      .then(function (res) { return res.json().then(function (data) { return { ok: res.ok, data: data }; }); })
      .then(function (pack) {
        if (!pack.ok || !pack.data.success) throw new Error(pack.data.error || "接口失败");
        state.rows = pack.data.rows || [];
        state.units = pack.data.charge_units || [];
        state.total = Number(pack.data.total || state.rows.length || 0);
        syncUnitOptions(state.units);
        render();
      })
      .catch(function (err) {
        state.rows = [];
        state.total = 0;
        els.count.textContent = "共 0 条";
        els.msg.textContent = err.message || "接口失败";
        els.grid.innerHTML = '<div class="empty">没有数据</div>';
      });
  }

  function selectedRows() {
    return state.rows.filter(function (row) { return state.selected[row.id]; });
  }

  function quoteLine(row) {
    var fee = firstFee(row) || { cells: {} };
    var fields = [fee.fee_name, row.pol, row.pod, fee.currency || row.currency];
    state.units.forEach(function (unit) {
      var cell = fee.cells ? fee.cells[unit] : null;
      fields.push(cell ? price(cell.sell) : "");
    });
    fields.push(row.via, row.carrier, dateOnly(row.valid_from) + "~" + dateOnly(row.valid_to), row.transit_days, row.remarks);
    return fields.map(dash).join(" / ");
  }

  function openQuote() {
    var rows = selectedRows();
    els.quoteText.value = rows.map(quoteLine).join("\n");
    els.copyMsg.textContent = rows.length ? "" : "未勾选运价";
    els.quoteModal.style.display = "flex";
  }

  function copyQuote() {
    var text = els.quoteText.value;
    function fallback() {
      els.quoteText.focus();
      els.quoteText.select();
      els.copyMsg.textContent = "已选中文本";
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        els.copyMsg.textContent = "已复制";
      }, fallback);
    } else {
      fallback();
    }
  }

  function bind() {
    els.filters.addEventListener("submit", function (ev) {
      ev.preventDefault();
      state.expanded = {};
      state.selected = {};
      load();
    });
    els.reset.addEventListener("click", function () {
      els.filters.reset();
      state.expanded = {};
      state.selected = {};
      load();
    });
    els.grid.addEventListener("click", function (ev) {
      var btn = ev.target.closest ? ev.target.closest(".expand") : null;
      if (!btn) return;
      var id = btn.getAttribute("data-id");
      state.expanded[id] = !state.expanded[id];
      render();
    });
    els.grid.addEventListener("change", function (ev) {
      if (ev.target.className.indexOf("sel") === -1) return;
      state.selected[ev.target.getAttribute("data-id")] = ev.target.checked;
    });
    els.quoteBtn.addEventListener("click", openQuote);
    els.closeModal.addEventListener("click", function () { els.quoteModal.style.display = "none"; });
    els.copyBtn.addEventListener("click", copyQuote);
  }

  function init() {
    ["filters", "reset", "unit", "count", "msg", "grid", "quoteBtn", "quoteModal",
      "closeModal", "quoteText", "copyBtn", "copyMsg"].forEach(function (id) { els[id] = $(id); });
    bind();
    load();
  }

  init();
}());
