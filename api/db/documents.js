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
async function loadSellerCfg(pool, raw, qco) {
  var code = qco || "";
  if(!code){ var h=(raw.issuingCompanyEN||raw.issuingCompany||"").toLowerCase(); if(h.includes("sanlyn"))code="sanlyn"; }
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

var CSS=`<style>
body{font-family:'Helvetica','Arial','PingFang SC',sans-serif;color:#000;margin:0;padding:30px;font-size:11px;line-height:1.4;}
.container{max-width:800px;margin:auto;}
.header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:15px;margin-bottom:25px;}
.seller-info{flex:1;}
.seller-name{font-weight:900;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:5px;}
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
</style>`;

function wrap(title,body,ap){return`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(title)}</title>${CSS}${ap?'<script>window.onload=function(){window.print()}<\/script>':""}</head><body><div class="container">${body}<div class="brand-slogan">⚡ Generated &amp; Verified by <b>Sanlyn OS Supply Chain Engine</b></div></div></body></html>`;}

function sellerNamePx(name){ var l=(name||"").length; return l<=28?"20px":l<=38?"17px":l<=48?"14px":"12px"; }
// audience: 'customs' → red 报关用 badge; 'customer' → blue 客户存档 badge; '' → no badge
function audienceBadge(audience) {
  if (audience === "customs") {
    return `<div style="display:inline-block;margin-top:4px;padding:3px 10px;border-radius:4px;background:#fee2e2;color:#991b1b;border:1.5px solid #dc2626;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;">FOR CUSTOMS USE · 报关专用</div>`;
  }
  if (audience === "customer") {
    return `<div style="display:inline-block;margin-top:4px;padding:3px 10px;border-radius:4px;background:#dbeafe;color:#1e3a8a;border:1.5px solid #2563eb;font-size:10px;font-weight:800;letter-spacing:.06em;text-transform:uppercase;">CUSTOMER COPY · 客户存档</div>`;
  }
  return "";
}
function docHdr(cfg,cn,en,audience){return`<div class="header"><div class="seller-info"><div class="seller-name" style="font-size:${sellerNamePx(cfg.nameEN)}">${esc(cfg.nameEN)}</div><p style="margin:2px 0">${esc(cfg.address)}</p><p style="margin:2px 0">Tel: ${esc(cfg.tel)} | Email: ${esc(cfg.email)}</p></div><div class="doc-type"><h1>${esc(en)}</h1>${audienceBadge(audience)}</div></div>`;}

function buyerBlock(cust,addr,tel,docNo,noLbl,ordNo,date,curr){return`<div class="meta-grid"><div><div class="section-label">BUYER (BILL TO)</div><p style="font-size:13px;font-weight:bold;margin:0">${esc(cust)||"[BUYER]"}</p><p style="margin:5px 0">${esc(addr)||"[ADDRESS]"}</p>${tel?`<p style="margin:2px 0">Tel: ${esc(tel)}</p>`:""}</div><div><div class="section-label">DETAILS</div><ul class="meta-list"><li><b>${esc(noLbl||"No.")}:</b> ${esc(docNo)}</li><li><b>Order:</b> ${esc(ordNo)}</li><li><b>Date:</b> ${esc(date)}</li>${curr?`<li><b>Currency:</b> ${esc(curr)}</li>`:""}</ul></div></div>`;}

function portBar(pol,pod,terms){return`<div class="trade-terms-bar"><span>POL: ${esc(pol)||"-"}</span><span>POD: ${esc(pod)||"-"}</span><span>Terms: ${esc(terms)||"-"} (Incoterms® 2020)</span></div>`;}

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

function sigBlock(){return`<div class="signature-grid"><div class="sig-box"><span>BUYER AUTHORIZED SIGNATURE</span><span style="font-weight:normal;font-size:9px">(Signature / Company Seal)</span></div><div class="sig-box"><span>SELLER AUTHORIZED SIGNATURE</span><span style="font-weight:normal;font-size:9px">(Signature / Company Seal)</span></div></div>`;}

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
      var r2 = await pool.query(
        "SELECT sku, hs_code, declaration_name, declaration_elements," +
        " bl_description, net_weight, gross_weight, cbm, carton_qty AS inner_qty, NULL AS inner_unit," +
        " barcode, factory_name" +
        " FROM products WHERE barcode = ANY($1::text[]) AND active = true",
        [barcodes]
      );
      r2.rows.forEach(function(row) { if (row.barcode) bcMap[row.barcode] = row; if (row.sku && !masterMap[row.sku]) masterMap[row.sku] = row; });
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

  var{type,id,ids,company:qco,print:ap,format,contract_no,bl_no,limit,audience:_audReq}=req.query;
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

    if(["sc","iv","pl","po","pi"].includes(type)){
      var oR=await pool.query("SELECT * FROM orders WHERE _id=$1 OR contract_no=$1 OR customer_po=$1 LIMIT 1",[id]);
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
      var date=fmtD(pick(o.delivery_date,o.created_at));
      var curr=pick(raw.currency,o.currency,"USD");
      var pol=pick(raw.pol,raw.portOfLoading,"-");
      var pod=pick(raw.destination,raw.pod,raw.destinationPort,"-");
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
      var _xlsCapture=null; // populated by sc/iv/pl blocks for xlsx export
      var tot=getTotal(prods,o);
      var tqty=prods.reduce(function(s,p){return s+Number(p.qty||0);},0)||Number(raw.totalQty||0);
      // GW/NW in products are PER-CARTON values — must multiply by qty for totals.
      var tgw=prods.reduce(function(s,p){return s+Number(p.grossWeight||p.gw||0)*Number(p.qty||0);},0)||Number(raw.grossWeight||0);
      var tnw=prods.reduce(function(s,p){return s+Number(p.netWeight||p.nw||0)*Number(p.qty||0);},0)||Number(raw.netWeight||0);

      var totRow=`<tr class="total-row"><td colspan="3" class="text-right" style="color:#555;font-size:11px;">TOTAL AMOUNT (${esc(curr)}):</td><td colspan="2" class="text-right" style="font-size:16px;font-weight:800;">${fmtM(tot)}</td></tr>`;

      if(type==="sc"){
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
        html=wrap((ordNo||no)+"_SC",`
          ${docHdr(cfg,"销售合同","SALES CONTRACT",audience)}
          ${buyerBlock(cust,caddr,ctel,no,"Contract No.",ordNo,date,curr)}
          ${portBar(pol,pod,inco)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsSC.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsSC,curr)}${totRow}</tbody></table>
          <div class="details-grid">${termsCard(cfg.terms.sc)}${bankCard(cfg.bank,curr)}</div>${sigBlock()}`,ap);
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

      if(type==="iv"){
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
        html=wrap((ordNo||noIV)+"_IV",`
          ${docHdr(cfg,"商业发票","COMMERCIAL INVOICE",audience)}
          ${buyerBlock(cust,caddr,ctel,noIV,"Invoice No.",ordNo,date,curr)}
          ${portBar(pol,pod,inco)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsIV.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsIV,curr)}${totRow}</tbody></table>
          <div class="details-grid">${termsCard(cfg.terms.iv)}${bankCard(cfg.bank,curr)}</div>${sigBlock()}`,ap);
        _xlsCapture={sheetName:"Invoice",docNo:(ordNo||noIV)+"_IV",buyer:cust,date:date,cno:cno,curr:curr,pol:pol,pod:pod,incoterm:inco,poNo:ordNo,seller:{nameEN:cfg.nameEN,address:cfg.address,tel:cfg.tel,email:cfg.email},terms:cfg.terms.iv,bank:cfg.bank,
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

      if(type==="pl"){
        var noPL=cno.split(" / ").map(function(c){return c.replace(/[^A-Z0-9-]/gi,"").slice(0,20);}).join(" / ");
        var tcbmPL=prods.reduce(function(s,p){return s+Number(p.cbm||p.volume||0);},0)||Number(raw.totalCBM||raw.cbm||0);
        var colsPL=[
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
          {k:"qty",al:"center",w:"55px",lbl:"QTY"},
          {k:"gw",al:"right",w:"75px",fn:function(p){var pg=Number(p.grossWeight||p.gw||0);var q=Number(p.qty||0);return fmtM(pg*q||pg);},lbl:"G.W (KG)"},
          {k:"nw",al:"right",w:"75px",fn:function(p){var pn=Number(p.netWeight||p.nw||0);var q=Number(p.qty||0);return fmtM(pn*q||pn);},lbl:"N.W (KG)"},
          {k:"cbm",al:"right",w:"65px",fn:function(p){return fmtM(p.cbm||p.volume||0,3);},lbl:"CBM"},
        ];
        html=wrap((ordNo||noPL)+"_PL",`
          ${docHdr(cfg,"装箱单","PACKING LIST",audience)}
          ${buyerBlock(cust,caddr,ctel,noPL,"P/L No.",ordNo,date,null)}
          ${portBar(pol,pod,inco)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsPL.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsPL,curr)}
          <tr class="total-row"><td colspan="2" class="text-right" style="color:#555;font-size:11px">SHIPPING MARKS: N/M &nbsp;&nbsp; Total:</td><td style="text-align:center">${fmtM(tqty,0)}</td><td class="text-right">${fmtM(tgw)}</td><td class="text-right">${fmtM(tnw)}</td><td class="text-right">${fmtM(tcbmPL,3)}</td></tr>
          </tbody></table>${sigBlock()}`,ap);
        _xlsCapture={sheetName:"Packing List",docNo:(ordNo||noPL)+"_PL",buyer:cust,date:date,cno:cno,curr:"",pol:pol,pod:pod,incoterm:inco,poNo:ordNo,seller:{nameEN:cfg.nameEN,address:cfg.address,tel:cfg.tel,email:cfg.email},
          headers:["NO.","Description & Size","QTY","G.W (KG)","N.W (KG)","CBM"],
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
          }},{k:"qty",fn:function(p){return Number(p.qty)||0;}},{k:"gw",fn:function(p){var pg=Number(p.grossWeight||p.gw||0);var q=Number(p.qty||0);return parseFloat((pg*q||pg).toFixed(2))||0;}},{k:"nw",fn:function(p){var pn=Number(p.netWeight||p.nw||0);var q=Number(p.qty||0);return parseFloat((pn*q||pn).toFixed(2))||0;}},{k:"cbm",fn:function(p){return parseFloat(Number(p.cbm||p.volume||0).toFixed(3))||0;}}],
          rows:prods,totals:["","TOTAL",tqty,parseFloat(tgw.toFixed(2)),parseFloat(tnw.toFixed(2)),parseFloat(tcbmPL.toFixed(3))]};
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
        html=wrap((ordNo||noPI)+"_PI",`
          ${docHdr(cfg,"","PROFORMA INVOICE")}
          ${buyerBlock(cust,caddr,ctel,noPI,"PI No.",ordNo,date,curr)}
          ${portBar(pol,pod,inco)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsPI.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsPI,curr)}${totRow}</tbody></table>
          <div class="details-grid">${termsCard(cfg.terms.iv)}${bankCard(cfg.bank,curr)}</div>${sigBlock()}`,ap);
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

    if(["so","debit"].includes(type)){
      var spR=await pool.query("SELECT * FROM shipping_plans WHERE _id=$1 OR shipment_no=$1 LIMIT 1",[id]);
      if(!spR.rows.length) return res.status(404).send("<h1>Shipment not found: "+esc(id)+"</h1>");
      var sp=spR.rows[0], spraw=sp.raw||{};
      if(typeof spraw==="string")try{spraw=JSON.parse(spraw);}catch(e){spraw={};}
      var cfg3=await loadSellerCfg(pool,spraw,qco);
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
        var dbNo="DB-"+soNo;

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
          .details-grid{display:grid;grid-template-columns:1fr 1fr;gap:30px;margin-top:10px;}
          .details-box{border:1px solid #000;padding:12px;}
          .details-box h4{margin:0 0 10px 0;font-size:11px;text-transform:uppercase;text-decoration:underline;}
          .sig-row{display:flex;justify-content:space-between;margin-top:50px;}
          .sig-b{width:45%;border-top:2px solid #000;padding-top:10px;text-align:center;height:80px;font-weight:700;display:flex;flex-direction:column;justify-content:space-between;}
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
            <div class="doc-type"><h1>借记通知单</h1><p>DEBIT NOTE</p></div>
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

      // ── Seller letterhead ─────────────────────────────────────────────
      ws.mergeCells("A1:F1");
      ws.getCell("A1").value=(_sel.nameEN||"SANLYN").toUpperCase();
      ws.getCell("A1").font={bold:true,size:16,color:{argb:"FF111111"}};
      ws.getCell("A1").alignment={horizontal:"center",vertical:"middle"};
      ws.getRow(1).height=26;

      ws.mergeCells("A2:F2");
      ws.getCell("A2").value=_sel.address||"";
      ws.getCell("A2").font={size:10,color:{argb:"FF555555"}};
      ws.getCell("A2").alignment={horizontal:"center"};

      ws.mergeCells("A3:F3");
      ws.getCell("A3").value="Tel: "+(_sel.tel||"")+"    Email: "+(_sel.email||"");
      ws.getCell("A3").font={size:10,color:{argb:"FF555555"}};
      ws.getCell("A3").alignment={horizontal:"center"};

      // Divider
      ws.getRow(4).height=4;
      ws.mergeCells("A4:F4");
      ws.getCell("A4").fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF111111"}};

      // Doc title
      ws.mergeCells("A5:F5");
      ws.getCell("A5").value=(_xlsCapture.sheetName||"").toUpperCase()+" — "+_xlsCapture.docNo;
      ws.getCell("A5").font={bold:true,size:13};
      ws.getCell("A5").alignment={horizontal:"center"};
      ws.getRow(5).height=22;

      // Meta rows
      ws.addRow([]);
      ws.addRow(["Buyer:",_xlsCapture.buyer,"","Date:",_xlsCapture.date]);
      ws.addRow(["Contract No.:",_xlsCapture.cno,"","Currency:",_xlsCapture.curr]);
      ws.addRow(["PO No.:",_xlsCapture.poNo||"","","",""]);
      ws.addRow(["POL:",_xlsCapture.pol,"","POD:",_xlsCapture.pod]);
      ws.addRow([]);

      // Header
      var hdrRow=ws.addRow(_xlsCapture.headers);
      hdrRow.eachCell(function(c){c.font={bold:true,color:{argb:"FFFFFFFF"}};c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF111111"}};c.alignment={horizontal:"center"};});
      ws.getColumn(1).width=6;
      ws.getColumn(2).width=52;

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
        dr.getCell(1).alignment={horizontal:"center"};
        // Right-align numeric columns
        for(var ci=2;ci<=cells.length;ci++){
          if(typeof cells[ci-1]==="number") dr.getCell(ci).alignment={horizontal:"right"};
        }
        // Alternate row fill
        if(rowNum%2===0) dr.eachCell(function(c){c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFFAFAFA"}};});
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
