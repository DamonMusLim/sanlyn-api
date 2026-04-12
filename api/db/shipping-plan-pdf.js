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
    const esc = s => {
      if (!s) return "";
      return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
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
    const isCost    = type === "cost";
    const isSI      = type === "si";
    const isBooking = type === "booking";
    const isBlDraft = type === "bl_draft";
    const isFreight = type === "freight_invoice";
    const isConfirm = !isCost && !isSI && !isBooking && !isBlDraft && !isFreight;

    const generatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    const genDate = new Date().toISOString().slice(0, 10);

    // ── Fetch customer/consignee info for docs that need it ──
    let cust = null;
    if (isBooking || isBlDraft || isFreight) {
      const customerName = p.customer_en || p.customer_cn || p.customer || "";
      if (customerName) {
        try {
          const cRes = await pool.query(
            `SELECT * FROM customers WHERE name_en ILIKE $1 OR name_cn ILIKE $1 LIMIT 1`,
            ["%" + customerName.trim() + "%"]
          );
          if (cRes.rows.length) cust = cRes.rows[0];
        } catch(e) {}
      }
    }

    // ── Shared CSS for new doc types ──
    const sharedCss = `
      * { box-sizing: border-box; margin: 0; padding: 0; }
      body { font-family: "PingFang SC","Microsoft YaHei",Arial,sans-serif; font-size: 12px; color: #1a1a2e; background: #fff; }
      .page { max-width: 210mm; margin: 0 auto; padding: 16mm 14mm 12mm; }
      .header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:18px; padding-bottom:12px; border-bottom:2px solid #1e3a8a; }
      .co-name { font-size:18px; font-weight:800; color:#1e3a8a; } .co-sub { font-size:10px; color:#64748b; margin-top:2px; }
      .doc-title { font-size:16px; font-weight:700; color:#1e3a8a; text-align:right; } .ref-no { font-family:monospace; font-size:13px; font-weight:700; background:#eff6ff; padding:3px 10px; border-radius:4px; border:1px solid #bfdbfe; display:inline-block; margin-top:4px; } .gen-time { font-size:9px; color:#94a3b8; margin-top:3px; text-align:right; }
      .sec-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.08em; color:#1e3a8a; border-left:3px solid #1e3a8a; padding-left:8px; margin:14px 0 8px; }
      table { width:100%; border-collapse:collapse; font-size:11px; }
      thead th { background:#1e3a8a; color:#fff; padding:7px 10px; text-align:left; font-size:9px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; }
      tbody tr { border-bottom:0.5px solid #e2e8f0; } tbody tr:nth-child(even) { background:#f8fafc; }
      tbody td { padding:7px 10px; vertical-align:top; }
      tfoot td { padding:8px 10px; font-weight:700; background:#eff6ff; border-top:1.5px solid #1e3a8a; }
      .grid2 { display:grid; grid-template-columns:1fr 1fr; gap:0; }
      .grid3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:0; }
      .field { padding:7px 10px; border:0.5px solid #e2e8f0; } .field:nth-child(odd){background:#f8fafc;}
      .lbl { font-size:9px; color:#64748b; font-weight:600; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:2px; }
      .val { font-size:12px; font-weight:700; color:#0f172a; font-family:monospace; }
      .val.n { font-family:inherit; }
      .total-bar { display:flex; justify-content:flex-end; gap:16px; align-items:center; padding:10px 14px; background:#1e3a8a; color:#fff; border-radius:0 0 6px 6px; }
      .total-lbl { font-size:10px; opacity:0.8; } .total-val { font-size:16px; font-weight:900; font-family:monospace; }
      .remark-box { padding:10px 12px; background:#fffbeb; border:0.5px solid #fde68a; border-radius:6px; font-size:12px; color:#78350f; line-height:1.7; margin-top:8px; }
      .sig-area { display:grid; grid-template-columns:1fr 1fr 1fr; gap:14px; margin-top:20px; }
      .sig-box { border-top:1px solid #cbd5e1; padding-top:8px; text-align:center; }
      .sig-line { height:32px; border-bottom:1px dashed #e2e8f0; margin:8px 0; }
      .sig-lbl { font-size:9px; color:#94a3b8; font-weight:600; text-transform:uppercase; }
      .footer { margin-top:16px; padding-top:10px; border-top:0.5px solid #e2e8f0; display:flex; justify-content:space-between; font-size:9px; color:#94a3b8; }
      @media print { @page{size:A4;margin:0} body{padding:0} .page{padding:12mm 12mm 10mm;max-width:none} .no-print{display:none!important} }
      @media screen { body{background:#f1f5f9} .page{background:#fff;box-shadow:0 4px 32px rgba(0,0,0,0.12);margin:20px auto;border-radius:8px} .print-btn{position:fixed;top:20px;right:20px;padding:10px 20px;background:#1e3a8a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(30,58,138,.4);z-index:1000} }
    `;
    const printBtn = `<button class="print-btn no-print" onclick="window.print()">🖨 打印 / 另存为PDF</button>`;
    const autoprint = `<script>if(new URLSearchParams(location.search).get('print')==='1')window.onload=()=>setTimeout(()=>window.print(),500);<\/script>`;
    const docHeader = (title, ref) => `
      <div class="header">
        <div><div class="co-name">三林宠物 Sanlyn</div><div class="co-sub">XIAMEN SANLYN IMPORT AND EXPORT CO., LTD</div><div class="co-sub" style="font-size:9px;color:#94a3b8">ai.sanlynos.com</div></div>
        <div><div class="doc-title">${title}</div><div class="ref-no">${fmt(ref)}</div><div class="gen-time">Date: ${genDate} · Generated: ${generatedAt}</div></div>
      </div>`;

    // ══════════════════════════════════════════
    // 托书 Booking Note
    // ══════════════════════════════════════════
    if (isBooking || isBlDraft) {
      // ── Aggregate cargo data from linked orders ──
      let totalCbm = 0, totalGw = 0, totalQty = 0;
      let blDescSet = new Set(), hsCodeSet = new Set();
      let issuingCoEN = "XIAMEN SANLYN IMPORT AND EXPORT CO., LTD";
      let issuingCoAddr = "Xiamen, Fujian, China";

      for (const o of orders) {
        totalCbm += Number(o.total_cbm || 0);
        totalGw  += Number(o.gross_weight || 0);
        totalQty += Number(o.total_qty || 0);
        const raw = typeof o.raw === "string" ? (() => { try { return JSON.parse(o.raw); } catch(e) { return {}; } })() : (o.raw || {});
        if (raw.blDescription) blDescSet.add(raw.blDescription);
        if (raw.issuingCompanyEN) issuingCoEN = raw.issuingCompanyEN;
        else if (raw.issuingCompany)  issuingCoEN = raw.issuingCompany;
        // Extract SKUs from products array in raw JSON
        const prods = raw.products || [];
        prods.forEach(pr => { if (pr.sku) hsCodeSet.add("__sku__" + pr.sku); });
      }

      // Query HS codes + bl_description from products table
      const skus = [...hsCodeSet].map(s => s.replace("__sku__","")).filter(Boolean);
      if (skus.length > 0) {
        try {
          const ph2 = skus.map((_,i) => `$${i+1}`).join(",");
          const hsRes = await pool.query(
            `SELECT DISTINCT hs_code, bl_description FROM products WHERE sku IN (${ph2}) AND hs_code IS NOT NULL AND hs_code != ''`,
            skus
          );
          hsRes.rows.forEach(r => {
            if (r.hs_code) hsCodeSet.add(r.hs_code);
            if (r.bl_description && !blDescSet.size) blDescSet.add(r.bl_description);
          });
          // Remove the __sku__ placeholders
          skus.forEach(s => hsCodeSet.delete("__sku__" + s));
        } catch(e) {}
      }

      const consignee = cust ? (cust.consignee || cust.name_en || cust.name_cn) : fmt(p.customer_en || p.customer);
      const consigneeAddr = cust ? (cust.address || cust.destination_port || "") : "";
      const blDescText = [...blDescSet].join(" / ") || "PET PRODUCTS";
      const hsText = [...hsCodeSet].filter(s => !s.startsWith("__sku__")).join(" / ") || "—";
      const cbmText = totalCbm > 0 ? totalCbm.toFixed(3) + " CBM" : "—";
      const gwText  = totalGw  > 0 ? totalGw.toLocaleString() + " KG" : "—";
      const qtyText = totalQty > 0 ? totalQty + " CTNS" : "—";

      if (isBooking) {
      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>托书 — ${fmt(p.shipment_no)}</title><style>${sharedCss}</style></head><body>
${printBtn}
<div class="page">
  ${docHeader("📋 托书 Booking Note", p.shipment_no)}

  <div class="sec-title">发货人 / Shipper</div>
  <div class="grid2">
    <div class="field"><div class="lbl">Shipper (发货人)</div><div class="val n">${esc(issuingCoEN)}</div></div>
    <div class="field"><div class="lbl">地址 Address</div><div class="val n">${esc(issuingCoAddr)}</div></div>
  </div>

  <div class="sec-title">收货人 / Consignee</div>
  <div class="grid2">
    <div class="field"><div class="lbl">Consignee (收货人)</div><div class="val n">${esc(consignee)}</div></div>
    <div class="field"><div class="lbl">地址 Address</div><div class="val n">${esc(consigneeAddr)}</div></div>
    <div class="field"><div class="lbl">通知方 Notify Party</div><div class="val n">${esc(consignee)}</div></div>
    <div class="field"><div class="lbl">联系方式 Contact</div><div class="val n">${cust ? esc(cust.contact_tel || cust.contact_email || "—") : "—"}</div></div>
  </div>

  <div class="sec-title">航线信息 / Sailing Details</div>
  <div class="grid3">
    <div class="field"><div class="lbl">船公司 Carrier</div><div class="val">${fmt(p.shipping_line)}</div></div>
    <div class="field"><div class="lbl">船名 Vessel</div><div class="val">${fmt(p.vessel)}</div></div>
    <div class="field"><div class="lbl">航次 Voyage</div><div class="val">${fmt(p.voyage)}</div></div>
    <div class="field"><div class="lbl">起运港 POL</div><div class="val">${fmt(p.pol)}</div></div>
    <div class="field"><div class="lbl">目的港 POD</div><div class="val">${fmt(p.pod)}</div></div>
    <div class="field"><div class="lbl">直航/中转</div><div class="val">${fmt(p.transit || "Direct")}</div></div>
    <div class="field"><div class="lbl">ETD 预计开船</div><div class="val">${fmtDate(p.etd)}</div></div>
    <div class="field"><div class="lbl">截单日 SI Cutoff</div><div class="val">${fmtDate(p.si_cutoff_date || p.cutoff_date)}</div></div>
    <div class="field"><div class="lbl">开港日 Port Open</div><div class="val">${fmtDate(p.port_open_date)}</div></div>
  </div>

  <div class="sec-title">柜型柜量 / Container</div>
  <div class="grid3">
    <div class="field"><div class="lbl">柜型 Type</div><div class="val">${fmt(p.container_type)}</div></div>
    <div class="field"><div class="lbl">柜量 Qty</div><div class="val">${fmt(p.container_qty)}</div></div>
    <div class="field"><div class="lbl">柜号 Container No.</div><div class="val">${p.container_no ? fmt(p.container_no) : "TBC"}</div></div>
  </div>

  <div class="sec-title">货物信息 / Cargo Details</div>
  <div class="grid2" style="margin-bottom:8px">
    <div class="field"><div class="lbl">货物描述 Description of Goods</div><div class="val n" style="font-size:13px;font-family:inherit">${esc(blDescText)}</div></div>
    <div class="field"><div class="lbl">HS Code</div><div class="val">${esc(hsText)}</div></div>
    <div class="field"><div class="lbl">总数量 Total Qty</div><div class="val">${esc(qtyText)}</div></div>
    <div class="field"><div class="lbl">总毛重 Gross Weight</div><div class="val">${esc(gwText)}</div></div>
    <div class="field"><div class="lbl">总体积 Total CBM</div><div class="val">${esc(cbmText)}</div></div>
    <div class="field"><div class="lbl">包装 Packing</div><div class="val n">Export standard cartons</div></div>
  </div>

  ${orders.length > 0 ? `
  <div class="sec-title">关联订单 / Linked Orders</div>
  <table>
    <thead><tr><th>#</th><th>合同号 Contract No.</th><th>客户PO Customer PO</th><th>箱数 Qty</th><th>CBM</th><th>毛重 GW (KG)</th></tr></thead>
    <tbody>${orders.map((o,i) => {
      const raw2 = typeof o.raw==="string" ? (()=>{try{return JSON.parse(o.raw);}catch(e){return {};}})() : (o.raw||{});
      return `<tr>
        <td style="color:#94a3b8">${i+1}</td>
        <td class="val" style="font-size:11px">${esc(o.contract_no || raw2.contractNo || "—")}</td>
        <td style="font-size:11px">${esc(o.customer_po || raw2.customerPO || "—")}</td>
        <td style="text-align:right">${o.total_qty || raw2.totalQty || "—"}</td>
        <td style="text-align:right">${o.total_cbm ? Number(o.total_cbm).toFixed(3) : (raw2.totalCBM || "—")}</td>
        <td style="text-align:right">${o.gross_weight || raw2.grossWeight || "—"}</td>
      </tr>`;
    }).join("")}</tbody>
    <tfoot><tr>
      <td colspan="3" style="text-align:right;font-weight:700">合计 TOTAL</td>
      <td style="text-align:right;font-weight:700">${qtyText}</td>
      <td style="text-align:right;font-weight:700">${cbmText}</td>
      <td style="text-align:right;font-weight:700">${gwText}</td>
    </tr></tfoot>
  </table>` : ""}

  ${p.remarks ? `<div class="sec-title">备注 Remarks</div><div class="remark-box">${esc(p.remarks)}</div>` : ""}

  <div class="sig-area">
    <div class="sig-box"><div class="sig-line"></div><div class="sig-lbl">制单 Prepared By</div></div>
    <div class="sig-box"><div class="sig-line"></div><div class="sig-lbl">货代确认 Forwarder</div></div>
    <div class="sig-box"><div class="sig-line"></div><div class="sig-lbl">日期 Date</div></div>
  </div>
  <div class="footer"><span>${esc(issuingCoEN)}</span><span>Booking Note · ${fmt(p.shipment_no)} · ${genDate}</span></div>
</div>${autoprint}</body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(html);
      } // end isBooking

      // ── 提单草稿 B/L Draft (shares aggregated data above) ──
      const blCargoLines = orders.length ? orders.map(o => {
        const raw2 = typeof o.raw==="string" ? (()=>{try{return JSON.parse(o.raw);}catch(e){return {};}})() : (o.raw||{});
        const marks = o.contract_no || raw2.contractNo || o.customer_po || "AS PER CONTRACT";
        const desc  = raw2.blDescription || blDescText || "PET PRODUCTS";
        const qty   = (o.total_qty || raw2.totalQty) ? (o.total_qty || raw2.totalQty) + " CTNS" : "";
        const wt    = (o.gross_weight || raw2.grossWeight) ? "G.W: " + (o.gross_weight || raw2.grossWeight) + " KG" : "";
        const cbm2  = (o.total_cbm || raw2.totalCBM) ? "MEAS: " + Number(o.total_cbm || raw2.totalCBM).toFixed(3) + " CBM" : "";
        return { marks, desc, qty, wt, cbm2 };
      }) : [{ marks: "AS PER CONTRACT", desc: blDescText || "PET PRODUCTS", qty: qtyText, wt: gwText, cbm2: cbmText }];

            const blHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>提单草稿 B/L Draft — ${fmt(p.shipment_no)}</title><style>${sharedCss}
      .bl-box{border:1px solid #1e3a8a;margin-bottom:0;}
      .bl-row{display:grid;border-bottom:1px solid #e2e8f0;}
      .bl-row.c2{grid-template-columns:1fr 1fr;} .bl-row.c3{grid-template-columns:1fr 1fr 1fr;}
      .bl-cell{padding:8px 10px;border-right:1px solid #e2e8f0;min-height:48px;} .bl-cell:last-child{border-right:none;}
      .bl-head{font-size:8px;color:#64748b;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;}
      .bl-val{font-size:11px;font-weight:600;color:#0f172a;margin-top:4px;line-height:1.5;}
      .draft-wm{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:120px;font-weight:900;color:rgba(200,0,0,0.06);pointer-events:none;z-index:0;white-space:nowrap;}
      </style></head><body>
${printBtn}
<div class="draft-wm">DRAFT</div>
<div class="page">
  ${docHeader("📝 提单草稿 B/L Draft", p.bl_no || p.shipment_no)}
  <div style="font-size:10px;color:#dc2626;text-align:center;margin-bottom:12px;font-weight:600">⚠️ DRAFT — FOR CONFIRMATION ONLY · 仅供确认，非正本</div>
  <div class="bl-box">
    <div class="bl-row c2">
      <div class="bl-cell">
        <div class="bl-head">Shipper / Exporter (发货人)</div>
        <div class="bl-val">${esc(issuingCoEN)}<br><span style="font-weight:400;font-size:10px">${esc(issuingCoAddr)}</span></div>
      </div>
      <div class="bl-cell">
        <div class="bl-head">B/L No.</div><div class="bl-val">${esc(p.bl_no || "TBC")}</div>
        <div class="bl-head" style="margin-top:6px">Shipment Ref.</div><div class="bl-val">${esc(p.shipment_no)}</div>
      </div>
    </div>
    <div class="bl-row c2">
      <div class="bl-cell" style="min-height:60px">
        <div class="bl-head">Consignee (收货人)</div>
        <div class="bl-val">${esc(consignee)}<br><span style="font-weight:400;font-size:10px">${esc(consigneeAddr)}</span></div>
      </div>
      <div class="bl-cell">
        <div class="bl-head">Notify Party (通知方)</div>
        <div class="bl-val">${esc(consignee)}<br><span style="font-weight:400;font-size:10px">${cust ? esc(cust.contact_tel||"") : ""}</span></div>
      </div>
    </div>
    <div class="bl-row c3">
      <div class="bl-cell"><div class="bl-head">Vessel (船名)</div><div class="bl-val">${esc(p.vessel||"—")}</div></div>
      <div class="bl-cell"><div class="bl-head">Voyage No.</div><div class="bl-val">${esc(p.voyage||"—")}</div></div>
      <div class="bl-cell"><div class="bl-head">Carrier (船公司)</div><div class="bl-val">${esc(p.shipping_line||"—")}</div></div>
    </div>
    <div class="bl-row c3">
      <div class="bl-cell"><div class="bl-head">Port of Loading (起运港)</div><div class="bl-val">${esc(p.pol||"—")}</div></div>
      <div class="bl-cell"><div class="bl-head">Port of Discharge (目的港)</div><div class="bl-val">${esc(p.pod||"—")}</div></div>
      <div class="bl-cell"><div class="bl-head">ETD</div><div class="bl-val">${fmtDate(p.etd)}</div></div>
    </div>
    <div class="bl-row c3">
      <div class="bl-cell"><div class="bl-head">Container No.</div><div class="bl-val">${esc(p.container_no||"TBC")}</div></div>
      <div class="bl-cell"><div class="bl-head">Container Type × Qty</div><div class="bl-val">${esc(p.container_type||"—")} × ${fmt(p.container_qty||1)}</div></div>
      <div class="bl-cell"><div class="bl-head">Freight</div><div class="bl-val">${p.freight_sale_usd ? "PREPAID" : "AS ARRANGED"}</div></div>
    </div>
    <div style="background:#1e3a8a;color:#fff;padding:6px 10px;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em">Description of Goods / Cargo Details</div>
    <table>
      <thead><tr><th>Marks & Nos.</th><th>Description</th><th>HS Code</th><th>Qty</th><th>Gross Wt.</th><th>Measurement</th></tr></thead>
      <tbody>${blCargoLines.map(c=>`<tr>
        <td class="val" style="font-size:10px">${esc(c.marks)}</td>
        <td>${esc(c.desc)}</td>
        <td style="font-family:monospace">${esc(hsText)}</td>
        <td style="text-align:right">${esc(c.qty)}</td>
        <td style="text-align:right">${esc(c.wt)}</td>
        <td style="text-align:right">${esc(c.cbm2)}</td>
      </tr>`).join("")}
      </tbody>
      <tfoot><tr><td colspan="3" style="text-align:right;font-weight:700">TOTAL</td><td style="text-align:right;font-weight:700">${qtyText}</td><td style="text-align:right;font-weight:700">${gwText}</td><td style="text-align:right;font-weight:700">${cbmText}</td></tr></tfoot>
    </table>
    <div class="bl-row" style="grid-template-columns:1fr">
      <div class="bl-cell"><div class="bl-head">Special Instructions</div>
      <div class="bl-val" style="min-height:24px">${p.remarks ? esc(p.remarks) : ""}</div></div>
    </div>
  </div>
  <div class="sig-area" style="margin-top:12px">
    <div class="sig-box"><div class="sig-line"></div><div class="sig-lbl">Shipper</div></div>
    <div class="sig-box"><div class="sig-line"></div><div class="sig-lbl">Confirmed By (船公司)</div></div>
    <div class="sig-box"><div class="sig-line"></div><div class="sig-lbl">Date</div></div>
  </div>
  <div class="footer"><span>${esc(issuingCoEN)}</span><span>B/L Draft · ${fmt(p.shipment_no)} · ${genDate}</span></div>
</div>${autoprint}</body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(blHtml);
    } // end isBooking || isBlDraft

    // ══════════════════════════════════════════
    // 海运费发票 Freight Invoice
    // ══════════════════════════════════════════
    if (isFreight) {
      const invoiceNo = "FI-" + fmt(p.shipment_no) + "-" + genDate.replace(/-/g,"");
      const billTo = cust ? (cust.name_en || cust.name_cn) : fmt(p.customer_en||p.customer);
      const feeRows = [
        { desc: "Ocean Freight 海运费", cur: "USD", amt: p.freight_sale_usd },
        { desc: "Documentation Fee 单证费", cur: "CNY", amt: p.doc_fee },
        { desc: "TLX Fee 电放费", cur: "CNY", amt: p.tlx_fee },
        { desc: "Information Transmission Fee 信息传输费", cur: "CNY", amt: p.info_trans_fee },
        { desc: "Booking Fee 订舱费", cur: "CNY", amt: p.bkg_fee },
        { desc: "THC 码头操作费", cur: "CNY", amt: p.thc_fee },
        { desc: "EIR Fee 设备交接费", cur: "CNY", amt: p.eir_fee },
        { desc: "Seal Fee 封签费", cur: "CNY", amt: p.seal_fee },
        { desc: "Trucking Fee 拖车费", cur: "CNY", amt: p.trucking_cost_total },
        { desc: "Customs Fee 报关费", cur: "CNY", amt: p.customs_cost_total },
        { desc: "Insurance 保险费", cur: "CNY", amt: p.insurance_cost },
      ].filter(r => r.amt != null && parseFloat(r.amt) !== 0);
      const totalUsd = feeRows.filter(r=>r.cur==="USD").reduce((s,r)=>s+Number(r.amt||0),0);
      const totalCny = feeRows.filter(r=>r.cur==="CNY").reduce((s,r)=>s+Number(r.amt||0),0);

      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>海运费发票 — ${fmt(p.shipment_no)}</title><style>${sharedCss}
      .inv-box { border:1px solid #e2e8f0; border-radius:6px; margin-bottom:14px; overflow:hidden; }
      </style></head><body>
${printBtn}
<div class="page">
  ${docHeader("💵 海运费发票 Freight Invoice", invoiceNo)}
  <div style="color:#7b1fa2;font-size:10px;text-align:right;margin-top:-12px;margin-bottom:12px;font-weight:600">🔒 内部文件 INTERNAL ONLY</div>

  <div class="grid2" style="margin-bottom:14px">
    <div>
      <div class="sec-title">开票方 / From</div>
      <div style="padding:8px 0;line-height:1.8;font-size:12px">
        <strong>XIAMEN SANLYN IMPORT AND EXPORT CO., LTD</strong><br>
        Xiamen, Fujian, China
      </div>
    </div>
    <div>
      <div class="sec-title">收票方 / Bill To</div>
      <div style="padding:8px 0;line-height:1.8;font-size:12px">
        <strong>${esc(billTo)}</strong><br>
        ${cust ? esc(cust.address||cust.destination_port||"") : ""}
      </div>
    </div>
  </div>

  <div class="sec-title">航次信息 / Shipment</div>
  <div class="grid3" style="margin-bottom:14px">
    <div class="field"><div class="lbl">Shipment Ref.</div><div class="val">${fmt(p.shipment_no)}</div></div>
    <div class="field"><div class="lbl">Vessel / Voyage</div><div class="val">${fmt(p.vessel)} ${fmt(p.voyage)}</div></div>
    <div class="field"><div class="lbl">Route</div><div class="val">${fmt(p.pol)} → ${fmt(p.pod)}</div></div>
    <div class="field"><div class="lbl">Container</div><div class="val">${fmt(p.container_type)} × ${fmt(p.container_qty||1)}</div></div>
    <div class="field"><div class="lbl">ETD</div><div class="val">${fmtDate(p.etd)}</div></div>
    <div class="field"><div class="lbl">Invoice Date</div><div class="val">${genDate}</div></div>
  </div>

  <div class="sec-title">费用明细 / Fee Breakdown</div>
  <table>
    <thead><tr><th>#</th><th>费用项目 Description</th><th style="text-align:right">币种</th><th style="text-align:right">金额 Amount</th></tr></thead>
    <tbody>
      ${feeRows.map((r,i)=>`<tr><td style="color:#94a3b8">${i+1}</td><td>${esc(r.desc)}</td><td style="text-align:right;font-family:monospace">${r.cur}</td><td style="text-align:right;font-family:monospace;font-weight:700">${fmtNum(r.amt)}</td></tr>`).join("")}
    </tbody>
    <tfoot>
      ${totalUsd > 0 ? `<tr><td colspan="2" style="text-align:right">小计 Subtotal (USD)</td><td style="text-align:right;font-family:monospace">USD</td><td style="text-align:right;font-family:monospace">${fmtNum(totalUsd)}</td></tr>` : ""}
      <tr><td colspan="2" style="text-align:right;color:#1e3a8a">小计 Subtotal (CNY)</td><td style="text-align:right;font-family:monospace;color:#1e3a8a">CNY</td><td style="text-align:right;font-family:monospace;color:#1e3a8a">${fmtNum(totalCny)}</td></tr>
    </tfoot>
  </table>
  ${(totalUsd > 0 || totalCny > 0) ? `
  <div class="total-bar">
    ${totalUsd > 0 ? `<span class="total-lbl">USD</span><span class="total-val" style="margin-right:16px">${fmtNum(totalUsd)}</span>` : ""}
    <span class="total-lbl">CNY 合计</span><span class="total-val">¥ ${fmtNum(totalCny)}</span>
  </div>` : ""}

  <div class="sig-area">
    <div class="sig-box"><div class="sig-line"></div><div class="sig-lbl">制单 Prepared By</div></div>
    <div class="sig-box"><div class="sig-line"></div><div class="sig-lbl">审核 Approved By</div></div>
    <div class="sig-box"><div class="sig-line"></div><div class="sig-lbl">Date</div></div>
  </div>
  <div class="footer"><span>XIAMEN SANLYN IMPORT AND EXPORT CO., LTD · 内部专用</span><span>Invoice No: ${invoiceNo} · ${genDate}</span></div>
</div>${autoprint}</body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(html);
    }

    const docTitle = isCost ? "成本核算单 — 内部专用" :
                     isSI   ? "Shipping Instructions" :
                              "海运计划确认书";

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
