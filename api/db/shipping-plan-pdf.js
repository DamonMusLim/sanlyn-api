// /api/db/shipping-plan-pdf.js
// GET ?id=xxx           → 海运计划确认书 HTML（打印就绪）
// GET ?id=xxx&type=si   → Shipping Instructions（英文版）
// GET ?id=xxx&type=cost → 内部成本核算单（含成本价，admin only）
//
// 返回 text/html，浏览器直接打开可 Ctrl+P 打印/另存为PDF

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const { id, type = "confirm" } = req.query;
  if (!id) return res.status(400).send("<h1>Missing id</h1>");

  try {
    const pool = getPool();

    // ── Fetch shipping plan ──
    const planRes = await pool.query(
      "SELECT * FROM shipping_plans WHERE _id = $1 OR shipment_no = $1 LIMIT 1",
      [id]
    );
    if (!planRes.rows.length) return res.status(404).send("<h1>Shipment not found</h1>");
    const p = planRes.rows[0];

    // ── Fetch linked orders ──
    let orders = [];
    const orderNos = p.order_nos || p.contract_nos || [];
    if (Array.isArray(orderNos) && orderNos.length > 0) {
      const ph = orderNos.map((_, i) => `$${i + 1}`).join(",");
      const oRes = await pool.query(
        `SELECT _id, order_no, contract_no, customer_po, raw
         FROM orders
         WHERE order_no IN (${ph}) OR contract_no IN (${ph}) OR _id::text IN (${ph})`,
        orderNos
      );
      orders = oRes.rows;
    }

    // ── Format helpers ──
    const fmt = v => (v == null || v === "") ? "—" : v;
    const fmtDate = v => {
      if (!v) return "—";
      return String(v).substring(0, 10);
    };
    const fmtNum = (v, dec = 2) => {
      if (v == null || v === "") return "—";
      return Number(v).toLocaleString("zh-CN", { minimumFractionDigits: dec, maximumFractionDigits: dec });
    };

    // ── Fee rows for cost sheet ──
    const portFees = [
      ["文件费 (Doc Fee)",         p.doc_fee],
      ["通讯费 (TLX Fee)",         p.tlx_fee],
      ["信息传输费",                p.info_trans_fee],
      ["订舱费 (Booking Fee)",     p.bkg_fee],
      ["码头操作费 (THC)",          p.thc_fee],
      ["设备交接费 (EIR)",          p.eir_fee],
      ["铅封费 (Seal Fee)",        p.seal_fee],
    ].filter(([, v]) => v != null && v > 0);

    const portFeesTotal = portFees.reduce((s, [, v]) => s + Number(v || 0), 0);

    // ── Determine doc type ──
    const isCost = type === "cost";
    const isSI   = type === "si";
    const isConfirm = !isCost && !isSI;

    const docTitle = isCost ? "成本核算单 — 内部专用" :
                     isSI   ? "Shipping Instructions" :
                              "海运计划确认书";

    const generatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });

    const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${docTitle} — ${fmt(p.shipment_no)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif;
    font-size: 12px;
    color: #1a1a2e;
    background: #fff;
    padding: 0;
  }
  .page {
    max-width: 210mm;
    margin: 0 auto;
    padding: 16mm 14mm 12mm;
  }
  /* ── Header ── */
  .header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 18px;
    padding-bottom: 12px;
    border-bottom: 2px solid #1e3a8a;
  }
  .logo-block .company-name {
    font-size: 20px;
    font-weight: 800;
    color: #1e3a8a;
    letter-spacing: 0.03em;
  }
  .logo-block .company-sub {
    font-size: 10px;
    color: #64748b;
    margin-top: 2px;
  }
  .doc-meta { text-align: right; }
  .doc-meta .doc-title {
    font-size: 16px;
    font-weight: 700;
    color: #1e3a8a;
    margin-bottom: 6px;
  }
  .doc-meta .ref-no {
    font-family: "Courier New", monospace;
    font-size: 13px;
    font-weight: 700;
    color: #0f172a;
    background: #eff6ff;
    padding: 3px 10px;
    border-radius: 4px;
    border: 1px solid #bfdbfe;
    display: inline-block;
  }
  .doc-meta .gen-time {
    font-size: 9px;
    color: #94a3b8;
    margin-top: 4px;
  }

  /* ── Section ── */
  .section { margin-bottom: 14px; }
  .section-title {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #1e3a8a;
    border-left: 3px solid #1e3a8a;
    padding-left: 8px;
    margin-bottom: 8px;
  }

  /* ── Grid ── */
  .grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
  .grid-3 { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0; }
  .field {
    padding: 7px 10px;
    border: 0.5px solid #e2e8f0;
  }
  .field:nth-child(odd) { background: #f8fafc; }
  .field .lbl {
    font-size: 9px;
    color: #64748b;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 3px;
  }
  .field .val {
    font-size: 12px;
    font-weight: 700;
    color: #0f172a;
    font-family: "Courier New", monospace;
  }
  .field .val.normal { font-family: inherit; }

  /* ── Route banner ── */
  .route-banner {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    background: linear-gradient(135deg, #eff6ff, #f0fdf4);
    border: 1px solid #bfdbfe;
    border-radius: 8px;
    padding: 14px 20px;
    margin-bottom: 14px;
  }
  .route-port .port-code {
    font-size: 22px;
    font-weight: 900;
    color: #1e3a8a;
    letter-spacing: 0.04em;
  }
  .route-port .port-label {
    font-size: 9px;
    color: #64748b;
    font-weight: 600;
    text-transform: uppercase;
    margin-top: 2px;
  }
  .route-arrow {
    font-size: 20px;
    color: #3b82f6;
    flex-shrink: 0;
  }
  .route-vessel {
    text-align: center;
    flex: 1;
    padding: 0 10px;
  }
  .route-vessel .vessel-name {
    font-size: 13px;
    font-weight: 700;
    color: #1e40af;
    font-family: "Courier New", monospace;
  }
  .route-vessel .voy {
    font-size: 10px;
    color: #3b82f6;
    margin-top: 2px;
  }

  /* ── Table ── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  thead th {
    background: #1e3a8a;
    color: #fff;
    padding: 7px 10px;
    text-align: left;
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  tbody tr { border-bottom: 0.5px solid #e2e8f0; }
  tbody tr:nth-child(even) { background: #f8fafc; }
  tbody td {
    padding: 7px 10px;
    color: #1e293b;
    vertical-align: top;
  }
  .mono { font-family: "Courier New", monospace; font-weight: 700; }
  tfoot td {
    padding: 8px 10px;
    font-weight: 700;
    background: #eff6ff;
    border-top: 1.5px solid #1e3a8a;
  }

  /* ── Fee grid ── */
  .fee-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 0;
    border: 0.5px solid #e2e8f0;
  }
  .fee-item {
    padding: 7px 10px;
    border: 0.5px solid #e2e8f0;
    background: #f8fafc;
  }
  .fee-item:nth-child(4n+1), .fee-item:nth-child(4n+2) { background: #fff; }
  .fee-item .fee-lbl { font-size: 9px; color: #64748b; font-weight: 600; margin-bottom: 3px; }
  .fee-item .fee-val { font-size: 12px; font-weight: 700; color: #1e3a8a; font-family: "Courier New", monospace; }

  /* ── Total bar ── */
  .total-bar {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 16px;
    padding: 10px 14px;
    background: #1e3a8a;
    color: #fff;
    border-radius: 0 0 6px 6px;
    margin-top: -1px;
  }
  .total-bar .total-lbl { font-size: 10px; opacity: 0.8; }
  .total-bar .total-val { font-size: 16px; font-weight: 900; font-family: "Courier New", monospace; }

  /* ── Status badge ── */
  .badge {
    display: inline-block;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 700;
  }
  .badge-blue  { background: #eff6ff; color: #1d4ed8; border: 1px solid #bfdbfe; }
  .badge-green { background: #f0fdf4; color: #15803d; border: 1px solid #bbf7d0; }
  .badge-amber { background: #fffbeb; color: #b45309; border: 1px solid #fde68a; }

  /* ── Signature ── */
  .sig-area {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 14px;
    margin-top: 20px;
  }
  .sig-box {
    border-top: 1px solid #cbd5e1;
    padding-top: 8px;
    text-align: center;
  }
  .sig-box .sig-lbl { font-size: 9px; color: #94a3b8; font-weight: 600; text-transform: uppercase; }
  .sig-box .sig-line { height: 32px; border-bottom: 1px dashed #e2e8f0; margin: 8px 0; }
  .sig-box .sig-name { font-size: 10px; color: #64748b; }

  /* ── Notice ── */
  .notice {
    margin-top: 14px;
    padding: 8px 12px;
    background: #fff7ed;
    border: 0.5px solid #fed7aa;
    border-radius: 6px;
    font-size: 10px;
    color: #92400e;
    line-height: 1.6;
  }

  /* ── Print ── */
  @media print {
    @page { size: A4; margin: 0; }
    body { padding: 0; }
    .page { padding: 12mm 12mm 10mm; max-width: none; }
    .no-print { display: none !important; }
  }
  @media screen {
    body { background: #f1f5f9; }
    .page {
      background: #fff;
      box-shadow: 0 4px 32px rgba(0,0,0,0.12);
      margin: 20px auto;
      border-radius: 8px;
    }
    .print-btn {
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 10px 20px;
      background: #1e3a8a;
      color: #fff;
      border: none;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      box-shadow: 0 4px 16px rgba(30,58,138,0.4);
      z-index: 1000;
      font-family: "PingFang SC", "Microsoft YaHei", Arial, sans-serif;
    }
    .print-btn:hover { background: #1e40af; }
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
      <div class="doc-title">${docTitle}</div>
      <div class="ref-no">${fmt(p.shipment_no)}</div>
      <div class="gen-time">生成时间：${generatedAt}</div>
    </div>
  </div>

  <!-- Route Banner -->
  <div class="route-banner">
    <div class="route-port">
      <div class="port-code">${fmt(p.pol)}</div>
      <div class="port-label">Port of Loading</div>
    </div>
    <div class="route-arrow">⟶</div>
    <div class="route-vessel">
      <div class="vessel-name">${fmt(p.vessel)}</div>
      <div class="voy">VOY ${fmt(p.voyage)}</div>
      ${p.carrier ? `<div style="font-size:9px;color:#64748b;margin-top:2px">${p.carrier}</div>` : ""}
    </div>
    <div class="route-arrow">⟶</div>
    <div class="route-port" style="text-align:right">
      <div class="port-code">${fmt(p.pod)}</div>
      <div class="port-label">Port of Discharge</div>
    </div>
  </div>

  <!-- Core Info Grid -->
  <div class="section">
    <div class="section-title">📋 基本信息</div>
    <div class="grid-3">
      <div class="field">
        <div class="lbl">提单号 B/L No.</div>
        <div class="val">${fmt(p.bl_no)}</div>
      </div>
      <div class="field">
        <div class="lbl">出运编号</div>
        <div class="val">${fmt(p.shipment_no)}</div>
      </div>
      <div class="field">
        <div class="lbl">流程状态</div>
        <div class="val normal">
          <span class="badge badge-blue">${fmt(p.flow_status)}</span>
        </div>
      </div>
      <div class="field">
        <div class="lbl">ETD 开船日</div>
        <div class="val">${fmtDate(p.etd)}</div>
      </div>
      <div class="field">
        <div class="lbl">ETA 预计到港</div>
        <div class="val">${fmtDate(p.eta)}</div>
      </div>
      <div class="field">
        <div class="lbl">截关日 SI Cutoff</div>
        <div class="val">${fmtDate(p.si_cutoff_date || p.cutoff_date)}</div>
      </div>
      <div class="field">
        <div class="lbl">柜型 Container Type</div>
        <div class="val">${fmt(p.container_type)}</div>
      </div>
      <div class="field">
        <div class="lbl">柜号 Container No.</div>
        <div class="val">${fmt(p.container_no)}</div>
      </div>
      <div class="field">
        <div class="lbl">港口开放日</div>
        <div class="val">${fmtDate(p.port_open_date)}</div>
      </div>
    </div>
  </div>

  <!-- Customer & Partners -->
  <div class="section">
    <div class="section-title">🏢 客户与服务商</div>
    <div class="grid-2">
      <div class="field">
        <div class="lbl">客户（中文）</div>
        <div class="val normal">${fmt(p.customer_cn || p.customer)}</div>
      </div>
      <div class="field">
        <div class="lbl">Customer (EN)</div>
        <div class="val normal">${fmt(p.customer_en || p.customer)}</div>
      </div>
      <div class="field">
        <div class="lbl">货代（国内）</div>
        <div class="val normal">${fmt(p.forwarder_cn)}</div>
      </div>
      <div class="field">
        <div class="lbl">Forwarder (Overseas)</div>
        <div class="val normal">${fmt(p.forwarder_en)}</div>
      </div>
      <div class="field">
        <div class="lbl">拖车行</div>
        <div class="val normal">${fmt(p.trucking_cn)}</div>
      </div>
      <div class="field">
        <div class="lbl">报关行</div>
        <div class="val normal">${fmt(p.customs_cn)}</div>
      </div>
    </div>
  </div>

  <!-- Linked Orders -->
  ${orders.length > 0 ? `
  <div class="section">
    <div class="section-title">📦 关联订单</div>
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>合同号</th>
          <th>客户PO</th>
          <th>客户</th>
          <th>品类</th>
        </tr>
      </thead>
      <tbody>
        ${orders.map((o, i) => {
          const raw = o.raw || {};
          const contractNo = o.contract_no || raw.contractNo || o._id;
          const customerPO = o.customer_po || raw.customerPO || "—";
          const customer   = raw.companyNameEN || raw.companyNameCN || "—";
          const category   = raw.category || "—";
          return `<tr>
            <td style="color:#94a3b8">${i + 1}</td>
            <td class="mono">${contractNo}</td>
            <td class="mono">${customerPO}</td>
            <td>${customer}</td>
            <td>${category}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
  </div>
  ` : (orderNos.length > 0 ? `
  <div class="section">
    <div class="section-title">📦 关联订单号</div>
    <div style="padding:10px;background:#f8fafc;border:0.5px solid #e2e8f0;border-radius:6px;font-family:monospace;font-size:11px;line-height:2">
      ${orderNos.join("　·　")}
    </div>
  </div>
  ` : "")}

  <!-- Fees Section -->
  ${isConfirm || isSI ? "" : ""}
  <div class="section">
    <div class="section-title">💰 费用明细</div>

    <!-- Ocean Freight -->
    <div style="margin-bottom:10px">
      <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">🚢 海运费</div>
      <div class="grid-3">
        <div class="field">
          <div class="lbl">海运费成本 USD</div>
          <div class="val">${p.freight_cost != null ? "USD " + fmtNum(p.freight_cost) : "—"}</div>
        </div>
        <div class="field">
          <div class="lbl">${isCost ? "海运费报价 USD" : "海运费 USD"}</div>
          <div class="val">${p.freight_sale_usd != null ? "USD " + fmtNum(p.freight_sale_usd) : "—"}</div>
        </div>
        <div class="field">
          <div class="lbl">运费合计 CNY</div>
          <div class="val">${p.freight_total_cny != null ? "¥ " + fmtNum(p.freight_total_cny) : "—"}</div>
        </div>
      </div>
    </div>

    <!-- Port Fees -->
    ${portFees.length > 0 ? `
    <div style="margin-bottom:10px">
      <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">🏗 港杂费</div>
      <div class="fee-grid">
        ${portFees.map(([lbl, val]) => `
        <div class="fee-item">
          <div class="fee-lbl">${lbl}</div>
          <div class="fee-val">¥ ${fmtNum(val)}</div>
        </div>`).join("")}
        <div class="fee-item" style="background:#eff6ff">
          <div class="fee-lbl" style="color:#1e3a8a">港杂合计</div>
          <div class="fee-val" style="color:#1e3a8a">¥ ${fmtNum(portFeesTotal)}</div>
        </div>
      </div>
    </div>
    ` : ""}

    <!-- Other Fees -->
    <div>
      <div style="font-size:9px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.06em;margin-bottom:6px">🚛 其他费用</div>
      <div class="grid-3">
        ${p.trucking_fee != null ? `<div class="field"><div class="lbl">拖车费</div><div class="val">¥ ${fmtNum(p.trucking_fee)}</div></div>` : ""}
        ${p.customs_fee != null ? `<div class="field"><div class="lbl">报关费</div><div class="val">¥ ${fmtNum(p.customs_fee)}</div></div>` : ""}
        ${p.insurance_cost != null ? `<div class="field"><div class="lbl">保险费</div><div class="val">¥ ${fmtNum(p.insurance_cost)}</div></div>` : ""}
        ${p.ddp_total != null ? `<div class="field"><div class="lbl">DDP费用</div><div class="val">¥ ${fmtNum(p.ddp_total)}</div></div>` : ""}
      </div>
    </div>

    ${p.freight_total_cny != null ? `
    <div class="total-bar">
      <span class="total-lbl">物流总费用</span>
      <span class="total-val">¥ ${fmtNum(p.freight_total_cny)}</span>
    </div>
    ` : ""}
  </div>

  <!-- Remarks -->
  ${p.remarks ? `
  <div class="section">
    <div class="section-title">📝 备注</div>
    <div style="padding:10px 12px;background:#fffbeb;border:0.5px solid #fde68a;border-radius:6px;font-size:12px;color:#78350f;line-height:1.7">
      ${p.remarks}
    </div>
  </div>
  ` : ""}

  <!-- Signature -->
  ${isConfirm ? `
  <div class="sig-area">
    <div class="sig-box">
      <div class="sig-line"></div>
      <div class="sig-lbl">制单 Prepared By</div>
      <div class="sig-name" style="margin-top:4px">${p.created_by || "—"}</div>
    </div>
    <div class="sig-box">
      <div class="sig-line"></div>
      <div class="sig-lbl">审核 Reviewed By</div>
    </div>
    <div class="sig-box">
      <div class="sig-line"></div>
      <div class="sig-lbl">客户确认 Customer</div>
    </div>
  </div>
  ` : ""}

  <!-- Footer -->
  <div style="margin-top:20px;padding-top:10px;border-top:0.5px solid #e2e8f0;display:flex;justify-content:space-between;font-size:9px;color:#94a3b8">
    <span>三林宠物 Sanlyn Pet Products Co., Ltd. | ai.sanlynos.com</span>
    <span>生成于 ${generatedAt} · Ref: ${fmt(p.shipment_no)}</span>
  </div>

</div>

<script>
  // Auto-trigger print if ?print=1
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
    console.error("[shipping-plan-pdf]", err);
    return res.status(500).send(`<h1>Error: ${err.message}</h1>`);
  }
}
