/* customs-declaration-editor.js — 让官方报关单变成"可编辑模版"(自安装外壳)
   复用 doc-editor 的自托管库 + WYSIWYG PDF/Excel + 保存草稿。只加编辑/导出外壳,不碰数据渲染。
   customs-declaration-form.js 只需在 </body> 前加一行 <script src>。 */
(function () {
  var VENDOR = "/templates/vendor/";
  function qp(k) { try { return new URLSearchParams(location.search).get(k) || ""; } catch (e) { return ""; } }
  function sheet() { return document.querySelector(".sheet") || document.body; }
  function baseName() { return "报关单_" + (qp("bl") || qp("id") || qp("shipment_no") || "draft"); }
  function draftKey() { return "customs_decl_draft_" + (qp("bl") || qp("id") || qp("shipment_no") || "manual"); }
  function toast(msg) {
    var b = document.getElementById("_cdToast");
    if (!b) { b = document.createElement("div"); b.id = "_cdToast"; b.className = "no-print";
      b.style.cssText = "position:fixed;top:52px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,.3)";
      document.body.appendChild(b); }
    b.textContent = msg; b.style.display = "block";
    setTimeout(function () { b.style.display = "none"; }, 1600);
  }

  // ── self-hosted lib loader (China-safe, same-origin) ──
  function loadScript(src, cb, onerr) {
    var ex = document.querySelector('script[data-vsrc="' + src + '"]');
    if (ex) { if (ex.getAttribute("data-loaded") === "1") return cb(); ex.addEventListener("load", cb); ex.addEventListener("error", onerr || function () {}); return; }
    var s = document.createElement("script"); s.src = src; s.setAttribute("data-vsrc", src);
    s.onload = function () { s.setAttribute("data-loaded", "1"); cb(); }; s.onerror = onerr || function () {}; document.head.appendChild(s);
  }
  function jsPDFctor() { return (window.jspdf && window.jspdf.jsPDF) || window.jsPDF || null; }
  function ensureLibs(names, cb, onerr) {
    var map = { html2canvas: { has: function () { return !!window.html2canvas; }, f: "html2canvas.min.js" },
                xlsx: { has: function () { return !!window.XLSX; }, f: "xlsx.full.min.js" },
                jspdf: { has: function () { return !!jsPDFctor(); }, f: "jspdf.umd.min.js" } };
    var need = names.filter(function (n) { return !map[n].has(); });
    var i = 0; (function nx() { if (i >= need.length) return cb(); loadScript(VENDOR + map[need[i]].f, function () { i++; nx(); }, onerr); })();
  }

  window.cdPrint = function () { window.print(); };
  window.cdSaveDraft = function () { try { localStorage.setItem(draftKey(), JSON.stringify({ html: sheet().innerHTML, ts: Date.now() })); toast("✓ 草稿已保存"); } catch (e) { toast("草稿保存失败"); } };
  function restoreDraft() { try { var d = JSON.parse(localStorage.getItem(draftKey()) || "null"); if (d && d.html && confirm("发现本地草稿，是否恢复？")) { sheet().innerHTML = d.html; makeEditable(); } } catch (e) {} }

  // ── WYSIWYG PDF(A4 横向,截编辑后的DOM) ──
  window.cdDownloadPdf = function () {
    function run() {
      window.html2canvas(sheet(), { scale: 2, useCORS: true, backgroundColor: "#fff", logging: false }).then(function (canvas) {
        var JsPDF = jsPDFctor();
        if (!JsPDF) { toast("PDF库缺失,改用打印"); return window.print(); }
        var pdf = new JsPDF("l", "mm", "a4"), pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
        var imgW = pw, imgH = canvas.height * pw / canvas.width, img = canvas.toDataURL("image/jpeg", 0.95);
        if (imgH <= ph) { pdf.addImage(img, "JPEG", 0, 0, imgW, imgH); }
        else { var pos = 0; while (pos < imgH - 0.5) { pdf.addImage(img, "JPEG", 0, -pos, imgW, imgH); pos += ph; if (pos < imgH - 0.5) pdf.addPage(); } }
        pdf.save(baseName() + ".pdf");
      }).catch(function () { toast("PDF生成失败,改用打印"); window.print(); });
    }
    ensureLibs(["html2canvas", "jspdf"], run, function () { toast("PDF库加载失败,改用打印"); window.print(); });
  };

  // ── Excel: 把报关单里所有表格原样倒进一个 sheet ──
  window.cdExportExcel = function () {
    function run() {
      try {
        var aoa = [];
        document.querySelectorAll(".sheet table").forEach(function (tbl) {
          [].forEach.call(tbl.rows, function (tr) { aoa.push([].map.call(tr.cells, function (td) { return (td.textContent || "").replace(/\s+/g, " ").trim(); })); });
          aoa.push([]);
        });
        var wb = window.XLSX.utils.book_new(), ws = window.XLSX.utils.aoa_to_sheet(aoa);
        window.XLSX.utils.book_append_sheet(wb, ws, "报关单");
        window.XLSX.writeFile(wb, baseName() + ".xlsx");
      } catch (e) { toast("导出失败: " + e.message); }
    }
    ensureLibs(["xlsx"], run, function () { toast("Excel库加载失败"); });
  };

  // ── 标记可编辑字段(抬头值 + 商品表数据格),不动标签/表头 ──
  function makeEditable() {
    document.querySelectorAll(".sheet .val").forEach(function (el) { el.setAttribute("contenteditable", "true"); el.classList.add("cd-ed"); });
    document.querySelectorAll(".sheet table.goods td").forEach(function (el) { el.setAttribute("contenteditable", "true"); el.classList.add("cd-ed"); });
  }

  function injectUI() {
    var st = document.createElement("style");
    st.textContent = ".cd-toolbar{position:sticky;top:0;z-index:1000;display:flex;gap:8px;flex-wrap:wrap;padding:8px 10px;background:#0f172a;font-family:Arial,sans-serif}.cd-toolbar button{padding:7px 13px;border:0;border-radius:7px;font-size:13px;font-weight:700;color:#fff;cursor:pointer}.cd-ed[contenteditable]:focus{outline:2px solid #38bdf8;background:#fefce8}@media print{.cd-toolbar,.no-print{display:none!important}}";
    document.head.appendChild(st);
    var tb = document.createElement("div"); tb.className = "cd-toolbar no-print";
    tb.innerHTML =
      '<button style="background:#0369a1" onclick="cdPrint()">🖨 打印</button>' +
      '<button style="background:#7c3aed" onclick="cdSaveDraft()">💾 保存草稿</button>' +
      '<button style="background:#be123c" onclick="cdDownloadPdf()">📄 PDF下载</button>' +
      '<button style="background:#15803d" onclick="cdExportExcel()">📊 Excel下载</button>';
    document.body.insertBefore(tb, document.body.firstChild);
  }

  function boot() { injectUI(); makeEditable(); restoreDraft(); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
