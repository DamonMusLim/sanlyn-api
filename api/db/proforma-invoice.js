// /api/db/proforma-invoice.js
// GET ?id=ORDER_ID         → Proforma Invoice HTML (printable / save as PDF)
// GET ?id=ORDER_ID&print=1 → auto-print on open
// GET ?id=ORDER_ID&lang=en → English only (default: bilingual)
//
// Multi-company: pass &company=petbaby|bamibi|etc  (default: reads from order.issuing_company or tenant)
// Returns text/html  — browser Ctrl+P or Save as PDF

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard

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
      "包装: 出口标准纸箱 / Export standard cartons.",
      "装运: 收到定金后30天内 / Shipment within 30 days.",
      "付款: 30%定金, 70%余款凭提单副本 / 30% Deposit, 70% against BL copy.",
      "索赔: 货到后30天内提出 / Claims within 30 days of arrival.",
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
      "包装: 出口标准纸箱 / Export standard cartons.",
      "装运: 收到定金后30天内 / Shipment within 30 days.",
      "付款: 30%定金, 70%余款凭提单副本 / 30% Deposit, 70% against BL copy.",
      "索赔: 货到后30天内提出 / Claims within 30 days of arrival.",
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
  if (!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT
  if (req.method !== "GET") return res.status(405).end();

  // ── Secondary token auth (DOCS_SECRET — for external share links) ──
  // S18.1 note: JWT check above is primary; DOCS_SECRET is an additional optional layer.
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
    var CUST_ADDRS_PI={"petsome":"LOT 1716, JALAN SG LONG, BATU 11, SG LONG, 43000 KAJANG, SELANGOR, MALAYSIA","dibaq":"LOT 1716, JALAN SG LONG, BATU 11, SG LONG, 43000 KAJANG, SELANGOR, MALAYSIA","enrich":"NO.2 JALAN PERDANA 1A, TAMAN SEGAR PERDANA, 43200 CHERAS, SELANGOR, MALAYSIA"};
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
    function _up(p){var v=p.unitPrice||p.price||p.unit_price||p.salePrice||p["_widget_1764396068577"]||0;if((!v||Number(v)===0)&&(p.subtotal||p.amount)&&p.qty&&Number(p.qty)>0)v=Number(p.subtotal||p.amount||0)/Number(p.qty);return v;}

    var total = 0;
    products.forEach(function(p) {
      var sub = Number(p.subtotal || p.amount || 0);
      if (!sub && p.qty) sub = Number(p.qty) * Number(_up(p));
      total += sub;
    });
    if (!total) total = Number(order.total_amount) || 0;

    // ── Generate invoice number for display ──
    var invoiceDisplay = "FS" + new Date().getFullYear() + (piNo.replace(/[^0-9]/g,"").slice(-8) || "00000001");

    // ── HTML ──
    var productRowsHtml = products.length > 0 ? products.map(function(p, i) {
      var name = p.productName || p.name || p.description || "-";
      var size = p.size || p.spec || "";
      var desc = size ? name + " (" + size + ")" : name;
      var qty = p.qty || p.quantity || "-";
      var up = _up(p);
      var sub = Number(p.subtotal || p.amount || 0);
      if (!sub && p.qty) sub = Number(p.qty) * Number(up);
      return '<tr><td>' + String(i+1).padStart(2,"0") + '</td><td>' + esc(desc) + '</td><td class="text-right">' + esc(String(qty)) + '</td><td class="text-right">' + fmtMoney(up) + '</td><td class="text-right">' + fmtMoney(sub) + '</td></tr>';
    }).join("") : '<tr><td>01</td><td colspan="4" style="color:#999;font-style:italic">— 产品明细将从订单自动填入 —</td></tr>';

    var termsHtml = cfg.terms.map(function(t,i){ return (i+1) + ". " + esc(t); }).join("<br>\n            ");

    var html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Proforma Invoice — ${esc(piNo)}</title>
<style>
  body{font-family:'Helvetica','Arial','PingFang SC',sans-serif;color:#000;margin:0;padding:30px;font-size:11px;line-height:1.4;}
  .container{max-width:800px;margin:auto;}
  .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:15px;margin-bottom:25px;}
  .seller-info{flex:1;}
  .seller-name{font-size:20px;font-weight:900;text-transform:uppercase;margin-bottom:5px;}
  .doc-type{text-align:right;}
  .doc-type h1{margin:0;font-size:28px;font-weight:900;letter-spacing:1px;}
  .doc-type p{font-size:14px;font-weight:bold;margin:2px 0;}
  .meta-grid{display:grid;grid-template-columns:1.2fr 0.8fr;gap:40px;margin-bottom:20px;}
  .section-label{font-size:10px;font-weight:bold;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:3px;margin-bottom:8px;color:#444;}
  .meta-list{list-style:none;padding:0;margin:0;}
  .meta-list li{margin-bottom:4px;display:flex;}
  .meta-list li b{width:110px;font-weight:bold;}
  .trade-terms-bar{border:2px solid #000;padding:10px;display:flex;justify-content:space-between;margin-bottom:25px;font-weight:bold;font-size:11px;}
  table{width:100%;border-collapse:collapse;margin-bottom:25px;}
  th{background:#000;color:#fff;padding:10px;text-align:left;font-size:10px;text-transform:uppercase;}
  td{padding:10px;border-bottom:1px solid #000;vertical-align:top;}
  .text-right{text-align:right;}
  .total-row{font-size:13px;font-weight:900;background:#fff;}
  .details-grid{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:10px;}
  .details-box{border:1px solid #000;padding:12px;}
  .details-box h4{margin:0 0 10px 0;font-size:11px;text-transform:uppercase;text-decoration:underline;}
  .signature-grid{display:flex;justify-content:space-between;margin-top:50px;}
  .sig-box{width:45%;border-top:2px solid #000;padding-top:10px;text-align:center;height:100px;font-weight:bold;display:flex;flex-direction:column;justify-content:space-between;}
  .brand-slogan{text-align:center;margin-top:60px;font-size:9px;color:#888;border-top:1px dashed #ccc;padding-top:15px;letter-spacing:1px;}
  .brand-slogan b{color:#555;}
  @media print{body{padding:0;}.container{max-width:100%;border:none;}}
</style>
${autoPrint ? '<script>window.onload=function(){window.print()}<\/script>' : ''}
</head>
<body>
<div class="container">
    <div class="header">
        <div class="seller-info">
            <div class="seller-name">${esc(cfg.nameCN)} / ${esc(cfg.nameEN)}</div>
            <p style="margin:2px 0;">${esc(cfg.address)}</p>
            <p style="margin:2px 0;">Tel: ${esc(cfg.tel)} | Email: ${esc(cfg.email)}</p>
        </div>
        <div class="doc-type">
            <h1>形式发票</h1>
            <p>PROFORMA INVOICE</p>
        </div>
    </div>
    <div class="meta-grid">
        <div>
            <div class="section-label">付款方 / BUYER (BILL TO)</div>
            <p style="font-size:13px;font-weight:bold;margin:0;">${esc(customer) || "[BUYER NAME]"}</p>
            <p style="margin:5px 0;">${esc(customerAddr) || "[ADDRESS]"}</p>
            ${customerTel ? '<p style="margin:2px 0;">Tel: ' + esc(customerTel) + '</p>' : ''}
        </div>
        <div>
            <div class="section-label">单据详情 / DETAILS</div>
            <ul class="meta-list">
                <li><b>发票编号 No.:</b> ${esc(invoiceDisplay)}</li>
                <li><b>订单编号 Order:</b> ${esc(orderNo)}</li>
                <li><b>日期 Date:</b> ${esc(piDate)}</li>
                <li><b>币种 Currency:</b> ${esc(currency)}</li>
            </ul>
        </div>
    </div>
    <div class="trade-terms-bar">
        <span>装运港 POL: ${esc(pol)}</span>
        <span>目的港 POD: ${esc(pod)}</span>
        <span>贸易术语 Terms: ${esc(incoterms)} (Incoterms® 2020)</span>
    </div>
    <table>
        <thead>
            <tr>
                <th style="width:40px;">No.</th>
                <th>品名及规格 Description &amp; Size</th>
                <th class="text-right" style="width:80px;">数量 Qty</th>
                <th class="text-right" style="width:80px;">单价 Price</th>
                <th class="text-right" style="width:100px;">金额 Amount</th>
            </tr>
        </thead>
        <tbody>
            ${productRowsHtml}
        </tbody>
        <tfoot>
            <tr class="total-row">
                <td colspan="4" class="text-right">总计金额 TOTAL AMOUNT (${esc(currency)}):</td>
                <td class="text-right">${fmtMoney(total)}</td>
            </tr>
        </tfoot>
    </table>
    <div class="details-grid">
        <div class="details-box">
            <h4>成交条款 TERMS &amp; CONDITIONS</h4>
            ${termsHtml}
        </div>
        <div class="details-box">
            <h4>银行信息 BANKING INFORMATION</h4>
            受益人: ${esc(cfg.bank.beneficiary)}<br>
            银行: ${esc(cfg.bank.bankName)}<br>
            SWIFT: ${esc(cfg.bank.swift)}<br>
            账号 Acc No.: ${esc(cfg.bank.usdAccount)}<br>
            <span style="color:red;font-size:10px;font-weight:bold;">* 付款前请务必核对账号信息 / Please verify bank info before payment.</span>
        </div>
    </div>
    <div class="signature-grid">
        <div class="sig-box">
            <span>BUYER AUTHORIZED SIGNATURE</span>
            <span style="font-weight:normal;font-size:9px;">(买方授权签署 / 盖章)</span>
        </div>
        <div class="sig-box">
            <span>SELLER AUTHORIZED SIGNATURE</span>
            <span style="font-weight:normal;font-size:9px;">(卖方授权签署 / 盖章)</span>
        </div>
    </div>
    <div class="brand-slogan">
        ⚡ Generated &amp; Verified by <b>Sanlyn OS Supply Chain Engine</b>
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
