// /api/db/customs-doc-pdf.js
// GET ?contract=xxx    → 按合同号查报关资料包
// GET ?shipment=xxx    → 按出运编号查报关资料包
// 返回 text/html 打印就绪页面（报关资料清单 + 单据状态）

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  // S17.3 P0: 报关资料需要登录，防止知道 shipment_no 即可下载
  if (!requireAuth(req, res)) return;

  const { contract, shipment } = req.query;
  if (!contract && !shipment) return res.status(400).send("<h1>Missing contract or shipment param</h1>");

  try {
    const pool = getPool();

    // ── Fetch customs_data ──
    let cSql = "SELECT * FROM customs_data WHERE 1=1";
    const cVals = [];
    if (contract)  { cVals.push(contract);  cSql += ` AND contract_no = $${cVals.length}`; }
    if (shipment)  { cVals.push(shipment);   cSql += ` AND shipment_no = $${cVals.length}`; }
    cSql += " ORDER BY updated_at DESC LIMIT 1";
    const cRes = await pool.query(cSql, cVals);
    const cd = cRes.rows[0] || null;

    // ── Fetch linked shipping plan ──
    let plan = null;
    const spKey = (cd && cd.shipment_no) || shipment;
    if (spKey) {
      const spRes = await pool.query(
        "SELECT * FROM shipping_plans WHERE shipment_no = $1 LIMIT 1", [spKey]
      );
      plan = spRes.rows[0] || null;
    }

    // ── Fetch linked order ──
    let order = null;
    const oKey = (cd && cd.contract_no) || contract;
    if (oKey) {
      const oRes = await pool.query(
        "SELECT *, raw FROM orders WHERE contract_no = $1 OR order_no = $1 OR bl_no = $1 LIMIT 1", [oKey]
      );
      order = oRes.rows[0] || null;
    }

    // ── Helpers ──
    const fmt     = v => (v == null || v === "") ? "—" : v;
    const fmtDate = v => v ? String(v).substring(0, 10) : "—";
    const fmtNum  = (v, dec = 2) => v != null ? Number(v).toLocaleString("zh-CN", { minimumFractionDigits: dec, maximumFractionDigits: dec }) : "—";

    const raw = (cd && cd.raw) || {};
    const oRaw = (order && order.raw) || {};
    const generatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

    // ── Document checklist definition ──
    const DOC_DEFS = [
      { key: "booking_note",         label: "订舱确认函",     labelEn: "Booking Confirmation",    icon: "📋", field: cd && cd.booking_note },
      { key: "customs_dec",          label: "报关单",         labelEn: "Customs Declaration",      icon: "📄", field: cd && cd.customs_dec },
      { key: "customs_dec_official", label: "海关放行通知",    labelEn: "Customs Release Notice",   icon: "✅", field: cd && cd.customs_dec_official },
      { key: "release_note",         label: "放货通知书",     labelEn: "Release Note",             icon: "📨", field: cd && cd.release_note },
      { key: "origin_cert",          label: "原产地证书",     labelEn: "Certificate of Origin",    icon: "🌐", field: cd && cd.origin_cert },
      { key: "quarantine_report",    label: "检疫证书",       labelEn: "Quarantine Certificate",   icon: "🔬", field: cd && cd.quarantine_report },
      { key: "bl_draft",             label: "提单草稿",       labelEn: "B/L Draft",                icon: "📝", field: cd && cd.bl_draft },
      { key: "bl_final",             label: "正本提单",       labelEn: "Bill of Lading (Final)",   icon: "🚢", field: cd && cd.bl_final },
      { key: "seal_photos",          label: "铅封照片",       labelEn: "Seal Photos",              icon: "🔒", field: cd && cd.seal_photos },
      { key: "factory_sign",         label: "工厂签收单",     labelEn: "Factory Receipt",          icon: "🏭", field: cd && cd.factory_sign },
      { key: "loading_details",      label: "装货明细",       labelEn: "Loading Details",          icon: "📦", field: cd && cd.loading_details },
    ];

    const uploaded = DOC_DEFS.filter(d => d.field);
    const missing  = DOC_DEFS.filter(d => !d.field);

    // ── Products from order ── 根治(2026-08-13 Damon"读OLI"): order_line_items(OLI) 是数量唯一真源。
    // 先读 OLI；只有 OLI 空才回退 orders.products（旧值可能是错的，如箱数 1440 而 OLI=1400）。
    let productSrc = [];
    if (order && order.id) {
      try {
        const liR = await pool.query(
          "SELECT sku, barcode, product_name, qty_ctn, size, unit_price FROM order_line_items WHERE order_id=$1 ORDER BY sort_order,id",
          [order.id]);
        productSrc = liR.rows.map(li => ({
          name: li.product_name, qty: Number(li.qty_ctn) || 0,
          barcode: li.barcode || li.sku, size: li.size, unitPrice: li.unit_price,
        }));
      } catch (e) { /* fall through to raw.products */ }
    }
    if (!productSrc.length) productSrc = Array.isArray(oRaw.products) ? oRaw.products : [];
    const products = productSrc.map(p => ({
      name:     p.name || p.productName || "—",
      qty:      p.qty  || p.quantity || "—",
      barcode:  p.barcode || p.sku || p.code || "—",
      spec:     p.size || p.spec || "",   // 规格读 size(75G X 100/CTN); raw.products无spec字段(2026-06-23修)
      price:    p.price || p.unitPrice || null,
    }));

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>报关资料清单 — ${fmt((cd && cd.customs_no) || contract || shipment)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif;
    font-size: 12px;
    color: #1a1a2e;
    background: #fff;
  }
  .page { max-width: 210mm; margin: 0 auto; padding: 16mm 14mm 12mm; }

  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 18px;
    padding-bottom: 12px;
    border-bottom: 2px solid #065f46;
  }
  .logo-block .company-name { font-size: 20px; font-weight: 800; color: #065f46; }
  .logo-block .company-sub  { font-size: 10px; color: #64748b; margin-top: 2px; }
  .doc-meta { text-align: right; }
  .doc-meta .doc-title  { font-size: 16px; font-weight: 700; color: #065f46; margin-bottom: 6px; }
  .doc-meta .ref-no     { font-family: monospace; font-size: 13px; font-weight: 700; color: #0f172a; background: #ecfdf5; padding: 3px 10px; border-radius: 4px; border: 1px solid #6ee7b7; display: inline-block; }
  .doc-meta .gen-time   { font-size: 9px; color: #94a3b8; margin-top: 4px; }

  .section { margin-bottom: 14px; }
  .section-title { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; color: #065f46; border-left: 3px solid #065f46; padding-left: 8px; margin-bottom: 8px; }

  .info-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; }
  .field { padding: 7px 10px; border: 0.5px solid #e2e8f0; }
  .field:nth-child(odd) { background: #f0fdf4; }
  .field .lbl { font-size: 9px; color: #64748b; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 3px; }
  .field .val { font-size: 12px; font-weight: 700; color: #0f172a; font-family: monospace; }
  .field .val.normal { font-family: inherit; }

  /* Doc checklist */
  .doc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  .doc-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 12px;
    border-radius: 7px;
    border: 1px solid;
  }
  .doc-item.ready { background: #f0fdf4; border-color: #86efac; }
  .doc-item.missing { background: #fff7ed; border-color: #fed7aa; }
  .doc-icon { font-size: 16px; flex-shrink: 0; }
  .doc-info .doc-name { font-size: 12px; font-weight: 700; color: #0f172a; }
  .doc-info .doc-name-en { font-size: 9px; color: #64748b; margin-top: 1px; }
  .doc-status { margin-left: auto; flex-shrink: 0; font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
  .status-ready   { background: #dcfce7; color: #15803d; border: 1px solid #86efac; }
  .status-missing { background: #ffedd5; color: #c2410c; border: 1px solid #fdba74; }

  /* Progress summary */
  .progress-bar-wrap { background: #e2e8f0; border-radius: 4px; height: 8px; overflow: hidden; margin: 8px 0; }
  .progress-bar-fill { height: 100%; border-radius: 4px; background: linear-gradient(90deg, #059669, #10b981); }

  /* Product table */
  table { width: 100%; border-collapse: collapse; font-size: 11px; }
  thead th { background: #065f46; color: #fff; padding: 7px 10px; text-align: left; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
  tbody tr { border-bottom: 0.5px solid #e2e8f0; }
  tbody tr:nth-child(even) { background: #f0fdf4; }
  tbody td { padding: 7px 10px; color: #1e293b; vertical-align: top; }
  .mono { font-family: monospace; font-weight: 700; }

  /* Sign area */
  .sig-area { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 20px; }
  .sig-box { border-top: 1px solid #cbd5e1; padding-top: 8px; }
  .sig-box .sig-lbl { font-size: 9px; color: #94a3b8; font-weight: 600; text-transform: uppercase; margin-bottom: 24px; }
  .sig-box .sig-line { height: 30px; border-bottom: 1px dashed #e2e8f0; }
  .sig-box .sig-sub  { font-size: 9px; color: #94a3b8; margin-top: 4px; }

  @media print {
    @page { size: A4; margin: 0; }
    body { padding: 0; }
    .page { padding: 12mm 12mm 10mm; max-width: none; }
    .no-print { display: none !important; }
    a { color: inherit !important; text-decoration: none !important; }
  }
  @media screen {
    body { background: #f1f5f9; }
    .page { background: #fff; box-shadow: 0 4px 32px rgba(0,0,0,0.12); margin: 20px auto; border-radius: 8px; }
    .print-btn { position: fixed; top: 20px; right: 20px; padding: 10px 20px; background: #065f46; color: #fff; border: none; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 16px rgba(6,95,70,0.4); z-index: 1000; font-family: "PingFang SC", "Microsoft YaHei", Arial, sans-serif; }
    .print-btn:hover { background: #047857; }
    .doc-link { text-decoration: none; }
  }
</style>
</head>
<body>

<button class="print-btn no-print" onclick="window.print()">🖨 打印 / 另存为PDF</button>

<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="logo-block">
      <div class="company-name">三林宠物</div>
      <div class="company-sub">Sanlyn Pet Products Co., Ltd.</div>
      <div class="company-sub" style="margin-top:4px;font-size:9px;color:#94a3b8">ai.sanlynos.com</div>
    </div>
    <div class="doc-meta">
      <div class="doc-title">报关资料清单</div>
      <div class="ref-no">${fmt((cd && cd.customs_no) || contract || shipment)}</div>
      <div class="gen-time">生成时间：${generatedAt}</div>
    </div>
  </div>

  <!-- Shipment Info -->
  <div class="section">
    <div class="section-title">📋 出运信息</div>
    <div class="info-grid">
      <div class="field">
        <div class="lbl">出运编号</div>
        <div class="val">${fmt((cd && cd.shipment_no) || shipment)}</div>
      </div>
      <div class="field">
        <div class="lbl">合同号</div>
        <div class="val">${fmt((cd && cd.contract_no) || (order && order.contract_no) || contract)}</div>
      </div>
      <div class="field">
        <div class="lbl">报关编号</div>
        <div class="val">${fmt(cd && cd.customs_no)}</div>
      </div>
      ${plan ? `
      <div class="field">
        <div class="lbl">提单号 B/L</div>
        <div class="val">${fmt(plan.bl_no)}</div>
      </div>
      <div class="field">
        <div class="lbl">船名 / 航次</div>
        <div class="val">${fmt(plan.vessel)} / ${fmt(plan.voyage)}</div>
      </div>
      <div class="field">
        <div class="lbl">ETD 开船日</div>
        <div class="val">${fmtDate(plan.etd)}</div>
      </div>
      <div class="field">
        <div class="lbl">装运港 POL</div>
        <div class="val">${fmt(plan.pol)}</div>
      </div>
      <div class="field">
        <div class="lbl">目的港 POD</div>
        <div class="val">${fmt(plan.pod)}</div>
      </div>
      <div class="field">
        <div class="lbl">柜型</div>
        <div class="val">${fmt(plan.container_type)}</div>
      </div>
      ` : ""}
      ${order ? `
      <div class="field">
        <div class="lbl">客户</div>
        <div class="val normal">${fmt(oRaw.companyNameEN || order.customer)}</div>
      </div>
      ` : ""}
    </div>
  </div>

  <!-- Document Progress -->
  <div class="section">
    <div class="section-title">📁 单据完整度</div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
      <span style="font-size:11px;color:#374151;font-weight:600">${uploaded.length} / ${DOC_DEFS.length} 已上传</span>
      <span style="font-size:11px;font-weight:700;color:${missing.length === 0 ? "#15803d" : "#c2410c"}">${missing.length === 0 ? "✅ 单据齐全" : `⚠ 缺 ${missing.length} 份`}</span>
    </div>
    <div class="progress-bar-wrap">
      <div class="progress-bar-fill" style="width:${Math.round((uploaded.length / DOC_DEFS.length) * 100)}%"></div>
    </div>
  </div>

  <!-- Doc Checklist -->
  <div class="section">
    <div class="section-title">📄 单据明细</div>
    <div class="doc-grid">
      ${DOC_DEFS.map(doc => {
        const isReady = !!doc.field;
        const fileUrl = doc.field;
        const isUrl = typeof fileUrl === "string" && (fileUrl.startsWith("http") || fileUrl.startsWith("//"));
        return `
        <div class="doc-item ${isReady ? "ready" : "missing"}">
          <div class="doc-icon">${doc.icon}</div>
          <div class="doc-info">
            <div class="doc-name">${doc.label}</div>
            <div class="doc-name-en">${doc.labelEn}</div>
            ${isReady && isUrl ? `<div style="font-size:9px;color:#059669;margin-top:2px">有文件</div>` : ""}
          </div>
          ${isReady
            ? (isUrl
              ? `<a href="${fileUrl}" target="_blank" class="doc-link no-print" style="margin-left:auto;flex-shrink:0;padding:3px 9px;background:#dcfce7;border:1px solid #86efac;border-radius:5px;font-size:10px;font-weight:700;color:#15803d">查看</a>
                 <span class="doc-status status-ready print-only" style="margin-left:auto">✓ 已上传</span>`
              : `<span class="doc-status status-ready" style="margin-left:auto">✓ 已上传</span>`)
            : `<span class="doc-status status-missing" style="margin-left:auto">待上传</span>`
          }
        </div>`;
      }).join("")}
    </div>
  </div>

  <!-- Products -->
  ${products.length > 0 ? `
  <div class="section">
    <div class="section-title">📦 装运商品</div>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>品名 Item Description</th>
          <th>规格 Spec</th>
          <th>条码 Barcode</th>
          <th style="text-align:right">数量 Qty</th>
          ${products.some(p => p.price) ? '<th style="text-align:right">单价 Unit Price</th>' : ""}
        </tr>
      </thead>
      <tbody>
        ${products.map((p, i) => `
        <tr>
          <td style="color:#94a3b8">${i + 1}</td>
          <td>${p.name}</td>
          <td style="color:#64748b;font-size:10px">${p.spec || "—"}</td>
          <td class="mono">${p.barcode}</td>
          <td style="text-align:right;font-weight:700">${p.qty}</td>
          ${products.some(px => px.price) ? `<td style="text-align:right;font-family:monospace">${p.price != null ? "$ " + Number(p.price).toFixed(2) : "—"}</td>` : ""}
        </tr>`).join("")}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="${products.some(p => p.price) ? 4 : 3}" style="font-weight:700;padding:7px 10px">合计</td>
          <td style="text-align:right;font-weight:800;font-family:monospace;padding:7px 10px">
            ${products.reduce((s, p) => s + (parseInt(p.qty) || 0), 0).toLocaleString()} 件
          </td>
          ${products.some(p => p.price) ? `<td style="text-align:right;font-weight:800;font-family:monospace;padding:7px 10px">
            $ ${products.reduce((s, p) => s + (p.price ? (parseFloat(p.price) * (parseInt(p.qty) || 0)) : 0), 0).toFixed(2)}
          </td>` : ""}
        </tr>
      </tfoot>
    </table>
  </div>
  ` : ""}

  <!-- Customs Raw Data (if any structured fields in raw) -->
  ${raw.hsCode || raw.hs_code ? `
  <div class="section">
    <div class="section-title">🔖 海关信息</div>
    <div class="info-grid">
      ${raw.hsCode || raw.hs_code ? `<div class="field"><div class="lbl">HS编码</div><div class="val">${raw.hsCode || raw.hs_code}</div></div>` : ""}
      ${raw.customsValue ? `<div class="field"><div class="lbl">报关价值</div><div class="val">USD ${fmtNum(raw.customsValue)}</div></div>` : ""}
      ${raw.tradeTerms ? `<div class="field"><div class="lbl">贸易术语</div><div class="val">${raw.tradeTerms}</div></div>` : ""}
      ${raw.cargoType ? `<div class="field"><div class="lbl">货物类型</div><div class="val normal">${raw.cargoType}</div></div>` : ""}
    </div>
  </div>
  ` : ""}

  <!-- Signature -->
  <div class="sig-area">
    <div class="sig-box">
      <div class="sig-lbl">制单 / 报关员</div>
      <div class="sig-line"></div>
      <div class="sig-sub">日期：_______________</div>
    </div>
    <div class="sig-box">
      <div class="sig-lbl">审核确认</div>
      <div class="sig-line"></div>
      <div class="sig-sub">日期：_______________</div>
    </div>
  </div>

  <!-- Footer -->
  <div style="margin-top:20px;padding-top:10px;border-top:0.5px solid #e2e8f0;display:flex;justify-content:space-between;font-size:9px;color:#94a3b8">
    <span>三林宠物 Sanlyn Pet Products Co., Ltd. | ai.sanlynos.com</span>
    <span>生成于 ${generatedAt}</span>
  </div>

</div>

<script>
  const params = new URLSearchParams(location.search);
  if (params.get('print') === '1') {
    window.onload = () => setTimeout(() => window.print(), 500);
  }
</script>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    return res.status(200).send(html);

  } catch (err) {
    console.error("[customs-doc-pdf]", err);
    return res.status(500).send(`<h1>Error: ${err.message}</h1>`);
  }
}
