// /api/db/shipping-plan-pdf.js
// GET ?id=xxx           → 海运计划确认书 HTML（打印就绪）
// GET ?id=xxx&type=si   → Shipping Instructions（英文版）
// GET ?id=xxx&type=cost → 内部成本核算单（含成本价，admin only）
//
// 返回 text/html，浏览器直接打开可 Ctrl+P 打印/另存为PDF

import { getPool, setCors } from "../db.js";
import { renderCustomsDeclaration } from "./customs-declaration-form.js"; // 海关报关单 2026-06-28
import { renderInboundNotice } from "./inbound-notice.js"; // 入货通知/订舱确认单 2026-07-05
import { renderInspectionRequest } from "./inspection-request-form.js"; // 出境货物检验检疫申请/报检单 2026-07-05
import { renderCustomsBundle } from "./customs-bundle-pdf.js"; // 一次性报关合成多页PDF 2026-07-05
import { renderReceiptDoc } from "./receipt-doc.js"; // 收款证明(银行原版docx母版灌数据) 2026-07-07

// 合同号/PO 展示用：去掉前导公司码前缀(如 "38-XM-244" -> "XM-244")，纯展示，不影响任何金额/归属计算。
// 呼应 documents.js 里同名用途的 stripPrefix()（那边只硬编码strip "40-"，这里适配任意公司码前缀）。
function stripCompanyPrefix(s) {
  if (!s) return "";
  return String(s).replace(/^\d+-/, "");
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  const { id, bl, type = "confirm" } = req.query;
  if (!id && !bl && !(type === "receipt" && req.query.refs)) return res.status(400).send("<h1>Missing id or bl</h1>");

  // 内转外→装箱资料可编辑模版(带token重定向,治type=transfer渲染错单)
  if (type === "transfer") {
    const _tk = req.query.token ? "&token=" + encodeURIComponent(req.query.token) : "";
    var _fmt = String(req.query.format || "");
    if (_fmt === "xlsx") {
      res.writeHead(302, { Location: "https://api.sanlyn.cn/api/db/shipping-transfer-data?plan_id=" + encodeURIComponent(id || bl) + "&format=xlsx" + _tk });
      return res.end();
    }
    res.writeHead(302, { Location: "https://api.sanlyn.cn/templates/transfer-template.html?plan_id=" + encodeURIComponent(id || bl) + _tk });
    return res.end();
  }

  try {
    const pool = getPool();
    // 海关出口货物报关单(官方版式)→ 独立模块。原 customs_decl 无 handler 会 fallback 成确认书(错单),这里正式接上。
    if (type === "customs_decl") {
      const _cdQuery = { ...req.query };
      _cdQuery.container_no = _cdQuery.container_no || _cdQuery.container || "";
      const _cdHtml = await renderCustomsDeclaration(pool, id || bl, _cdQuery);
      if (!_cdHtml) return res.status(404).send("<h1>Shipment not found</h1>");
      // format=pdf → 转可下载 PDF(复用 _html-to-pdf.js: puppeteer-core+系统chrome); 否则返回 HTML 供浏览器打印
      if (String(req.query.format || "") === "pdf") {
        const { htmlToPdf } = await import("./_html-to-pdf.js");
        const _cdPdf = await htmlToPdf(_cdHtml);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", "attachment; filename=" + encodeURIComponent("报关单_" + (bl || id || "") + ".pdf"));
        res.setHeader("Cache-Control", "no-store");
        return res.status(200).send(_cdPdf);
      }
      return res.status(200).send(_cdHtml);
    }

    // 入货通知 / 订舱确认单 (给工厂/车队: 收箱/截港/截关/截单/VGM + 箱量) → 独立模块
    if (type === "inbound_notice") {
      const _inHtml = await renderInboundNotice(pool, id || bl, req.query);
      if (!_inHtml) return res.status(404).send("<h1>Shipment not found</h1>");
      return res.status(200).send(_inHtml);
    }

    // 出境货物检验检疫申请 / 报检单 (按柜, 货物与报关单同源) → 独立模块
    if (type === "inspection_request") {
      const _irQuery = { ...req.query };
      _irQuery.container_no = _irQuery.container_no || _irQuery.container || "";
      const _irHtml = await renderInspectionRequest(pool, id || bl, _irQuery);
      if (!_irHtml) return res.status(404).send("<h1>Shipment not found</h1>");
      return res.status(200).send(_irHtml);
    }

    // 一次性报关: 报关单 + PL·SC·IV报关版 + 报检单 合成一份多页 PDF (按柜)
    if (type === "customs_bundle") {
      const _parts = String(req.query.parts || "").split(",").map(x => x.trim()).filter(Boolean);
      const _bundle = await renderCustomsBundle(pool, {
        shipmentId: id || bl,
        container_no: req.query.container_no || req.query.container || "",
        token: req.query.token || "",
        apiBase: "https://api.sanlyn.cn",
        parts: _parts,
      });
      if (!_bundle) return res.status(404).send("<h1>报关全套: 未找到船务计划或组件</h1>");
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", "attachment; filename=" + encodeURIComponent(_bundle.filename));
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).send(_bundle.buffer);
    }

    // 收款证明：跨境业务人民币结算收款说明（2016版）— 银行官方合规单据。
    // 不重画排版：原版 docx 母版 + {字段} 占位符灌数据 → 转 PDF。没数据的字段一律留空，绝不猜。
    if (type === "receipt") {
      // ?refs=CY00365,CY00362 支持一笔银行汇款合并覆盖多票；单票沿用 id/bl。
      const _refs = req.query.refs
        ? String(req.query.refs).split(",").map(s => s.trim()).filter(Boolean)
        : (id || bl);
      // 银行入账通知书(汇入通知)提取到的真实字段——比系统报价更权威，取真实到账金额/汇款人。
      const _overrides = {};
      if (req.query.bank_amount) _overrides.amount_total = req.query.bank_amount;
      if (req.query.bank_payer) _overrides.payer_name = req.query.bank_payer;
      const _rec = await renderReceiptDoc(pool, _refs, _overrides);
      if (!_rec) return res.status(404).send("<h1>Shipment not found</h1>");
      const _asDocx = String(req.query.format || "") === "docx";
      res.setHeader("Content-Type", _asDocx ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document" : "application/pdf");
      res.setHeader("Content-Disposition", "inline; filename=" + encodeURIComponent(_asDocx ? _rec.filename.replace(/\.pdf$/, ".docx") : _rec.filename));
      res.setHeader("Cache-Control", "no-cache");
      return res.status(200).send(_asDocx ? _rec.docxBuffer : _rec.pdfBuffer);
    }

    // ── Fetch shipping plan ──
    const planRes = id
      ? await pool.query(
          "SELECT * FROM shipping_plans WHERE _id = $1 OR shipment_no = $1 OR id::text = $1 LIMIT 1",
          [id]
        )
      : await pool.query(
          "SELECT * FROM shipping_plans WHERE bl_no = $1 LIMIT 1",
          [bl]
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
    const isCost       = type === "cost";
    const isSI         = type === "si";
    const isBooking    = type === "booking";
    const isBlDraft    = type === "bl_draft";
    const isFreight    = type === "freight_invoice";
    const isFobInvoice = type === "fob_invoice";
    const isFobPortcharge = type === "fob_portcharge";
    const isDebitNote  = type === "freight_debit_note";
    const isExwInvoice = type === "exw_invoice"; // EXW全费用账单(客户版) — 独立渲染器 doc-exw-invoice.js
    const isConfirm    = !isCost && !isSI && !isBooking && !isBlDraft && !isFreight && !isFobInvoice && !isFobPortcharge && !isDebitNote && !isExwInvoice;

    const generatedAt = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    const genDate = new Date().toISOString().slice(0, 10);

    // ── Fetch customer/consignee info for docs that need it ──
    let cust = null;
    if (isBooking || isBlDraft || isFreight || isFobInvoice || isFobPortcharge || isExwInvoice) {
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

    // ── EXW 全费用账单(客户版):独立渲染器,接 fsb 真实卖价 ──
    if (isExwInvoice) {
      const { renderExwInvoice } = await import("./doc-exw-invoice.js");
      const _exwHtml = await renderExwInvoice(pool, p, null, cust, req.query);
      if (!_exwHtml) return res.status(404).send("<h1>Shipment not found</h1>");
      if (String(req.query.format || "") === "pdf") {
        try {
          const { htmlToPdf } = await import("./_html-to-pdf.js");
          const _exwPdf = await htmlToPdf(_exwHtml);
          res.setHeader("Content-Type", "application/pdf");
          res.setHeader("Content-Disposition", "attachment; filename=" + encodeURIComponent("EXW全费用账单_" + (p.shipment_no || p.bl_no || p.id || "") + ".pdf"));
          res.setHeader("Cache-Control", "no-store");
          return res.status(200).send(_exwPdf);
        } catch(e) {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          return res.status(200).send(_exwHtml);
        }
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(_exwHtml);
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
      const issuingName   = raw4.issuingCompanyEN || issuingCoEN;
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
${printBtn}
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

      const totalUsd  = parseFloat(p.freight_sale_usd || 0);
      const unitPrice = ctnQty > 0 ? totalUsd / ctnQty : totalUsd;
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
      Swift Code: <strong>BKCHCNBJ73A</strong><br>
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

    // ══════════════════════════════════════════
    // FOB 港杂费账单 (工厂版·对外)
    // GET ?id=xxx&type=fob_portcharge
    // 克隆 fob_invoice 洋宝宝版式，只含工厂承担的非海运CNY港杂费
    // ══════════════════════════════════════════
    if (isFobPortcharge) {
      const blNo      = p.bl_no || "—";
      const scNo      = p.contract_no || "—";
      const orderNo   = p.raw?.customerPO || "—";
      const vessel    = [p.vessel, p.voyage].filter(Boolean).join(" / ") || "—";
      const ctnType   = p.container_type || "40HQ";
      const ctnNos       = (p.container_no || "").split(/[,/]\s*/).map(s=>s.trim()).filter(Boolean);
      const rawSealNos   = (p.raw?.sealNo || "").split(/[,/;]\s*/).map(s=>s.trim()).filter(Boolean);
      const totalCartons = p.total_cartons || p.raw?.totalCtns || null;
      const totalGW      = p.gross_weight_kg || null;
      const totalCBM     = p.total_cbm || null;
      const freightTerm  = "PREPAID";

      let factoryCode = "";
      try {
        // 2026-07-06 根治：外单常见 FSB.bl_no 存的是订舱号原文(如"I228525576")而 shipping_plans.bl_no
        // 是全称waybill号(如"YMJAI228525576")，纯bl_no精确匹配会找不到，导致误落回写死参考卡。
        // 改成 bl_no匹配 OR link_plan_id匹配(整数id，更可靠的关联键)。
        const payerRes = await pool.query(
          `SELECT DISTINCT payer_company_code
           FROM active_freight_supplier_bills
           WHERE (bl_no = $1 OR link_plan_id = $2)
             AND (cost_category !~* '海运|ocean|freight')
             AND COALESCE(amount,0) > 0
             AND COALESCE(payer_company_code,'') <> ''
           LIMIT 1`,
          [blNo, String(p.id)]
        );
        factoryCode = payerRes.rows[0]?.payer_company_code || "";
      } catch(_) {}

      let factory = null;
      if (factoryCode) {
        try {
          const factoryRes = await pool.query(
            `SELECT name_cn, tax_id FROM companies WHERE code = $1 LIMIT 1`,
            [factoryCode]
          );
          factory = factoryRes.rows[0] || null;
        } catch(_) {}
      }
      const billTo = factory ? (factory.name_cn || factoryCode) : factoryCode;

      let portChargeRows = [];
      if (factoryCode) {
        try {
          const chargeRes = await pool.query(
            `SELECT cost_category, amount, currency, qty, unit_price, charge_basis
             FROM active_freight_supplier_bills
             WHERE (bl_no = $1 OR link_plan_id = $3)
               AND payer_company_code = $2
               AND (cost_category !~* '海运|ocean|freight')
               AND UPPER(COALESCE(currency,'CNY')) = 'CNY'
               AND COALESCE(amount,0) > 0
             ORDER BY id`,
            [blNo, factoryCode, String(p.id)]
          );
          portChargeRows = chargeRes.rows;
        } catch(_) {}
      }

      // ── 标准港杂费率卡（Damon 2026-06-29 定，覆盖系统脏数据）整票×1 / 每柜×柜量 ──
      // 2026-07-06 根治：真实账单(freight_supplier_bills 已挂 payer_company_code)存在时优先用真实数据，
      // 只有真查不到(historical脏数据/未挂payer)才落回这张写死参考卡兜底，不再无条件覆盖真实值。
      let usedFallbackCard = false;
      if (!portChargeRows.length) {
        usedFallbackCard = true;
        const PORT_CHARGE_CARD = [
          { name:"舱单费",            basis:"整票", price:100,  perCtn:false },
          { name:"码头操作费(THC)",    basis:"每柜", price:1100, perCtn:true  },
          { name:"铅封费",            basis:"每柜", price:55,   perCtn:true  },
          { name:"单证费",            basis:"整票", price:400,  perCtn:false },
          { name:"港杂费",            basis:"每柜", price:50,   perCtn:true  },
          { name:"提箱费",            basis:"每柜", price:307,  perCtn:true  },
          { name:"电放费",            basis:"整票", price:450,  perCtn:false },
          { name:"设备交接单费",       basis:"每柜", price:50,   perCtn:true  },
          { name:"燃油附加费",         basis:"每柜", price:50,   perCtn:true  },
          { name:"订舱费",            basis:"整票", price:100,  perCtn:false },
          { name:"码头信息服务费",     basis:"每柜", price:7,    perCtn:true  },
          { name:"EDI",              basis:"每柜", price:3.90, perCtn:true  },
          { name:"场站费用",          basis:"每柜", price:400,  perCtn:true  },
        ];
        const ctnQtyPC = parseInt(p.container_qty) || 1;
        portChargeRows = PORT_CHARGE_CARD.map(c => {
          const qty = c.perCtn ? ctnQtyPC : 1;
          return { cost_category:c.name, charge_basis:c.basis, currency:"CNY", qty, unit_price:c.price, amount:Number((c.price*qty).toFixed(2)) };
        });
      }

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

      const totalCny = portChargeRows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
      const chargeRowsHtml = portChargeRows.length
        ? portChargeRows.map(r => {
          const qty = r.qty == null || r.qty === "" ? 1 : Number(r.qty);
          const unitPrice = r.unit_price == null || r.unit_price === "" ? Number(r.amount || 0) : Number(r.unit_price);
          return `<tr>
        <td>${esc(r.cost_category || "港杂费 Port Charges")}</td>
        <td>${esc(r.charge_basis || "整票")}</td>
        <td class="c">${esc(r.currency || "CNY")}</td>
        <td class="c">${fmtNum(qty, 0)}</td>
        <td class="r">${fmtNum(unitPrice)}</td>
        <td class="r">${fmtNum(r.amount)}</td>
      </tr>`;
        }).join("")
        : `<tr><td colspan="6" style="text-align:center;color:#999">No CNY port charge rows found / 未找到人民币港杂费明细</td></tr>`;

      // 账单号：PC-{BL}-{YYYYMMDD}
      const portchargeNo = "PC-" + (p.bl_no || p.shipment_no || String(p.id)).replace(/[^A-Z0-9]/gi,"").toUpperCase() + "-" + genDate.replace(/-/g, "");

      const fobPortchargeHtml = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>Port Charge Statement — ${esc(p.shipment_no || blNo)}</title>
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
      <div class="doc-cn">港杂费账单</div>
      <div class="inv-no">No. ${esc(portchargeNo)}</div>
    </div>
  </div>

  ${usedFallbackCard ? `<div style="background:#fff3cd;border:2px solid #c00;border-radius:4px;padding:8px 12px;margin-bottom:12px;font-size:11px;font-weight:800;color:#c00">
    ⚠️ 系统未查到该票真实账单明细(freight_supplier_bills)，以下为标准参考费率估算，非实际账单数据，出单前请人工核实真实费用！
    <br>⚠️ NOT ACTUAL BILLED CHARGES — reference rate card only, verify against real supplier invoice before issuing.
  </div>` : ""}

  <div class="info-grid">
    <div class="info-box">
      <div class="row"><div class="lbl">TO (工厂名称):</div><div class="val big">${esc(billTo)}</div></div>
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
      <tr class="section"><td colspan="6">Port Charges | 港杂费</td></tr>
      ${chargeRowsHtml}
    </tbody>
    <tfoot>
      <tr class="total-usd"><td class="label" colspan="5">TOTAL CNY (人民币合计)</td><td>¥ ${fmtNum(totalCny)}</td></tr>
    </tfoot>
  </table>

  <div class="fx-note">* Port charges are payable in CNY only. / 港杂费仅按人民币支付。</div>

  <div class="pay-grid">
    <div class="pay-box cny" style="grid-column:1 / -1">
      <div class="plbl">TOTAL PAYABLE IN CNY · 人民币应付合计</div>
      <div class="pamt">¥ ${fmtNum(totalCny)}</div>
      <div class="psub">Port charges only · Remit to CNY A/C below</div>
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
      Swift Code: <strong>BKCHCNBJ73A</strong><br>
      Bank Addr: No. 40 North Hubin Road, Xiamen<br>
      USD Account (美金账号): <strong>433849630299</strong><br>
      CNY Account (人民币账号): <strong>433849860868</strong><br>
      <span style="color:#c00;font-size:8px">* Please check the account number carefully before remittance.</span>
    </div>
  </div>


</div>${autoprint}</body></html>`;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).send(fobPortchargeHtml);
    }

    // ══════════════════════════════════════════
    // DEPRECATED 2026-05-18 · Use /api/db/documents?type=debit&id=<shipping_plan_id>
    // The canonical debit note generator now lives in documents.js (Sanlyn OS branded).
    // 301 redirect preserves any existing bookmarks/links.
    // ══════════════════════════════════════════
    if (isDebitNote) {
      return res.redirect(301, "/api/db/documents?type=debit&id=" + encodeURIComponent(req.query?.id || ""));
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
      <div class="cn">上海洋宝宝国际物流有限公司</div>
      <div class="en">Shanghai Ocean Baby International Logistics Co., Ltd.</div>
      <div class="tag">Ocean Freight · Air Freight · Express · Integrated Logistics Solutions</div>
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
    Bank: <strong>BANK OF CHINA XIAMEN BRANCH</strong> &nbsp;·&nbsp; Swift: <strong>BKCHCNBJ73A</strong><br>
    USD A/C: <strong>433849630299</strong> &nbsp;·&nbsp; CNY A/C: <strong>433849860868</strong><br>
    Account Name: <strong>SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.</strong>
  </div>

  <!-- See-quotation link — only shown when quote_ref exists -->
  ${quoteRef ? `
  <div style="background:#f0f9ff;border:1px dashed #38bdf8;border-radius:5px;padding:8px 12px;margin-top:10px;font-size:10px;color:#0369a1">
    📄 <strong>For itemized breakdown · 完整费用明细见报价单</strong> &nbsp;·&nbsp; Quote Ref: <strong class="mono">${esc(quoteRef)}</strong>
  </div>` : ""}

  <!-- Footer -->
  <div class="footer-bar">
    <span>Contact: Damon · Email: damon@sanlynos.com</span>
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

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    return res.status(200).send(html);

  } catch (err) {
    console.error("[shipping-plan-pdf]", err);
    return res.status(500).send(`<h1>Error: ${err.message}</h1>`);
  }
}
