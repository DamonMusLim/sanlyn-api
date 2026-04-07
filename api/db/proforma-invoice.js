// /api/db/proforma-invoice.js
// GET ?id=ORDER_ID         → Proforma Invoice HTML (printable / save as PDF)
// GET ?id=ORDER_ID&print=1 → auto-print on open
// GET ?id=ORDER_ID&lang=en → English only (default: bilingual)
//
// Multi-company: pass &company=petbaby|bamibi|etc  (default: reads from order.issuing_company or tenant)
// Returns text/html  — browser Ctrl+P or Save as PDF

import { getPool, setCors } from "../db.js";

// ── Company configs (add more companies here as needed) ──
var COMPANY_CONFIGS = {
  default: {
    nameCN: "厦门巴匕进出口有限公司",
    nameEN: "XIAMEN PET BABY IMPORT AND EXPORT CO., LTD",
    address: "4th Floor, 26-9# Huarong Road, Huli, Xiamen, China",
    tel: "+86 186 0905 8888",
    email: "info@petbaby.cn",
    bank: {
      beneficiary: "XIAMEN PET BABY IMPORT AND EXPORT CO., LTD",
      bankName: "BANK OF CHINA XIAMEN BRANCH",
      swift: "BKCHCNBI73A",
      bankAddr: "No. 40 North Hubin Road, Xiamen, China",
      usdAccount: "4299 8287 9286",
      rmbAccount: "4312 7991 8006",
    },
    terms: [
      "PACKAGING: Export standard cartons.",
      "SHIPMENT: Within 30 days after receipt of the deposit.",
      "PAYMENT: 30% deposit via T/T, 70% balance against copy of B/L.",
      "QUALITY CLAIM: Claims must be made within 30 days after cargo arrival at the destination port.",
      "VALIDITY: This invoice is valid for 7 days from the date of issue.",
    ],
  },
  sanlyn: {
    nameCN: "厦门三麟进出口有限公司",
    nameEN: "XIAMEN SANLYN IMPORT AND EXPORT CO., LTD",
    address: "Xiamen, Fujian, China",
    tel: "+86 186 0905 8888",
    email: "info@sanlyn.cn",
    bank: {
      beneficiary: "XIAMEN SANLYN IMPORT AND EXPORT CO., LTD",
      bankName: "BANK OF CHINA XIAMEN BRANCH",
      swift: "BKCHCNBI73A",
      bankAddr: "No. 40 North Hubin Road, Xiamen, China",
      usdAccount: "[USD Account]",
      rmbAccount: "[RMB Account]",
    },
    terms: [
      "PACKAGING: Export standard cartons.",
      "SHIPMENT: Within 30 days after receipt of the deposit.",
      "PAYMENT: 30% deposit via T/T, 70% balance against copy of B/L.",
      "QUALITY CLAIM: Claims must be made within 30 days after cargo arrival.",
      "VALIDITY: This invoice is valid for 7 days from the date of issue.",
    ],
  },
};

function fmt(v, decimals) {
  if (v === null || v === undefined || v === "") return "-";
  var n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toFixed(decimals !== undefined ? decimals : 2);
}
function fmtMoney(v) {
  if (!v && v !== 0) return "-";
  var n = Number(v);
  if (isNaN(n)) return String(v);
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(v) {
  if (!v) return "-";
  try { return new Date(v).toISOString().slice(0, 10); } catch (e) { return String(v); }
}
function esc(s) {
  if (!s) return "";
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).end();

  // ── Token auth ──
  var DOC_TOKEN = process.env.DOCS_SECRET || "";
  var reqToken = req.query.token || req.headers["x-docs-token"] || "";
  if(DOC_TOKEN && reqToken !== DOC_TOKEN){
    return res.status(401).send("<h1>401 Unauthorized</h1><p>Missing or invalid access token.</p>");
  }

  var { id, company = "default", print: autoPrint } = req.query;
  if (!id) return res.status(400).send("<h1>Missing id (order _id or contract_no)</h1>");

  var cfg = COMPANY_CONFIGS[company] || COMPANY_CONFIGS["default"];

  try {
    var pool = getPool();

    // ── Fetch order ──
    var orderRes = await pool.query(
      "SELECT * FROM orders WHERE _id = $1 OR contract_no = $1 OR customer_po = $1 LIMIT 1",
      [id]
    );
    if (!orderRes.rows.length) return res.status(404).send("<h1>Order not found: " + esc(id) + "</h1>");
    var order = orderRes.rows[0];
    var raw = order.raw || {};
    if (typeof raw === "string") try { raw = JSON.parse(raw); } catch(e) { raw = {}; }

    // ── Resolve company config from order if not explicitly passed ──
    if (!req.query.company) {
      var issuingCo = (raw.issuingCompanyEN || raw.issuingCompany || "").toLowerCase();
      if (issuingCo.includes("sanlyn")) cfg = COMPANY_CONFIGS["sanlyn"] || cfg;
    }

    // ── Customer info ──
    var customer = order.company_name_en || raw.companyNameEN || raw.companyNameCN || order.customer || "";
    var _rawAddr = raw.customerAddress || raw.deliveryAddress || "";
    var CUST_ADDRS_PI={"petsome":"LOT 1716, JALAN SG LONG, BATU 11, SG LONG, 43000 KAJANG, SELANGOR, MALAYSIA","dibaq":"LOT 1716, JALAN SG LONG, BATU 11, SG LONG, 43000 KAJANG, SELANGOR, MALAYSIA"};
    var customerAddr=(function(name,existing){if(existing&&existing.trim().length>3)return existing;var k=(name||"").toLowerCase();for(var key in CUST_ADDRS_PI){if(k.includes(key))return CUST_ADDRS_PI[key];}return existing||"";})(customer,_rawAddr);
    var customerTel = raw.phone || "";

    // ── PI number: use contract_no or generate from order_no ──
    var piNo = order.contract_no || ("PI-" + (order.order_no || id).toString().replace(/[^A-Z0-9-]/gi,"").slice(0,20));
    var orderNo = raw.customerPO || order.customer_po || order.order_no || "-";
    var piDate = fmtDate(order.delivery_date || order.created_at);
    var currency = raw.currency || order.currency || "USD";
    var pol = raw.pol || raw.portOfLoading || "-";
    var pod = raw.destination || raw.pod || raw.destinationPort || "-";
    var incoterms = raw.tradeTerms || raw.incoterms || "FOB";

    // ── Products ──
    var products = [];
    if (Array.isArray(raw.products)) products = raw.products;
    else if (Array.isArray(raw.items)) products = raw.items;

    // Calculate total
    var total = 0;
    products.forEach(function(p) {
      var sub = Number(p.subtotal || p.amount || 0);
      if (!sub && p.qty && p.unitPrice) sub = Number(p.qty) * Number(p.unitPrice);
      total += sub;
    });
    if (!total) total = Number(order.total_amount) || 0;

    // ── Generate invoice number for display ──
    var invoiceDisplay = "FS" + new Date().getFullYear() + (piNo.replace(/[^0-9]/g,"").slice(-8) || "00000001");

    // ── HTML ──
    var html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proforma Invoice — ${esc(piNo)}</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter','Noto Sans SC',Arial,sans-serif;color:#222;background:#f0f0f0;font-size:13px;}
  .page{background:#fff;width:210mm;min-height:297mm;margin:0 auto;padding:14mm 14mm 10mm 14mm;position:relative;}

  /* Header */
  .header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;}
  .seller-name{font-size:22px;font-weight:800;color:#111;line-height:1.2;letter-spacing:-0.3px;}
  .seller-sub{font-size:9.5px;color:#888;margin-top:2px;font-weight:500;}
  .seller-addr{font-size:10px;color:#555;margin-top:4px;line-height:1.5;}
  .title-block{text-align:right;}
  .title-cn{font-size:26px;font-weight:800;color:#111;letter-spacing:2px;}
  .title-en{font-size:13px;font-weight:700;letter-spacing:2px;color:#555;margin-top:3px;}

  .divider{border:none;border-top:2px solid #111;margin:16px 0 12px 0;}

  /* Info row */
  .info-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:10px;}
  .info-section{border:1px solid #ddd;border-radius:2px;}
  .info-section-hdr{font-size:9px;font-weight:700;letter-spacing:1px;color:#888;padding:4px 8px;border-bottom:1px solid #eee;background:#fafafa;text-transform:uppercase;}
  .info-section-body{padding:8px;}
  .buyer-name{font-size:13px;font-weight:700;color:#111;margin-bottom:3px;}
  .buyer-addr{font-size:10.5px;color:#444;line-height:1.5;}
  .details-grid{display:grid;grid-template-columns:auto 1fr;gap:3px 8px;align-items:baseline;}
  .detail-lbl{font-size:10px;color:#888;white-space:nowrap;}
  .detail-val{font-size:12px;font-weight:600;color:#111;}

  /* Port banner */
  .port-banner{border:2px solid #111;color:#111;background:#fff;display:flex;border-radius:2px;overflow:hidden;margin-bottom:10px;}
  .port-cell{flex:1;padding:8px 12px;border-right:1px solid #ddd;}
  .port-cell:last-child{border-right:none;}
  .port-lbl{font-size:8.5px;font-weight:700;letter-spacing:1px;color:#aaa;text-transform:uppercase;margin-bottom:2px;}
  .port-val{font-size:12px;font-weight:600;}

  /* Products table */
  table.items{width:100%;border-collapse:collapse;margin-bottom:0;}
  table.items thead tr{background:#111;color:#fff;}
  table.items th{padding:8px 10px;font-size:10.5px;font-weight:700;letter-spacing:0.5px;text-align:center;}
  table.items th.left{text-align:left;}
  table.items td{padding:7px 10px;border-bottom:1px solid #eee;font-size:12px;vertical-align:middle;}
  table.items td.center{text-align:center;}
  table.items td.right{text-align:right;}
  table.items td.no{text-align:center;color:#888;width:36px;}
  table.items tr.total-row td{border-top:2px solid #111;border-bottom:none;padding-top:10px;font-weight:700;font-size:13px;}
  table.items tr:nth-child(even) td{background:#fafafa;}
  .total-label{text-align:right;color:#555;font-size:11px;}
  .total-amount{text-align:right;font-size:16px;font-weight:800;color:#111;}

  /* T&C + Banking */
  .bottom-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;}
  .bottom-card{border:1px solid #ddd;border-radius:2px;}
  .bottom-hdr{font-size:9.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;padding:5px 10px;border-bottom:1px solid #eee;background:#fafafa;}
  .bottom-body{padding:10px;font-size:10.5px;color:#444;line-height:1.7;}
  .bottom-body ol{padding-left:14px;}
  .bottom-body li{margin-bottom:1px;}
  .bank-row{display:flex;gap:4px;margin-bottom:3px;}
  .bank-lbl{color:#888;min-width:72px;font-size:10px;}
  .bank-val{color:#111;font-weight:500;font-size:10.5px;}
  .bank-warning{color:#c00;font-size:9.5px;margin-top:6px;font-weight:600;}

  /* Signatures */
  .sig-row{display:flex;justify-content:space-between;margin-top:16px;padding-top:6px;}
  .sig-block{width:44%;text-align:center;}
  .sig-line{border-top:1px solid #aaa;margin-bottom:6px;padding-top:6px;}
  .sig-label{font-size:10px;font-weight:700;letter-spacing:0.5px;color:#444;text-transform:uppercase;}
  .sig-sub{font-size:9px;color:#999;margin-top:3px;}
  .sig-space{height:44px;}

  /* Footer */
  .footer{margin-top:14px;text-align:center;font-size:9px;color:#bbb;border-top:1px solid #eee;padding-top:6px;}
  .footer span{color:#f9ab00;font-weight:700;}

  @media print{
    body{background:#fff;}
    .page{width:100%;padding:10mm 12mm 8mm 12mm;box-shadow:none;}
  }
</style>
${autoPrint ? '<script>window.onload=function(){window.print();}</script>' : ''}
</head>
<body>
<div class="page">

  <!-- ── Header ── -->
  <div class="header">
    <div>
      <div class="seller-name">${esc(cfg.nameEN)}</div>
      <div class="seller-sub">Global Sourcing &amp; Supply Chain Partner</div>
      <div class="seller-addr">
        ${esc(cfg.address)}<br>
        Tel: ${esc(cfg.tel)} &nbsp;|&nbsp; Email: ${esc(cfg.email)}
      </div>
    </div>
    <div class="title-block">
      <div class="title-cn">形式发票</div>
      <div class="title-en">PROFORMA INVOICE</div>
    </div>
  </div>

  <hr class="divider">

  <!-- ── Buyer + Details ── -->
  <div class="info-row">
    <div class="info-section">
      <div class="info-section-hdr">BUYER (BILL TO)</div>
      <div class="info-section-body">
        <div class="buyer-name">${esc(customer) || "[BUYER NAME]"}</div>
        <div class="buyer-addr">
          ${esc(customerAddr)}
          ${customerTel ? "<br>Tel: " + esc(customerTel) : ""}
        </div>
      </div>
    </div>
    <div class="info-section">
      <div class="info-section-hdr">DETAILS</div>
      <div class="info-section-body">
        <div class="details-grid">
          <div class="detail-lbl">No.:</div>
          <div class="detail-val">${esc(piNo)}</div>
          <div class="detail-lbl">Order:</div>
          <div class="detail-val">${esc(orderNo)}</div>
          <div class="detail-lbl">Date:</div>
          <div class="detail-val">${esc(piDate)}</div>
          <div class="detail-lbl">Currency:</div>
          <div class="detail-val">${esc(currency)}</div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Port Banner ── -->
  <div class="port-banner">
    <div class="port-cell">
      <div class="port-lbl">PORT OF LOADING</div>
      <div class="port-val">${esc(pol)}</div>
    </div>
    <div class="port-cell">
      <div class="port-lbl">PORT OF DESTINATION</div>
      <div class="port-val">${esc(pod)}</div>
    </div>
    <div class="port-cell">
      <div class="port-lbl">TERMS (Incoterms® 2020)</div>
      <div class="port-val">${esc(incoterms)}</div>
    </div>
  </div>

  <!-- ── Products Table ── -->
  <table class="items">
    <thead>
      <tr>
        <th style="width:36px">NO.</th>
        <th class="left">品名 Description</th>
        <th style="width:100px;text-align:center">规格 Size</th>
        <th style="width:60px">数量 QTY</th>
        <th style="width:90px">单价 Price</th>
        <th style="width:100px">金额 Amount</th>
      </tr>
    </thead>
    <tbody>
      ${products.length > 0 ? products.map(function(p, i) {
        var name = p.productName || p.name || p.description || "-";
        var size = p.size || p.spec || "-";
        var qty = p.qty || p.quantity || "-";
        var _up=p.unitPrice||p.price||p.unit_price||p["_widget_1764396068577"]||0;
        if((!_up||Number(_up)===0)&&(p.subtotal||p.amount)&&p.qty&&Number(p.qty)>0)_up=Number(p.subtotal||p.amount||0)/Number(p.qty);
        var unitPrice = fmtMoney(_up);
        var sub = Number(p.subtotal || p.amount || 0);
        if (!sub && p.qty && _up) sub = Number(p.qty) * Number(_up);
        return `<tr>
          <td class="no">${String(i+1).padStart(2,"0")}</td>
          <td>${esc(name)}</td>
          <td class="center">${esc(size)}</td>
          <td class="center">${esc(String(qty))}</td>
          <td class="right">${unitPrice}</td>
          <td class="right">${fmtMoney(sub)}</td>
        </tr>`;
      }).join("") : `<tr>
          <td class="no">01</td>
          <td colspan="5" style="color:#ccc;font-style:italic;">— 产品明细将从订单自动填入 —</td>
        </tr>`}
      <!-- Empty filler rows if < 3 items -->
      ${products.length > 0 && products.length < 3 ? Array(3 - products.length).fill(0).map(function(_,i){
        return `<tr><td class="no" style="color:#ddd">${String(products.length+i+1).padStart(2,"0")}</td><td colspan="5"></td></tr>`;
      }).join("") : ""}
      <!-- Total row -->
      <tr class="total-row">
        <td colspan="4" class="total-label">TOTAL AMOUNT (${esc(currency)}):</td>
        <td colspan="2" class="total-amount">${fmtMoney(total)}</td>
      </tr>
    </tbody>
  </table>

  <!-- ── Terms + Banking ── -->
  <div class="bottom-grid">
    <div class="bottom-card">
      <div class="bottom-hdr">TERMS &amp; CONDITIONS</div>
      <div class="bottom-body">
        <ol>
          ${cfg.terms.map(function(t){ return "<li>" + esc(t) + "</li>"; }).join("")}
        </ol>
      </div>
    </div>
    <div class="bottom-card">
      <div class="bottom-hdr">BANKING INFORMATION</div>
      <div class="bottom-body">
        <div class="bank-row"><div class="bank-lbl">受益人:</div><div class="bank-val">${esc(cfg.bank.beneficiary)}</div></div>
        <div class="bank-row"><div class="bank-lbl">银行:</div><div class="bank-val">${esc(cfg.bank.bankName)}</div></div>
        <div class="bank-row"><div class="bank-lbl">SWIFT:</div><div class="bank-val">${esc(cfg.bank.swift)}</div></div>
        <div class="bank-row"><div class="bank-lbl">银行地址:</div><div class="bank-val">${esc(cfg.bank.bankAddr)}</div></div>
        <div class="bank-row"><div class="bank-lbl">USD Account:</div><div class="bank-val">${esc(cfg.bank.usdAccount)}</div></div>
        <div class="bank-row"><div class="bank-lbl">RMB Account:</div><div class="bank-val">${esc(cfg.bank.rmbAccount)}</div></div>
        <div class="bank-warning">* 付款前请务必核对账号信息 / Please verify bank info before payment.</div>
      </div>
    </div>
  </div>

  <!-- ── Signatures ── -->
  <div class="sig-row">
    <div class="sig-block">
      <div class="sig-space"></div>
      <div class="sig-line"></div>
      <div class="sig-label">Buyer Authorized Signature</div>
      <div class="sig-sub">(买方授权签署 / 盖章)</div>
    </div>
    <div class="sig-block">
      <div class="sig-space"></div>
      <div class="sig-line"></div>
      <div class="sig-label">Seller Authorized Signature</div>
      <div class="sig-sub">(卖方授权签署 / 盖章)</div>
    </div>
  </div>

  <!-- ── Footer ── -->
  <div class="footer">
    <span>⚡</span> Generated &amp; Verified by <span>Sanlyn OS Supply Chain Engine</span>
  </div>

</div>
</body>
</html>`;

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(html);

  } catch (err) {
    return res.status(500).send("<h1>Error: " + esc(err.message) + "</h1>");
  }
}
