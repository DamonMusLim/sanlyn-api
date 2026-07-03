// /api/db/credit-note-doc.js — Credit Note (贷记通知单) renderer
// Standalone module (≤500-line rule): documents.js delegates type=cn here.
// Reads credit_notes by cn_no and renders a customer-facing Credit Note HTML.
// Modeled on the Debit Note layout in documents.js. 2026-06-28.

function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}
function fmtM(n){var x=Number(n||0);return x.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}
function fmtD(d){if(!d)return"";try{var x=new Date(d);return x.getFullYear()+"-"+String(x.getMonth()+1).padStart(2,"0")+"-"+String(x.getDate()).padStart(2,"0");}catch(e){return String(d);}}

async function loadSeller(pool, companyCode){
  try{
    var q = companyCode
      ? "SELECT * FROM seller_profiles WHERE code=$1 LIMIT 1"
      : "SELECT * FROM seller_profiles WHERE is_default=TRUE LIMIT 1";
    var r = await pool.query(q, companyCode?[companyCode]:[]);
    if(!r.rows.length) r = await pool.query("SELECT * FROM seller_profiles ORDER BY id LIMIT 1");
    var s = r.rows[0]||{};
    return { nameEN:s.name_en||"", address:s.address||"", tel:s.tel||"", email:s.email||"",
      bank:{ beneficiary:s.bank_beneficiary||s.name_en||"", bankName:s.bank_name||"",
        swift:s.bank_swift||"", usdAccount:s.usd_account||"", rmbAccount:s.rmb_account||"" } };
  }catch(e){ return { nameEN:"[SELLER]", address:"", tel:"", email:"", bank:{} }; }
}

// Render a Credit Note. Returns HTML string, or null if not found.
export async function renderCreditNote(pool, cnNo, opts){
  opts = opts || {};
  var r = await pool.query(
    "SELECT * FROM credit_notes WHERE cn_no=$1 OR id::text=$1 LIMIT 1", [cnNo]
  );
  if(!r.rows.length) return null;
  var cn = r.rows[0];
  var items = Array.isArray(cn.items) ? cn.items
    : (typeof cn.items==="string" ? (function(){try{return JSON.parse(cn.items);}catch(e){return [];}})() : []);
  // company_code on credit_notes is the CUSTOMER's code (= 收款方), not the
  // issuer. Seller = issuing company: prefer raw.issuing_company, else default.
  var _issuer = (cn.raw && (cn.raw.issuing_company||cn.raw.issuingCompany)) || null;
  var cfg = await loadSeller(pool, _issuer);
  var buyer = {};
  try { var _br = await pool.query("SELECT address FROM companies WHERE code=$1 LIMIT 1", [cn.company_code]); buyer = (_br.rows && _br.rows[0]) || {}; } catch(e){}
  var curr = cn.currency || "CNY";
  var total = Number(cn.net_amount||0);
  var ap = opts.print;

  var CSS=`<style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Helvetica','Arial','PingFang SC',sans-serif;color:#000;padding:30px;font-size:11px;line-height:1.4;background:#f0f0f0;}
    .container{max-width:820px;margin:auto;background:#fff;padding:30px;}
    .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:15px;margin-bottom:25px;}
    .seller-name{font-size:18px;font-weight:900;text-transform:uppercase;margin-bottom:4px;}
    .seller-sub{font-size:10px;color:#666;}
    .doc-type h1{margin:0;font-size:26px;font-weight:900;letter-spacing:1px;text-align:right;color:#b91c1c;}
    .doc-type p{font-size:13px;font-weight:700;margin:3px 0;text-align:right;color:#444;}
    .meta-grid{display:grid;grid-template-columns:1.2fr 0.8fr;gap:40px;margin-bottom:20px;}
    .section-label{font-size:10px;font-weight:700;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:3px;margin-bottom:8px;color:#444;}
    .meta-list{list-style:none;padding:0;margin:0;}
    .meta-list li{margin-bottom:5px;display:flex;gap:6px;}
    .meta-list b{min-width:120px;font-weight:700;}
    table{width:100%;border-collapse:collapse;margin-bottom:20px;}
    th{background:#000;color:#fff;padding:9px 8px;text-align:left;font-size:10px;text-transform:uppercase;}
    td{padding:8px;border-bottom:1px solid #ccc;vertical-align:top;}
    .tc{text-align:center;} .tr{text-align:right;}
    tfoot td{font-size:14px;font-weight:900;border-top:2px solid #000;border-bottom:none;color:#b91c1c;}
    .details-box{border:1px solid #000;padding:12px;margin-top:10px;}
    .details-box h4{margin:0 0 8px 0;font-size:11px;text-transform:uppercase;text-decoration:underline;}
    .sig-row{display:flex;justify-content:space-between;margin-top:46px;}
    .sig-b{width:45%;border-top:2px solid #000;padding-top:10px;text-align:center;height:70px;font-weight:700;}
    .footer-slogan{text-align:center;margin-top:26px;font-size:9px;color:#888;border-top:1px dashed #ccc;padding-top:12px;letter-spacing:1px;}
    @media print{body{background:#fff;padding:0;}.container{max-width:100%;}}
  </style>`;

  var rows = items.map(function(it,i){
    var no = it.no!=null?it.no:(i+1);
    var prodName = it.product||it.desc||it.product_name||it.name||"-";
    var prod = it.product_en ? (esc(prodName)+` <span style="color:#777">/ ${esc(it.product_en)}</span>`) : esc(prodName);
    var pdiffVal = it.unit_price_diff!=null ? it.unit_price_diff : (it.price_diff!=null ? it.price_diff : null);
    var diff = pdiffVal!=null ? fmtM(pdiffVal) : "—";
    var unitStr = it.unit||it.qty_unit||"-";
    var qty = it.qty!=null ? it.qty : "—";
    return `<tr><td>${String(no).padStart(2,"0")}</td><td>${prod}${it.note?`<div style="color:#777;font-size:9.5px;margin-top:2px">${esc(it.note)}</div>`:""}</td>`
      +`<td class="tc">${qty}</td><td class="tc">${esc(unitStr)}</td><td class="tr">${diff}</td>`
      +`<td class="tr">${fmtM(it.amount)}</td></tr>`;
  }).join("") || `<tr><td colspan="6" style="text-align:center;color:#ccc;font-style:italic;padding:20px">— 无明细 —</td></tr>`;

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Credit Note — ${esc(cn.cn_no)}</title>${CSS}${ap?'<script>window.onload=function(){window.print()}<\/script>':""}</head><body><div class="container">
    <div class="header">
      <div class="seller-info">
        <div class="seller-name">${esc(cfg.nameEN)}</div>
        <div class="seller-sub">${esc(cfg.address)}</div>
        ${(cfg.tel||cfg.email)?`<div class="seller-sub">${cfg.tel?`Tel: ${esc(cfg.tel)}`:""}${cfg.tel&&cfg.email?" | ":""}${cfg.email?`Email: ${esc(cfg.email)}`:""}</div>`:""}
      </div>
      <div class="doc-type"><h1>贷记通知单</h1><p>CREDIT NOTE</p></div>
    </div>
    <div class="meta-grid">
      <div>
        <div class="section-label">收款方 / TO</div>
        <p style="font-size:13px;font-weight:700;margin:0 0 4px 0">${esc(cn.company_name||"")}</p>
        ${buyer.address?`<p style="font-size:10px;color:#555;margin:0;line-height:1.5">${esc(buyer.address)}</p>`:""}
      </div>
      <div>
        <div class="section-label">单据详情 / DETAILS</div>
        <ul class="meta-list">
          <li><b>贷记单号 CN No.:</b>${esc(cn.cn_no)}</li>
          ${cn.order_no?`<li><b>订单号 Order No.:</b>${esc(cn.order_no)}</li>`:""}
          ${cn.contract_no?`<li><b>合同号 Contract:</b>${esc(cn.contract_no)}</li>`:""}
          ${cn.invoice_no?`<li><b>关联发票 Invoice:</b>${esc(cn.invoice_no)}</li>`:""}
          <li><b>日期 Date:</b>${fmtD(cn.issued_date||cn.created_at)}</li>
        </ul>
      </div>
    </div>
    <table>
      <thead><tr>
        <th style="width:40px">No.</th>
        <th>货物 / Description</th>
        <th class="tc" style="width:60px">数量 Qty</th>
        <th class="tc" style="width:50px">单位 Unit</th>
        <th class="tr" style="width:90px">单价差 Diff</th>
        <th class="tr" style="width:100px">贷记金额 Amount</th>
      </tr></thead>
      <tbody>${rows}</tbody>
      <tfoot><tr><td colspan="5" class="tr">贷记总额 TOTAL CREDIT (${esc(curr)}):</td><td class="tr">${fmtM(total)}</td></tr></tfoot>
    </table>
    ${cn.note?`<div class="details-box"><h4>备注 / Remarks</h4><p style="color:#555;font-size:10.5px">${esc(cn.note)}</p></div>`:""}
    <div class="details-box">
      <h4>退款账户 / Banking</h4>
      <div style="font-size:10.5px;line-height:1.8">受益人 ${esc(cfg.bank.beneficiary||"")}<br>银行 ${esc(cfg.bank.bankName||"")}<br>${cfg.bank.swift?`SWIFT ${esc(cfg.bank.swift)}<br>`:""}账号 RMB ${esc(cfg.bank.rmbAccount||"")} ${cfg.bank.usdAccount?` / USD ${esc(cfg.bank.usdAccount)}`:""}</div>
    </div>
    <div class="sig-row">
      <div class="sig-b">客户确认 / CUSTOMER<br><span style="font-weight:400;font-size:9px">(签字/盖章 Signature)</span></div>
      <div class="sig-b">我司签发 / ISSUED BY<br><span style="font-weight:400;font-size:9px">(签字/盖章 Signature)</span></div>
    </div>
    <div class="footer-slogan">Generated &amp; Verified by Sanlyn OS · CREDIT NOTE ${esc(cn.cn_no)}</div>
  </div></body></html>`;
}
