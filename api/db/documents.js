// /api/db/documents.js  — Sanlyn OS Unified Document Generator
//
// GET ?type=sc&id=ORDER_ID        → Sales Contract
// GET ?type=iv&id=ORDER_ID        → Commercial Invoice
// GET ?type=pl&id=ORDER_ID        → Packing List
// GET ?type=po&id=ORDER_ID        → Purchase Order (CN/EN bilingual)
// GET ?type=so&id=SHIPMENT_ID     → Booking Note 托书 (→ forwarder)
// GET ?type=debit&id=SHIPMENT_ID  → Freight Debit Note 账单 (公版)
// GET ?type=tr&id=SHIPMENT_ID     → Telex Release 电放申请书暨保函
//
// &company=petbaby|sanlyn|...     → override issuing company
// &print=1                        → auto-print on open
// All return text/html — English for foreign clients, bilingual for internal

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js"; // S18.1: handler-level auth guard

// ── Seller config: loaded from seller_profiles table (no hardcoding) ──────────
// To add a new issuing company, INSERT a row into seller_profiles.
// Shape returned: { nameEN, nameCN, address, tel, email, bank:{...}, terms:{sc:[],iv:[]} }
//
// 2026-05-19 (damon 上下游规矩):
//   货物类 (PI/SC/IV/PL)  → 客户下单时手选出单方 (raw.issuingCompany)
//   海运类 (SO/SQ/DN)     → 自动绑 OCEANBABY (上海洋宝宝)
//     预留接口: raw.shippingVendor / spraw.shipping_vendor 未来可手选
//     现在写死 'OCEANBABY' 默认，但不 hardcode 在模板里，全过 seller_profiles
async function loadSellerCfg(pool, raw, qco, opts) {
  opts = opts || {};
  var code = qco || "";
  if(!code){ var h=(raw.issuingCompanyEN||raw.issuingCompany||"").toLowerCase(); if(h.includes("sanlyn"))code="sanlyn"; }
  // 海运类强制 OCEANBABY (除非 raw.shippingVendor 显式给出)
  if(opts.shipping){
    code = raw.shipping_vendor || raw.shippingVendor || code || "yangbaobao";
  }
  try {
    var q = code
      ? "SELECT * FROM seller_profiles WHERE code=$1 LIMIT 1"
      : "SELECT * FROM seller_profiles WHERE is_default=TRUE LIMIT 1";
    var p = code ? [code] : [];
    var r = await pool.query(q, p);
    if(!r.rows.length){ // fallback: first row
      var fb = await pool.query("SELECT * FROM seller_profiles ORDER BY id LIMIT 1");
      if(!fb.rows.length) throw new Error("No seller profile found");
      r = fb;
    }
    var s = r.rows[0];
    return {
      nameEN: s.name_en||"", nameCN: s.name_cn||"",
      address: s.address||"", tel: s.tel||"", email: s.email||"",
      bank: {
        beneficiary: s.bank_beneficiary||s.name_en||"",
        bankName: s.bank_name||"", swift: s.bank_swift||"",
        bankAddr: s.bank_addr||"", usdAccount: s.usd_account||"",
        rmbAccount: s.rmb_account||"",
      },
      terms: {
        sc: Array.isArray(s.terms_sc) ? s.terms_sc : (s.terms_sc||[]),
        iv: Array.isArray(s.terms_iv) ? s.terms_iv : (s.terms_iv||[]),
      },
    };
  } catch(e) {
    // Hard fallback so doc still renders if DB query fails
    return { nameEN:"[SELLER]", nameCN:"", address:"", tel:"", email:"",
      bank:{beneficiary:"",bankName:"",swift:"",bankAddr:"",usdAccount:""},
      terms:{sc:[],iv:[]}, _err: e.message };
  }
}

var FORWARDERS = {
  default: {
    nameCN: "上海洋宝宝国际物流有限公司", nameEN: "SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.",
    bank: { accountName: "SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.", bankName: "BANK OF CHINA XIAMEN BRANCH", swift: "BKCHCNBI73A", bankAddr: "No. 40 North Hubin Road, Xiamen", usdAccount: "433849630299", cnyAccount: "433849860868" },
    contact: "Damon", email: "damon@petbaby.cc",
  },
};

function esc(s){ if(!s)return""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function fmtM(v,d){ if(v===null||v===undefined||v==="")return"-"; var n=Number(v); if(isNaN(n))return String(v); return n.toLocaleString("en-US",{minimumFractionDigits:d!==undefined?d:2,maximumFractionDigits:d!==undefined?d:2}); }
function fmtD(v){ if(!v)return"-"; try{return new Date(v).toISOString().slice(0,10);}catch(e){return String(v);} }
function pick(){ for(var i=0;i<arguments.length;i++){if(arguments[i]!==null&&arguments[i]!==undefined&&arguments[i]!=="")return arguments[i];} return ""; }

// resolveCo replaced by async loadSellerCfg above

var CUST_ADDRS={
  "petsome":"LOT 1716, JALAN SG LONG, BATU 11, SG LONG, 43000 KAJANG, SELANGOR, MALAYSIA",
  "dibaq":"LOT 1716, JALAN SG LONG, BATU 11, SG LONG, 43000 KAJANG, SELANGOR, MALAYSIA",
  "enrich":"NO.2 JALAN PERDANA 1A, TAMAN SEGAR PERDANA, 43200 CHERAS, SELANGOR, MALAYSIA",
};
function resolveAddr(name,existing){
  if(existing&&existing.trim()&&existing.trim().length>3)return existing;
  var k=(name||"").toLowerCase();
  for(var key in CUST_ADDRS){if(k.includes(key))return CUST_ADDRS[key];}
  return existing||"";
}
function resolveUnitPrice(p){
  var up=p.unitPrice||p.price||p.unit_price||p.salePrice||p["_widget_1764396068577"]||0;
  if((!up||Number(up)===0)&&(p.subtotal||p.amount)&&p.qty&&Number(p.qty)>0){
    up=Number(p.subtotal||p.amount||0)/Number(p.qty);
  }
  return up;
}

// 2026-05-19 — header restyle (Damon request, see /tmp/pl-header-v2-preview.html):
//   light gray info-bar, smaller seller name, bilingual title, doc-ref moved to footer,
//   header height compressed ~140px (was ~280).
var CSS=`<style>
body{font-family:-apple-system,'Helvetica Neue','Helvetica','Arial','PingFang SC',sans-serif;color:#111;margin:0;padding:24px;font-size:11px;line-height:1.4;}
.container{max-width:800px;margin:auto;background:#fff;}
.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:1.5px solid #111;padding-bottom:10px;margin-bottom:16px;}
.seller-info{flex:1;min-width:0;}
.seller-name{font-weight:700;color:#111;letter-spacing:0.01em;margin:0 0 4px;text-transform:uppercase;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.seller-info p{font-size:10px;color:#555;margin:0;line-height:1.5;}
.doc-type{text-align:right;flex-shrink:0;margin-left:24px;}
.doc-type h1{margin:0;font-size:22px;font-weight:800;letter-spacing:0.06em;color:#111;line-height:1;}
.doc-type p{font-size:10px;color:#888;letter-spacing:0.18em;margin:4px 0 0;}
.meta-grid{display:grid;grid-template-columns:1.4fr 1fr;gap:28px;margin-bottom:14px;}
.section-label{font-size:9px;font-weight:700;color:#666;letter-spacing:0.12em;text-transform:uppercase;margin:0 0 4px;padding-bottom:4px;border-bottom:1px solid #ddd;}
.meta-grid p[style*="font-size:13px"]{font-size:12px !important;font-weight:700;color:#111;margin:6px 0 3px !important;}
.meta-grid p{font-size:10px;color:#444;line-height:1.5;margin:2px 0;}
.meta-list{list-style:none;padding:0;margin:6px 0 0;}
.meta-list li{margin-bottom:3px;display:flex;justify-content:space-between;font-size:10.5px;}
.meta-list li b{font-weight:normal;color:#777;width:auto;}
.meta-list li{font-family:-apple-system,'Helvetica Neue',sans-serif;}
.meta-list li b+*,.meta-list li :not(b){color:#111;font-family:'SF Mono',Menlo,monospace;text-align:right;}
.trade-terms-bar{display:grid;grid-template-columns:1fr 1fr 1fr;border:1px solid #e5e5e5;border-radius:2px;margin-bottom:14px;background:#fafafa;padding:0;font-weight:normal;font-size:11px;}
.trade-terms-bar span{padding:8px 12px;border-right:1px solid #e5e5e5;font-weight:600;color:#111;display:block;}
.trade-terms-bar span:last-child{border-right:none;}
table{width:100%;border-collapse:collapse;margin-bottom:14px;margin-top:4px;}
th{background:#f5f5f5;border-top:1.5px solid #111;border-bottom:1px solid #111;padding:7px 8px;font-size:9px;font-weight:700;color:#333;letter-spacing:0.06em;text-transform:uppercase;text-align:left;}
td{padding:8px;font-size:10.5px;border-bottom:1px solid #ececec;vertical-align:top;color:#222;}
.text-right{text-align:right;font-family:'SF Mono',Menlo,monospace;}
.total-row td{border-top:1.5px solid #111;border-bottom:1.5px solid #111;font-weight:800;font-size:11px;background:#fafafa;}
.details-grid{display:grid;grid-template-columns:1fr 1fr;gap:24px;margin-top:12px;page-break-inside:avoid;break-inside:avoid;}
.details-box{border:1px solid #e5e5e5;background:#fafafa;padding:10px 12px;page-break-inside:avoid;break-inside:avoid;font-size:10px;line-height:1.6;color:#333;}
.details-box h4{margin:0 0 6px 0;font-size:9px;font-weight:700;color:#666;letter-spacing:0.1em;text-transform:uppercase;text-decoration:none;}
.signature-grid{display:flex;justify-content:space-between;margin-top:36px;page-break-inside:avoid;break-inside:avoid;}
.sig-box{width:46%;border-top:1px solid #111;padding-top:8px;text-align:center;font-size:9px;font-weight:700;color:#444;letter-spacing:0.08em;text-transform:uppercase;display:flex;flex-direction:column;gap:4px;page-break-inside:avoid;break-inside:avoid;}
.sig-box>span:nth-child(2),.sig-box>span:last-child{font-weight:normal;font-size:8.5px;color:#888;text-transform:none;letter-spacing:normal;}
tr,thead,tfoot{page-break-inside:avoid;break-inside:avoid;}
.total-row{page-break-inside:avoid;break-inside:avoid;}
.footer-block{page-break-inside:avoid;break-inside:avoid;display:block;}
.doc-ref{text-align:center;margin-top:18px;padding-top:10px;border-top:1px solid #e5e5e5;font-size:9.5px;color:#666;display:flex;justify-content:center;gap:12px;}
.doc-ref .ref-k{color:#999;}
.doc-ref .ref-v{color:#333;font-family:'SF Mono',Menlo,monospace;font-weight:600;}
.doc-ref .ref-sep{color:#ccc;}
.brand-slogan{text-align:center;margin-top:14px;font-size:8.5px;color:#aaa;letter-spacing:0.1em;}
.brand-slogan b{color:#888;font-weight:600;}
@media print{body{padding:0;}.container{max-width:100%;border:none;}}
</style>`;

// 2026-05-19: docRef = optional footer reference (Doc No + Issue date), moved from header
function wrap(title,body,ap,docRef){
  var ref = docRef
    ? `<div class="doc-ref"><span><span class="ref-k">Doc No.</span> <span class="ref-v">${esc(docRef.docNo||title)}</span></span><span class="ref-sep">·</span><span><span class="ref-k">Issued</span> <span class="ref-v">${esc(docRef.date||new Date().toISOString().slice(0,10))}</span></span></div>`
    : '';
  return`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(title)}</title>${CSS}${ap?'<script>window.onload=function(){window.print()}<\/script>':""}</head><body><div class="container">${body}${ref}<div class="brand-slogan">⚡ Generated &amp; Verified by <b>Sanlyn OS Supply Chain Engine</b></div></div></body></html>`;
}

function sellerNamePx(name){ var l=(name||"").length; return l<=28?"20px":l<=38?"17px":l<=48?"14px":"12px"; }
// Per damon 2026-05-18: NO audience badge on PDF — recipient (customer or customs)
// shouldn't see internal admin labels. Admin tracks the version themselves.
// `audience` still drives behavior (merge / categorization) just not displayed.
function docHdr(cfg,cn,en /*, audience — intentionally unused for display */){
  // 2026-05-19 — Light header v2:
  //   - smaller seller name (13px not 20+)
  //   - English title primary 22px, Chinese subtitle 10px gray
  //   - no Tel/Email (Damon: hardcoded was not BABI's real contact)
  //   - Doc No + Issued moved to footer via wrap(docRef)
  return`<div class="header"><div class="seller-info"><div class="seller-name">${esc(cfg.nameEN)}</div><p>${esc(cfg.address)}</p></div><div class="doc-type"><h1>${esc(en)}</h1>${cn?`<p>${esc(cn)}</p>`:""}</div></div>`;
}

function buyerBlock(cust,addr,tel,docNo,noLbl,ordNo,date,curr){
  // 2026-05-19: PL 用 "Buyer / Consignee" (无金额单据), 其他用 "Buyer (Bill To)"
  var buyerLbl = curr ? "BUYER (BILL TO)" : "BUYER / CONSIGNEE";
  return`<div class="meta-grid"><div><div class="section-label">${buyerLbl}</div><p style="font-size:13px;font-weight:bold;margin:0">${esc(cust)||"[BUYER]"}</p><p style="margin:5px 0">${esc(addr)||"[ADDRESS]"}</p>${tel?`<p style="margin:2px 0">Tel: ${esc(tel)}</p>`:""}</div><div><div class="section-label">ORDER DETAILS</div><ul class="meta-list"><li><b>${esc(noLbl||"No.")}:</b> ${esc(docNo)}</li><li><b>Order:</b> ${esc(ordNo)}</li><li><b>Date:</b> ${esc(date)}</li>${curr?`<li><b>Currency:</b> ${esc(curr)}</li>`:""}</ul></div></div>`;
}

function portBar(pol,pod,terms){
  // 2026-05-19 light info-bar (3 cells with subtle gray bg + 1px lines)
  return`<div class="trade-terms-bar"><span><span style="display:block;font-size:8.5px;font-weight:700;color:#888;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:2px">Port of Loading</span><span style="font-size:11px;font-weight:600;color:#111">${esc(pol)||"—"}</span></span><span><span style="display:block;font-size:8.5px;font-weight:700;color:#888;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:2px">Port of Discharge</span><span style="font-size:11px;font-weight:600;color:#111">${esc(pod)||"—"}</span></span><span><span style="display:block;font-size:8.5px;font-weight:700;color:#888;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:2px">Incoterms</span><span style="font-size:11px;font-weight:600;color:#111">${esc(terms)||"—"} (Incoterms® 2020)</span></span></div>`;
}

function bankCard(bk,curr){
  var cur=String(curr||"").toUpperCase();
  var isCNY=cur==="CNY"||cur==="RMB";
  var acct=isCNY?(bk.rmbAccount||bk.cnyAccount||""):(bk.usdAccount||"");
  var acctLabel=isCNY?"Account No. (CNY)":"Account No. (USD)";
  return`<div class="details-box"><h4>BANKING INFORMATION</h4>Beneficiary: ${esc(bk.beneficiary||bk.accountName||"")}<br>Bank: ${esc(bk.bankName)}<br>SWIFT: ${esc(bk.swift)}<br>${bk.bankAddr?`Bank Address: ${esc(bk.bankAddr)}<br>`:""}${acct?`${acctLabel}: ${esc(acct)}<br>`:""}<span style="color:red;font-size:10px;font-weight:bold">* Please verify bank info before payment.</span></div>`;
}

function termsCard(ts){
  // Strip Chinese + " / " separators from terms. Keep English portion only.
  function _en(t){ var s=String(t||""); if(s.indexOf("/")>=0) s=s.split("/").pop(); return s.replace(/[\u4e00-\u9fff:：]/g,"").trim(); }
  return`<div class="details-box"><h4>TERMS &amp; CONDITIONS</h4>${ts.map(function(t,i){return(i+1)+". "+esc(_en(t));}).join("<br>")}</div>`;
}

function sigBlock(sealUrl){
  // Auto-stamp: overlay the seller's company seal (公章) on the SELLER box.
  // mix-blend-mode:multiply drops the white background so only the red chop shows.
  var seal = sealUrl ? `<img src="${sealUrl}" alt="seal" style="position:absolute;right:6px;bottom:0;width:118px;height:auto;opacity:.92;pointer-events:none"/>` : "";
  return`<div class="signature-grid"><div class="sig-box"><span>BUYER AUTHORIZED SIGNATURE</span><span style="font-weight:normal;font-size:9px">(Signature / Company Seal)</span></div><div class="sig-box" style="position:relative">${seal}<span>SELLER AUTHORIZED SIGNATURE</span><span style="font-weight:normal;font-size:9px">(Signature / Company Seal)</span></div></div>`;}

function productRows(prods,cols){
  if(!prods.length)return'<tr><td>01</td><td colspan="'+cols.length+'" style="color:#999;font-style:italic">— Line items will auto-populate from order —</td></tr>';
  var totalCols=cols.length+1; // +1 for NO.
  var lastGroup=""; var idx=0; var out=[];
  prods.forEach(function(p){
    // Emit a group header row when the order group changes (multi-order B/L merge).
    var grp=p._groupKey||"";
    if(grp && grp!==lastGroup){
      var hdr="ORDER "+(p._customerPO||"")+(p._containerNo?" · "+p._containerNo:"")+(p._contractNo?" · "+p._contractNo:"");
      out.push('<tr class="group-header" style="background:#f0f4ff"><td colspan="'+totalCols+'" style="font-weight:700;color:#1e40af;padding:6px 8px;font-size:11px;letter-spacing:.02em">'+esc(hdr)+'</td></tr>');
      lastGroup=grp;
    }
    idx++;
    out.push('<tr><td>'+String(idx).padStart(2,"0")+'</td>'+cols.map(function(c){var v=c.fn?c.fn(p):(p[c.k]||"-");return'<td class="'+(c.al==="right"?"text-right":"")+'">'+esc(String(v))+'</td>';}).join("")+'</tr>');
  });
  return out.join("");
}

function getProds(raw){return Array.isArray(raw.products)?raw.products:Array.isArray(raw.items)?raw.items:[];}
function getTotal(prods,order){return prods.reduce(function(s,p){var sub=Number(p.subtotal||p.amount||0);if(!sub&&p.qty)sub=Number(p.qty)*Number(resolveUnitPrice(p));return s+sub;},0)||Number(order.total_amount)||0;}

// ── enrichProdsFromMaster ────────────────────────────────────────────────────
// Fills missing PRODUCT ATTRIBUTE fields in raw.products[] items from the
// products master table (joined by sku). Used only at document-generation time
// — never writes to the DB and never modifies orders.raw.
//
// ── PRICE THREE-TIER RULE (HARD BOUNDARY) ───────────────────────────────────
// Prices in this system are separated into three independent tiers. They must
// never cross-fill or fall back to each other:
//
//   Tier 1 — Customs / declaration price:
//     customs_declared_price, declaration_price, declaration_amount
//     Source: order-confirmed customs value agreed with customs broker.
//
//   Tier 2 — Factory / purchase price:
//     factory_price, factoryPrice, purchase_price
//     Source: agreed procurement price with the factory.
//
//   Tier 3 — Customer / sale price:
//     unitPrice, customer_price, price
//     Source: agreed sale price on the customer's contract (PI/IV).
//
// Customer documents take Tier 3. Factory documents take Tier 2.
// Customs declarations take Tier 1. No cross-tier fallback ever.
//
// ── WHAT THIS FUNCTION MAY FILL (product attribute fields only) ──────────────
//   hs_code, declaration_name, bl_description,
//   net_weight, gross_weight, cbm,
//   inner_qty, inner_unit,
//   barcode, factory_name
//   (declaration_elements as a non-price attribute string)
//
// ── STRICTLY FORBIDDEN FROM MERGE (all pricing / cost / margin fields) ───────
//   unitPrice, price, customer_price,
//   factoryPrice, factory_price, purchase_price,
//   customs_declared_price, declaration_price, declaration_amount,
//   unitPriceCNY, unitPriceUSD,
//   cost, profit, freightShare, margin, platform_fee, commission
//
// Fill rule: blank-only — a field is filled from master ONLY when the product
// item's value is undefined, null, or "". Numeric zero (0) is preserved as-is.
//
// Fail-open: sku absent → skip item; sku not in master → console.warn + keep
//   original; DB error → console.warn + return original prods unchanged.
async function enrichProdsFromMaster(pool, prods) {
  if (!prods || !prods.length) return prods;
  var skus = prods.map(function(p) { return p && p.sku; }).filter(Boolean);
  // 2026-05-18: fallback to barcode lookup when SKU not on raw product.
  // Many legacy raw.products carry only barcode (no sku), preventing bl_description fill.
  var barcodes = prods.map(function(p) { return p && (p.barcode || p.code); }).filter(Boolean);
  if (!skus.length && !barcodes.length) return prods; // nothing to JOIN

  var masterMap = {};
  var bcMap = {};
  try {
    if (skus.length) {
      var r = await pool.query(
        "SELECT sku, hs_code, declaration_name, declaration_elements," +
        " bl_description, net_weight, gross_weight, cbm, carton_qty AS inner_qty, NULL AS inner_unit," +
        " barcode, factory_name" +
        " FROM products WHERE sku = ANY($1::text[]) AND active = true",
        [skus]
      );
      r.rows.forEach(function(row) { masterMap[row.sku] = row; if (row.barcode) bcMap[row.barcode] = row; });
    }
    if (barcodes.length) {
      // 2026-05-18: legacy raw.products often store SKU in the `barcode` field
      // (TNC-06, CP1894, etc — not real EAN barcodes). Match on barcode OR sku
      // so either column hits work.
      var r2 = await pool.query(
        "SELECT sku, hs_code, declaration_name, declaration_elements," +
        " bl_description, net_weight, gross_weight, cbm, carton_qty AS inner_qty, NULL AS inner_unit," +
        " barcode, factory_name" +
        " FROM products WHERE (barcode = ANY($1::text[]) OR sku = ANY($1::text[])) AND active = true",
        [barcodes]
      );
      r2.rows.forEach(function(row) {
        if (row.barcode) bcMap[row.barcode] = row;
        if (row.sku) bcMap[row.sku] = row; // also key by sku so 'barcode'-named SKUs resolve
        if (row.sku && !masterMap[row.sku]) masterMap[row.sku] = row;
      });
    }
  } catch (e) {
    console.warn("[documents] enrichProdsFromMaster: DB error —", e.message, "— using raw products only");
    return prods; // fail-open: DB unreachable, render with existing data
  }

  // _f: fill from master only when prod value is undefined / null / ""
  // Never fills when prod value is 0, false, or any other defined value.
  function _f(prodVal, masterVal) {
    return (prodVal === undefined || prodVal === null || prodVal === "") && masterVal != null
      ? masterVal
      : prodVal;
  }

  return prods.map(function(p) {
    if (!p) return p;
    // Try SKU first, then barcode fallback (2026-05-18)
    var m = (p.sku && masterMap[p.sku]) || ((p.barcode || p.code) && bcMap[p.barcode || p.code]);
    if (!m) {
      return p; // unknown — render with raw values
    }
    // Build enriched copy. Pricing / cost / margin fields are NOT in this list.
    return Object.assign({}, p, {
      netWeight:           _f(p.netWeight,           m.net_weight),
      grossWeight:         _f(p.grossWeight,         m.gross_weight),
      cbm:                 _f(p.cbm,                 m.cbm),
      blDescription:       _f(p.blDescription   || p.bl_description,   m.bl_description),
      declarationName:     _f(p.declarationName  || p.declaration_name, m.declaration_name),
      hsCode:              _f(p.hsCode || p.hs_code || p.hscode,        m.hs_code),
      declarationElements: _f(p.declarationElements,                    m.declaration_elements),
      inner_qty:           _f(p.inner_qty,                              m.inner_qty),
      inner_unit:          _f(p.inner_unit,                             m.inner_unit),
      barcode:             _f(p.barcode || p.code,                      m.barcode),
      factory_name:        _f(p.factory_name,                           m.factory_name),
    });
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT
  if(req.method!=="GET") return res.status(405).end();

  // ── Token auth ── must pass ?token=DOCS_SECRET or X-Docs-Token header
  var DOC_TOKEN = process.env.DOCS_SECRET || "";
  var reqToken = req.query.token || req.headers["x-docs-token"] || "";
  if(DOC_TOKEN && reqToken !== DOC_TOKEN){
    return res.status(401).send("<h1>401 Unauthorized</h1><p>Missing or invalid access token.</p>");
  }

  var{type,id,ids,company:qco,print:ap,format,contract_no,bl_no,limit,audience:_audReq,fmt:_fmtVariant}=req.query;
  // 2026-05-19 (damon): _fmtVariant 'iv' → DN 用商业发票风格（部分国家如马来需要）
  // audience: 'customs' (BL-merged) or 'customer' (per-contract).
  // Default: customs when merge will happen, customer otherwise.
  // Customer-explicit override forces per-contract render even if siblings exist.
  // format=xlsx → Excel export (handled after data fetch, same query pipeline)

  // ── List mode: no type/id → return documents table rows ──
  // DOCS-AUTH-AUDIT-001 P1-HIGH scope guard (2026-05-13):
  // Non-internal users (customers) MUST only see their own company's documents.
  // Scoping is done server-side via JOIN to orders.company_code.
  // Fail-closed: customer with no companyCodes gets empty array, not 403, to avoid breaking UI.
  if(!type && !id){
    try{
      var pool2=getPool();
      var isInternal2 = req.user && (
        req.user.role === "admin" || req.user.role === "finance" ||
        req.user.role === "trader" || req.user.role === "logistics"
      );

      var p2=[], w2=[];

      var q2;
      if(isInternal2){
        // Internal: full table access
        q2 = "SELECT d.* FROM documents d";
        if(contract_no){ p2.push(contract_no); w2.push("d.contract_no=$"+p2.length); }
        if(bl_no){       p2.push(bl_no);       w2.push("d.bl_no=$"+p2.length); }
        if(w2.length) q2 += " WHERE "+w2.join(" AND ");
      } else {
        // Customer scope: JOIN orders on contract_no, filter by company_code.
        // Fail-closed: if user has no company codes, return empty immediately.
        var codes2 = req.user && (req.user.companyCodes || (req.user.companyCode ? [req.user.companyCode] : [])) || [];
        if(!codes2.length){
          return res.json({success:true,data:[],count:0,_scope:"empty-no-company"});
        }
        // JOIN to orders — docs without a matching order row are excluded (safer).
        // Docs linked only via bl_no (no contract_no) are also excluded; they surface
        // through the shipping-plan → order join when that path is implemented.
        p2.push(codes2); // $1 = text[]
        q2 = "SELECT d.* FROM documents d"
           + " INNER JOIN orders o ON o.contract_no = d.contract_no"
           + " WHERE o.company_code = ANY($1::text[])";
        if(contract_no){ p2.push(contract_no); q2 += " AND d.contract_no=$"+p2.length; }
        if(bl_no){       p2.push(bl_no);       q2 += " AND d.bl_no=$"+p2.length; }
      }

      q2 += " ORDER BY d.created_at DESC";
      p2.push(parseInt(limit)||1000); q2 += " LIMIT $"+p2.length;
      var r2=await pool2.query(q2,p2);
      return res.json({success:true,data:r2.rows,count:r2.rowCount});
    }catch(e2){ return res.status(500).json({error:e2.message}); }
  }

  if(!type||!id) return res.status(400).send("<h1>Missing type or id</h1>");

  try {
    var pool=getPool(), html="";

    if(["sc","iv","pl","po","pi","pack"].includes(type)){
      var oR=await pool.query("SELECT * FROM orders WHERE _id=$1 OR contract_no=$1 OR customer_po=$1 OR order_no=$1 LIMIT 1",[id]);
      if(!oR.rows.length) return res.status(404).send("<h1>Order not found: "+esc(id)+"</h1>");
      var o=oR.rows[0], raw=o.raw||{};
      // DOCS-AUTH-AUDIT-001 P1-HIGH: customer scope guard on generated docs.
      // Fail-closed: customer can only generate docs for their own orders.
      var _isInternal = req.user && (req.user.role==="admin"||req.user.role==="finance"||req.user.role==="trader"||req.user.role==="logistics");
      if(!_isInternal){
        var _codes = req.user && (req.user.companyCodes||(req.user.companyCode?[req.user.companyCode]:[])) || [];
        if(!_codes.length || !_codes.includes(o.company_code)){
          return res.status(403).send("<h1>403 Forbidden</h1><p>You do not have access to this document.</p>");
        }
      }
      if(typeof raw==="string")try{raw=JSON.parse(raw);}catch(e){raw={};}
      var cfg=await loadSellerCfg(pool,raw,qco);
      var cust=pick(o.company_name_en,raw.companyNameEN,raw.companyNameCN,o.customer);
      var caddr=resolveAddr(cust,pick(raw.customerAddress,raw.deliveryAddress));
      var ctel=raw.phone||"";
      var ordNo=pick(raw.customerPO,o.customer_po,o.order_no);
      var cno=pick(o.contract_no,o.order_no,id);
      var date=fmtD(new Date()); // 单据日期 = 今日（出单当天）
      var curr=pick(raw.currency,o.currency,"USD");
      // POL = 工厂带过来的港口：取该单工厂在 factories.ports 的首个港口。
      // 取生产工厂名（产品的 factory_name），NOT raw.factory（那是出单主体 BABI）。
      var _facName=pick((raw.products&&raw.products[0]&&(raw.products[0].factory_name||raw.products[0].factory)),"");
      var _facPol="";
      if(_facName){
        try{
          var _fpR=await pool.query("SELECT ports FROM factories WHERE name=$1 LIMIT 1",[_facName]);
          var _ports=_fpR.rows[0] && _fpR.rows[0].ports;
          if(Array.isArray(_ports) && _ports.length) _facPol=_ports[0];
          else if(typeof _ports==="string" && _ports) _facPol=_ports.replace(/[{}"]/g,"").split(",")[0].trim();
        }catch(e){}
      }
      // POL/POD/BL 从关联的 SO(托书/海运计划) + BL 带（实际订舱港口优先于工厂默认港）。
      var _spPol="", _spPod="", _spBl="";
      try{
        var _spR=await pool.query(
          "SELECT pol,pod,bl_no FROM shipping_plans WHERE NULLIF($1,'') IS NOT NULL AND (bl_no=$1 OR contract_no=$1 OR order_contract_nos ILIKE '%'||$1||'%') OR (NULLIF($2,'') IS NOT NULL AND (contract_no=$2 OR order_contract_nos ILIKE '%'||$2||'%')) ORDER BY tracking_updated_at DESC NULLS LAST, eta DESC NULLS LAST LIMIT 1",
          [o.contract_no||"", o.order_no||""]
        );
        if(_spR.rows[0]){ _spPol=_spR.rows[0].pol||""; _spPod=_spR.rows[0].pod||""; _spBl=_spR.rows[0].bl_no||""; }
      }catch(e){}
      var pol=pick(raw.pol,raw.portOfLoading,_spPol,_facPol,"-");
      var pod=pick(raw.destination,raw.pod,raw.destinationPort,_spPod,"-");
      var inco=pick(raw.tradeTerms,raw.incoterms,"FOB");
      var prods=await enrichProdsFromMaster(pool,getProds(raw));
      // ── Look up container assignment from container_bookings subtable ──
      // Source of truth for which container holds which order (plus driver/VGM/trucking).
      // Falls back to orders.raw.containerNo if no booking record yet.
      var _cbMap={}; // contract_no → container_no
      try {
        var cbR=await pool.query(
          "SELECT contract_no, container_no FROM container_bookings WHERE contract_no = ANY($1::text[])",
          [[pick(o.contract_no,o.order_no,id)].concat(String(ids||"").split(",").map(function(s){return s.trim();}).filter(Boolean))]
        );
        cbR.rows.forEach(function(row){ if(row.contract_no) _cbMap[row.contract_no]=row.container_no; });
      } catch (e) { console.warn("[documents] container_bookings lookup failed:",e.message); }

      // Tag primary-order products with group metadata (container / customer PO / contract).
      // Used by productRows() to emit a section header when multiple orders are merged.
      var _primaryCno=pick(o.contract_no,o.order_no,id);
      var _primaryContainer=pick(_cbMap[_primaryCno], raw.containerNo, "");
      var _primaryPO=pick(raw.customerPO,o.customer_po,o.order_no);
      prods=prods.map(function(p){return Object.assign({},p,{_groupKey:_primaryCno,_containerNo:_primaryContainer,_customerPO:_primaryPO,_contractNo:_primaryCno});});
      // ── Multi-order B/L merge: when ?ids=CN1,CN2,... passed (SC/IV/PL only, NOT PI) ──
      // Load sibling orders (same B/L, different contracts) and merge their products into
      // ONE combined trade doc — required for customs declaration on grouped shipments.
      var _mergedCnos=[cno], _mergedPOs=[ordNo];
      var _hasMultiOrder=false;
      // 2026-05-18: auto-detect siblings sharing the same BL — no need for frontend to pass ?ids=
      // When this order has a BL number and ?ids= wasn't explicit, look up all other orders
      // with the same BL and merge them into one consolidated IV/SC/PL. Mirrors damon's
      // sample IV-YMJAI228525573 covering XM-254/256/262/263 in one PDF.
      // Customer-audience override: skip BL-merge — customer wants per-contract version.
      var audience = String(_audReq || "").toLowerCase() === "customer" ? "customer" : "customs";
      // BOTH audiences merge by BL — per damon 2026-05-18: "客户的也要合并！客户要全品名详情"
      // Only the product name field differs: customs uses bl_description, customer uses full name.
      var autoIds = ids;
      if (!autoIds && type !== "pi") {
        var blForLookup = pick(o.bl_no, raw.blNo, raw.bl_no);
        if (blForLookup) {
          try {
            var sibBl = await pool.query(
              "SELECT contract_no, customer_po FROM orders WHERE bl_no=$1 OR raw->>'blNo'=$2",
              [blForLookup, blForLookup]
            );
            var sibCnos = sibBl.rows
              .map(function(r){ return r.contract_no || r.customer_po; })
              .filter(function(v){ return v && v !== cno; });
            if (sibCnos.length) autoIds = sibCnos.join(",");
          } catch (e) { /* lookup failed — fall through to single-order */ }
        }
      }
      if(autoIds && type!=="pi"){
        var idList=String(autoIds).split(",").map(function(s){return s.trim();}).filter(function(s){return s && s!==id;});
        if(idList.length){
          var sibR=await pool.query("SELECT * FROM orders WHERE contract_no = ANY($1::text[]) OR customer_po = ANY($1::text[])",[idList]);
          // Sort sibling orders by customer_po for stable output (XM-254 → 256 → 262 → 263 etc.)
          var sibRows=sibR.rows.slice().sort(function(a,b){var pa=(a.customer_po||"");var pb=(b.customer_po||"");return pa<pb?-1:pa>pb?1:0;});
          for(var sib of sibRows){
            var sRaw=sib.raw||{};
            if(typeof sRaw==="string")try{sRaw=JSON.parse(sRaw);}catch(e){sRaw={};}
            var sProds=await enrichProdsFromMaster(pool,getProds(sRaw));
            var sCno=sib.contract_no||sib.customer_po;
            var sPO=pick(sRaw.customerPO,sib.customer_po,sib.order_no);
            var sContainer=pick(_cbMap[sCno], sRaw.containerNo, "");
            if(sProds.length){
              var tagged=sProds.map(function(p){return Object.assign({},p,{_groupKey:sCno,_containerNo:sContainer,_customerPO:sPO,_contractNo:sCno});});
              prods=prods.concat(tagged);
            }
            if(sCno) _mergedCnos.push(sCno);
            if(sPO) _mergedPOs.push(sPO);
          }
          _hasMultiOrder=true;
          // Dedupe & join for display
          var _uniq=function(arr){return arr.filter(function(v,i,a){return v && a.indexOf(v)===i;});};
          cno=_uniq(_mergedCnos).join(" / ");
          ordNo=_uniq(_mergedPOs).join(" / ");
          // Re-sort merged products by customer_po so groups appear in order
          prods.sort(function(a,b){var pa=(a._customerPO||"");var pb=(b._customerPO||"");return pa<pb?-1:pa>pb?1:0;});
        }
      }
      // Single-order: no group header needed — blank the tag so productRows skips it.
      if(!_hasMultiOrder) prods=prods.map(function(p){return Object.assign({},p,{_groupKey:""});});

      // 2026-05-18 — Customs aggregation + drop empty product rows.
      // Empty rows ({qty:0, name empty}) leak through from upstream import bugs;
      // they show as "—" in PDF and break visual cleanliness. Filter ANY audience.
      prods = prods.filter(function(p){
        if (!p) return false;
        var hasName = (p.productName || p.name || p.description || p.blDescription || p.bl_description);
        var hasQty  = Number(p.qty || 0) > 0;
        return hasName || hasQty;
      });
      // Chinese customs declares by HS code / 报关品名, NOT per-SKU.
      // Group products by (bl_description, hs_code) and sum qty + amount.
      // Customer audience keeps SKU-level detail (full marketing names).
      // ────────────────────────────────────────────────────────────────────
      // 2026-05-19 (damon 字段表方针): 报关 IV/SC/PL 用 products 字段表
      // 直接拉 declaration_name + hs_code，按 (declaration_name + hs_code)
      // 去重合并。不再合成 "PET FOOD / 宠物食品 WANPY 罐头 Canned" 假名。
      //
      // 简单规矩：
      //   • 产品就是 product_name（PL 客户版/IV/SC/PI 客户版 用）
      //   • 报关合并 = declaration_name（"宠物食品"/"宠物玩具"等）+ hs_code 去重
      // ────────────────────────────────────────────────────────────────────
      if (audience === "customs") {
        // Per damon 2026-05-18: customs doesn't split by sub-contract — one
        // consolidated table per BL. Strip _groupKey so sibling orders merge.
        prods = prods.map(function(p){ return Object.assign({}, p, { _groupKey: "" }); });
        _hasMultiOrder = false;

        // 拉所有用到的 SKU 的 declaration_name + hs_code（一次性 join 产品表）
        var skuList = prods.map(function(p){return p.sku||p.code||p.product_code||"";}).filter(Boolean);
        var skuMeta = {};
        if (skuList.length) {
          try {
            var metaR = await pool.query(
              "SELECT sku, declaration_name, hs_code FROM products WHERE sku = ANY($1::text[]) AND declaration_name IS NOT NULL AND declaration_name != ''",
              [skuList]
            );
            metaR.rows.forEach(function(r){
              if (!skuMeta[r.sku]) skuMeta[r.sku] = { dn: r.declaration_name, hs: r.hs_code || "" };
            });
          } catch(e) { /* fallthrough to per-product fields */ }
        }

        var groups = {};
        var order = [];
        prods.forEach(function(p){
          var sku = p.sku || p.code || p.product_code || "";
          var meta = skuMeta[sku] || {};
          // 字段表优先；缺则用产品自带字段；最后兜底"宠物食品"
          var dn = p.declaration_name || p.declarationName || meta.dn || "宠物食品";
          var hs = p.hs_code || p.hsCode || meta.hs || "";
          // 报关展示名 = 报关品名（dedupe by declaration_name + hs）
          var key = "|" + dn + "|" + hs;
          if (!groups[key]) {
            groups[key] = Object.assign({}, p, {
              productName: dn, name: dn, blDescription: dn,
              declaration_name: dn, declarationName: dn,
              hs_code: hs, hsCode: hs,
              size: "", spec: "",        // 合并行不显规格
              qty: 0, subtotal: 0,
              grossWeight: 0, netWeight: 0, _cbmTot: 0,
              _aggCount: 0,
            });
            order.push(key);
          }
          var g = groups[key];
          g.qty       += Number(p.qty || 0);
          g.subtotal  += Number(p.subtotal || (Number(p.qty||0) * Number(resolveUnitPrice(p)||0)) || 0);
          g.grossWeight += Number(p.grossWeight||p.gw||0) * Number(p.qty||0);
          g.netWeight   += Number(p.netWeight  ||p.nw||0) * Number(p.qty||0);
          g._cbmTot     += Number(p.cbmPerCtn||p.cbm_per_ctn||p.cbm||0) * Number(p.qty||0);
          g._aggCount += 1;
          if (!g.unitPrice && p.unitPrice) g.unitPrice = p.unitPrice;
        });
        // 合并行 grossWeight/netWeight/_cbmTot 已是该报关品名的「总量」(每箱值×箱数累加)。
        // 下游报关列/合计直接当总量用，不再 ×qty。
        prods = order.map(function(k){ return groups[k]; });
      }

      var _xlsCapture=null; // populated by sc/iv/pl blocks for xlsx export
      var tot=getTotal(prods,o);
      // 总箱数/总净重/总毛重：直接带订单字段表（total_qty/net_weight/gross_weight），不重算。
      var tqty=Number(o.total_qty)||prods.reduce(function(s,p){return s+Number(p.qty||0);},0)||Number(raw.totalQty||0);
      var tgw=Number(o.gross_weight)||prods.reduce(function(s,p){return s+Number(p.grossWeight||p.gw||0)*Number(p.qty||0);},0)||Number(raw.grossWeight||0);
      var tnw=Number(o.net_weight)||prods.reduce(function(s,p){return s+Number(p.netWeight||p.nw||0)*Number(p.qty||0);},0)||Number(raw.netWeight||0);

      // 2026-05-19: discount support — read raw.discounts[] {label, amount} and netAmount
      var _disc = Array.isArray(raw.discounts) ? raw.discounts : [];
      var _discSum = _disc.reduce(function(s,d){return s+Number(d.amount||0);},0);
      var _netAmt = (raw.netAmount != null) ? Number(raw.netAmount) : (tot + _discSum); // discounts are negative
      var totRow;
      if (_disc.length > 0) {
        var _discRows = _disc.map(function(d){
          return `<tr class="total-row"><td colspan="3" class="text-right" style="color:#888;font-size:10px;">${esc(d.label||'Discount')}:</td><td colspan="2" class="text-right" style="color:#c44;font-size:11px;">${fmtM(Number(d.amount||0))}</td></tr>`;
        }).join('');
        totRow = `<tr class="total-row"><td colspan="3" class="text-right" style="color:#777;font-size:10px;">GROSS AMOUNT (${esc(curr)}):</td><td colspan="2" class="text-right" style="color:#777;font-size:12px;">${fmtM(tot)}</td></tr>`
              + _discRows
              + `<tr class="total-row" style="border-top:2px solid #000;"><td colspan="3" class="text-right" style="font-size:11px;">NET PAYABLE (${esc(curr)}):</td><td colspan="2" class="text-right" style="font-size:16px;font-weight:800;">${fmtM(_netAmt)}</td></tr>`;
      } else {
        totRow=`<tr class="total-row"><td colspan="3" class="text-right" style="color:#555;font-size:11px;">TOTAL AMOUNT (${esc(curr)}):</td><td colspan="2" class="text-right" style="font-size:16px;font-weight:800;">${fmtM(tot)}</td></tr>`;
      }

      var _PACK = (type==="pack"); var _packBodies = {};
      if(type==="sc"||_PACK){
        var no=cno.split(" / ").map(function(c){return c.replace(/[^A-Z0-9-]/gi,"").slice(0,20);}).join(" / ");
        var colsSC=[
          {k:"name",al:"",fn:function(p){
            // Audience-aware product name (2026-05-18):
            //   customs → bl_description / declarationName / hsName (short, HS-friendly)
            //   customer → productName / name (full marketing name with brand+flavor+spec)
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          },lbl:"Description &amp; Size"},
          {k:"qty",al:"center",w:"70px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:function(p){return fmtM(resolveUnitPrice(p));},lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"110px",fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},lbl:"Amount"},
        ];
        var _fsNoSC = (raw.fs_no || raw.internal_no || (ordNo||no)) + "-SC";
        _packBodies.sc=`
          ${docHdr(cfg,"销售合同","SALES CONTRACT",audience)}
          ${buyerBlock(cust,caddr,ctel,no,"Contract No.",ordNo,date,curr)}
          ${portBar(pol,pod,inco)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsSC.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsSC,curr)}${totRow}</tbody></table>
          <div class="footer-block"><div class="details-grid">${termsCard(cfg.terms.sc)}${bankCard(cfg.bank,curr)}</div>${sigBlock(cfg.seal_url)}</div>`; html=wrap((ordNo||no)+"_SC",_packBodies.sc,ap,{docNo:_fsNoSC,date:date});
        _xlsCapture={sheetName:"Sales Contract",docNo:(ordNo||no)+"_SC",buyer:cust,date:date,cno:cno,curr:curr,pol:pol,pod:pod,incoterm:inco,poNo:ordNo,seller:{nameEN:cfg.nameEN,address:cfg.address,tel:cfg.tel,email:cfg.email},terms:cfg.terms.sc,bank:cfg.bank,
          headers:["NO.","Description & Size","QTY","Unit Price ("+curr+")","Amount ("+curr+")"],
          colKeys:[
            {k:"name",fn:function(p){
            // Audience-aware product name (2026-05-18):
            //   customs → bl_description / declarationName / hsName (short, HS-friendly)
            //   customer → productName / name (full marketing name with brand+flavor+spec)
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          }},
            {k:"qty"},
            {k:"price",fn:function(p){return parseFloat(String(fmtM(resolveUnitPrice(p))).replace(/,/g,""))||0;}},
            {k:"amt",fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return parseFloat(String(fmtM(s)).replace(/,/g,""))||0;}}
          ],
          rows:prods,totals:["","TOTAL","","",parseFloat(String(fmtM(tot)).replace(/,/g,""))||0]};
      }

      if(type==="iv"||_PACK){
        var noIV=cno.split(" / ").map(function(c){return c.replace(/[^A-Z0-9-]/gi,"").slice(0,20);}).join(" / ");
        var colsIV=[
          {k:"name",al:"",fn:function(p){
            // Audience-aware product name (2026-05-18):
            //   customs → bl_description / declarationName / hsName (short, HS-friendly)
            //   customer → productName / name (full marketing name with brand+flavor+spec)
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          },lbl:"Description &amp; Size"},
          {k:"qty",al:"center",w:"70px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:function(p){return fmtM(resolveUnitPrice(p));},lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"110px",fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},lbl:"Amount"},
        ];
        var _fsNoIV = (raw.fs_no || raw.internal_no || (ordNo||noIV)) + "-IV";
        _packBodies.iv=`
          ${docHdr(cfg,"商业发票","COMMERCIAL INVOICE",audience)}
          ${buyerBlock(cust,caddr,ctel,noIV,"Invoice No.",ordNo,date,curr)}
          ${portBar(pol,pod,inco)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsIV.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsIV,curr)}${totRow}</tbody></table>
          <div class="footer-block"><div class="details-grid">${termsCard(cfg.terms.iv)}${bankCard(cfg.bank,curr)}</div>${sigBlock(cfg.seal_url)}</div>`; html=wrap((ordNo||noIV)+"_IV",_packBodies.iv,ap,{docNo:_fsNoIV,date:date});
        _xlsCapture={sheetName:"Invoice",docNo:(ordNo||noIV)+"_IV",buyer:cust,buyerAddr:caddr,date:date,cno:cno,curr:curr,pol:pol,pod:pod,incoterm:inco,poNo:ordNo,seller:{nameEN:cfg.nameEN,address:cfg.address,tel:cfg.tel,email:cfg.email},terms:cfg.terms.iv,bank:cfg.bank,
          headers:["NO.","Description & Size","QTY","Unit Price ("+curr+")","Amount ("+curr+")"],
          colKeys:[{k:"name",fn:function(p){
            // Audience-aware product name (2026-05-18):
            //   customs → bl_description / declarationName / hsName (short, HS-friendly)
            //   customer → productName / name (full marketing name with brand+flavor+spec)
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          }},{k:"qty"},{k:"price",fn:function(p){return parseFloat(String(fmtM(resolveUnitPrice(p))).replace(/,/g,""))||0;}},{k:"amt",fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return parseFloat(String(fmtM(s)).replace(/,/g,""))||0;}}],
          rows:prods,totals:["","TOTAL","","",parseFloat(String(fmtM(tot)).replace(/,/g,""))||0]};
      }

      if(type==="pl"||_PACK){
        var noPL=cno.split(" / ").map(function(c){return c.replace(/[^A-Z0-9-]/gi,"").slice(0,20);}).join(" / ");
        // CBM resolution: prefer explicit per-CTN field × qty; fall back to p.cbm (line total) for legacy rows
        var cbmOf=function(p){if(audience==='customs')return Number(p._cbmTot||p.cbm||0);var perCtn=Number(p.cbmPerCtn||p.cbm_per_ctn||0);var q=Number(p.qty||0);if(perCtn>0&&q>0)return perCtn*q;return Number(p.cbm||p.volume||0);};
        var tcbmPL=Number(o.total_cbm)||prods.reduce(function(s,p){return s+cbmOf(p);},0)||Number(raw.totalCBM||raw.cbm||0);
        var colsPL=[
          {k:"name",al:"",fn:function(p){
            // 2026-05-19 字段表方针:
            //   customer 版 → 用 product_name (真品名 per SKU)
            //   customs 版  → 上游已 group-merge 成 declaration_name 行
            //                  直接读 productName (已被 merge 块改写为 dn)
            var n = pick(p.productName, p.name, p.description, "-");
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          },lbl:"Description &amp; Size"},
          // 2026-05-19 客户要求 PL 加 barcode 列 (仓库扫货用)
          {k:"bc",al:"center",w:"110px",fn:function(p){return p.barcode||p.code||"";},lbl:"Barcode"},
          {k:"qty",al:"center",w:"55px",lbl:"CTN"},
          {k:"nw",al:"right",w:"80px",fn:function(p){var pn=Number(p.netWeight||p.nw||0);var q=Number(p.qty||0);return fmtM(audience==='customs'?pn:(pn*q||pn));},lbl:"TOTAL NW (KG)"},
          {k:"gw",al:"right",w:"80px",fn:function(p){var pg=Number(p.grossWeight||p.gw||0);var q=Number(p.qty||0);return fmtM(audience==='customs'?pg:(pg*q||pg));},lbl:"TOTAL GW (KG)"},
          {k:"cbm",al:"right",w:"70px",fn:function(p){return fmtM(cbmOf(p),3);},lbl:"CBM (CU.M.)"},
        ];
        // 2026-05-19: PL 不显示 Currency (无金额信息); buyer label = "Buyer / Consignee"
        // Doc No + Issued 移到 footer via wrap docRef
        var _fsNoPL = (raw.fs_no || raw.internal_no || (ordNo||noPL)) + "-PL";
        _packBodies.pl=`
          ${docHdr(cfg,"装箱单","PACKING LIST",audience)}
          ${buyerBlock(cust,caddr,ctel,noPL,"Contract No.",ordNo,date,"")}
          ${portBar(pol,pod,inco)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsPL.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsPL,curr)}
          <tr class="total-row"><td colspan="2" class="text-right" style="color:#555;font-size:11px">SHIPPING MARKS: N/M &nbsp;&nbsp; TOTAL:</td><td></td><td style="text-align:center">${fmtM(tqty,0)}</td><td class="text-right">${fmtM(tnw)}</td><td class="text-right">${fmtM(tgw)}</td><td class="text-right">${fmtM(tcbmPL,3)}</td></tr>
          </tbody></table>${sigBlock(cfg.seal_url)}`; html=wrap((ordNo||noPL)+"_PL",_packBodies.pl,ap,{docNo:_fsNoPL,date:date});

      if(_PACK){
        // 不自己拼版式：复用现有单据模板，每张各放一个原样 .container（跟单张完全一致），
        // 用 page-break 分成 3 页。
        var _ct =function(b){return b?'<div class="container">'+b+'</div>':'';};
        var _ctp=function(b){return b?'<div class="container" style="page-break-before:always">'+b+'</div>':'';};
        html=`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc((ordNo||id)+" 报关 PL·SC·IV")}</title>${CSS}</head><body>`
          +_ct(_packBodies.pl)+_ctp(_packBodies.sc)+_ctp(_packBodies.iv)
          +`</body></html>`;
      }
        _xlsCapture={sheetName:"Packing List",docNo:(ordNo||noPL)+"_PL",buyer:cust,buyerAddr:caddr,date:date,cno:cno,curr:"",pol:pol,pod:pod,incoterm:inco,poNo:ordNo,seller:{nameEN:cfg.nameEN,address:cfg.address,tel:cfg.tel,email:cfg.email},
          headers:["NO.","Description & Size","Barcode","CTN","TOTAL NW (KG)","TOTAL GW (KG)","CBM (CU.M.)"],
          colKeys:[{k:"name",fn:function(p){
            // PL Excel — same rule: always real product name (see colsPL above)
            var n = pick(p.productName, p.name, p.description, "-");
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          }},{k:"bc",fn:function(p){return p.barcode||p.code||"";}},{k:"qty",fn:function(p){return Number(p.qty)||0;}},{k:"nw",fn:function(p){var pn=Number(p.netWeight||p.nw||0);var q=Number(p.qty||0);return parseFloat((pn*q||pn).toFixed(2))||0;}},{k:"gw",fn:function(p){var pg=Number(p.grossWeight||p.gw||0);var q=Number(p.qty||0);return parseFloat((pg*q||pg).toFixed(2))||0;}},{k:"cbm",fn:function(p){return parseFloat(cbmOf(p).toFixed(3))||0;}}],
          rows:prods,totals:["","TOTAL","",tqty,parseFloat(tnw.toFixed(2)),parseFloat(tgw.toFixed(2)),parseFloat(tcbmPL.toFixed(3))]};
      }

      if(type==="pi"){
        var noPI=cno.replace(/[^A-Z0-9-]/gi,"").slice(0,20);
        var colsPI=[
          {k:"name",al:"",fn:function(p){
            // Audience-aware product name (2026-05-18):
            //   customs → bl_description / declarationName / hsName (short, HS-friendly)
            //   customer → productName / name (full marketing name with brand+flavor+spec)
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          },lbl:"Description &amp; Size"},
          {k:"qty",al:"center",w:"70px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:function(p){return fmtM(resolveUnitPrice(p));},lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"110px",fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},lbl:"Amount ("+curr+")"},
        ];
        var _fsNoPI = (raw.fs_no || raw.internal_no || (ordNo||noPI)) + "-PI";
        html=wrap((ordNo||noPI)+"_PI",`
          ${docHdr(cfg,"形式发票","PROFORMA INVOICE")}
          ${buyerBlock(cust,caddr,ctel,noPI,"PI No.",ordNo,date,curr)}
          ${portBar(pol,pod,inco)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsPI.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsPI,curr)}${totRow}</tbody></table>
          <div class="footer-block"><div class="details-grid">${termsCard(cfg.terms.iv)}${bankCard(cfg.bank,curr)}</div>${sigBlock(cfg.seal_url)}</div>`,ap,{docNo:_fsNoPI,date:date});
        _xlsCapture={sheetName:"Proforma Invoice",docNo:(ordNo||noPI)+"_PI",buyer:cust,date:date,cno:cno,curr:curr,pol:pol,pod:pod,incoterm:inco,poNo:ordNo,seller:{nameEN:cfg.nameEN,address:cfg.address,tel:cfg.tel,email:cfg.email},terms:cfg.terms.iv,bank:cfg.bank,
          headers:["NO.","Description & Size","QTY","Unit Price ("+curr+")","Amount ("+curr+")"],
          colKeys:[
            {k:"name",fn:function(p){
            // Audience-aware product name (2026-05-18):
            //   customs → bl_description / declarationName / hsName (short, HS-friendly)
            //   customer → productName / name (full marketing name with brand+flavor+spec)
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          }},
            {k:"qty"},
            {k:"price",fn:function(p){return parseFloat(String(fmtM(resolveUnitPrice(p))).replace(/,/g,""))||0;}},
            {k:"amt",fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return parseFloat(String(fmtM(s)).replace(/,/g,""))||0;}}
          ],
          rows:prods,totals:["","TOTAL","","",parseFloat(String(fmtM(tot)).replace(/,/g,""))||0]};
      }

      if(type==="po"){
        var noPO=pick(o.order_no,o.contract_no,id);
        var factory=pick(raw.factory,raw.factoryName,raw.supplier,"[FACTORY]");
        var buyerTaxNo=pick(cfg.taxNo,raw.sellerTaxNo,"");
        var vendorTaxNo=pick(raw.factoryTaxNo,raw.vendorTaxNo,"");
        var vendorAddress="", vendorBank="", vendorAccount="";
        try{
          var fSearch=factory.replace(/股份|有限公司|进出口/g,"").trim().slice(0,6);
          var fR=await pool.query("SELECT * FROM factories WHERE name=$1 OR name LIKE $2 LIMIT 1",[factory,'%'+fSearch+'%']);
          if(fR.rows.length){
            var fd=fR.rows[0];
            vendorTaxNo=vendorTaxNo||fd.tax_no||"";
            vendorAddress=fd.address||"";
            vendorBank=fd.bank_name||"";
            vendorAccount=fd.bank_account||"";
          }
        }catch(e){}
        var totPO=prods.reduce(function(s,p){var fp=pick(p.factoryPrice,p.unitPrice,p.price);var sub=Number(p.subtotalFactory||p.subtotal||0);if(!sub&&p.qty&&fp)sub=Number(p.qty)*Number(fp);return s+sub;},0)||Number(o.total_amount)||0;
        html=wrap("Purchase Order — "+noPO,`
          ${docHdr(cfg,"采购合同","PURCHASE ORDER")}
          <div class="meta-grid">
            <div>
              <div class="section-label">买方信息 BUYER / BILL TO</div>
              <p style="font-size:13px;font-weight:bold;margin:0">${esc(cfg.nameCN)}</p>
              <p style="margin:2px 0;color:#666;font-size:10px">${esc(cfg.nameEN)}</p>
              ${buyerTaxNo?`<p style="margin:2px 0">税号: ${esc(buyerTaxNo)}</p>`:""}
              <p style="margin:2px 0">地址: ${esc(cfg.address)}</p>
              <p style="margin:2px 0">开户银行: ${esc(cfg.buyerBank||cfg.bank.bankName)}</p>
              <p style="margin:2px 0">银行账户: ${esc(cfg.bank.rmbAccount)}</p>
            </div>
            <div>
              <div class="section-label">供应商信息 VENDOR / SHIP FROM</div>
              <p style="font-size:13px;font-weight:bold;margin:0">${esc(factory)}</p>
              ${vendorTaxNo?`<p style="margin:2px 0">税号: ${esc(vendorTaxNo)}</p>`:""}
              ${(vendorAddress||raw.factoryAddress)?`<p style="margin:2px 0">地址: ${esc(vendorAddress||raw.factoryAddress)}</p>`:""}
              ${(vendorBank||raw.factoryBank)?`<p style="margin:2px 0">开户银行: ${esc(vendorBank||raw.factoryBank)}</p>`:""}
              ${(vendorAccount||raw.factoryAccount)?`<p style="margin:2px 0">银行账户: ${esc(vendorAccount||raw.factoryAccount)}</p>`:""}
            </div>
          </div>
          <div class="trade-terms-bar">
            <span>Order No.: ${esc(ordNo)}</span>
            <span>Contract No.: ${esc(cno)}</span>
            <span>Delivery: ${esc(date)}</span>
          </div>
          <table><thead><tr><th style="width:36px">NO.</th><th>品名 Item Description</th><th style="width:70px;text-align:center">数量 Qty</th><th style="width:90px;text-align:right">单价 Unit Price</th><th style="width:100px;text-align:right">金额 Amount</th><th style="width:90px;text-align:center">条形码 Code</th></tr></thead>
          <tbody>
            ${prods.length===0?`<tr><td>01</td><td colspan="5" style="color:#999;font-style:italic">— 产品明细将自动填入 —</td></tr>`:
              prods.map(function(p,i){
                var fp=pick(p.factoryPrice,p.unitPrice,p.price);
                var sub=Number(p.subtotalFactory||p.subtotal||0);if(!sub&&p.qty&&fp)sub=Number(p.qty)*Number(fp);
                return`<tr><td>${String(i+1).padStart(2,"0")}</td><td>${esc(pick(p.productName,p.name,"-"))}</td><td style="text-align:center">${esc(String(p.qty||"-"))}</td><td class="text-right">${fmtM(fp)}</td><td class="text-right">${fmtM(sub)}</td><td style="text-align:center;font-size:10px;color:#666">${esc(p.barcode||p.code||"")}</td></tr>`;
              }).join("")}
            <tr class="total-row"><td colspan="2" class="text-right" style="color:#555;font-size:11px">合计 Total:</td><td style="text-align:center">${fmtM(tqty,0)}</td><td></td><td class="text-right" style="font-size:14px">${fmtM(totPO)}</td><td></td></tr>
          </tbody></table>
          <div class="details-grid">
            <div class="details-box"><h4>备注及条款 REMARKS &amp; TERMS</h4>
              1. 质量 Quality: 供方须保证产品符合约定规格。终端客户投诉有据可查时，供方承担退款或补货责任。(Supplier guarantees specs; liable for refund/replacement on verified defects.)<br>
              2. 交期 Delivery: 如有延误，须提前5个工作日书面通知。逾期导致的亏舱费、改船费、客户索赔由供方承担。(5 working days written notice required for delays. Supplier liable for resulting losses.)<br>
              3. 系统声明: 本合同由 Sanlyn OS 供应链引擎自动生成，作为双方商业确认之有效凭证。
            </div>
            ${bankCard(cfg.bank,curr)}
          </div>
          <div class="signature-grid"><div class="sig-box"><span>BUYER REPRESENTATIVE</span><span style="font-weight:normal;font-size:9px">(买方代表签署 / 盖章)</span></div><div class="sig-box"><span>SELLER REPRESENTATIVE</span><span style="font-weight:normal;font-size:9px">(卖方代表签署 / 盖章)</span></div></div>
        `,ap);
      }
    }

    if(["so","debit","freight-quote","sq"].includes(type)){
      // 2026-05-19: accept _id / shipment_no / contract_no / bl_no
      var spR=await pool.query(
        "SELECT * FROM shipping_plans WHERE _id=$1 OR shipment_no=$1 OR contract_no=$1 OR bl_no=$1 OR order_contract_nos ILIKE '%'||$1||'%' LIMIT 1",
        [id]
      );
      if(!spR.rows.length) return res.status(404).send("<h1>Shipment not found: "+esc(id)+"</h1>");
      var sp=spR.rows[0], spraw=sp.raw||{};
      if(typeof spraw==="string")try{spraw=JSON.parse(spraw);}catch(e){spraw={};}
      // 海运类文档强制走 OCEANBABY (除非 spraw.shipping_vendor 指定)
      var cfg3=await loadSellerCfg(pool,spraw,qco,{shipping:true});
      var fwd=FORWARDERS["default"];
      var vessel=pick(sp.vessel,spraw.vessel,"-");
      var voyage=pick(sp.voyage,spraw.voyage,"-");
      var polSp=pick(sp.pol,"-"), podSp=pick(sp.pod,"-");
      var etd=fmtD(pick(sp.etd,sp.shipment_date));
      var cutoff=fmtD(sp.cutoff_date);
      var ctype=pick(sp.container_type,spraw.containerType,"40HQ");
      var cqty=pick(sp.container_qty,spraw.containerQty,1);
      var tgwSp=pick(sp.gross_weight,spraw.grossWeight,"-");
      var tcbm=pick(sp.total_cbm,spraw.totalCBM,"-");
      var soNo=pick(sp.shipment_no,id);
      // helper: reject widget template strings from old form system
      function notWidget(v){ return v&&typeof v==="string"&&!v.includes("#_widget_")&&!v.includes("${")&&v.trim().length>1; }
      function pickClean(){ for(var i=0;i<arguments.length;i++){var v=arguments[i];if(notWidget(v))return v;} return ""; }
      var consignee=pickClean(sp.customer_en,sp.customer,spraw.consignee)||"[CONSIGNEE]";
      var consAddr=resolveAddr(consignee, notWidget(spraw.consigneeAddress)?spraw.consigneeAddress:"");
      var shipper=cfg3.nameEN;
      // Cargo lines — per product with HS code
      var cargoLines=[], cargoByOrder={};
      function _buildLines(rr){
        var prods=rr.products||rr.items||[], lines=[];
        prods.forEach(function(p){
          var desc=p.blDescription||p.declarationName||p.bl_description||p.productNameEN||p.productName||p.name||"";
          var hs=p.hsCode||p.hs_code||p.hscode||"";
          if(!desc&&!hs)return;
          var key=(hs+"|"+desc).toLowerCase();
          if(!lines.some(function(cl){return(cl.hs+"|"+cl.desc).toLowerCase()===key;}))lines.push({desc:desc,hs:hs});
        });
        if(!prods.length){var d=rr.blDescription||rr.cargoDescription||"",hs=rr.hsCode||rr.hs_code||"";if(d||hs)lines.push({desc:d,hs:hs});}
        return lines;
      }
      var _orderNos=sp.order_nos||spraw.orderNos||spraw.order_nos||[];
      if(_orderNos&&_orderNos.length){
        var loR=await pool.query("SELECT raw,contract_no,order_no,total_qty,total_cbm,gross_weight FROM orders WHERE order_no = ANY($1::text[]) OR contract_no = ANY($1::text[])",[ _orderNos]);
        for(var loRow of loR.rows){
          var rr=loRow.raw||{};if(typeof rr==="string")try{rr=JSON.parse(rr);}catch(e){rr={};}
          var enrichedBLProds=await enrichProdsFromMaster(pool,rr.products||rr.items||[]);
          var rrE=Object.assign({},rr,{products:enrichedBLProds,items:enrichedBLProds});
          var lines=_buildLines(rrE);
          var key=loRow.contract_no||loRow.order_no||"";
          if(key)cargoByOrder[key]=lines;
          lines.forEach(function(l){var k=(l.hs+"|"+l.desc).toLowerCase();if(!cargoLines.some(function(cl){return(cl.hs+"|"+cl.desc).toLowerCase()===k;}))cargoLines.push(l);});
        }
      }
      if(!cargoLines.length){var fb=pick(spraw.cargoDescription,sp.cargo_description,"");if(fb)cargoLines=[{desc:fb,hs:""}];}
      function _cargoHTML(lines){
        if(!lines||!lines.length)return'<span style="color:#aaa;font-size:11px">— 请补充货描 —</span>';
        return lines.map(function(cl){return'<div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dashed #eee"><span style="font-size:11px">'+esc(cl.desc||"—")+'</span>'+(cl.hs?'<span style="font-size:10px;color:#555;margin-left:12px;white-space:nowrap">HS: <b>'+esc(cl.hs)+'</b></span>':"")+' </div>';}).join("");
      }

      if(type==="so"){
        var carrier=pick(sp.shipping_line,spraw.shippingLine,"-");
        var eta=pick(sp.eta,spraw.eta,"-"); if(eta&&eta!=="-")eta=fmtD(eta);
        var conNo=pick(sp.container_no,spraw.containerNo,"");
        var sealNo=pick(sp.seal_no,spraw.sealNo,"");
        var cargoDescHTML=_cargoHTML(cargoLines);

        html=wrap("Booking Note — "+soNo,`
          <table style="width:100%;border-collapse:collapse;margin-bottom:0">
            <tr>
              <td style="padding:10px 0 6px 0;border-bottom:2px solid #111">
                <div style="font-size:17px;font-weight:800">${esc(fwd.nameCN)}</div>
                <div style="font-size:10px;color:#666;margin-top:1px">${esc(fwd.nameEN)}</div>
              </td>
              <td style="padding:10px 0 6px 0;border-bottom:2px solid #111;text-align:right;vertical-align:bottom">
                <div style="font-size:15px;font-weight:800;letter-spacing:2px">出口货物委托书</div>
                <div style="font-size:11px;font-weight:600;color:#555;letter-spacing:1px">SHIPPING ORDER</div>
                <div style="font-size:11px;margin-top:4px"><b>D/R No.:</b> ${esc(soNo)} &nbsp;&nbsp; <b>日期:</b> ${esc(fmtD(sp.created_at))}</div>
              </td>
            </tr>
          </table>

          <table style="width:100%;border-collapse:collapse;margin-top:10px;margin-bottom:0">
            <tr>
              <td style="border:1px solid #aaa;padding:8px 10px;font-size:11px;vertical-align:top;width:60%">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:4px">Shipper / 发货人</div>
                <div style="font-weight:700;font-size:12px">${esc(shipper)}</div>
                <div style="font-size:10px;color:#666;margin-top:2px">${esc(cfg3.address||"")}</div>
              </td>
              <td style="border:1px solid #aaa;padding:8px 10px;font-size:11px;vertical-align:top;width:40%;color:#c00" rowspan="3">
                <div style="font-size:9px;font-weight:700;margin-bottom:6px">请在提单待确认样上注明：</div>
                <div style="font-size:11px;font-weight:600">申请目的港最长免箱时间，至少申请目的港免箱混 <u>21 天</u></div>
              </td>
            </tr>
            <tr>
              <td style="border:1px solid #aaa;padding:8px 10px;font-size:11px;vertical-align:top">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:4px">Consignee / 收货人</div>
                <div style="font-weight:700;font-size:12px">${esc(consignee)}</div>
                ${consAddr?`<div style="font-size:10px;color:#666;margin-top:2px">${esc(consAddr)}</div>`:""}
              </td>
            </tr>
            <tr>
              <td style="border:1px solid #aaa;padding:8px 10px;font-size:11px;vertical-align:top">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:4px">Notify Party / 通知人</div>
                <div style="font-weight:700;font-size:12px">${esc(consignee)}</div>
                ${consAddr?`<div style="font-size:10px;color:#666;margin-top:2px">${esc(consAddr)}</div>`:""}
              </td>
            </tr>
          </table>

          <table style="width:100%;border-collapse:collapse;margin-top:8px">
            <tr>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px;width:40%">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">Ocean Vessel &amp; Voyage / 船名航次</div>
                <b>${esc(vessel)}</b> / ${esc(voyage)}
              </td>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px;width:30%">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">Port of Loading / 装货港</div>
                <b>${esc(polSp)}</b>
              </td>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px;width:30%">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">Carrier / 船公司</div>
                <b>${esc(carrier)}</b>
              </td>
            </tr>
            <tr>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">Port of Discharge / 卸货港</div>
                <b>${esc(podSp)}</b>
              </td>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">ETD / 开船日</div>
                <b>${esc(etd)}</b>
              </td>
              <td style="border:1px solid #aaa;padding:7px 10px;font-size:11px">
                <div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:2px">ETA / 预计到港</div>
                <b>${esc(eta)}</b>
              </td>
            </tr>
          </table>

          <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:11px">
            <thead><tr style="background:#111;color:#fff">
              <th style="padding:7px 8px;font-size:10px;text-align:center;width:16%">Container No.<br>集装箱号</th>
              <th style="padding:7px 8px;font-size:10px;text-align:center;width:12%">Seal No.<br>封志号</th>
              <th style="padding:7px 8px;font-size:10px;text-align:center;width:9%">Type<br>柜型</th>
              <th style="padding:7px 8px;font-size:10px;text-align:left">Description of Goods &amp; HS Code<br>货物描述 &amp; HS编码</th>
              <th style="padding:7px 8px;font-size:10px;text-align:center;width:10%">G.W.(KG)<br>毛重</th>
              <th style="padding:7px 8px;font-size:10px;text-align:center;width:9%">CBM<br>方数</th>
            </tr></thead>
            <tbody>${(function(){
              var ctrs=spraw.containers||[];
              if(ctrs.length){
                return ctrs.map(function(c){
                  var okey=c.order_no||c.contract_no||"";
                  var cLines=(okey&&cargoByOrder[okey])?cargoByOrder[okey]:cargoLines;
                  return "<tr>"
                    +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:middle'>"+esc(c.container_no||"—")+"</td>"
                    +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:middle'>"+esc(c.seal_no||"—")+"</td>"
                    +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:middle'>"+esc(c.type||ctype)+"</td>"
                    +"<td style='border:1px solid #ddd;padding:8px;vertical-align:top'>"+_cargoHTML(cLines)+"</td>"
                    +"<td style='border:1px solid #ddd;padding:8px;text-align:center;font-weight:700;vertical-align:middle'>"+esc(String(c.gw||"—"))+"</td>"
                    +"<td style='border:1px solid #ddd;padding:8px;text-align:center;font-weight:700;vertical-align:middle'>"+esc(String(c.cbm||"—"))+"</td>"
                    +"</tr>";
                }).join("");
              }
              return "<tr>"
                +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:top'>"+esc(conNo)||"—"+"</td>"
                +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:top'>"+esc(sealNo)||"—"+"</td>"
                +"<td style='border:1px solid #ddd;padding:8px;text-align:center;vertical-align:top'>"+esc(ctype)+"</td>"
                +"<td style='border:1px solid #ddd;padding:8px;vertical-align:top'>"+cargoDescHTML+"</td>"
                +"<td style='border:1px solid #ddd;padding:8px;text-align:center;font-weight:700;vertical-align:top'>"+esc(String(tgwSp))+"</td>"
                +"<td style='border:1px solid #ddd;padding:8px;text-align:center;font-weight:700;vertical-align:top'>"+esc(String(tcbm))+"</td>"
                +"</tr>";
            })()}</tbody>
          </table>

          <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-top:10px;font-size:11px">
            ${[["截关日 Cut-off",cutoff||"-"],["运费 Freight","FREIGHT PREPAID"],["柜型 Container",ctype],["柜量 Qty",String(cqty)]].map(function(b){return`<div style="border:1px solid #ddd;padding:6px 10px;border-radius:2px"><div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase">${b[0]}</div><div style="font-weight:600;font-size:12px;margin-top:2px">${esc(b[1])}</div></div>`;}).join("")}
          </div>
          <div style="margin-top:12px;font-size:10px;padding-top:8px;border-top:1px solid #eee;display:flex;justify-content:space-between;color:#555">
            <div><b>制单:</b> ${esc(cfg3.nameEN)}</div><div><b>联系人:</b> ${esc(fwd.contact)} &nbsp; <b>Email:</b> ${esc(fwd.email)}</div>
          </div>
        `,ap);
      }

      if(type==="debit"){
        // ⚠ Real fields only — never fabricate values (memory: feedback_never_invent_fields)
        var freightTerm = pick(sp.freight_term, "");           // 2026-05-18 new column
        var quoteRef    = pick(sp.quote_ref, "");              // 2026-05-18 new column
        var buyerUscc   = pick(cust && cust.uscc, "");         // 2026-05-18 new customers.uscc
        var exr=Number(pick(sp.exchange_rate,spraw.exchangeRate,7.2));
        var fUSD=Number(pick(sp.freight_sale_usd,0));
        var fCNY=Number(pick(sp.freight_cost,0));
        var thcF=Number(pick(sp.thc_fee,0));
        var docF=Number(pick(sp.doc_fee,0));
        var sealF=Number(pick(sp.seal_fee,0));
        var blF=Number(pick(sp.tlx_fee,0));
        var eirF=Number(pick(sp.eir_fee,0));
        var vgmF=Number(pick(sp.info_trans_fee,0));
        var bkgF=Number(pick(sp.bkg_fee,0));
        var truck=Number(pick(sp.trucking_cost_total,0));
        var customs=Number(pick(sp.customs_cost_total,0));
        var ins=Number(pick(sp.insurance_cost,0));
        var blNo=pick(sp.bl_no,spraw.blNo,spraw.bl_no,"");
        var totCNY=fCNY+thcF+docF+sealF+blF+eirF+vgmF+bkgF+truck+customs;
        var totUSD=fUSD+ins;
        // 2026-05-19: DN 默认 "DB-" 前缀；fmt=iv 时改 "INV-" + 标题切 INVOICE
        var _isIvFmt = (_fmtVariant === "iv");
        var dbNo = (_isIvFmt ? "INV-" : "DB-") + soNo;
        var _dnTitleCN = _isIvFmt ? "海运费发票" : "借记通知单";
        var _dnTitleEN = _isIvFmt ? "FREIGHT INVOICE" : "DEBIT NOTE";

        // Build fee rows: [label_en, label_cn, qty, currency, amount]
        var feeList=[
          ["OCEAN FREIGHT","海运费",1,"USD",fUSD],
          ["THC","码头操作费",1,"CNY",thcF],
          ["DOCUMENTATION FEE","文件费",1,"CNY",docF],
          ["SEAL FEE","铅封费",cqty,"CNY",sealF],
          ["B/L FEE","提单/电放费",1,"CNY",blF],
          ["EIR","设备交接费",cqty,"CNY",eirF],
          ["VGM","信息代输费",1,"CNY",vgmF],
          ["BOOKING FEE","订舱费",1,"CNY",bkgF],
          ["TRUCKING","拖车费",1,"CNY",truck],
          ["CUSTOMS","报关费",1,"CNY",customs],
          ["INSURANCE","保险费",1,"USD",ins],
        ].filter(function(r){return r[4]>0;});

        var CSS2=`<style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{font-family:'Helvetica','Arial','PingFang SC',sans-serif;color:#000;padding:30px;font-size:11px;line-height:1.4;background:#f0f0f0;}
          .container{max-width:800px;margin:auto;background:#fff;padding:30px;}
          .header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:15px;margin-bottom:25px;}
          .seller-name{font-size:18px;font-weight:900;text-transform:uppercase;margin-bottom:4px;}
          .seller-sub{font-size:10px;color:#666;}
          .doc-type h1{margin:0;font-size:28px;font-weight:900;letter-spacing:1px;text-align:right;}
          .doc-type p{font-size:13px;font-weight:700;margin:3px 0;text-align:right;color:#444;}
          .meta-grid{display:grid;grid-template-columns:1.2fr 0.8fr;gap:40px;margin-bottom:20px;}
          .section-label{font-size:10px;font-weight:700;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:3px;margin-bottom:8px;color:#444;}
          .meta-list{list-style:none;padding:0;margin:0;}
          .meta-list li{margin-bottom:5px;display:flex;gap:6px;}
          .meta-list b{min-width:110px;font-weight:700;}
          .shipping-bar{border:2px solid #000;padding:10px;display:flex;justify-content:space-between;margin-bottom:25px;font-weight:700;font-size:11px;}
          table{width:100%;border-collapse:collapse;margin-bottom:25px;}
          th{background:#000;color:#fff;padding:10px;text-align:left;font-size:10px;text-transform:uppercase;}
          td{padding:10px;border-bottom:1px solid #ccc;vertical-align:top;}
          .tc{text-align:center;} .tr{text-align:right;}
          tfoot td{font-size:13px;font-weight:900;border-top:2px solid #000;border-bottom:none;}
          .details-grid{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:10px;page-break-inside:avoid;break-inside:avoid;}
          .details-box{border:1px solid #000;padding:12px;page-break-inside:avoid;break-inside:avoid;}
          .details-box h4{margin:0 0 10px 0;font-size:11px;text-transform:uppercase;text-decoration:underline;}
          .sig-row{display:flex;justify-content:space-between;margin-top:50px;page-break-inside:avoid;break-inside:avoid;}
          .sig-b{width:45%;border-top:2px solid #000;padding-top:10px;text-align:center;height:80px;font-weight:700;display:flex;flex-direction:column;justify-content:space-between;page-break-inside:avoid;break-inside:avoid;}
          tr,thead,tfoot,tfoot td{page-break-inside:avoid;break-inside:avoid;}
          .sig-note{font-weight:400;font-size:9px;}
          .footer-slogan{text-align:center;margin-top:30px;font-size:9px;color:#888;border-top:1px dashed #ccc;padding-top:12px;letter-spacing:1px;}
          @media print{body{background:#fff;padding:0;}.container{max-width:100%;}}
        </style>`;

        html=`<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>Debit Note — ${esc(dbNo)}</title>${CSS2}${ap?'<script>window.onload=function(){window.print()}<\/script>':""}</head><body><div class="container">
          <div class="header">
            <div class="seller-info">
              <div class="seller-name">${esc(cfg3.nameEN)}</div>
              <div class="seller-sub">${esc(cfg3.address)}</div>
              <div class="seller-sub">Tel: ${esc(cfg3.tel)} | Email: ${esc(cfg3.email)}</div>
            </div>
            <div class="doc-type"><h1>${esc(_dnTitleCN)}</h1><p>${esc(_dnTitleEN)}</p></div>
          </div>
          <div class="meta-grid">
            <div>
              <div class="section-label">付款方 / BILL TO</div>
              <p style="font-size:13px;font-weight:700;margin:0 0 5px 0">${esc(consignee)}</p>
              <p style="color:#555">${esc(consAddr)}</p>
              ${buyerUscc?`<p style="color:#555;font-family:monospace;font-size:10px;margin-top:3px">USCC 统一社会信用代码: <b>${esc(buyerUscc)}</b></p>`:""}
            </div>
            <div>
              <div class="section-label">单据详情 / DETAILS</div>
              <ul class="meta-list">
                <li><b>账单编号 DB No.:</b>${esc(dbNo)}</li>
                ${blNo?`<li><b>提单号 B/L No.:</b>${esc(blNo)}</li>`:""}
                <li><b>日期 Date:</b>${fmtD(new Date())}</li>
                <li><b>ETD:</b>${esc(etd)}</li>
                ${freightTerm?`<li><b>付款方式 Freight Term:</b>${esc(freightTerm)}</li>`:""}
                ${quoteRef?`<li><b>报价单号 Quote Ref:</b>${esc(quoteRef)}</li>`:""}
              </ul>
            </div>
          </div>
          <div class="shipping-bar">
            <span>船名航次 VSL/VOY: ${esc(vessel)} / ${esc(voyage)}</span>
            <span>起运港 POL: ${esc(polSp)}</span>
            <span>目的港 POD: ${esc(podSp)}</span>
          </div>
          <table>
            <thead><tr>
              <th style="width:40px">No.</th>
              <th>费用项目 Description</th>
              <th class="tc" style="width:55px">数量 Qty</th>
              <th class="tc" style="width:55px">币种 Cur</th>
              <th class="tr" style="width:100px">金额 Amount</th>
            </tr></thead>
            <tbody>
              ${feeList.map(function(r,i){return`<tr><td>${String(i+1).padStart(2,"0")}</td><td>${esc(r[0])} / <span style="color:#555">${esc(r[1])}</span></td><td class="tc">${r[2]}</td><td class="tc">${r[3]}</td><td class="tr">${fmtM(r[4])}</td></tr>`;}).join("")||`<tr><td colspan="5" style="text-align:center;color:#ccc;font-style:italic;padding:20px">— 费用明细将从海运计划自动填入 —</td></tr>`}
            </tbody>
            <tfoot>
              ${totCNY>0?`<tr><td colspan="4" class="tr">小计 CNY:</td><td class="tr">CNY ${fmtM(totCNY)}</td></tr>`:""}
              ${totUSD>0?`<tr><td colspan="4" class="tr">小计 USD:</td><td class="tr">USD ${fmtM(totUSD)}</td></tr>`:""}
              <tr><td colspan="4" class="tr">总计应付 TOTAL DUE (CNY equiv):</td><td class="tr">CNY ${fmtM(totCNY+totUSD*exr)}</td></tr>
            </tfoot>
          </table>
          <div class="details-grid">
            <div style="border:none;padding:0">
              <h4 style="border-bottom:1px solid #000;padding-bottom:5px;text-decoration:none;font-size:11px;text-transform:uppercase">备注 / REMARKS</h4>
              <p style="color:#555;margin-top:5px;font-size:10.5px">请在收到账单后 7 个工作日内安排付款。如有疑问，请及时联系我司财务部。<br>Please arrange payment within 7 working days upon receipt of this debit note.</p>
            </div>
            <div class="details-box">
              <h4>汇款账户 Banking Information</h4>
              <div style="font-size:10.5px;line-height:1.9">
                受益人: ${esc(cfg3.bank.beneficiary)}<br>
                银行: ${esc(cfg3.bank.bankName)}<br>
                SWIFT: ${esc(cfg3.bank.swift)}<br>
                账号 USD: ${esc(cfg3.bank.usdAccount)}<br>
                账号 RMB: ${esc(cfg3.bank.rmbAccount)}<br>
                <span style="color:red;font-size:9.5px;font-weight:700">* 汇款时请备注账单号 DB No. / Please remark DB No. when remitting.</span>
              </div>
            </div>
          </div>
          <div class="sig-row">
            <div class="sig-b"><span>CLIENT CONFIRMATION</span><span class="sig-note">(客户确认签署 / 盖章)</span></div>
            <div class="sig-b"><span>AUTHORIZED SIGNATURE</span><span class="sig-note">(开票方授权签署 / 盖章)</span></div>
          </div>
          <div class="footer-slogan">⚡ Generated &amp; Verified by <b>Sanlyn OS Supply Chain Engine</b></div>
        </div></body></html>`;
      }

      // ──────────────────────────────────────────────────────────────────────
      // SO 海运单 Shipping Order / SQ 海运确认报价 Freight Quote
      // 2026-05-19: 用现有模板库设计 (freight-quote-enrich-2026-04.html)
      // 同一 dark-theme 模板，标题/内容不同；自动从 shipping_plans 填字段
      // ──────────────────────────────────────────────────────────────────────
      if(type==="so" || type==="freight-quote" || type==="sq"){
        var isSO = (type==="so");
        var docTitle = isSO ? "海运单" : "海运确认报价";
        var docTitleEN = isSO ? "SHIPPING ORDER" : "OCEAN FREIGHT QUOTATION";
        var docNo = (isSO ? "SO-" : "FQ-") + pick(sp.bl_no, sp.contract_no, soNo);
        var blNoX = pick(sp.bl_no, spraw.blNo, spraw.bl_no, "—");
        var vesselX = pick(sp.vessel, spraw.vessel, "—");
        var voyageX = pick(sp.voyage, spraw.voyage, "—");
        var cntrX = pick(sp.container_no, spraw.containerNo, "—");
        var sealX = pick(sp.seal_no, spraw.sealNo, "—");
        var polX = pick(sp.pol, spraw.pol, "—");
        var podX = pick(sp.pod, spraw.pod, "—");
        var etdX = fmtD(pick(sp.etd, spraw.etd, ""));
        var etaX = fmtD(pick(sp.eta, spraw.eta, ""));
        var atdX = fmtD(pick(sp.atd, spraw.atd, ""));
        var ctnTypeX = pick(sp.container_type, spraw.containerType, "40HQ");
        var carrierX = pick(sp.carrier_code, spraw.carrier, "—");
        var forwarderX = pick(sp.forwarder_cn, spraw.forwarderCN, spraw.freightForwarder, "—");
        var bookingNoX = pick(sp.forwarder_booking_no, spraw.bookingNo, "—");
        // SO/SQ 走 shipping_plan-only 路径，不需要 order.raw
        var _orderRaw = (typeof raw === 'object' && raw) ? raw : {};
        var totalCtnsX = pick(sp.total_cartons, _orderRaw.totalQty, spraw.totalQty, "—");
        var gwX = pick(sp.gross_weight_kg, _orderRaw.grossWeight, spraw.grossWeight, "—");
        var cbmX = pick(sp.total_cbm, _orderRaw.totalCBM, spraw.totalCBM, "—");
        var shipperX = pick(spraw.shipper, cfg3 && cfg3.nameEN, "—");
        var consigneeX = pick(sp.customer_en, sp.customer, _orderRaw.companyNameEN, _orderRaw.companyName, "—");

        // === CSS 来自模板库 templates/freight-quote-enrich-2026-04.html ===
        var CSS_SO=`<style>
          :root{--bg:#0B1120;--panel:#111a2f;--panel2:#0e1628;--line:#1f2a44;--line2:#2a3858;
                --txt:#e2e8f0;--mut:#94a3b8;--dim:#64748b;--blue:#38bdf8;--blue-bg:rgba(56,189,248,.15);
                --emerald:#34d399;--amber:#fbbf24;--mono:'SF Mono','Menlo','Consolas',monospace;}
          *{box-sizing:border-box}
          body{margin:0;padding:32px 18px;background:var(--bg);color:var(--txt);
               font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif;font-size:13px;line-height:1.55}
          .wrap{max-width:880px;margin:0 auto}
          .doc{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
          .doc-hdr{padding:22px 26px;border-bottom:1px solid var(--line);
                   background:linear-gradient(180deg,#13203d 0%,#111a2f 100%);
                   display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
          .doc-hdr h1{margin:0 0 4px;font-size:18px;font-weight:800;letter-spacing:.01em}
          .doc-hdr .seller{font-size:11px;color:var(--mut);font-family:var(--mono);line-height:1.5}
          .doc-hdr .seller b{color:var(--txt)}
          .doc-hdr .qno{text-align:right;font-family:var(--mono);font-size:11px;color:var(--mut)}
          .doc-hdr .qno .big{font-size:16px;color:var(--txt);font-weight:700;margin-bottom:2px}
          .meta{padding:16px 26px;border-bottom:1px solid var(--line);background:var(--panel2);
                display:grid;grid-template-columns:1fr 1fr;gap:6px 24px;font-size:12px}
          .meta .k{color:var(--mut);font-size:11px}
          .meta .v{font-family:var(--mono);color:var(--txt);font-weight:600}
          .sec{padding:18px 26px;border-bottom:1px solid var(--line)}
          .sec:last-of-type{border-bottom:none}
          .sec-ttl{font-size:11px;color:var(--blue);text-transform:uppercase;letter-spacing:.06em;
                   font-weight:800;margin-bottom:12px}
          table{width:100%;border-collapse:collapse;font-size:12px}
          th{text-align:left;color:var(--mut);font-weight:700;padding:9px 10px;
             border-bottom:1px solid var(--line);font-size:10px;text-transform:uppercase;letter-spacing:.05em}
          td{padding:11px 10px;border-bottom:1px solid var(--line);font-family:var(--mono);font-size:12px}
          tr:last-child td{border-bottom:none}
          td.r{text-align:right}td.c{text-align:center}td.b{font-weight:700}
          .pill{display:inline-block;padding:2px 8px;border-radius:4px;font-size:9px;font-weight:700;
                letter-spacing:.05em;text-transform:uppercase}
          .pill-fob{background:rgba(56,189,248,.15);color:var(--blue);border:1px solid rgba(56,189,248,.4)}
          .terms{padding:14px 26px;background:var(--panel2);color:var(--mut);font-size:11px;line-height:1.7}
          .terms .lbl{color:var(--blue);font-weight:700;font-size:10px;text-transform:uppercase;
                      letter-spacing:.05em;margin-bottom:4px;display:block}
          .terms ul{margin:0;padding-left:18px}
          .sig{padding:24px 26px;display:grid;grid-template-columns:1fr 1fr;gap:60px;
               border-top:1px solid var(--line);background:var(--panel2)}
          .sig div{border-top:1px solid var(--line2);padding-top:6px;font-size:10px;color:var(--mut);text-align:center}
          .sig div b{color:var(--txt);display:block;font-size:11px;margin-bottom:2px}
          .foot{padding:10px 26px;font-size:10px;color:var(--dim);text-align:center;
                font-style:italic;border-top:1px solid var(--line)}
          @media print{body{padding:0;background:#fff;color:#000}
            .doc{border:none;background:#fff;color:#000}
            .meta,.terms,.sig,.doc-hdr,.foot{background:#fff !important;color:#000 !important}
            .meta .k,.terms,.foot,.sig div{color:#444 !important}
            .meta .v,td,th,.doc-hdr h1,.doc-hdr .seller b{color:#000 !important}}
        </style>`;

        var issueDate = new Date().toISOString().slice(0,10).toUpperCase().replace(/-/g,' / ');
        var noteText = isSO
          ? "本海运单为运输确认凭证，仅供报关、提货使用。货物金额请参考 Commercial Invoice (IV)。"
          : "本海运报价确认基于上述航次。具体计费见 Freight Debit Note (DN)。Local charges 另行结算。";

        html=`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${esc(docTitleEN)} — ${esc(docNo)}</title>${CSS_SO}${ap?'<script>window.onload=function(){window.print()}<\/script>':''}</head>
<body><div class="wrap"><div class="doc">

  <div class="doc-hdr">
    <div>
      <h1>${esc(docTitleEN)}</h1>
      <div class="seller">
        <b>${esc(cfg3 && cfg3.nameEN || shipperX)}</b><br>
        ${esc(cfg3 && cfg3.address || "")}<br>
        Tel: ${esc(cfg3 && cfg3.tel || "")} · Email: ${esc(cfg3 && cfg3.email || "")}
      </div>
    </div>
    <div class="qno">
      <div class="big">${esc(docNo)}</div>
      <div>${esc(docTitle)}</div>
      <div>Issue date: ${esc(issueDate)}</div>
    </div>
  </div>

  <div class="meta">
    <div class="k">SHIPPER 发货方</div><div class="k">CONSIGNEE 收货方</div>
    <div class="v">${esc(shipperX)}</div>
    <div class="v">${esc(consigneeX)}</div>
    <div class="k" style="margin-top:6px">CARRIER 船公司</div><div class="k" style="margin-top:6px">FORWARDER 货代</div>
    <div class="v">${esc(carrierX)}</div>
    <div class="v">${esc(forwarderX)}</div>
    <div class="k" style="margin-top:6px">POL 起运港</div><div class="k" style="margin-top:6px">POD 目的港</div>
    <div class="v">${esc(polX)}</div>
    <div class="v">${esc(podX)}</div>
  </div>

  <div class="sec">
    <div class="sec-ttl">SHIPMENT 航次 · ${esc(blNoX)}</div>
    <table>
      <thead><tr>
        <th style="width:36px">NO.</th><th>Detail</th>
        <th class="c" style="width:90px">Container</th>
        <th class="r" style="width:120px">Value</th>
      </tr></thead>
      <tbody>
        <tr><td class="c">01</td><td>Vessel / Voyage</td><td class="c">${esc(ctnTypeX)}</td><td class="r b">${esc(vesselX)} ${esc(voyageX)}</td></tr>
        <tr><td class="c">02</td><td>B/L No.</td><td class="c">—</td><td class="r b">${esc(blNoX)}</td></tr>
        <tr><td class="c">03</td><td>Booking No.</td><td class="c">—</td><td class="r">${esc(bookingNoX)}</td></tr>
        <tr><td class="c">04</td><td>Container No. / Seal</td><td class="c">${esc(ctnTypeX)}</td><td class="r">${esc(cntrX)} / ${esc(sealX)}</td></tr>
        <tr><td class="c">05</td><td>ETD 预计开船 → ETA 预计到港</td><td class="c">—</td><td class="r"><b>${esc(etdX)}</b> → ${esc(etaX)}</td></tr>
        ${atdX !== "-" ? `<tr><td class="c">06</td><td>ATD 实际开船</td><td class="c">—</td><td class="r b" style="color:var(--emerald)">${esc(atdX)}</td></tr>` : ""}
      </tbody>
    </table>
  </div>

  <div class="sec">
    <div class="sec-ttl">CARGO 货物</div>
    <table>
      <thead><tr><th>项目 Item</th><th class="r">数量 Value</th></tr></thead>
      <tbody>
        <tr><td>总箱数 Total Cartons</td><td class="r b">${esc(totalCtnsX)}</td></tr>
        <tr><td>总毛重 Gross Weight</td><td class="r b">${esc(gwX)} KG</td></tr>
        <tr><td>总体积 CBM</td><td class="r b">${esc(cbmX)} m³</td></tr>
      </tbody>
    </table>
  </div>

  <div class="terms">
    <span class="lbl">NOTE</span>
    <ul><li>${esc(noteText)}</li>${isSO?'<li>本单据不含金额；如需查看商业金额请下载 Commercial Invoice (IV)。</li>':'<li>本运价不含金额，仅作运输安排确认；正式账单见 Freight Debit Note (DN)。</li>'}</ul>
  </div>

  <div class="sig">
    <div><b>SHIPPER ACKNOWLEDGED</b>(签字 / 盖章)</div>
    <div><b>CARRIER / AGENT</b>(签字 / 盖章)</div>
  </div>

  <div class="foot">⚡ Generated &amp; Verified by Sanlyn OS Supply Chain Engine · ${esc(issueDate)}</div>
</div></div></body></html>`;

        // 2026-05-19: SO/SQ Excel 导出支持
        _xlsCapture = {
          sheetName: isSO ? "Shipping Order" : "Freight Quote",
          docNo: docNo,
          buyer: consigneeX, date: issueDate, cno: sp.contract_no || "",
          curr: "", pol: polX, pod: podX, incoterm: "",
          poNo: sp.contract_no || "",
          seller: { nameEN: cfg3 && cfg3.nameEN || "", address: cfg3 && cfg3.address || "", tel: cfg3 && cfg3.tel || "", email: cfg3 && cfg3.email || "" },
          headers: ["NO.", "Item", "Detail"],
          rows: [
            { no: "01", item: "Vessel / Voyage",       detail: vesselX + " " + voyageX },
            { no: "02", item: "B/L No.",                detail: blNoX },
            { no: "03", item: "Booking No.",            detail: bookingNoX },
            { no: "04", item: "Container No. / Seal",   detail: cntrX + " / " + sealX },
            { no: "05", item: "ETD",                    detail: etdX },
            { no: "06", item: "ETA",                    detail: etaX },
            { no: "07", item: "ATD",                    detail: atdX },
            { no: "08", item: "Total Cartons",          detail: totalCtnsX },
            { no: "09", item: "Gross Weight (KG)",      detail: gwX },
            { no: "10", item: "CBM",                    detail: cbmX },
          ],
          colKeys: [
            { k: "no",     fn: function(r){return r.no;} },
            { k: "item",   fn: function(r){return r.item;} },
            { k: "detail", fn: function(r){return r.detail;} },
          ],
          totals: [],
        };
      }

      if(type==="tr"){
        var blNoTR=pick(sp.bl_no,spraw.blNo,spraw.bl_no,"");
        var cntrNo=pick(sp.container_no,spraw.containerNo,"");
        var consigneeTR=pick(sp.customer_en,sp.customer,spraw.consignee,"");
        var consAddrTR=pick(spraw.consigneeAddress,"");
        var shipperTR=cfg3.nameEN;
        var toParty=pick(sp.shipping_line,spraw.shippingLine,fwd.nameCN,"___________________________");

        var CSSTR=`<style>
          *{box-sizing:border-box;margin:0;padding:0}
          body{font-family:'SimSun','STSong','Noto Serif SC',serif;line-height:1.8;color:#000;padding:40px;background:#f0f0f0;}
          .page{max-width:800px;margin:auto;background:#fff;padding:40px;}
          .hdr{text-align:center;border-bottom:2px solid #000;margin-bottom:20px;padding-bottom:10px;}
          .hdr h1{margin:0;font-size:20px;font-weight:900;letter-spacing:2px;}
          .hdr p{margin:4px 0;font-size:11px;color:#666;}
          .title{text-align:center;font-size:20px;font-weight:700;margin:20px 0;text-decoration:underline;letter-spacing:1px;}
          .to-line{margin-bottom:18px;font-size:13px;}
          table{width:100%;border-collapse:collapse;margin-bottom:20px;}
          td{padding:7px 10px;border:1px solid #ccc;vertical-align:top;font-size:12px;}
          .lbl{font-weight:700;width:150px;background:#f5f5f5;}
          .clauses{font-size:13px;text-align:justify;margin-bottom:30px;}
          .clauses p{margin:10px 0;text-indent:2em;}
          .footer{display:flex;justify-content:space-between;margin-top:50px;align-items:flex-end;}
          .sig-left{flex:1;}
          .sig-left p{margin-bottom:8px;font-size:12px;}
          .sig-line{border-bottom:1px solid #000;height:40px;margin-bottom:8px;}
          .stamp-box{width:150px;height:150px;border:1px dashed #999;display:flex;align-items:center;justify-content:center;color:#aaa;font-size:12px;text-align:center;line-height:1.6;}
          @media print{body{background:#fff;padding:0;}.page{max-width:100%;}}
        </style>`;

        html=`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>电放申请书 — ${esc(blNoTR||soNo)}</title>${CSSTR}${ap?'<script>window.onload=function(){window.print()}<\/script>':""}</head><body><div class="page">
          <div class="hdr">
            <h1>${esc(shipperTR)}</h1>
            <p>${esc(cfg3.address)} | Tel: ${esc(cfg3.tel)}</p>
          </div>
          <div class="title">电放申请书暨保函 (TELEX RELEASE LETTER OF GUARANTEE)</div>
          <p class="to-line">致 (To): <b>${esc(toParty)}</b></p>
          <table>
            <tr>
              <td class="lbl">提单号 (B/L NO.)</td><td>${esc(blNoTR)||"&nbsp;"}</td>
              <td class="lbl">船名航次 (VSL/VOY)</td><td>${esc(vessel)} / ${esc(voyage)}</td>
            </tr>
            <tr>
              <td class="lbl">起运港 (POL)</td><td>${esc(polSp)}</td>
              <td class="lbl">目的港 (POD)</td><td>${esc(podSp)}</td>
            </tr>
            <tr>
              <td class="lbl">箱号 (CNTR NO.)</td><td colspan="3">${esc(cntrNo)||"&nbsp;"}</td>
            </tr>
            <tr>
              <td class="lbl">收货人 (Consignee)</td>
              <td colspan="3"><b>${esc(consigneeTR)}</b>${consAddrTR?" — "+esc(consAddrTR):""}</td>
            </tr>
          </table>
          <div class="clauses">
            <p>我司作为上述货物的发货人，现请求贵司在不提交正本提单的情况下，凭收货人身份证明将货物放给上述收货人。为此，我司特此承诺：</p>
            <p>1. 我司承担由此产生的所有法律责任、赔偿、诉讼费、利息及相关损失，并保证贵司免受任何损失。<br><span style="color:#555;font-size:12px">(We hereby undertake to indemnify you against all consequences, liabilities, losses, damages, costs and expenses of whatsoever nature arising from this release.)</span></p>
            <p>2. 我司保证已收回或未签发全套正本提单，不存在正本提单在外流通之情形。<br><span style="color:#555;font-size:12px">(We guarantee that the full set of original B/Ls has been surrendered or was never issued and is not in circulation.)</span></p>
            <p>3. 本保函受中华人民共和国法律管辖，如发生纠纷，提交相关海事法院解决。<br><span style="color:#555;font-size:12px">(This guarantee shall be governed by the laws of the PRC. Any disputes shall be submitted to the competent maritime court.)</span></p>
          </div>
          <div class="footer">
            <div class="sig-left">
              <p>申请公司 (Shipper): <b>${esc(shipperTR)}</b></p>
              <div class="sig-line"></div>
              <p>授权代表签字 (Authorized Signature): ____________________</p>
              <p>日期 (Date): ${fmtD(new Date())}</p>
            </div>
            <div class="stamp-box">此处加盖公章<br>(Company Stamp)</div>
          </div>
        </div></body></html>`;
      }
    }

    // ── Excel export (format=xlsx) ─────────────────────────────────────────────
    if(format==="xlsx" && !_xlsCapture){
      return res.status(400).json({error:"xlsx_not_supported_for_type",type:type});
    }
    if(format==="xlsx" && _xlsCapture){
      var ExcelJS=(await import("exceljs")).default;
      var wb=new ExcelJS.Workbook();
      wb.creator="Sanlyn OS"; wb.created=new Date();
      var ws=wb.addWorksheet(_xlsCapture.sheetName||_xlsCapture.docNo);
      var _sel=_xlsCapture.seller||{};

      // ── 外贸 (foreign-trade) header: title + Shipper/Consignee + meta ─────
      // FOREIGN-TRADE-XLSX-2026-05-20 (per Damon, ref Smartsheet CI template):
      // company name (L) + doc title (R), then Shipper/Consignee two-block, then
      // compact meta row. Table/totals/banking/signatures below are unchanged.
      var _LC=(_xlsCapture.headers||[]).length||5;  // 5 for IV, 7 for PL
      var _CL=function(n){var s="";while(n>0){var m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26);}return s;};
      var _lc=_CL(_LC), _half=Math.max(1,Math.floor(_LC/2));
      var _NAVY="FF1F3A5F",_GREY="FF8A94A6",_DARK="FF1A1A1A",_LIGHT="FFEEF2F7",_LINE="FFC8D0DA";
      var _thin={style:"thin",color:{argb:_LINE}}, _bd={top:_thin,bottom:_thin,left:_thin,right:_thin};

      // Title band — company name left, doc title right
      ws.mergeCells("A1:"+_CL(Math.max(1,_LC-2))+"2");
      ws.getCell("A1").value=(_sel.nameEN||"SANLYN").toUpperCase();
      ws.getCell("A1").font={bold:true,size:11,color:{argb:_DARK}};ws.getCell("A1").alignment={vertical:"middle"};
      ws.mergeCells("A3:"+_CL(Math.max(1,_LC-2))+"3");
      ws.getCell("A3").value=_sel.address||"";ws.getCell("A3").font={size:8,color:{argb:_GREY}};
      ws.mergeCells(_CL(_LC-1)+"1:"+_lc+"2");
      var _tc=ws.getCell(_CL(_LC-1)+"1");_tc.value=(_xlsCapture.sheetName||"").toUpperCase();_tc.font={bold:true,size:12,color:{argb:_NAVY}};_tc.alignment={horizontal:"right",vertical:"middle"};
      ws.mergeCells(_CL(_LC-1)+"3:"+_lc+"3");
      var _dn=ws.getCell(_CL(_LC-1)+"3");_dn.value="No. "+_xlsCapture.docNo;_dn.font={size:8.5,color:{argb:_GREY}};_dn.alignment={horizontal:"right"};
      ws.getRow(1).height=15;ws.getRow(2).height=2;ws.getRow(3).height=13;
      // navy rule (row 4)
      for(var _c4=1;_c4<=_LC;_c4++)ws.getCell(4,_c4).fill={type:"pattern",pattern:"solid",fgColor:{argb:_NAVY}};
      ws.getRow(4).height=2;

      // Shipper / Consignee two-block (rows 5-8)
      function _ptitle(rr,c1,c2,txt){ws.mergeCells(rr,c1,rr,c2);var cc=ws.getCell(rr,c1);cc.value=txt;cc.font={bold:true,size:8,color:{argb:"FFFFFFFF"}};cc.fill={type:"pattern",pattern:"solid",fgColor:{argb:_NAVY}};cc.alignment={vertical:"middle"};}
      _ptitle(5,1,_half,"SHIPPER / EXPORTER");_ptitle(5,_half+1,_LC,"CONSIGNEE");ws.getRow(5).height=14;
      function _pbody(r0,c1,c2,nm,ad){ws.mergeCells(r0,c1,r0,c2);ws.getCell(r0,c1).value=nm;ws.getCell(r0,c1).font={bold:true,size:8.5,color:{argb:_DARK}};ws.mergeCells(r0+1,c1,r0+2,c2);var ac=ws.getCell(r0+1,c1);ac.value=ad;ac.font={size:8,color:{argb:_DARK}};ac.alignment={wrapText:true,vertical:"top"};}
      _pbody(6,1,_half,(_sel.nameEN||""),(_sel.address||""));
      _pbody(6,_half+1,_LC,(_xlsCapture.buyer||""),(_xlsCapture.buyerAddr||""));
      ws.getRow(7).height=22;
      for(var _rr=5;_rr<=8;_rr++)for(var _cc2=1;_cc2<=_LC;_cc2++)ws.getCell(_rr,_cc2).border=_bd;

      // Compact meta row (row 9) — Date / Contract / Currency / Terms / POL / POD
      var _meta=[["Date:",_xlsCapture.date],["Contract:",_xlsCapture.cno],["Currency:",_xlsCapture.curr],["Terms:",_xlsCapture.incoterm],["POL:",_xlsCapture.pol],["POD:",_xlsCapture.pod]];
      _meta.slice(0,_LC).forEach(function(kv,i){
        var cc=ws.getCell(9,i+1);
        cc.value={richText:[{text:kv[0]+" ",font:{bold:true,size:8,color:{argb:_GREY}}},{text:String(kv[1]||""),font:{size:8.5,color:{argb:_DARK}}}]};
        cc.fill={type:"pattern",pattern:"solid",fgColor:{argb:_LIGHT}};cc.border=_bd;cc.alignment={vertical:"middle"};
      });
      ws.getRow(9).height=14;
      ws.addRow([]);

      // Header
      var hdrRow=ws.addRow(_xlsCapture.headers);
      hdrRow.eachCell(function(c){c.font={bold:true,color:{argb:"FFFFFFFF"}};c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF111111"}};c.alignment={horizontal:"center",vertical:"middle"};c.border={top:{style:"thin",color:{argb:"FF999999"}},bottom:{style:"thin",color:{argb:"FF999999"}},left:{style:"thin",color:{argb:"FFCCCCCC"}},right:{style:"thin",color:{argb:"FFCCCCCC"}}};});hdrRow.height=20;
      ws.getColumn(1).width=6;
      ws.getColumn(2).width=46;
      ws.getColumn(2).alignment={wrapText:true,vertical:"top"};

      // Data rows
      var rowNum=0;
      var lastGrp="";
      _xlsCapture.rows.forEach(function(p){
        // Group header
        var grp=p._groupKey||"";
        if(grp&&grp!==lastGrp){
          var gRow=ws.addRow(["","ORDER "+(p._customerPO||"")+(p._containerNo?" · "+p._containerNo:"")+(p._contractNo?" · "+p._contractNo:"")]);
          gRow.eachCell(function(c){c.font={bold:true,color:{argb:"FF1e40af"}};c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFe8eeff"}};});
          ws.mergeCells("B"+gRow.number+":F"+gRow.number);
          lastGrp=grp;
        }
        rowNum++;
        var cells=[String(rowNum).padStart(2,"0")];
        _xlsCapture.colKeys.forEach(function(k){
          var v=k.fn?k.fn(p):(p[k.k]||"");
          // Strip commas from numbers
          var n=parseFloat(String(v).replace(/,/g,""));
          cells.push(isNaN(n)?v:n);
        });
        var dr=ws.addRow(cells);
        var _alt=(rowNum%2===0);
        dr.eachCell(function(c,ci){
          c.border={top:{style:"hair",color:{argb:"FFDDDDDD"}},bottom:{style:"hair",color:{argb:"FFDDDDDD"}},left:{style:"hair",color:{argb:"FFEEEEEE"}},right:{style:"hair",color:{argb:"FFEEEEEE"}}};
          var h=(ci===1)?"center":(ci===2)?"left":"right";
          // ALIGN-FIX-2026-05-20: keep vertical:middle for ALL cells incl. numeric
          // (the old override loop dropped it → numbers floated to bottom).
          c.alignment={horizontal:h,vertical:"middle",wrapText:(ci===2)};
          if(!c.font)c.font={size:10};
          if(_alt)c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFFAFAFA"}};
        });
      });

      // Totals row
      ws.addRow([]);
      var tRow=ws.addRow(_xlsCapture.totals);
      tRow.eachCell(function(c,ci){c.font={bold:true};if(ci===tRow.cellCount)c.numFmt="#,##0.00";});

      // Column widths for numeric cols
      for(var ci=3;ci<=_xlsCapture.headers.length;ci++) ws.getColumn(ci).width=16;

      // ── Footer: Incoterm / Terms & Conditions / Banking / Signatures ─────
      var _lastCol=_xlsCapture.headers.length; // e.g. 5 for SC/IV/PI, 6 for PL
      var _colLetter=function(n){var s="";while(n>0){var m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26);}return s;};
      var _lastColL=_colLetter(_lastCol);

      function _stripCN(t){var s=String(t||"");if(s.indexOf("/")>=0)s=s.split("/").pop();return s.replace(/[\u4e00-\u9fff:：]/g,"").trim();}
      function _addSectionTitle(title){
        ws.addRow([]);
        var r=ws.addRow([title]);
        ws.mergeCells("A"+r.number+":"+_lastColL+r.number);
        r.getCell(1).font={bold:true,size:11,color:{argb:"FFFFFFFF"}};
        r.getCell(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF111111"}};
        r.getCell(1).alignment={horizontal:"left",vertical:"middle"};
        r.height=18;
      }
      function _addKV(label,value){
        var r=ws.addRow([label,value]);
        r.getCell(1).font={bold:true,size:10};
        r.getCell(2).font={size:10};
        ws.mergeCells("B"+r.number+":"+_lastColL+r.number);
      }
      function _addNote(text,color){
        var r=ws.addRow([text]);
        ws.mergeCells("A"+r.number+":"+_lastColL+r.number);
        r.getCell(1).font={italic:true,size:9,color:{argb:color||"FF888888"}};
      }

      // Incoterm line (small, right under totals)
      if(_xlsCapture.incoterm){
        ws.addRow([]);
        var rInco=ws.addRow(["Trade Terms:","("+_xlsCapture.incoterm+") Incoterms® 2020"]);
        rInco.getCell(1).font={bold:true,size:10};
        rInco.getCell(2).font={size:10};
        ws.mergeCells("B"+rInco.number+":"+_lastColL+rInco.number);
      }

      // Terms & Conditions
      if(Array.isArray(_xlsCapture.terms)&&_xlsCapture.terms.length){
        _addSectionTitle("TERMS & CONDITIONS");
        _xlsCapture.terms.forEach(function(t,i){
          var line=(i+1)+". "+_stripCN(t);
          var r=ws.addRow([line]);
          ws.mergeCells("A"+r.number+":"+_lastColL+r.number);
          r.getCell(1).alignment={wrapText:true,vertical:"top"};
          r.getCell(1).font={size:10};
        });
      }

      // Banking Information
      var bk=_xlsCapture.bank;
      if(bk&&(bk.beneficiary||bk.accountName||bk.bankName||bk.swift)){
        _addSectionTitle("BANKING INFORMATION");
        _addKV("Beneficiary:",bk.beneficiary||bk.accountName||"");
        if(bk.bankName)   _addKV("Bank:",bk.bankName);
        if(bk.swift)      _addKV("SWIFT:",bk.swift);
        if(bk.bankAddr)   _addKV("Bank Address:",bk.bankAddr);
        if(bk.usdAccount) _addKV("Account No.:",bk.usdAccount);
        _addNote("* Please verify bank info before payment.","FFCC0000");
      }

      // Signatures
      ws.addRow([]);ws.addRow([]);
      var sigMid=Math.max(2,Math.ceil(_lastCol/2));
      var sigR1=ws.addRow([]);
      // Draw top border across two halves as signature lines
      for(var _ci=1;_ci<=_lastCol;_ci++){
        sigR1.getCell(_ci).border={top:{style:"medium",color:{argb:"FF000000"}}};
      }
      var sigR2=ws.addRow([]);
      sigR2.getCell(1).value="BUYER AUTHORIZED SIGNATURE";
      sigR2.getCell(sigMid+1).value="SELLER AUTHORIZED SIGNATURE";
      ws.mergeCells("A"+sigR2.number+":"+_colLetter(sigMid)+sigR2.number);
      ws.mergeCells(_colLetter(sigMid+1)+sigR2.number+":"+_lastColL+sigR2.number);
      sigR2.getCell(1).font={bold:true,size:10};
      sigR2.getCell(sigMid+1).font={bold:true,size:10};
      sigR2.getCell(1).alignment={horizontal:"center"};
      sigR2.getCell(sigMid+1).alignment={horizontal:"center"};
      var sigR3=ws.addRow([]);
      sigR3.getCell(1).value="(Signature / Company Seal)";
      sigR3.getCell(sigMid+1).value="(Signature / Company Seal)";
      ws.mergeCells("A"+sigR3.number+":"+_colLetter(sigMid)+sigR3.number);
      ws.mergeCells(_colLetter(sigMid+1)+sigR3.number+":"+_lastColL+sigR3.number);
      sigR3.getCell(1).font={size:9,color:{argb:"FF888888"}};
      sigR3.getCell(sigMid+1).font={size:9,color:{argb:"FF888888"}};
      sigR3.getCell(1).alignment={horizontal:"center"};
      sigR3.getCell(sigMid+1).alignment={horizontal:"center"};
      // Give space for stamps
      ws.addRow([]);ws.addRow([]);ws.addRow([]);

      res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
      res.setHeader("Content-Disposition","attachment; filename=\""+_xlsCapture.docNo+".xlsx\"");
      res.setHeader("Cache-Control","no-store");
      var buf=await wb.xlsx.writeBuffer();
      return res.status(200).send(Buffer.from(buf));
    }
    // ── PDF export (format=pdf) — puppeteer renders HTML → PDF buffer ────────
    if(format==="pdf"){
      try{
        var puppeteer=(await import("puppeteer")).default;
        // Prefer system Chrome (lighter than Puppeteer's bundled Chromium).
        // /usr/bin/google-chrome is installed on the API server; env override for other hosts.
        var chromePath=process.env.CHROME_PATH||process.env.PUPPETEER_EXECUTABLE_PATH||"/usr/bin/google-chrome";
        var launchOpts={
          headless:"new",
          args:["--no-sandbox","--disable-setuid-sandbox","--disable-dev-shm-usage",
                "--disable-gpu","--disable-software-rasterizer"],
        };
        try{
          var fs=await import("fs");
          if(fs.existsSync(chromePath)) launchOpts.executablePath=chromePath;
        }catch(_){}
        var browser=await puppeteer.launch(launchOpts);
        var page=await browser.newPage();
        // Pass HTML directly — no circular HTTP request needed
        await page.setContent(html,{waitUntil:"networkidle0"});
        var pdfBuf=await page.pdf({
          format:"A4",
          printBackground:true,
          margin:{top:"14mm",bottom:"14mm",left:"12mm",right:"12mm"},
        });
        await browser.close();
        // Infer a filename from the html (grab first <title> tag)
        var titleMatch=html.match(/<title[^>]*>([^<]+)<\/title>/i);
        var pdfName=(titleMatch?titleMatch[1].replace(/[^A-Za-z0-9_\-\.]/g,"_"):"document")+".pdf";
        res.setHeader("Content-Type","application/pdf");
        res.setHeader("Content-Disposition","attachment; filename=\""+pdfName+"\"");
        res.setHeader("Cache-Control","no-store");
        return res.status(200).send(Buffer.from(pdfBuf));
      }catch(pdfErr){
        console.error("[documents] puppeteer PDF error:",pdfErr.message);
        // Return JSON error so frontend can fall back to print=1 instead of
        // tricking the browser into saving HTML with a .pdf extension
        res.setHeader("Content-Type","application/json");
        return res.status(503).json({error:"pdf_render_unavailable",detail:pdfErr.message});
      }
    }
    // ──────────────────────────────────────────────────────────────────────────

    if(!html) return res.status(400).send("<h1>Unknown type: "+esc(type)+"</h1>");
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.setHeader("Cache-Control","no-store");
    return res.status(200).send(html);
  }catch(err){
    return res.status(500).send("<h1>Error: "+esc(err.message)+"</h1>");
  }
}
