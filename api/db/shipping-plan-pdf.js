// /api/db/shipping-plan-pdf.js
// GET ?id=xxx           → 海运计划确认书 HTML（打印就绪）
// GET ?id=xxx&type=si   → Shipping Instructions（英文版）
// GET ?id=xxx&type=cost → 内部成本核算单（含成本价，admin only）
//
// 返回 text/html，浏览器直接打开可 Ctrl+P 打印/另存为PDF

import { getPool, setCors } from "../db.js";

// ── Helper: send HTML or render to PDF via puppeteer when format=pdf ──
async function renderHtml(res, html, format, opts = {}) {
  if (format === "pdf") {
    try {
      const puppeteer = (await import("puppeteer")).default;
      const chromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";
      const launchOpts = {
        headless: "new",
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
               "--disable-gpu", "--disable-software-rasterizer"],
      };
      try { const fs = await import("fs"); if (fs.existsSync(chromePath)) launchOpts.executablePath = chromePath; } catch (_) {}
      const browser = await puppeteer.launch(launchOpts);
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdfBytes = await page.pdf({ format: "A4", landscape: !!opts.landscape, printBackground: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } });
      await browser.close();
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Cache-Control", "no-cache");
      return res.end(pdfBytes);
    } catch (pdfErr) {
      console.error("[shipping-plan-pdf] puppeteer error:", pdfErr.message);
      return res.status(500).send(`PDF generation failed: ${pdfErr.message}`);
    }
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  return res.status(200).send(html);
}

// 客户单据字段净化：去掉 order_no 的内部 company_id 前缀（如 "38-XM-246" → "XM-246"）
function stripCompanyPrefix(str) {
  return (str || '').replace(/^\d+-/, '').trim();
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const { id, bl, type = "confirm", format } = req.query;
  if (!id && !bl) return res.status(400).send("<h1>Missing id or bl</h1>");

  try {
    const pool = getPool();

    // ── Fetch shipping plan ──
    const planRes = id
      ? await pool.query(
          "SELECT * FROM shipping_plans WHERE _id = $1 OR shipment_no = $1 OR id::text = $1 LIMIT 1",
          [id]
        )
      : await pool.query(
          "SELECT * FROM shipping_plans WHERE bl_no = $1 ORDER BY container_qty DESC NULLS LAST, id ASC",
          [bl]
        );
    if (!planRes.rows.length) return res.status(404).send("<h1>Shipment not found</h1>");
    const p = planRes.rows[0];
    // BL-level merge: all sibling plans sharing the same BL (used only by freight_invoice)
    const blSiblingPlans = bl ? planRes.rows : [p];

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

    // ── Determine doc type ──（2026-06-10 上移：transfer 块需先于 fee rows 判型）
    const isCost       = type === "cost";
    const isSI         = type === "si";
    const isBooking    = type === "booking";
    const isBlDraft    = type === "bl_draft";
    const isFreight    = type === "freight_invoice";
    const isFobInvoice = type === "fob_invoice";
    const isDebitNote  = type === "freight_debit_note";
    const isQuote      = type === "freight";
    const isNonDg      = type === "nondg";
    const isTelex      = type === "telex";
    const isTransfer   = type === "transfer"; // 内转外信息表(给船东) 2026-06-10
    const isConfirm    = !isCost && !isSI && !isBooking && !isBlDraft && !isFreight && !isFobInvoice && !isDebitNote && !isQuote && !isNonDg && !isTelex && !isTransfer;

    // ══════════════════════════════════════════
    // 内转外信息表 Domestic-to-Export Transfer List（type=transfer · 给船东）
    // 模板源: 副本Q093701550-内转外表格 (2026-06-10 Damon定版)
    // 每柜一行: 内贸段(raw.legs mode=domestic) + 外贸段 + container_bookings + orders总量直读
    // 铁律: 字段缺失显示— 不兜底; 不出现合同号/客户编码等内部信息
    // ══════════════════════════════════════════
    if (isTransfer) {
      const praw = (typeof p.raw === "string" ? (()=>{try{return JSON.parse(p.raw);}catch(e){return {};}})() : (p.raw || {}));
      const legs = Array.isArray(praw.legs) ? praw.legs : [];
      const legDom = legs.find(l => l && l.mode === "domestic") || {};
      const legExp = legs.find(l => l && l.mode === "export") || {};
      const trf = praw.transfer || {};
      const domVessel = [legDom.vessel, legDom.voyage].filter(Boolean).join(" ");
      const expVessel = ([p.vessel, p.voyage].filter(Boolean).join(" ")) || ([legExp.vessel, legExp.voyage].filter(Boolean).join(" "));
      const expPort = praw.export_pol || legExp.pol || p.pol || "";
      const expBl = p.bl_no || legExp.bl_no || "";
      const cbRes = await pool.query(
        `SELECT cb.container_no, cb.seal_no, cb.container_type, cb.tare_weight_kg, cb.vgm_weight_kg, cb.contract_no,
                o.total_qty, o.gross_weight, o.total_cbm
         FROM container_bookings cb LEFT JOIN orders o ON o.contract_no = cb.contract_no
         WHERE ($1 <> '' AND cb.bl_no = $1) OR cb.shipping_plan_id::text = $2::text
         ORDER BY cb.container_no`,
        [expBl || "", String(p.id)]
      );
      // 一柜多合同 → 合并为一行（订单总量按柜聚合，与单据合单矩阵同口径）
      const byCtn = {};
      cbRes.rows.forEach(r => {
        const k = r.container_no || "—";
        if (!byCtn[k]) byCtn[k] = { container_no: r.container_no, seal_no: r.seal_no, container_type: r.container_type,
          tare: r.tare_weight_kg, vgm: r.vgm_weight_kg, qty: 0, gw: 0, cbm: 0, _has: false };
        if (r.total_qty != null)    { byCtn[k].qty += Number(r.total_qty);    byCtn[k]._has = true; }
        if (r.gross_weight != null) { byCtn[k].gw  += Number(r.gross_weight); }
        if (r.total_cbm != null)    { byCtn[k].cbm += Number(r.total_cbm);    }
      });
      const ctns = Object.values(byCtn);
      let tQty = 0, tGw = 0, tCbm = 0, tVgm = 0, vgmAll = true;
      ctns.forEach(c => { tQty += c.qty; tGw += c.gw; tCbm += c.cbm; if (c.vgm != null) tVgm += Number(c.vgm); else vgmAll = false; });
      const trRows = ctns.map(c => `<tr>
        <td>${esc(domVessel) || "—"}</td>
        <td>${esc(trf.domestic_eta_note || "") || "—"}</td>
        <td class="mono">${esc(legDom.waybill || "") || "—"}</td>
        <td>${esc(c.container_type || "") || "—"}</td>
        <td class="mono">${esc(c.container_no || "") || "—"}</td>
        <td class="mono">${esc(c.seal_no || "") || "—"}</td>
        <td>${esc(expPort) || "—"}</td>
        <td class="mono">${esc(expBl) || "—"}</td>
        <td>${esc(expVessel) || "—"}</td>
        <td class="r">${c._has ? fmtNum(c.qty, 0) : "—"}</td>
        <td class="r">${c.gw ? fmtNum(c.gw, 1) : "—"}</td>
        <td class="r">${c.cbm ? fmtNum(c.cbm, 2) : "—"}</td>
        <td class="r">${c.tare != null ? fmtNum(c.tare, 0) : "—"}</td>
        <td class="r">${c.vgm != null ? fmtNum(c.vgm, 1) : "—"}</td>
        <td>${esc(trf.transfer_time || "") || "—"}</td>
      </tr>`).join("");
      const transferHtml = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>内转外信息表 — ${esc(expBl || p.shipment_no || "")}</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:12px;color:#0f172a;background:#f1f5f9}
.page{max-width:297mm;margin:20px auto;padding:12mm 10mm;background:#fff;box-shadow:0 4px 32px rgba(0,0,0,.12);border-radius:8px}
.title{text-align:center;font-size:18px;font-weight:800;margin-bottom:2px}
.sub{text-align:center;font-size:10px;color:#64748b;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:10.5px}
th,td{border:1px solid #94a3b8;padding:6px 5px;text-align:center;vertical-align:middle}
th{background:#f1f5f9;font-size:9.5px;font-weight:700;color:#334155}
td.mono{font-family:monospace;font-weight:700}td.r{font-family:monospace;text-align:right}
tfoot td{font-weight:800;background:#f8fafc}
.foot{margin-top:10px;display:flex;justify-content:space-between;font-size:9px;color:#94a3b8}
@media print{@page{size:A4 landscape;margin:8mm}body{background:#fff}.page{box-shadow:none;margin:0;padding:0;max-width:none}.no-print{display:none!important}}
@media screen{.print-btn{position:fixed;top:20px;right:20px;padding:10px 20px;background:#1e3a8a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;z-index:1000}}</style></head><body>
<button class="print-btn no-print" onclick="window.print()">🖨 打印 / 另存为PDF</button>
<div class="page">
<div class="title">内转外信息表 / DOMESTIC-TO-EXPORT TRANSFER LIST</div>
<div class="sub">外贸提单 B/L: ${esc(expBl) || "—"} · ${esc(expPort) || "—"} 出口 · Generated ${generatedAtT()}</div>
<table><thead><tr>
<th>进口船名航次</th><th>内贸船到港时间</th><th>进口内贸提单号</th><th>柜型</th><th>柜号</th><th>封铅</th><th>外贸出口港口</th><th>对应外贸提单号</th><th>对应船名航次</th><th>件数</th><th>重量(KG)</th><th>体积(CBM)</th><th>柜重(KG)</th><th>VGM(KG)</th><th>内转外时间</th>
</tr></thead><tbody>${trRows || `<tr><td colspan="15" style="color:#dc2626;font-weight:700">【缺：柜号数据 container_bookings】</td></tr>`}</tbody>
<tfoot><tr><td colspan="9" style="text-align:right">合计 TOTAL（${ctns.length} 柜）</td><td class="r">${fmtNum(tQty,0)}</td><td class="r">${fmtNum(tGw,1)}</td><td class="r">${fmtNum(tCbm,2)}</td><td></td><td class="r">${vgmAll && ctns.length ? fmtNum(tVgm,1) : "—"}</td><td></td></tr></tfoot></table>
<div class="foot"><span>Sanlyn OS · Transfer List</span><span>${esc(p.shipment_no || "")} · ${new Date().toISOString().slice(0,10)}</span></div>
</div></body></html>`;
      function generatedAtT(){ return new Date().toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}); }
      return renderHtml(res, transferHtml, format, { landscape: true });
    }

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

    const generatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    const genDate = new Date().toISOString().slice(0, 10);

    // ── Fetch customer/consignee info for docs that need it ──
    let cust = null;
    if (isBooking || isBlDraft || isFreight || isFobInvoice || isQuote || isNonDg || isTelex) {
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

    // ══════════════════════════════════════════
    // 货代出单公司（洋宝宝）— 全部字段从 companies 表按 ID 取，严禁编写
    // 缺字段一律红标【缺：xxx】，绝不兜底默认值
    // ══════════════════════════════════════════
    // 货代出单档案（洋宝宝）来自 seller_profiles，含公章 seal_url / 正确 SWIFT
    let issuer = null;
    try {
      const iRes = await pool.query(`SELECT * FROM seller_profiles WHERE code='yangbaobao' LIMIT 1`);
      if (iRes.rows.length) issuer = iRes.rows[0];
    } catch(e) {}
    // 取字段或红标【缺】：from(对象,'列名','中文名')
    const MISS = (label) => `<span style="color:#dc2626;font-weight:700">【缺：${label}】</span>`;
    const from = (obj, key, label) => {
      const v = obj && obj[key] != null ? String(obj[key]).trim() : "";
      return v ? esc(v) : MISS(label);
    };
    // 银行（seller_profiles 列）
    const usdBank = issuer && issuer.usd_account ? { account: issuer.usd_account, bank: issuer.bank_name, swift: issuer.bank_swift } : null;
    const cnyBank = issuer && issuer.rmb_account ? { account: issuer.rmb_account, bank: issuer.bank_name, swift: issuer.bank_swift } : null;

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
    if (isBooking || isBlDraft || isQuote || isNonDg || isTelex) {
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

      // ── 客户报价 Freight Quote（type=freight，干净·不露成本）──
      if (isQuote) {
        const vsl = esc(p.vessel || "—"), voy = esc(p.voyage || "");
        const route = esc((p.pol || "—") + " → " + (p.pod || "—"));
        const ctr = esc(p.container_type || "—");
        const oceanUsd = p.freight_sale_usd != null ? Number(p.freight_sale_usd) : null;
        const thc = p.thc_fee != null ? Number(p.thc_fee) : null;
        const validTo = esc(p.quote_valid_to || "");
        const q = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>海运报价 — ${esc(p.bl_no||p.shipment_no||"")}</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:13px;color:#0f172a;background:#f1f5f9}
.page{max-width:210mm;margin:20px auto;padding:16mm 14mm;background:#fff;box-shadow:0 4px 32px rgba(0,0,0,.12);border-radius:8px}
.hd{border-bottom:3px solid #0ea5e9;padding-bottom:12px;margin-bottom:18px}
.hd h1{font-size:18px;color:#0c4a6e}.hd .en{font-size:11px;color:#64748b;margin-top:2px}
.title{font-size:22px;font-weight:800;color:#0ea5e9;text-align:right;margin-top:-38px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;margin:16px 0}
.grid .l{color:#64748b;font-size:11px}.grid .v{font-weight:700}
table{width:100%;border-collapse:collapse;margin:16px 0}th,td{border:1px solid #cbd5e1;padding:9px 12px;text-align:left}
th{background:#f0f9ff;color:#0c4a6e}td.r,th.r{text-align:right}
.total{background:#0ea5e9;color:#fff;font-size:18px;font-weight:800}
.note{margin-top:20px;font-size:11px;color:#64748b;line-height:1.8}</style></head><body><div class="page">
<div class="hd"><h1>${from(issuer,'name_cn','出单公司')}</h1><div class="en">${from(issuer,'name_en','英文名')} · Ocean Freight · Integrated Logistics</div></div>
<div class="title">OCEAN FREIGHT QUOTE</div>
<div class="grid"><div><div class="l">客户 Customer</div><div class="v">${esc(consignee||"—")}</div></div>
<div><div class="l">航线 Route (POL→POD)</div><div class="v">${route}</div></div>
<div><div class="l">船名航次 Vessel/Voyage</div><div class="v">${vsl} ${voy}</div></div>
<div><div class="l">柜型 Container</div><div class="v">${ctr}</div></div>
<div><div class="l">货物 Commodity</div><div class="v">${esc(blDescText)}</div></div>
<div><div class="l">报价有效期 Valid Until</div><div class="v">${validTo||"—"}</div></div></div>
<table><thead><tr><th>项目 Item</th><th class="r">金额 Amount</th></tr></thead><tbody>
<tr><td>海运费 Ocean Freight (${ctr})</td><td class="r">${oceanUsd!=null?"USD "+oceanUsd.toLocaleString():"—"}</td></tr>
<tr><td>码头操作费 THC</td><td class="r">${thc!=null?"CNY "+thc.toLocaleString():"代收代付 At cost"}</td></tr>
<tr><td>港杂费 Local Charges</td><td class="r">代收代付 At cost</td></tr>
<tr class="total"><td>合计 TOTAL (Ocean Freight)</td><td class="r">${oceanUsd!=null?"USD "+oceanUsd.toLocaleString():"—"}</td></tr></tbody></table>
<div class="note">备注 Remarks:<br>1. 以上报价仅供参考，最终以订舱确认为准 / Quote for reference, subject to booking confirmation.<br>2. 港杂费、拖车费、报关费按实代收代付 / Local charges at cost.<br>3. 海运费以美元结算 / Ocean freight settled in USD.<br><br>联系 Contact: ${from(issuer,'tel','电话')}</div>
</div></body></html>`;
        return renderHtml(res, q, format);
      }

      // ── 非危险品声明 Non-Dangerous Goods Declaration（type=nondg）──
      if (isNonDg) {
        const vsl = esc(p.vessel || "—"), voy = esc(p.voyage || "");
        const route = esc((p.pol || "—") + " → " + (p.pod || "—"));
        const today = new Date().toISOString().slice(0,10);
        const d = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>非危险品声明 — ${esc(p.bl_no||"")}</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:14px;color:#0f172a;background:#f1f5f9;line-height:1.9}
.page{max-width:210mm;margin:20px auto;padding:22mm 20mm;background:#fff;box-shadow:0 4px 32px rgba(0,0,0,.12);border-radius:8px;min-height:280mm}
.hd{text-align:center;border-bottom:2px solid #0f172a;padding-bottom:14px;margin-bottom:8px}
.hd h1{font-size:18px}.hd .en{font-size:11px;color:#64748b}
.title{text-align:center;font-size:20px;font-weight:800;margin:24px 0}
.info{margin:16px 0}.info div{margin:4px 0}.info b{display:inline-block;width:140px;color:#475569}
.body p{margin:14px 0;text-indent:0}
.sign{margin-top:60px;display:flex;justify-content:flex-end}.sign .box{width:280px}.sign .line{border-top:1px solid #0f172a;margin-top:50px;padding-top:6px;font-size:12px;color:#475569}</style></head><body><div class="page">
<div class="hd"><h1>${from(issuer,'name_cn','出单公司')}</h1><div class="en">${from(issuer,'name_en','英文名')}</div></div>
<div class="title">非危险品声明<br><span style="font-size:14px">NON-DANGEROUS GOODS DECLARATION</span></div>
<div class="info"><div><b>提单号 B/L No.:</b> ${esc(p.bl_no||"—")}</div>
<div><b>船名航次 Vessel/Voyage:</b> ${vsl} ${voy}</div>
<div><b>航线 Route:</b> ${route}</div>
<div><b>柜型柜号 Container:</b> ${esc((p.container_type||"")+" "+(p.container_no||""))||"—"}</div>
<div><b>货物 Commodity:</b> ${esc(blDescText)}</div>
<div><b>HS编码 HS Code:</b> ${esc(hsText)}</div></div>
<div class="body"><p>致 / TO: 承运人及船公司 The Carrier / Shipping Line</p>
<p>兹声明，本公司承运的上述货物（${esc(blDescText)}）经确认为<b>普通货物，非危险品</b>，不属于国际海运危险货物规则（IMDG Code）所列明的任何类别危险品，运输、装卸及储存过程中无危险性。</p>
<p>We hereby declare that the above-mentioned cargo shipped by us is <b>general cargo and NON-DANGEROUS goods</b>, not classified under any class of the IMDG Code, and poses no danger during transport, handling or storage.</p>
<p>如因本声明不实造成的一切后果及责任，由本公司承担。<br>We shall bear all consequences and liabilities arising from any misrepresentation in this declaration.</p></div>
<div class="sign"><div class="box"><div>声明单位 Declared by:</div><div class="line">${from(issuer,'name_cn','出单公司')}<br>盖章 / Authorized Signature & Stamp<br>日期 Date: ${today}</div></div></div>
</div></body></html>`;
        return renderHtml(res, d, format);
      }

      // ── 电放保函 Telex Release Letter of Indemnity（type=telex）──
      if (isTelex) {
        const vsl = esc(p.vessel || "—"), voy = esc(p.voyage || "");
        const route = esc((p.pol || "—") + " → " + (p.pod || "—"));
        const today = new Date().toISOString().slice(0,10);
        const t = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>电放保函 — ${esc(p.bl_no||"")}</title><style>
*{box-sizing:border-box;margin:0;padding:0}body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:14px;color:#0f172a;background:#f1f5f9;line-height:1.9}
.page{max-width:210mm;margin:20px auto;padding:22mm 20mm;background:#fff;box-shadow:0 4px 32px rgba(0,0,0,.12);border-radius:8px;min-height:280mm}
.hd{text-align:center;border-bottom:2px solid #0f172a;padding-bottom:14px;margin-bottom:8px}.hd h1{font-size:18px}.hd .en{font-size:11px;color:#64748b}
.title{text-align:center;font-size:20px;font-weight:800;margin:24px 0}
.info{margin:16px 0}.info div{margin:4px 0}.info b{display:inline-block;width:150px;color:#475569}
.body p{margin:14px 0}
.sign{margin-top:60px;display:flex;justify-content:flex-end}.sign .box{width:280px}.sign .line{border-top:1px solid #0f172a;margin-top:50px;padding-top:6px;font-size:12px;color:#475569}</style></head><body><div class="page">
<div class="hd"><h1>${from(issuer,'name_cn','出单公司')}</h1><div class="en">${from(issuer,'name_en','英文名')}</div></div>
<div class="title">电放保函<br><span style="font-size:14px">LETTER OF INDEMNITY FOR TELEX RELEASE</span></div>
<div class="info"><div><b>提单号 B/L No.:</b> ${esc(p.bl_no||"—")}</div>
<div><b>船名航次 Vessel/Voyage:</b> ${vsl} ${voy}</div>
<div><b>航线 Route:</b> ${route}</div>
<div><b>收货人 Consignee:</b> ${esc(consignee||"—")}</div>
<div><b>柜型柜号 Container:</b> ${esc((p.container_type||"")+" "+(p.container_no||""))||"—"}</div>
<div><b>货物 Commodity:</b> ${esc(blDescText)}</div></div>
<div class="body"><p>致 / TO: 承运人及船公司 The Carrier / Shipping Line</p>
<p>就上述提单项下货物，本公司申请办理<b>电放（Telex Release）</b>，请贵司通知目的港代理凭收货人身份放货，无需出示正本提单。</p>
<p>We hereby request <b>TELEX RELEASE</b> of the cargo under the above B/L. Please instruct your agent at destination to release the cargo to the consignee without presentation of the original Bill of Lading.</p>
<p>本公司确认已收回全套正本提单，并保证承担因电放放货引起的一切责任、索赔及费用，使贵司免受任何损失。<br>We confirm all original B/Ls have been surrendered, and shall indemnify and hold you harmless against all liabilities, claims and costs arising from such telex release.</p></div>
<div class="sign"><div class="box"><div>申请单位 Applicant:</div><div class="line">${from(issuer,'name_cn','出单公司')}<br>盖章 / Authorized Signature & Stamp<br>日期 Date: ${today}</div></div></div>
</div></body></html>`;
        return renderHtml(res, t, format);
      }


      if (isBooking) {
      // ── v4 booking note ──
      const raw4       = p.raw || {};
      const tradeTerm  = raw4.tradeTerm  || "EXW";
      const releaseType= p.release_type  || (raw4.telexRelease ? "telex" : "obl");
      const freightCC  = (raw4.freightTerms || "Collect").toLowerCase().includes("collect");
      const cargoReady = raw4.cargoReadyDate || "";
      const bookingRef = p.forwarder_booking_no || raw4.bookingNo || "";
      const fwdMark    = raw4.forwarderMark || "";
      const ctrQty     = raw4.containerQty || 1;
      const ctrType    = p.container_type  || "—";
      const ctrNo      = p.container_no    || "TBC";
      const customsBroker = p.customs_cn   || raw4.supplierCustoms || "—";
      const truckingCo    = p.trucking_cn  || raw4.supplierTrucking|| "—";
      const fwdCo         = p.forwarder_cn || raw4.supplierFreight || "—";
      const issuingName   = p.shipper || raw4.issuingCompanyEN || issuingCoEN;
      const refNo         = p._id || p.shipment_no || "—";
      // checkbox helpers
      const cb  = (on) => on ? `<span class="cb-box ck">✓</span>` : `<span class="cb-box"></span>`;
      const tag = (txt,cls) => `<span class="tag ${cls}">${txt}</span>`;

      const html = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>托书 — ${esc(refNo)}</title><style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:12px;color:#0f172a;background:#f1f5f9}
.page{max-width:210mm;margin:20px auto;padding:14mm 12mm 12mm;background:#fff;box-shadow:0 4px 32px rgba(0,0,0,.12);border-radius:8px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;padding-bottom:10px;border-bottom:2px solid #1e3a8a}
.doc-t{font-size:17px;font-weight:800;color:#1e3a8a}.ref-no{font-family:monospace;font-size:12px;font-weight:700;background:#eff6ff;padding:2px 9px;border-radius:4px;border:1px solid #bfdbfe;display:inline-block;margin-top:4px}
.gen-t{font-size:9px;color:#94a3b8;margin-top:3px}
.co-r{text-align:right}.co-name{font-size:15px;font-weight:900;color:#1e3a8a}.co-os{color:#3b82f6}.co-sub{font-size:9px;color:#94a3b8;margin-top:2px}
.main{display:grid;grid-template-columns:1fr 190px;border:1px solid #cbd5e1}
.lc{border-right:1px solid #cbd5e1}.pb{padding:8px 10px;border-bottom:1px solid #e2e8f0}.pb:last-child{border-bottom:none}
.pl{font-size:9px;font-weight:700;color:#1e3a8a;text-transform:uppercase;letter-spacing:.07em;margin-bottom:3px;padding-bottom:3px;border-bottom:.5px solid #e2e8f0}
.pn{font-size:12px;font-weight:700;color:#0f172a;line-height:1.5}.pa{font-size:10.5px;color:#334155;line-height:1.5;margin-top:2px}
.rc{}.rr{padding:6px 10px;border-bottom:1px solid #e2e8f0;min-height:30px}.rr:last-child{border-bottom:none}
.rl{font-size:8.5px;font-weight:700;color:#1e3a8a;text-transform:uppercase;letter-spacing:.06em}
.rv{font-size:11px;font-weight:700;color:#0f172a;font-family:monospace;margin-top:2px}.rv.n{font-family:inherit}
.route{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid #cbd5e1;border-top:none}
.rc2{padding:7px 10px;border-right:1px solid #e2e8f0}.rc2:last-child{border-right:none}
.rl2{font-size:8.5px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.05em}
.rv2{font-size:12px;font-weight:700;color:#0f172a;font-family:monospace;margin-top:2px}
.cargo-w{border:1px solid #cbd5e1;border-top:none}
table{width:100%;border-collapse:collapse}
thead th{background:#1e3a8a;color:#fff;padding:6px 10px;text-align:left;font-size:8.5px;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
thead th.r{text-align:right}tbody td{padding:7px 10px;border-bottom:.5px solid #e2e8f0;font-size:11px;vertical-align:top}
tfoot td{padding:7px 10px;font-weight:700;background:#eff6ff;border-top:1.5px solid #1e3a8a;font-size:11px}
.hs{font-family:monospace;font-size:10px;color:#475569;margin-top:3px}
.redbox{border:2px solid #dc2626;border-radius:6px;padding:8px 12px;margin-top:12px}
.rbt{font-size:9.5px;font-weight:800;color:#dc2626;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px}
.rb-r{display:flex;align-items:center;gap:16px;padding:4px 0;border-bottom:.5px solid #fee2e2;flex-wrap:wrap}
.rb-r:last-child{border-bottom:none}
.rbl{font-size:9.5px;font-weight:700;color:#0f172a;min-width:100px;white-space:nowrap}
.cbg{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.cb{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600}
.cb-box{width:13px;height:13px;border:1.5px solid #94a3b8;border-radius:2px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;flex-shrink:0}
.cb-box.ck{border-color:#000;background:#000;color:#fff;font-weight:900}
.pay{margin-top:10px;padding:8px 12px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px}
.pay-t{font-size:9px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.06em;margin-bottom:7px}
.pay-g{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px}
.pi{display:flex;align-items:center;gap:8px}.pl2{font-size:10px;font-weight:700;color:#0f172a;min-width:88px}
.svc{display:flex;gap:0;border:1px solid #e2e8f0;border-radius:6px;overflow:hidden;margin-top:10px}
.si{flex:1;padding:8px 4px;text-align:center;border-right:1px solid #e2e8f0}.si:last-child{border-right:none}
.si.on{background:#f0fdf4}.si.off{background:#f8fafc;opacity:.55}
.si-i{font-size:15px;margin-bottom:3px}.si-n{font-size:10px;font-weight:700;color:#0f172a}.si-s{font-size:8.5px;color:#64748b}
.sig4{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:12px;margin-top:16px}
.sb{border-top:1px solid #cbd5e1;padding-top:6px;text-align:center}.sb.cr{border-top:1px solid #fbbf24;background:#fffbeb;border-radius:0 0 4px 4px}
.sl{height:28px;border-bottom:1px dashed #e2e8f0;margin:6px 0}
.slb{font-size:8.5px;color:#94a3b8;font-weight:600;text-transform:uppercase}
.footer{margin-top:12px;padding-top:8px;border-top:.5px solid #e2e8f0;display:flex;justify-content:space-between;font-size:8.5px;color:#94a3b8}
.tag{display:inline-block;font-size:10px;font-weight:700;padding:2px 8px;border-radius:4px}
.tb{background:#eff6ff;color:#1e3a8a;border:1px solid #bfdbfe}.tg{background:#f0fdf4;color:#166534;border:1px solid #bbf7d0}
@media print{@page{size:A4;margin:0}body{background:#fff;padding:0}.page{padding:10mm 10mm 8mm;max-width:none;box-shadow:none;border-radius:0}.no-print{display:none!important}}
@media screen{.print-btn{position:fixed;top:20px;right:20px;padding:10px 20px;background:#1e3a8a;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(30,58,138,.4);z-index:1000}}
</style></head><body>
<div class="page">

<div class="hdr">
  <div>
    <div class="doc-t">📋 托书 Booking Note</div>
    <div class="ref-no">${esc(refNo)}</div>
    <div class="gen-t">${genDate} · Generated: ${generatedAt}</div>
  </div>
  <div class="co-r">
    <div class="co-name">Sanlyn <span class="co-os">OS</span></div>
    <div class="co-sub">Booking Note · Auto Generated</div>
    <div class="co-sub">sanlyn.cn</div>
  </div>
</div>

<div class="main">
  <div class="lc">
    <div class="pb"><div class="pl">发货人 Shipper</div><div class="pn">${esc(issuingName)}</div><div class="pa">${esc(issuingCoAddr)}</div></div>
    <div class="pb"><div class="pl">收货人 Consignee</div><div class="pn">${esc(consignee)}</div><div class="pa">${esc(consigneeAddr)}</div></div>
    <div class="pb" style="min-height:56px"><div class="pl">通知人 Notify Party</div><div class="pn" style="color:#475569;font-weight:500">SAME AS CONSIGNEE</div></div>
  </div>
  <div class="rc">
    <div class="rr"><div class="rl">外运编号 Booking Ref</div><div class="rv">${esc(bookingRef)}</div></div>
    <div class="rr"><div class="rl">货代标识 Forwarder</div><div class="rv">${esc(fwdMark||fwdCo)}</div></div>
    <div class="rr"><div class="rl">报关地点 Customs</div><div class="rv n">${esc(p.pol||"厦门")}</div></div>
    <div class="rr"><div class="rl">报关行 Broker</div><div class="rv n">${esc(customsBroker)}</div></div>
    <div class="rr"><div class="rl">操作 Ops Contact</div><div class="rv n" style="color:#94a3b8">—</div></div>
    <div class="rr"><div class="rl">单证 Doc Contact</div><div class="rv n" style="color:#94a3b8">—</div></div>
  </div>
</div>

<div class="route">
  <div class="rc2"><div class="rl2">起运港 POL</div><div class="rv2 n">${esc(p.pol||"—")}${raw4.terminal?` (${esc(raw4.terminal)})`:"" }</div></div>
  <div class="rc2"><div class="rl2">目的港 POD</div><div class="rv2 n">${esc(p.pod||"—")}</div></div>
  <div class="rc2"><div class="rl2">船名/航次 Vessel/Voyage</div><div class="rv2">${esc(p.vessel||"—")} / ${esc(p.voyage||"—")}</div></div>
  <div class="rc2"><div class="rl2">ETD 预计开船</div><div class="rv2">${fmtDate(p.etd)}</div></div>
</div>

<div class="cargo-w">
  <table>
    <thead>
      <tr>
        <th style="width:55px">唛头 Mark</th>
        <th style="width:80px">件数 Packages</th>
        <th>货物名称及HS Code Description &amp; HS</th>
        <th class="r" style="width:90px">毛重 G.W.</th>
        <th class="r" style="width:80px">体积 CBM</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="color:#94a3b8">N/M</td>
        <td style="font-weight:700">${esc(qtyText)}</td>
        <td><div style="font-weight:700">${esc(blDescText)}</div><div class="hs">HS: ${esc(hsText)}</div></td>
        <td style="text-align:right;font-weight:700">${esc(gwText)}</td>
        <td style="text-align:right;font-weight:700">${esc(cbmText)}</td>
      </tr>
      <tr><td></td><td></td><td></td><td></td><td></td></tr>
      <tr><td></td><td></td><td></td><td></td><td></td></tr>
      <tr><td></td><td></td><td></td><td></td><td></td></tr>
    </tbody>
    <tfoot><tr>
      <td></td><td style="font-weight:700">${esc(qtyText)}</td>
      <td style="text-align:right;color:#475569">合计 TOTAL</td>
      <td style="text-align:right">${esc(gwText)}</td>
      <td style="text-align:right">${esc(cbmText)}</td>
    </tr></tfoot>
  </table>
</div>

<div class="redbox">
  <div class="rbt">⚠ 确认事项 Declarations</div>
  <div class="rb-r" style="background:#fffbeb;margin:-4px -4px 6px;padding:7px 10px;border-radius:4px;border:1.5px solid #fbbf24!important">
    <span class="rbl" style="color:#92400e">📦 货好时间 Cargo Ready</span>
    <span style="font-size:13px;font-weight:900;color:#92400e;font-family:monospace;border-bottom:1.5px solid #d97706;padding-bottom:1px;min-width:110px">${cargoReady||"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"}</span>
    <span style="font-size:9px;color:#b45309;margin-left:auto">如来不及请提前告知</span>
  </div>
  <div class="rb-r">
    <span class="rbl">贸易条款 Terms</span>
    <div class="cbg">
      <span class="cb">${cb(tradeTerm==="FOB")} FOB</span>
      <span class="cb">${cb(tradeTerm==="EXW")} EXW</span>
      <span class="cb">${cb(tradeTerm==="CIF")} CIF</span>
      <span class="cb">${cb(tradeTerm==="CNF")} CNF</span>
      <span class="cb">${cb(!["FOB","EXW","CIF","CNF"].includes(tradeTerm))} 其他</span>
    </div>
    <span class="rbl" style="margin-left:20px">拖车/报关</span>
    <div class="cbg">
      <span class="cb">${cb(true)} 自拖自报</span>
      <span class="cb">${cb(false)} 代拖代报</span>
    </div>
  </div>
  <div class="rb-r">
    <span class="rbl">危险品/电池/液体</span>
    <div class="cbg">
      <span class="cb">${cb(false)} YES<span style="font-size:8.5px;color:#94a3b8">(需MSDS)</span></span>
      <span class="cb">${cb(true)} NO</span>
    </div>
    <span class="rbl" style="margin-left:20px">实木/木架/托盘</span>
    <div class="cbg">
      <span class="cb">${cb(false)} YES</span>
      <span class="cb">${cb(true)} NO</span>
      <span style="font-size:9px;color:#94a3b8">熏蒸:</span>
      <span class="cb">${cb(false)} YES</span>
      <span class="cb">${cb(false)} NO</span>
    </div>
  </div>
  <div class="rb-r">
    <span class="rbl">箱型箱量 Container</span>
    <span style="font-family:monospace;font-weight:700;font-size:12px">${esc(ctrType)} × ${ctrQty}</span>
    <span style="color:#94a3b8;font-size:9px;margin-left:8px">柜号: ${esc(ctrNo)}</span>
  </div>
</div>

<div class="pay">
  <div class="pay-t">付款方式 Payment Terms</div>
  <div class="pay-g">
    <div class="pi"><span class="pl2">海运费 Ocean Freight</span>
      <div class="cbg"><span class="cb">${cb(!freightCC)} PREPAID</span><span class="cb">${cb(freightCC)} CC 到付</span></div></div>
    <div class="pi"><span class="pl2">目的港费 DTHC</span>
      <div class="cbg"><span class="cb">${cb(!freightCC)} PREPAID</span><span class="cb">${cb(freightCC)} CC 到付</span></div></div>
    <div class="pi"><span class="pl2">提单类型 B/L</span>
      <div class="cbg">
        <span class="cb">${cb(releaseType==="obl")} 正本 OBL</span>
        <span class="cb">${cb(releaseType==="telex")} 电放 Telex</span>
        <span class="cb">${cb(releaseType==="swb")} SWB</span>
      </div></div>
  </div>
</div>

<div class="svc">
  <div class="si on"><div class="si-i">✅</div><div class="si-n">订舱</div><div class="si-s">Booking</div></div>
  <div class="si on"><div class="si-i">✅</div><div class="si-n">VGM 委托</div><div class="si-s">VGM by Agent</div></div>
  <div class="si off"><div class="si-i">⬜</div><div class="si-n">拖车 (自理)</div><div class="si-s">Own Trucking</div></div>
  <div class="si off"><div class="si-i">⬜</div><div class="si-n">报关 (自理)</div><div class="si-s">Own Customs</div></div>
  <div class="si off"><div class="si-i">⬜</div><div class="si-n">装箱 (自理)</div><div class="si-s">Own Stuffing</div></div>
</div>

<div class="sig4">
  <div class="sb"><div class="sl"></div><div class="slb">制单 Prepared By</div></div>
  <div class="sb"><div class="sl"></div><div class="slb">货代确认 Forwarder</div></div>
  <div class="sb"><div class="sl"></div><div class="slb">日期 Date</div></div>
  <div class="sb cr">
    <div style="font-size:13px;font-weight:900;color:#92400e;font-family:monospace;line-height:28px">${cargoReady||"&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;"}</div>
    <div style="font-size:8.5px;color:#b45309;font-weight:700;text-transform:uppercase">📦 货好时间 Cargo Ready</div>
    <div style="font-size:8px;color:#d97706">如来不及请提前告知</div>
  </div>
</div>

<div class="footer">
  <span style="font-weight:700;color:#475569">${esc(issuingName)}</span>
  <span>Booking Note · ${esc(refNo)} · ${genDate}</span>
</div>

</div>${autoprint}</body></html>`;

      return renderHtml(res, html, format);
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
      // BL merge: when ?bl= is used, aggregate across all sibling plans sharing this BL.
      // Primary plan = row with highest container_qty (already sorted first by query).
      // Use primary for all shipping logistics info; aggregate order_nos from all siblings.
      const _primaryPlan = blSiblingPlans[0];
      const _mergedOrderNos = [...new Set(
        blSiblingPlans.flatMap(sp => sp.order_nos || []).map(stripCompanyPrefix).filter(Boolean)
      )];

      const invoiceNo = 'FI-' + (p.bl_no || p.shipment_no || String(p.id)) + '-' + genDate.replace(/-/g,'');
      const rawCostLines = Array.isArray(_primaryPlan.raw?.cost_lines) ? _primaryPlan.raw.cost_lines : [];

      // When port_surcharge_total is set, show as single bundled line; do not also list individual thc/eir/seal/doc/bkg components (avoids double-count)
      const _portTotal = Number(_primaryPlan.port_surcharge_total || 0);
      // Opt-in: CNY local charges only appear when incoterm is CIF/CFR/DDP/DAP.
      // FOB/EXW/NULL (unknown) → safe default: ocean freight USD only.
      const _term = (_primaryPlan.freight_term || '').trim().toUpperCase();
      const _isCifCfr = /^(CIF|CFR|CNF|C&F|DDP|DAP)$/.test(_term);
      const fallbackCostLines = [
        { name: 'Ocean Freight 海运费', amount: _primaryPlan.freight_sale_usd, currency: 'USD', remark: '' },
        ...(_isCifCfr && _portTotal > 0
          ? [{ name: '港杂费 Port Charges', amount: _primaryPlan.port_surcharge_total, currency: 'CNY', remark: '' }]
          : _isCifCfr
            ? [
                { name: 'THC Fee', amount: _primaryPlan.thc_fee, currency: 'CNY', remark: '' },
                { name: 'EIR Fee', amount: _primaryPlan.eir_fee, currency: 'CNY', remark: '' },
                { name: 'Seal Fee', amount: _primaryPlan.seal_fee, currency: 'CNY', remark: '' },
                { name: '订舱费 Booking Fee', amount: _primaryPlan.bkg_fee, currency: 'CNY', remark: '' },
                { name: '单证费 Document Fee', amount: _primaryPlan.doc_fee, currency: 'CNY', remark: '' },
                { name: 'TLX Fee', amount: _primaryPlan.tlx_fee, currency: 'CNY', remark: '' },
                { name: '报关服务费 Customs Service', amount: _primaryPlan.customs_cost_total, currency: 'CNY', remark: '' },
              ]
            : []  // FOB/EXW/NULL: no CNY charges on customer invoice
        ),
        ...(_isCifCfr ? [{ name: '拖车费 Trucking', amount: _primaryPlan.trucking_cost_total, currency: 'CNY', remark: '' }] : []),
        { name: '保险费 Insurance', amount: _primaryPlan.insurance_cost, currency: 'CNY', remark: '' },
      ];

      const feeLines = (rawCostLines.length
        ? rawCostLines.map(line => ({ name: line.name || 'Freight Charge', amount: line.sale, currency: line.currency || 'CNY', remark: line.remark || '' }))
        : fallbackCostLines
      ).filter(line => Number(line.amount || 0) !== 0);

      const _ctnQtyForTotal = parseInt(_primaryPlan.container_qty || _primaryPlan.raw?.containers?.length || 1);
      const usdTotal = feeLines.filter(line => String(line.currency||'').toUpperCase()==='USD').reduce((sum,line)=>sum+Number(line.amount||0)*_ctnQtyForTotal,0);
      const cnyTotal = feeLines.filter(line => String(line.currency||'').toUpperCase()!=='USD').reduce((sum,line)=>sum+Number(line.amount||0),0);

      // Prefer container_bookings for multi-container plans; use primaryPlan as the source
      let _fiBkgs = [];
      try {
        // Collect container_bookings from ALL sibling plans (covers BL-merge case)
        const _siblingIds = blSiblingPlans.map(sp => sp.id);
        const _ph = _siblingIds.map((_, i) => `$${i + 1}`).join(',');
        const _fbRes = await pool.query(
          `SELECT container_no, seal_no, contract_no, cargo_weight_kg::numeric AS gross_weight_kg, container_type
           FROM container_bookings WHERE shipping_plan_id IN (${_ph}) ORDER BY shipping_plan_id, id`,
          _siblingIds
        );
        _fiBkgs = _fbRes.rows;
      } catch(_) {}
      const _perCtnCartons = _primaryPlan.total_cartons && _fiBkgs.length > 1 ? Math.round(parseInt(_primaryPlan.total_cartons) / _fiBkgs.length) : null;
      const _perCtnCBM     = _primaryPlan.total_cbm     && _fiBkgs.length > 1 ? parseFloat(_primaryPlan.total_cbm) / _fiBkgs.length : null;
      const containers = _fiBkgs.length > 1
        ? _fiBkgs.map(cb => ({
            container_no: cb.container_no,
            seal_no: cb.seal_no,
            po: stripCompanyPrefix(cb.contract_no),
            gross_weight_kg: cb.gross_weight_kg,
            cartons: _perCtnCartons,
            cbm: _perCtnCBM != null ? parseFloat(_perCtnCBM.toFixed(3)) : null,
            container_type: cb.container_type,
          }))
        : Array.isArray(_primaryPlan.raw?.containers) ? _primaryPlan.raw.containers
        : [{ container_no: _primaryPlan.container_no, seal_no: _primaryPlan.seal_no, container_type: _primaryPlan.container_type, gross_weight_kg: _primaryPlan.gross_weight_kg, cbm: _primaryPlan.total_cbm, cartons: _primaryPlan.total_cartons }];
      // PO list: use merged order nos from all sibling plans (already stripped of prefix)
      // Fall back to raw.customerPO of primary plan if no merged list
      const _allPos = _mergedOrderNos.length > 0
        ? _mergedOrderNos
        : (_primaryPlan.raw?.customerPO || '').split(/[,，]\s*/).map(s => s.trim()).filter(Boolean);

      // FX rate for payment box
      let fxRate = 7.0;
      try {
        const fxRes2 = await pool.query(`SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' ORDER BY fetched_at DESC LIMIT 1`);
        if (fxRes2.rows.length) fxRate = Math.round((parseFloat(fxRes2.rows[0].rate) + 0.1) * 10000) / 10000;
      } catch(_) {}
      const cnyEquiv = Math.round(usdTotal * fxRate * 100) / 100;

      // Issuer / bank
      const issuerNameEN = (issuer && issuer.name_en) || 'SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.';
      const issuerNameCN = (issuer && issuer.name_cn) || '上海洋宝宝国际物流有限公司';
      const bankName   = (issuer && issuer.bank_name)    || 'BANK OF CHINA XIAMEN BRANCH';
      const bankSwift  = (issuer && issuer.bank_swift)   || 'BKCHCNBI73A';
      const bankAddr   = (issuer && issuer.bank_addr)    || 'No. 40 North Hubin Road, Xiamen';
      const usdAcct    = (issuer && issuer.usd_account)  || '433849630299';
      const cnyAcct    = (issuer && issuer.rmb_account)  || '433849860868';

      // Container rows
      let ctnSumCTN = 0, ctnSumGW = 0, ctnSumCBM = 0;
      const ctnRowsHtml = containers.map((c, i) => {
        const ctns = c.cartons       ? parseInt(c.cartons)            : (i===0 && p.total_cartons   ? parseInt(p.total_cartons)   : null);
        const gw   = c.gross_weight_kg ? parseFloat(c.gross_weight_kg) : (i===0 && p.gross_weight_kg ? parseFloat(p.gross_weight_kg) : null);
        const cbm  = c.cbm           ? parseFloat(c.cbm)             : (i===0 && p.total_cbm       ? parseFloat(p.total_cbm)       : null);
        ctnSumCTN += ctns || 0; ctnSumGW += gw || 0; ctnSumCBM += cbm || 0;
        const po = c.po || _allPos[i] || p.contract_no || '—';
        return `<tr style="border-bottom:1px solid #efefef">
          <td style="padding:5px 8px;color:#888;font-size:9px">Container ${i+1}</td>
          <td style="padding:5px 8px;font-family:monospace;font-weight:800;font-size:10px">${esc(c.container_no||'')}</td>
          <td style="padding:5px 8px;font-family:monospace;color:#555;font-size:9.5px">${esc(c.seal_no||'')}</td>
          <td style="padding:5px 8px;font-weight:700;font-size:9.5px">${esc(String(po))}</td>
          <td style="padding:5px 8px;font-family:monospace;text-align:right;font-size:9.5px">${ctns != null ? fmtNum(ctns,0) : '—'}</td>
          <td style="padding:5px 8px;font-family:monospace;text-align:right;font-size:9.5px">${gw  != null ? fmtNum(gw) +' KGS' : '—'}</td>
          <td style="padding:5px 8px;font-family:monospace;text-align:right;font-size:9.5px">${cbm != null ? fmtNum(cbm,3)+' CBM' : '—'}</td>
        </tr>`;
      }).join('');
      // container_bookings is authoritative; for BL-merge, all sibling bookings are already in _fiBkgs
      const ctnQtyFI = _fiBkgs.length > 0 ? _fiBkgs.length : parseInt(_primaryPlan.container_qty || containers.length || 1);
      const ctnTypeFI = _primaryPlan.container_type || '40HQ';

      // Charge rows — USD section first, then CNY
      const usdLines = feeLines.filter(l => String(l.currency||'').toUpperCase()==='USD');
      const cnyLines = feeLines.filter(l => String(l.currency||'').toUpperCase()!=='USD');
      let chargeRowsHtml = '';
      if (usdLines.length) {
        chargeRowsHtml += `<tr class="section"><td colspan="6">Ocean Freight | 海运费</td></tr>`;
        chargeRowsHtml += usdLines.map(l => `<tr>
          <td class="label">${esc(l.name)}</td><td>Per Container / 箱</td>
          <td class="c">USD</td><td class="c">${ctnQtyFI}</td>
          <td class="r">${fmtNum(l.amount)}</td><td class="r">${fmtNum(l.amount * ctnQtyFI)}</td></tr>`).join('');
      }
      if (cnyLines.length) {
        chargeRowsHtml += `<tr class="section"><td colspan="6">Local Charges | 港杂及其他费用</td></tr>`;
        chargeRowsHtml += cnyLines.map(l => `<tr>
          <td class="label">${esc(l.name)}</td><td>—</td>
          <td class="c">CNY</td><td class="c">1</td>
          <td class="r">${fmtNum(l.amount)}</td><td class="r">${fmtNum(l.amount)}</td></tr>`).join('');
      }

      const custNameFI = cust ? (cust.name_en || cust.name_cn || '') : (_primaryPlan.customer_en || '');
      const vesselFI   = [_primaryPlan.vessel, _primaryPlan.voyage].filter(Boolean).join(' / ') || '—';
      const _freightTermDisplay = (_primaryPlan.freight_term || '').trim().toUpperCase() || 'PREPAID';

      const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>Freight Invoice ${esc(invoiceNo)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:11px;color:#111;background:#e5e7eb;padding:0}
.page{max-width:200mm;margin:14px auto;padding:11mm 13mm;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:14px}
.hdr-l .co-en{font-size:15px;font-weight:900;color:#111;letter-spacing:.01em;line-height:1.2}
.hdr-l .co-cn{font-size:10px;color:#555;margin-top:3px}
.hdr-l .tag{font-size:8.5px;color:#888;margin-top:4px}
.hdr-r{text-align:right}
.hdr-r .doc-en{font-size:18px;font-weight:900;color:#111;letter-spacing:.05em}
.hdr-r .doc-cn{font-size:10px;color:#555;margin-top:1px}
.hdr-r .inv-no{display:inline-block;font-size:11px;font-weight:800;color:#111;font-family:monospace;border:2px solid #111;border-radius:3px;padding:2px 9px;margin-top:4px;letter-spacing:.03em}
.info-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:0 12px;margin-bottom:12px;border:1px solid #e0e0e0;border-radius:4px;overflow:hidden}
.info-box{font-size:10px}
.info-box .row{display:grid;grid-template-columns:118px 1fr;border-bottom:1px solid #efefef;min-height:22px}
.info-box .row:last-child{border-bottom:none}
.info-box .lbl{background:#f7f7f7;color:#666;font-weight:700;padding:4px 8px;border-right:1px solid #efefef;display:flex;align-items:center}
.info-box .val{color:#111;font-weight:600;padding:4px 8px;display:flex;align-items:center}
.info-box .val.big{font-size:12px;font-weight:900}
table.charges{width:100%;border-collapse:collapse;margin-bottom:0;font-size:10px;border:1px solid #ccc}
table.charges thead th{background:#111;color:#fff;padding:7px 9px;text-align:left;font-weight:700;font-size:9.5px;letter-spacing:.04em}
table.charges thead th.r{text-align:right}
table.charges thead th.c{text-align:center}
table.charges tr.section td{background:#333;color:#fff;font-weight:800;letter-spacing:.05em;font-size:9.5px;text-transform:uppercase;padding:5px 9px}
table.charges tbody td{padding:7px 9px;border-bottom:1px solid #efefef;font-family:monospace;color:#111}
table.charges tbody td.label{font-family:inherit;color:#222}
table.charges tbody td.r{text-align:right}
table.charges tbody td.c{text-align:center}
table.charges tfoot{border-top:2px solid #111}
table.charges tfoot tr td{padding:7px 9px;font-weight:800;font-family:monospace;color:#111;background:#f7f7f7}
table.charges tfoot tr.total-usd td{font-size:12px;color:#111}
table.charges tfoot tr td:last-child{text-align:right}
table.charges tfoot tr td.label{font-family:inherit;text-align:right;font-size:10px}
.fx-note{font-size:8.5px;color:#666;text-align:right;margin:6px 0 10px;font-style:italic}
.fx-note strong{color:#111;font-style:normal}
.pay-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.pay-box{padding:12px 14px;border-radius:4px;border:2px solid #111}
.pay-box.usd{background:#f7f7f7}
.pay-box.cny{background:#efefef}
.pay-box .plbl{font-size:8.5px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;color:#111;margin-bottom:5px}
.pay-box .pamt{font-size:20px;font-weight:900;font-family:monospace;color:#111;letter-spacing:.01em}
.pay-box .psub{font-size:8px;color:#666;margin-top:3px}
.bottom{display:grid;grid-template-columns:1.05fr 1fr;gap:10px;margin-top:0}
.box-tt,.box-bk{padding:9px 11px;background:#f9f9f9;border:1px solid #ddd;border-radius:4px;font-size:9px;line-height:1.8;color:#444}
.box-tt strong,.box-bk strong{color:#111}
.box-tt .title,.box-bk .title{font-size:9.5px;font-weight:900;color:#111;letter-spacing:.05em;margin-bottom:4px;text-transform:uppercase;border-bottom:1px solid #ddd;padding-bottom:3px}
.warn{color:#c00;font-size:8px}
.footer-bar{display:flex;justify-content:space-between;margin-top:10px;padding-top:6px;border-top:1px solid #ddd;font-size:8px;color:#999;font-family:monospace}
@media print{body{padding:0;background:#fff}.page{margin:0;padding:8mm 10mm;box-shadow:none;max-width:none}}
@media screen{body{background:#f1f5f9}.page{box-shadow:0 4px 32px rgba(0,0,0,.12);margin:20px auto;border-radius:8px}}
</style></head>
<body>
<div class="page">
  <div class="hdr">
    <div class="hdr-l">
      <div class="co-en">${esc(issuerNameEN)}</div>
      <div class="co-cn">${esc(issuerNameCN)}</div>
      <div class="tag">Ocean Freight · Air Freight · Express · Integrated Logistics Solutions</div>
    </div>
    <div class="hdr-r">
      <div class="doc-en">INVOICE</div>
      <div class="doc-cn">运费发票</div>
      <div class="inv-no">No. ${esc(invoiceNo)}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <div class="row"><div class="lbl">TO (客户名称):</div><div class="val big">${esc(custNameFI)}</div></div>
      <div class="row"><div class="lbl">SHPT MODE:</div><div class="val">Sea Export</div></div>
      <div class="row"><div class="lbl">INV/BL NO.:</div><div class="val">${esc(_primaryPlan.bl_no||'—')}</div></div>
      <div class="row"><div class="lbl">P.O.L (起运港):</div><div class="val">${esc(_primaryPlan.pol||'—')}</div></div>
    </div>
    <div class="info-box">
      <div class="row"><div class="lbl">DATE (出单日期):</div><div class="val">${esc(genDate)}</div></div>
      <div class="row"><div class="lbl">Vessel/Voyage (船名航次):</div><div class="val">${esc(vesselFI)}</div></div>
      <div class="row"><div class="lbl">ETD (离港日):</div><div class="val">${fmtDate(_primaryPlan.etd)}</div></div>
      <div class="row"><div class="lbl">P.O.D (目的港):</div><div class="val">${esc(_primaryPlan.pod||'—')}</div></div>
    </div>
  </div>

  <div style="margin-bottom:12px;border:1px solid #ddd;border-radius:4px;overflow:hidden;font-size:10px">
    <div style="background:#111;color:#fff;font-weight:800;font-size:9.5px;letter-spacing:.05em;padding:6px 10px;display:flex;justify-content:space-between;align-items:center">
      <span>Containers / 集装箱明细 (${ctnQtyFI} × ${esc(ctnTypeFI)})</span>
      <span style="font-weight:700;letter-spacing:.03em">Freight Term: ${esc(_freightTermDisplay)}</span>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#333;color:#fff;font-size:9px;font-weight:700;letter-spacing:.03em">
          <th style="padding:5px 8px;text-align:left;width:70px">Container #</th>
          <th style="padding:5px 8px;text-align:left;width:120px">Container No.</th>
          <th style="padding:5px 8px;text-align:left;width:100px">Seal No.</th>
          <th style="padding:5px 8px;text-align:left;width:90px">PO / 合同号</th>
          <th style="padding:5px 8px;text-align:right;width:70px">CTN</th>
          <th style="padding:5px 8px;text-align:right;width:95px">Gross Weight</th>
          <th style="padding:5px 8px;text-align:right;width:75px">Volume</th>
        </tr>
      </thead>
      <tbody>${ctnRowsHtml}</tbody>
      <tfoot>
        <tr style="background:#f7f7f7;font-weight:900;border-top:2px solid #111;font-size:9.5px">
          <td style="padding:6px 8px;color:#666;font-size:9px">${ctnQtyFI} × ${esc(ctnTypeFI)}</td>
          <td style="padding:6px 8px" colspan="3"></td>
          <td style="padding:6px 8px;text-align:right;font-family:monospace">${ctnSumCTN > 0 ? fmtNum(ctnSumCTN,0) : '—'}</td>
          <td style="padding:6px 8px;text-align:right;font-family:monospace">${ctnSumGW  > 0 ? fmtNum(ctnSumGW) +' KGS' : '—'}</td>
          <td style="padding:6px 8px;text-align:right;font-family:monospace">${ctnSumCBM > 0 ? fmtNum(ctnSumCBM,3)+' CBM' : '—'}</td>
        </tr>
      </tfoot>
    </table>
  </div>

  <table class="charges">
    <thead>
      <tr>
        <th style="width:36%">Charge Item (费用明细)</th>
        <th style="width:18%">Charge Unit / 计费单位</th>
        <th class="c" style="width:10%">Currency / 币种</th>
        <th class="c" style="width:8%">Qty / 数量</th>
        <th class="r" style="width:12%">Price / 单价</th>
        <th class="r" style="width:16%">Amount / 合计</th>
      </tr>
    </thead>
    <tbody>${chargeRowsHtml}</tbody>
    <tfoot>
      ${usdTotal > 0 ? `<tr class="total-usd"><td class="label" colspan="5">TOTAL USD (美元合计)</td><td>$ ${fmtNum(usdTotal)}</td></tr>` : ''}
      ${cnyTotal > 0 ? `<tr><td class="label" colspan="5">TOTAL CNY (人民币合计)</td><td>¥ ${fmtNum(cnyTotal)}</td></tr>` : ''}
    </tfoot>
  </table>

  <div class="fx-note">* Please remit the full amount in ONE of the following currencies. / 请选择以下一种币种全额支付。</div>
  <div class="fx-note">开票日期汇率 Invoice Date Rate (<strong>${esc(genDate)}</strong>): <strong>1 USD = ${fxRate} CNY</strong></div>

  <div class="pay-grid">
    <div class="pay-box usd">
      <div class="plbl">TOTAL PAYABLE IN USD · 如全用美元支付</div>
      <div class="pamt">$ ${fmtNum(usdTotal)}</div>
      <div class="psub">Ocean freight only · Remit to USD A/C below</div>
    </div>
    <div class="pay-box cny">
      <div class="plbl">TOTAL PAYABLE IN CNY · 如全用人民币支付</div>
      <div class="pamt">¥ ${fmtNum(cnyEquiv + cnyTotal)}</div>
      <div class="psub">USD ${fmtNum(usdTotal)} × ${fxRate}${cnyTotal > 0 ? ' + ¥ '+fmtNum(cnyTotal)+' (local charges)' : ''} = ¥ ${fmtNum(cnyEquiv + cnyTotal)}</div>
    </div>
  </div>

  <div class="bottom">
    <div class="box-tt">
      <div class="title">TERMS &amp; CONDITIONS (法律声明与条款)</div>
      1. PAYMENT DUE: Please arrange payment strictly within the agreed credit term. Late payment may result in delayed release of the Bill of Lading or cargo.<br>
      2. EXCHANGE RATE: For USD charges settled in RMB, the exchange rate shall be subject to our company's notification.<br>
      3. LIABILITY: All business is transacted under our Standard Trading Conditions.
    </div>
    <div class="box-bk">
      <div class="title">BANKING INFORMATION (银行信息)</div>
      Bank Name: <strong>${esc(bankName)}</strong><br>
      Account Name: <strong>${esc(issuerNameEN)}</strong><br>
      Swift Code: <strong>${esc(bankSwift)}</strong><br>
      Bank Addr: ${esc(bankAddr)}<br>
      USD Account (美金账号): <strong>${esc(usdAcct)}</strong><br>
      CNY Account (人民币账号): <strong>${esc(cnyAcct)}</strong><br>
      <span class="warn">* Please check the account number carefully before remittance.</span>
    </div>
  </div>


</div>
${autoprint}</body></html>`;
      return renderHtml(res, html, format);
    }

    // ══════════════════════════════════════════
    // FOB 海运费发票 (客户版·对外)
    // GET ?id=xxx&type=fob_invoice
    // 只含海运费USD + 当日汇率+0.1 CNY等值，不含港杂费
    // ══════════════════════════════════════════
    if (isFobInvoice) {
      // 拉最新汇率 USD_CNY
      const fxRes = await pool.query(
        `SELECT rate FROM exchange_rates WHERE currency_pair='USD_CNY' ORDER BY fetched_at DESC LIMIT 1`
      );
      const baseRate = fxRes.rows.length ? parseFloat(fxRes.rows[0].rate) : 7.0;
      const fxRate   = Math.round((baseRate + 0.1) * 10000) / 10000; // +0.1，保留4位

      const billTo    = cust ? (cust.name_en || cust.name_cn || "") : (p.customer_en || "");
      const billAddr  = cust ? (cust.address || "") : "";
      const blNo      = p.bl_no || "—";
      const scNo      = p.contract_no || "—";
      const orderNo   = p.raw?.customerPO || "—";
      const vessel    = [p.vessel, p.voyage].filter(Boolean).join(" / ") || "—";
      const ctnQty    = parseInt(p.container_qty || 1);
      const ctnType   = p.container_type || "40HQ";
      // 箱号处理：支持逗号/斜杠分隔的多柜
      const ctnNos       = (p.container_no || "").split(/[,/]\s*/).map(s=>s.trim()).filter(Boolean);
      const rawSealNos   = (p.raw?.sealNo || "").split(/[,/;]\s*/).map(s=>s.trim()).filter(Boolean);
      const totalCartons = p.total_cartons || p.raw?.totalCtns || null;
      const totalGW      = p.gross_weight_kg || null;
      const totalCBM     = p.total_cbm || null;
      const freightTerm  = "PREPAID";

      // ── 方案A: 同BL多个shipping_plan → 每个plan一柜 ──
      // ── 方案B: 单plan多PO → 查orders表取每PO的CTN/GW/CBM ──
      let siblingPlans = [];
      try {
        const sibRes = await pool.query(
          `SELECT id, container_no,
                  COALESCE(raw->>'customerPO', '') AS po,
                  COALESCE(raw->>'sealNo', '') AS seal,
                  total_cartons, gross_weight_kg, total_cbm
           FROM shipping_plans WHERE bl_no = $1 AND id != $2 ORDER BY id`,
          [p.bl_no, p.id]
        );
        siblingPlans = sibRes.rows;
      } catch(_) {}

      // ── 优先用 container_bookings（多柜单plan场景）──
      let cbookings = [];
      try {
        const cbRes = await pool.query(
          `SELECT container_no, seal_no, contract_no,
                  cargo_weight_kg::numeric AS gross_weight_kg,
                  container_type
           FROM container_bookings WHERE shipping_plan_id = $1 ORDER BY id`,
          [p.id]
        );
        cbookings = cbRes.rows;
      } catch(_) {}

      const isMultiPlan = siblingPlans.length > 0;
      const useBookings = cbookings.length > 1; // 有多行柜子记录才用，单行退回老逻辑

      let ctnRows = [];
      let sumCartons = 0, sumGW = 0, sumCBM = 0;

      if (useBookings) {
        // 从 container_bookings 读多柜（每行一柜，有 contract_no/cargo_weight_kg）
        // 总量字段从 shipping_plans 读（total_cartons/cbm 不在 container_bookings 里）
        const perCtnCartons = p.total_cartons ? Math.round(parseInt(p.total_cartons) / cbookings.length) : null;
        const perCtnCBM     = p.total_cbm     ? parseFloat(p.total_cbm) / cbookings.length : null;
        ctnRows = cbookings.map((cb, i) => {
          const gwVal  = cb.gross_weight_kg ? parseFloat(cb.gross_weight_kg) : null;
          const ctnVal = perCtnCartons;
          const cbmVal = perCtnCBM ? parseFloat(perCtnCBM.toFixed(3)) : null;
          sumCartons += ctnVal || 0;
          sumGW      += gwVal  || 0;
          sumCBM     += cbmVal || 0;
          return {
            no:   (cb.container_no || "").trim(),
            seal: (cb.seal_no || "").trim(),
            po:   stripCompanyPrefix(cb.contract_no) || orderNo || scNo,
            ctn:  ctnVal,
            gw:   gwVal,
            cbm:  cbmVal,
          };
        });
      } else if (isMultiPlan) {
        // 每个 sibling plan 对应一柜
        const allPlans = [
          { container_no: ctnNos[0] || "", po: orderNo !== "—" ? orderNo : scNo, seal: rawSealNos[0] || "",
            total_cartons: p.total_cartons, gross_weight_kg: p.gross_weight_kg, total_cbm: p.total_cbm },
          ...siblingPlans.map(s => ({
            container_no: (s.container_no || "").trim(),
            po: s.po || "",
            seal: (s.seal || "").trim(),
            total_cartons: s.total_cartons,
            gross_weight_kg: s.gross_weight_kg,
            total_cbm: s.total_cbm,
          }))
        ];
        ctnRows = allPlans.map(pl => {
          const ctnVal = pl.total_cartons ? parseInt(pl.total_cartons) : null;
          const gwVal  = pl.gross_weight_kg ? parseFloat(pl.gross_weight_kg) : null;
          const cbmVal = pl.total_cbm ? parseFloat(pl.total_cbm) : null;
          sumCartons += ctnVal || 0;
          sumGW      += gwVal  || 0;
          sumCBM     += cbmVal || 0;
          return { no: pl.container_no, seal: pl.seal, po: pl.po || "—", ctn: ctnVal, gw: gwVal, cbm: cbmVal };
        });
      } else {
        // 单plan：多PO时查orders表
        const poList = orderNo !== "—"
          ? orderNo.split(/[,\s]+/).map(s => s.trim()).filter(Boolean)
          : [];
        let orderDataMap = {};
        if (poList.length > 1) {
          try {
            const ordRes = await pool.query(
              `SELECT customer_po, total_cartons, gross_weight, total_cbm FROM orders WHERE customer_po = ANY($1)`,
              [poList]
            );
            ordRes.rows.forEach(r => { orderDataMap[r.customer_po] = r; });
          } catch(_) {}
        }
        ctnRows = ctnNos.map((no, i) => {
          const seal  = rawSealNos[i] || "—";
          const po    = poList[i] || (orderNo !== "—" ? orderNo : scNo) || "—";
          const ord   = orderDataMap[po] || {};
          const isSingle = ctnNos.length === 1;
          const ctnVal = ord.total_cartons ? parseInt(ord.total_cartons) : (isSingle && totalCartons ? parseInt(totalCartons) : null);
          const gwVal  = ord.gross_weight  ? parseFloat(ord.gross_weight) : (isSingle && totalGW ? parseFloat(totalGW) : null);
          const cbmVal = ord.total_cbm     ? parseFloat(ord.total_cbm)    : (isSingle && totalCBM ? parseFloat(totalCBM) : null);
          sumCartons += ctnVal || 0;
          sumGW      += gwVal  || 0;
          sumCBM     += cbmVal || 0;
          return { no, seal, po, ctn: ctnVal, gw: gwVal, cbm: cbmVal };
        });
      }

      const actualCtnQty = ctnRows.length || ctnNos.length;
      const footerCartons = sumCartons > 0 ? sumCartons : (totalCartons ? parseInt(totalCartons) : null);
      const footerGW      = sumGW > 0 ? sumGW : (totalGW ? parseFloat(totalGW) : null);
      const footerCBM     = sumCBM > 0 ? sumCBM : (totalCBM ? parseFloat(totalCBM) : null);

      const ctnRowsHtml = ctnRows.map((r, i) => `<tr class="ctn-row">
          <td class="ctn-idx">Container ${i+1}</td>
          <td class="ctn-no">${esc(r.no)}</td>
          <td class="ctn-seal">${esc(r.seal)}</td>
          <td style="padding:5px 8px;font-weight:700;color:#111;font-size:9.5px">${esc(r.po)}</td>
          <td class="ctn-ctn">${r.ctn ? r.ctn.toLocaleString('en') : '—'}</td>
          <td class="ctn-gw">${r.gw ? fmtNum(r.gw)+' KGS' : '—'}</td>
          <td class="ctn-cbm">${r.cbm ? r.cbm.toFixed(3)+' CBM' : '—'}</td>
        </tr>`).join("");

      const unitPrice = parseFloat(p.freight_sale_usd || 0);
      const totalUsd  = unitPrice * ctnQty;
      const totalCny  = Math.round(totalUsd * fxRate * 100) / 100;

      // 发票号：FI-{shipment_no}-{YYYYMMDD}
      const fobInvNo = "FI-" + (p.shipment_no || String(p.id)) + "-" + genDate.replace(/-/g, "");

      const fobHtml = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>Freight Invoice — ${esc(p.shipment_no || blNo)}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:11px;color:#111;background:#e5e7eb;padding:0}
.page{max-width:200mm;margin:14px auto;padding:11mm 13mm;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.1)}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #111;padding-bottom:10px;margin-bottom:14px}
.hdr-l .co-en{font-size:15px;font-weight:900;color:#111;letter-spacing:.01em;line-height:1.2}
.hdr-l .co-cn{font-size:10px;color:#555;margin-top:3px}
.hdr-l .tag{font-size:8.5px;color:#888;margin-top:4px}
.hdr-r{text-align:right}
.hdr-r .doc-en{font-size:18px;font-weight:900;color:#111;letter-spacing:.05em}
.hdr-r .doc-cn{font-size:10px;color:#555;margin-top:1px}
.hdr-r .inv-no{display:inline-block;font-size:11px;font-weight:800;color:#111;font-family:monospace;border:2px solid #111;border-radius:3px;padding:2px 9px;margin-top:4px;letter-spacing:.03em}
.info-grid{display:grid;grid-template-columns:1.05fr 1fr;gap:0 12px;margin-bottom:12px;border:1px solid #e0e0e0;border-radius:4px;overflow:hidden}
.info-box{font-size:10px}
.info-box .row{display:grid;grid-template-columns:118px 1fr;border-bottom:1px solid #efefef;min-height:22px}
.info-box .row:last-child{border-bottom:none}
.info-box .lbl{background:#f7f7f7;color:#666;font-weight:700;padding:4px 8px;border-right:1px solid #efefef;display:flex;align-items:center}
.info-box .val{color:#111;font-weight:600;padding:4px 8px;display:flex;align-items:center}
.info-box .val.big{font-size:12px;font-weight:900}
table.charges{width:100%;border-collapse:collapse;margin-bottom:0;font-size:10px;border:1px solid #ccc}
table.charges thead th{background:#111;color:#fff;padding:7px 9px;text-align:left;font-weight:700;font-size:9.5px;letter-spacing:.04em}
table.charges thead th.r{text-align:right}
table.charges thead th.c{text-align:center}
table.charges tr.section td{background:#333;color:#fff;font-weight:800;letter-spacing:.05em;font-size:9.5px;text-transform:uppercase;padding:5px 9px}
table.charges tbody td{padding:7px 9px;border-bottom:1px solid #efefef;font-family:monospace;color:#111}
table.charges tbody td.label{font-family:inherit;color:#222}
table.charges tbody td.r{text-align:right}
table.charges tbody td.c{text-align:center}
table.charges tfoot{border-top:2px solid #111}
table.charges tfoot tr td{padding:7px 9px;font-weight:800;font-family:monospace;color:#111;background:#f7f7f7}
table.charges tfoot tr.total-usd td{font-size:12px}
table.charges tfoot tr td:last-child{text-align:right}
table.charges tfoot tr td.label{font-family:inherit;text-align:right;font-size:10px}
.fx-note{text-align:right;font-size:8.5px;color:#666;margin:6px 0 10px;font-style:italic}
.fx-note strong{color:#111;font-style:normal}
.pay-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
.pay-box{padding:12px 14px;border-radius:4px;border:2px solid #111}
.pay-box.usd{background:#f7f7f7}
.pay-box.cny{background:#efefef}
.pay-box .plbl{font-size:8.5px;font-weight:900;text-transform:uppercase;letter-spacing:.07em;color:#111;margin-bottom:5px}
.pay-box .pamt{font-size:20px;font-weight:900;font-family:monospace;color:#111}
.pay-box .psub{font-size:8px;color:#666;margin-top:3px}
.bottom{display:grid;grid-template-columns:1.05fr 1fr;gap:10px}
.box-tt,.box-bk{padding:9px 11px;background:#f9f9f9;border:1px solid #ddd;border-radius:4px;font-size:9px;line-height:1.8;color:#444}
.box-tt strong,.box-bk strong{color:#111}
.box-tt .title,.box-bk .title{font-size:9.5px;font-weight:900;color:#111;letter-spacing:.05em;margin-bottom:4px;text-transform:uppercase;border-bottom:1px solid #ddd;padding-bottom:3px}
.warn{color:#c00;font-size:8px}
.footer-bar{display:flex;justify-content:space-between;margin-top:10px;padding-top:6px;border-top:1px solid #ddd;font-size:8px;color:#999;font-family:monospace}
@media print{body{padding:0;background:#fff}.page{margin:0;padding:8mm 10mm;box-shadow:none}}
@media screen{body{background:#f1f5f9}.page{box-shadow:0 4px 32px rgba(0,0,0,.12);margin:20px auto;border-radius:8px}}
</style></head><body>
<div class="page">
  <div class="hdr">
    <div class="hdr-l">
      <div class="co-en">SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.</div>
      <div class="co-cn">上海洋宝宝国际物流有限公司</div>
      <div class="tag">Ocean Freight · Air Freight · Express · Integrated Logistics Solutions</div>
    </div>
    <div class="hdr-r">
      <div class="doc-en">INVOICE</div>
      <div class="doc-cn">运费发票</div>
      <div class="inv-no">No. ${esc(fobInvNo)}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <div class="row"><div class="lbl">TO (客户名称):</div><div class="val big">${esc(billTo)}</div></div>
      <div class="row"><div class="lbl">SHPT MODE:</div><div class="val">Sea Export</div></div>
      <div class="row"><div class="lbl">INV/BL NO.:</div><div class="val">${esc(blNo)}</div></div>
      <div class="row"><div class="lbl">P.O.L (起运港):</div><div class="val">${esc(p.pol || "—")}</div></div>
    </div>
    <div class="info-box">
      <div class="row"><div class="lbl">DATE (出单日期):</div><div class="val">${genDate}</div></div>
      <div class="row"><div class="lbl">Vessel/Voyage (船名航次):</div><div class="val">${esc(vessel)}</div></div>
      <div class="row"><div class="lbl">ETD (离港日):</div><div class="val">${fmtDate(p.etd)}</div></div>
      <div class="row"><div class="lbl">P.O.D (目的港):</div><div class="val">${esc(p.pod || "—")}</div></div>
    </div>
  </div>

  <!-- ── CONTAINER SECTION ── -->
  <div style="margin-bottom:12px;border:1px solid #ddd;border-radius:4px;overflow:hidden;font-size:10px">
    <div style="background:#111;color:#fff;font-weight:800;font-size:9.5px;letter-spacing:.05em;padding:6px 10px;display:flex;justify-content:space-between;align-items:center">
      <span>Containers / 集装箱明细 (${actualCtnQty} × ${ctnType})</span>
      <span style="font-weight:700;letter-spacing:.03em">Freight Term: ${freightTerm}</span>
    </div>
    <table style="width:100%;border-collapse:collapse">
      <thead>
        <tr style="background:#333;color:#fff;font-size:9px;font-weight:700;letter-spacing:.03em">
          <th style="padding:5px 8px;text-align:left;width:70px">Container #</th>
          <th style="padding:5px 8px;text-align:left;width:120px">Container No.</th>
          <th style="padding:5px 8px;text-align:left;width:100px">Seal No.</th>
          <th style="padding:5px 8px;text-align:left;width:90px">PO / 合同号</th>
          <th style="padding:5px 8px;text-align:right;width:70px">CTN</th>
          <th style="padding:5px 8px;text-align:right;width:95px">Gross Weight</th>
          <th style="padding:5px 8px;text-align:right;width:75px">Volume</th>
        </tr>
      </thead>
      <tbody>${ctnRowsHtml}</tbody>
      <tfoot>
        <tr style="background:#f7f7f7;font-weight:900;border-top:2px solid #111;font-size:9.5px">
          <td style="padding:6px 8px;color:#666;font-size:9px">${actualCtnQty} × ${ctnType}</td>
          <td style="padding:6px 8px" colspan="3"></td>
          <td style="padding:6px 8px;text-align:right;font-family:monospace">${footerCartons ? footerCartons.toLocaleString('en') : '—'}</td>
          <td style="padding:6px 8px;text-align:right;font-family:monospace">${footerGW ? fmtNum(footerGW)+' KGS' : '—'}</td>
          <td style="padding:6px 8px;text-align:right;font-family:monospace">${footerCBM ? footerCBM.toFixed(3)+' CBM' : '—'}</td>
        </tr>
      </tfoot>
    </table>
  </div>
  <style>
    tr.ctn-row td{padding:5px 10px;border-bottom:1px solid #efefef;color:#111}
    tr.ctn-row td.ctn-idx{color:#888;font-size:9px}
    tr.ctn-row td.ctn-no{font-family:monospace;font-weight:800;font-size:10px}
    tr.ctn-row td.ctn-seal{font-family:monospace;color:#555;font-size:9.5px}
    tr.ctn-row td.ctn-ctn,tr.ctn-row td.ctn-gw,tr.ctn-row td.ctn-cbm{font-family:monospace;text-align:right;font-size:9.5px}
  </style>

  <table class="charges">
    <thead>
      <tr>
        <th>Charge Item (费用明细)</th>
        <th>Charge Unit / 计费单位</th>
        <th class="c">Currency / 币种</th>
        <th class="c">Qty / 数量</th>
        <th class="r">Price / 单价</th>
        <th class="r">Amount / 合计</th>
      </tr>
    </thead>
    <tbody>
      <tr class="section"><td colspan="6">Ocean Freight | 海运费</td></tr>
      <tr>
        <td>海运费 Ocean Freight</td>
        <td>Per Container / 箱</td>
        <td class="c">USD</td>
        <td class="c">${ctnQty}</td>
        <td class="r">${fmtNum(unitPrice)}</td>
        <td class="r">${fmtNum(totalUsd)}</td>
      </tr>
    </tbody>
    <tfoot>
      <tr class="total-usd"><td class="label" colspan="5">TOTAL USD (美元合计)</td><td>$ ${fmtNum(totalUsd)}</td></tr>
    </tfoot>
  </table>

  <div class="fx-note">* Please remit the full amount in ONE of the following currencies. / 请选择以下一种币种全额支付。</div>
  <div class="fx-note">开票日期汇率 Invoice Date Rate (<strong>${genDate}</strong>): <strong>1 USD = ${fxRate.toFixed(4)} CNY</strong></div>

  <div class="pay-grid">
    <div class="pay-box usd">
      <div class="plbl">TOTAL PAYABLE IN USD · 如全用美元支付</div>
      <div class="pamt">$ ${fmtNum(totalUsd)}</div>
      <div class="psub">Ocean freight only · Remit to USD A/C below</div>
    </div>
    <div class="pay-box cny">
      <div class="plbl">TOTAL PAYABLE IN CNY · 如全用人民币支付</div>
      <div class="pamt">¥ ${fmtNum(totalCny)}</div>
      <div class="psub">USD ${fmtNum(totalUsd)} × ${fxRate.toFixed(4)} = ¥ ${fmtNum(totalCny)}</div>
    </div>
  </div>

  <div class="bottom">
    <div class="box-tt">
      <div class="title">TERMS &amp; CONDITIONS (法律声明与条款)</div>
      1. PAYMENT DUE: Please arrange payment strictly within the agreed credit term. Late payment may result in delayed release of the Bill of Lading or cargo.<br>
      2. EXCHANGE RATE: For USD charges settled in RMB, the exchange rate shall be subject to our company's notification.<br>
      3. LIABILITY: All business is transacted under our Standard Trading Conditions.
    </div>
    <div class="box-bk">
      <div class="title">BANKING INFORMATION (银行信息)</div>
      Bank Name: <strong>BANK OF CHINA XIAMEN BRANCH</strong><br>
      Account Name: <strong>SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.</strong><br>
      Swift Code: <strong>BKCHCNBI73A</strong><br>
      Bank Addr: No. 40 North Hubin Road, Xiamen<br>
      USD Account (美金账号): <strong>433849630299</strong><br>
      CNY Account (人民币账号): <strong>433849860868</strong><br>
      <span style="color:#c00;font-size:8px">* Please check the account number carefully before remittance.</span>
    </div>
  </div>


</div>${autoprint}</body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(fobHtml);
    }

    // ─────────────────────────────────────────────────────
    // DRIVER NOTICE  type=driver_notice
    // One page per container from raw.containers_driver
    // ─────────────────────────────────────────────────────
    if (type === 'driver_notice') {
      const ctnDrivers = Array.isArray(p.raw && p.raw.containers_driver ? p.raw.containers_driver : null) ? p.raw.containers_driver : [];
      if (!ctnDrivers.length) {
        return res.status(404).send('<h1>No containers_driver data found for this plan</h1>');
      }
      const factoryAddr    = (p.raw && p.raw.factoryAddr)    || '';
      const factoryContact = (p.raw && p.raw.factoryContact) || '';
      const blDisplay      = (p.bl_no || '').replace(/^YMJA[I]?/, 'I');

      const pageStyle = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:12px;color:#111;background:#e5e7eb;padding:16px}
.page{max-width:148mm;margin:0 auto 24px;padding:10mm 12mm;background:#fff;box-shadow:0 2px 8px rgba(0,0,0,.15);page-break-after:always}
.page:last-child{page-break-after:auto}
.title{text-align:center;font-size:18px;font-weight:900;letter-spacing:.1em;border-bottom:3px double #111;padding-bottom:8px;margin-bottom:14px}
table.fields{width:100%;border-collapse:collapse}
table.fields td{padding:7px 10px;border:1px solid #ccc;vertical-align:middle;line-height:1.5}
table.fields td.lbl{background:#f5f5f5;font-weight:700;color:#333;width:38%;font-size:11px;white-space:nowrap}
table.fields td.val{font-size:12px;font-weight:600;color:#111}
table.fields td.val.big{font-size:15px;font-weight:900;letter-spacing:.05em;color:#111}
table.fields td.val.mono{font-family:monospace;font-size:13px;font-weight:800}
.footer{margin-top:12px;font-size:9px;color:#999;text-align:center}
@media print{body{background:#fff;padding:0}.page{margin:0;box-shadow:none;padding:8mm 10mm}}
</style></head><body>`;

      const pages = ctnDrivers.map(function(c, i) {
        const parts = (c.loadTime || '').split(' ');
        const loadDate = parts[0] ? parts[0].replace(/-/g, '.') : '';
        const loadTime = parts[1] || '';
        return '<div class="page">' +
          '<div class="title">拖箱通知</div>' +
          '<table class="fields">' +
          '<tr><td class="lbl">拖箱时间</td><td class="val big">' + (loadDate ? loadDate + ' ' + loadTime : '—') + '</td></tr>' +
          '<tr><td class="lbl">装货详细地址</td><td class="val">' + (factoryAddr || '—') + '</td></tr>' +
          '<tr><td class="lbl">工厂联系人</td><td class="val">' + (factoryContact || '—') + '</td></tr>' +
          '<tr><td class="lbl">车号</td><td class="val mono">' + (c.truck || '—') + '</td></tr>' +
          '<tr><td class="lbl">司机</td><td class="val">' + (c.driver || '—') + '&nbsp;&nbsp;' + (c.phone || '') + '</td></tr>' +
          '<tr><td class="lbl">车架号</td><td class="val">&nbsp;</td></tr>' +
          '<tr><td class="lbl">提单号</td><td class="val mono">' + blDisplay + '</td></tr>' +
          '<tr><td class="lbl">箱号</td><td class="val big mono">' + (c.no || '—') + '</td></tr>' +
          '<tr><td class="lbl">封签号</td><td class="val mono">' + (c.seal || '—') + '</td></tr>' +
          '<tr><td class="lbl">箱型</td><td class="val">' + (p.container_type || '40HQ') + ' 出口</td></tr>' +
          '<tr><td class="lbl">柜重</td><td class="val">' + (c.containerWeight ? c.containerWeight + 'KG' : '—') + '</td></tr>' +
          '<tr><td class="lbl">提箱地</td><td class="val">' + (c.pickup || '—') + '</td></tr>' +
          '<tr><td class="lbl">还箱地</td><td class="val">' + (c.dropoff || '—') + '</td></tr>' +
          '</table>' +
          '<div class="footer">第 ' + (i + 1) + ' 柜 / 共 ' + ctnDrivers.length + ' 柜 · 三林供应链</div>' +
          '</div>';
      });

      const driverHtml = pageStyle + pages.join('') + '</body></html>';
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(driverHtml);
    }

    // ══════════════════════════════════════════
    // DEPRECATED 2026-05-18 · Use /api/db/documents?type=debit&id=<shipping_plan_id>
    // The canonical debit note generator now lives in documents.js (Sanlyn OS branded).
    // 301 redirect preserves any existing bookmarks/links.
    // ══════════════════════════════════════════
    if (isDebitNote) {
      // 2026-06-10: 301 曾丢 format/token 参数 → DAS iframe 401/HTML 死按钮。重定向必须透传全部 query。
      var _dnQs = "type=debit&id=" + encodeURIComponent(req.query?.id || "");
      if (req.query?.format) _dnQs += "&format=" + encodeURIComponent(req.query.format);
      if (req.query?.token)  _dnQs += "&token="  + encodeURIComponent(req.query.token);
      if (req.query?.stamp)  _dnQs += "&stamp="  + encodeURIComponent(req.query.stamp);
      return res.redirect(301, "/api/db/documents?" + _dnQs);
    }
    if (false) {  // dead code below — keep for ~30 days then drop entirely
      const dnNo = "YBB-" + (p.shipment_no || p.bl_no || "").replace(/[^A-Z0-9]/gi,"").toUpperCase() + "-" + genDate.replace(/-/g,"");
      // ⚠ Customer name: real fields only. NEVER fall back to a hardcoded company name (per memory: feedback_never_invent_fields)
      const toName  = cust ? (cust.name_en || cust.name_cn) : (p.customer_en || p.customer_cn || "");
      const toNote  = cust ? (cust.address || "") : "";
      const toUscc  = cust ? (cust.uscc || "") : "";              // real column added 2026-05-18
      const freightTerm = p.freight_term || "";                    // real column added 2026-05-18 — show only if set
      const quoteRef    = p.quote_ref || "";                        // real column added 2026-05-18 — link to itemized FQ

      const cnyFees = [
        ["EDI 费 EDI Fee",                          p.edi_fee],
        ["报关费 Customs Declaration Fee",           p.customs_cost_total],
        ["单证费 Documentation Fee",                 p.doc_fee],
        ["电装箱费 E-Packing List Fee",              p.epacking_fee],
        ["订舱费 Booking Fee",                       p.bkg_fee],
        ["条形码费 Barcode Fee",                     p.barcode_fee],
        ["箱单费 Packing List Fee",                  p.packing_fee],
        ["THC 码头操作费",                            p.thc_fee],
        ["吊机费 Crane Fee",                         p.crane_fee],
        ["堆存费 Storage Fee",                       p.storage_fee],
        ["进港费 Port Entry Fee",                    p.port_entry_fee],
        ["提箱费 Container Pick-up Fee",             p.pickup_fee],
        ["停车费 Parking Fee",                       p.parking_fee],
        ["拖车费 Trucking Fee",                      p.trucking_cost_total],
        ["铅封费 Seal Fee",                          p.seal_fee],
        ["电放费 TLX Fee",                           p.tlx_fee],
        ["信息传输费",                                p.info_trans_fee],
        ["保险费 Insurance",                         p.insurance_cost],
        ["其他 Other",                               p.other_fee],
      ].filter(([, v]) => v != null && parseFloat(v) > 0);

      const cnyTotal = cnyFees.reduce((s,[,v]) => s + Number(v||0), 0);
      const usdFreight = parseFloat(p.freight_cost || 0);
      const containerLabel = [p.container_type, p.container_qty ? `×${p.container_qty}` : ""].filter(Boolean).join(" ");
      const ticketCount = p.order_contract_nos ? (Array.isArray(p.order_contract_nos) ? p.order_contract_nos.length : 1) : 1;
      const boxCount = p.container_qty || 1;

      const debitHtml = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>Freight Debit Note — ${esc(p.bl_no||p.shipment_no||"")}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:"PingFang SC","Microsoft YaHei",Arial,sans-serif;font-size:11px;color:#1a1a2e;background:#fff;padding:0}
.page{max-width:190mm;margin:0 auto;padding:10mm 12mm}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1e40af;padding-bottom:10px;margin-bottom:12px}
.hdr-l .cn{font-size:16px;font-weight:900;color:#1e40af}
.hdr-l .en{font-size:9px;color:#64748b;margin-top:1px}
.hdr-l .tag{font-size:8.5px;color:#64748b;margin-top:2px}
.hdr-r .badge{font-size:13px;font-weight:800;color:#1e40af;letter-spacing:0.04em;border:2px solid #1e40af;padding:4px 10px;border-radius:4px}
.meta-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;background:#f1f5f9;border-radius:6px;padding:8px 10px;margin-bottom:12px}
.meta-item .lbl{font-size:7.5px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:.06em}
.meta-item .val{font-size:10px;font-weight:700;color:#1e293b;font-family:"SF Mono",monospace;margin-top:1px}
.party-row{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px}
.party-box{border:1px solid #e2e8f0;border-radius:5px;padding:8px 10px}
.party-box .dir{font-size:7.5px;font-weight:900;color:#94a3b8;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.party-box .name{font-size:11px;font-weight:800;color:#1e293b;line-height:1.4}
.party-box .sub{font-size:9px;color:#64748b;margin-top:2px}
.section-title{font-size:8px;font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:#64748b;border-bottom:1px solid #e2e8f0;padding-bottom:4px;margin-bottom:6px;margin-top:10px}
table{width:100%;border-collapse:collapse;font-size:10px}
table th{background:#f8fafc;text-align:left;padding:4px 6px;font-size:7.5px;font-weight:700;color:#64748b;text-transform:uppercase}
table td{padding:3px 6px;border-bottom:1px solid #f1f5f9}
table tr:last-child td{border-bottom:none}
.mono{font-family:"SF Mono",monospace}
.text-right{text-align:right}
.freight-bar{background:#1e40af;color:#fff;border-radius:6px;padding:10px 14px;margin-top:10px;display:flex;justify-content:space-between;align-items:center}
.freight-bar .lbl{font-size:9px;font-weight:700;opacity:.8}
.freight-bar .amt{font-size:20px;font-weight:900;font-family:"SF Mono",monospace;letter-spacing:.02em}
.summary-bar{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}
.sum-box{border:1px solid #e2e8f0;border-radius:5px;padding:8px 10px;display:flex;justify-content:space-between;align-items:center}
.sum-box .s-lbl{font-size:8px;color:#94a3b8;font-weight:700}
.sum-box .s-val{font-size:13px;font-weight:900;font-family:"SF Mono",monospace;color:#1e293b}
.bank-box{background:#f8fafc;border:1px solid #e2e8f0;border-radius:5px;padding:8px 10px;margin-top:10px;font-size:9px;line-height:1.8;color:#475569}
.bank-box strong{color:#1e293b}
.footer-bar{display:flex;justify-content:space-between;margin-top:12px;padding-top:8px;border-top:1px solid #e2e8f0;font-size:8px;color:#94a3b8}
.internal-badge{display:inline-block;font-size:7.5px;font-weight:800;color:#7c3aed;background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.2);border-radius:3px;padding:1px 6px;margin-left:6px;vertical-align:middle}
@media print{body{padding:0}.page{padding:8mm 10mm}.no-print{display:none}}
</style>
</head>
<body>
<div class="page">
  <!-- Header -->
  <div class="hdr">
    <div class="hdr-l">
      <div class="cn">${from(issuer,'name_cn','出单公司')}</div>
      <div class="en">${from(issuer,'name_en','英文名')}</div>
      <div class="tag">Ocean Freight · Integrated Logistics Solutions</div>
    </div>
    <div class="hdr-r">
      <div class="badge">FREIGHT DEBIT NOTE</div>
      <div style="font-size:8px;color:#94a3b8;text-align:right;margin-top:4px">Ref: ${esc(dnNo)}</div>
      <div class="internal-badge">🔒 INTERNAL</div>
    </div>
  </div>

  <!-- Meta bar — only show fields with real values (no fabricated placeholders) -->
  <div class="meta-bar">
    <div class="meta-item"><div class="lbl">B/L No.</div><div class="val">${esc(fmt(p.bl_no))}</div></div>
    <div class="meta-item"><div class="lbl">ETD</div><div class="val">${fmtDate(p.etd)}</div></div>
    <div class="meta-item"><div class="lbl">Container</div><div class="val">${esc(containerLabel||"—")}</div></div>
    <div class="meta-item"><div class="lbl">POD</div><div class="val">${esc(fmt(p.pod))}</div></div>
    ${freightTerm ? `<div class="meta-item"><div class="lbl">Freight Term</div><div class="val">${esc(freightTerm)}</div></div>` : ""}
  </div>

  <!-- TO block — enlarged consignee; FROM removed (issuer info in header). USCC printed only if present. -->
  <div class="party-box" style="margin-bottom:12px">
    <div class="dir">TO · 收票方</div>
    <div class="name" style="font-size:15px">${esc(toName||"—")}</div>
    ${toNote ? `<div class="sub">${esc(toNote)}</div>` : ""}
    ${toUscc ? `<div class="sub mono">USCC 统一社会信用代码: <strong>${esc(toUscc)}</strong></div>` : ""}
  </div>

  <!-- Simple FI: USD ocean freight + CNY subtotal only. Itemized breakdown lives in the quotation (FQ). -->
  ${usdFreight > 0 ? `
  <div class="freight-bar">
    <div>
      <div class="lbl">🚢 Ocean Freight · 海运费</div>
      <div style="font-size:8px;opacity:.7;margin-top:2px">${esc(containerLabel)} · ${esc(fmt(p.pod))}</div>
    </div>
    <div class="amt">$${fmtNum(usdFreight)}</div>
  </div>` : ""}

  <!-- Two-currency totals — what the customer actually pays -->
  <div class="summary-bar">
    <div class="sum-box" style="background:#fef3c7;border-color:#fde68a">
      <div>
        <div class="s-lbl">TOTAL PAYABLE · CNY 人民币应付</div>
        <div style="font-size:8px;color:#94a3b8;margin-top:2px">Local charges at ${esc(fmt(p.pol)||"POL")} · Remit to CNY A/C</div>
      </div>
      <div class="s-val" style="font-size:18px;color:#b45309">¥ ${fmtNum(cnyTotal)}</div>
    </div>
    <div class="sum-box" style="background:#dbeafe;border-color:#bfdbfe">
      <div>
        <div class="s-lbl">TOTAL PAYABLE · USD 美元应付</div>
        <div style="font-size:8px;color:#94a3b8;margin-top:2px">Ocean freight only · Remit to USD A/C</div>
      </div>
      <div class="s-val" style="font-size:18px;color:#1e40af">$ ${fmtNum(usdFreight)}</div>
    </div>
  </div>

  <!-- Bank info -->
  <div class="bank-box">
    <strong>BANKING INFORMATION · 银行信息</strong><br>
    Bank: <strong>${usdBank&&usdBank.bank?esc(usdBank.bank):(cnyBank&&cnyBank.bank?esc(cnyBank.bank):from(issuer,'bank_name','开户行'))}</strong> &nbsp;·&nbsp; Swift: <strong>${usdBank&&usdBank.swift?esc(usdBank.swift):(cnyBank&&cnyBank.swift?esc(cnyBank.swift):MISS('Swift'))}</strong><br>
    USD A/C: <strong>${usdBank&&usdBank.account?esc(usdBank.account):MISS('USD账户')}</strong> &nbsp;·&nbsp; CNY A/C: <strong>${cnyBank&&cnyBank.account?esc(cnyBank.account):(issuer&&issuer.bank_account?esc(issuer.bank_account):MISS('CNY账户'))}</strong><br>
    Account Name: <strong>${from(issuer,'name_en','英文名')}</strong>
  </div>

  <!-- See-quotation link — only shown when quote_ref exists -->
  ${quoteRef ? `
  <div style="background:#f0f9ff;border:1px dashed #38bdf8;border-radius:5px;padding:8px 12px;margin-top:10px;font-size:10px;color:#0369a1">
    📄 <strong>For itemized breakdown · 完整费用明细见报价单</strong> &nbsp;·&nbsp; Quote Ref: <strong class="mono">${esc(quoteRef)}</strong>
  </div>` : ""}

  <!-- Footer -->
  <div class="footer-bar">
    <span>${from(issuer,'name_cn','出单公司')} · ${from(issuer,'contact_name','联系人')} · ${from(issuer,'contact_phone','电话')}</span>
    <span>Ref: ${esc(dnNo)} · Generated ${genDate}</span>
  </div>
</div>
</body></html>`;

      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(debitHtml);
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

    // ── format=pdf: puppeteer renders HTML → PDF (used by stamp/apply.js) ──
    if (format === "pdf") {
      try {
        const puppeteer = (await import("puppeteer")).default;
        // Use system Chrome same as documents.js — bundled Chromium is NOT installed on this server
        const chromePath = process.env.CHROME_PATH || process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/google-chrome";
        const launchOpts = {
          headless: "new",
          args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
                 "--disable-gpu", "--disable-software-rasterizer"],
        };
        try {
          const fs = await import("fs");
          if (fs.existsSync(chromePath)) launchOpts.executablePath = chromePath;
        } catch (_) {}
        const browser = await puppeteer.launch(launchOpts);
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: "networkidle0" });
        const pdfBytes = await page.pdf({ format: "A4", printBackground: true, margin: { top: "10mm", bottom: "10mm", left: "10mm", right: "10mm" } });
        await browser.close();
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Cache-Control", "no-cache");
        return res.end(pdfBytes);
      } catch (pdfErr) {
        console.error("[shipping-plan-pdf] puppeteer PDF error:", pdfErr.message);
        // fallback to HTML if puppeteer fails — apply.js will see a non-PDF response
        return res.status(500).send(`<h1>PDF generation failed: ${pdfErr.message}</h1>`);
      }
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    return res.status(200).send(html);

  } catch (err) {
    console.error("[shipping-plan-pdf]", err);
    return res.status(500).send(`<h1>Error: ${err.message}</h1>`);
  }
}
