// doc-helpers.js — HTML building helpers for document rendering
// CSS is defined in doc-css.js and re-exported from here
import { CSS } from "./doc-css.js";
export { CSS };

export function esc(s){ if(!s)return""; return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
export function fmtM(v,d){ if(v===null||v===undefined||v==="")return"-"; var n=Number(v); if(isNaN(n))return String(v); return n.toLocaleString("en-US",{minimumFractionDigits:d!==undefined?d:2,maximumFractionDigits:d!==undefined?d:2}); }
export function fmtD(v){ if(!v)return"-"; try{return new Date(v).toISOString().slice(0,10);}catch(e){return String(v);} }
export function pick(){ for(var i=0;i<arguments.length;i++){if(arguments[i]!==null&&arguments[i]!==undefined&&arguments[i]!=="")return arguments[i];} return ""; }

// resolveCo replaced by async loadSellerCfg above

export var CUST_ADDRS={
  "petsome":"LOT 1716, JALAN SG LONG, BATU 11, SG LONG, 43000 KAJANG, SELANGOR, MALAYSIA",
  "dibaq":"LOT 1716, JALAN SG LONG, BATU 11, SG LONG, 43000 KAJANG, SELANGOR, MALAYSIA",
  "enrich":"NO.2 JALAN PERDANA 1A, TAMAN SEGAR PERDANA, 43200 CHERAS, SELANGOR, MALAYSIA",
};
export function resolveAddr(name,existing){
  if(existing&&existing.trim()&&existing.trim().length>3)return existing;
  var k=(name||"").toLowerCase();
  for(var key in CUST_ADDRS){if(k.includes(key))return CUST_ADDRS[key];}
  return existing||"";
}
export function resolveUnitPrice(p){
  var up=p.unitPrice||p.price||p.unit_price||p.salePrice||p["_widget_1764396068577"]||0;
  if((!up||Number(up)===0)&&(p.subtotal||p.amount)&&p.qty&&Number(p.qty)>0){
    up=Number(p.subtotal||p.amount||0)/Number(p.qty);
  }
  return up;
}

// 2026-05-19 — header restyle (Damon request, see /tmp/pl-header-v2-preview.html):
//   light gray info-bar, smaller seller name, bilingual title, doc-ref moved to footer,
//   header height compressed ~140px (was ~280).

// 2026-05-19: docRef = optional footer reference (Doc No + Issue date), moved from header
export function wrap(title,body,ap){return`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(title)}</title>${CSS}${ap?'<script>window.onload=function(){window.print()}<\/script>':""}</head><body><div class="container">${body}<div class="brand-slogan">⚡ Generated &amp; Verified by <b>Sanlyn OS Supply Chain Engine</b> <span style="font-size:9px;opacity:.55;margin-left:8px">Terms v1.1.0</span></div></div></body></html>`;}

export function sellerNamePx(name){ var l=(name||"").length; return l<=28?"20px":l<=38?"17px":l<=48?"14px":"12px"; }
// Per damon 2026-05-18: NO audience badge on PDF — recipient (customer or customs)
// shouldn't see internal admin labels. Admin tracks the version themselves.
// `audience` still drives behavior (merge / categorization) just not displayed.
export function docHdr(cfg,cn,en /*, audience — intentionally unused for display */){var _contact=[cfg.tel?'Tel: '+esc(cfg.tel):'',cfg.email?'Email: '+esc(cfg.email):''].filter(Boolean).join(' | ');return`<div class="header"><div class="seller-info"><div class="seller-name" style="font-size:${sellerNamePx(cfg.nameEN)}">${esc(cfg.nameEN)}</div><p style="margin:2px 0">${esc(cfg.address)}</p>${_contact?`<p style="margin:2px 0">${_contact}</p>`:''}</div><div class="doc-type"><h1>${esc(en)}</h1></div></div>`;}

export function buyerBlock(cust,addr,tel,docNo,noLbl,ordNo,date,curr){return`<div class="meta-grid"><div><div class="section-label">BUYER (BILL TO)</div><p style="font-size:13px;font-weight:bold;margin:0">${esc(cust)||"[BUYER]"}</p><p style="margin:5px 0">${esc(addr)||"[ADDRESS]"}</p>${tel?`<p style="margin:2px 0">Tel: ${esc(tel)}</p>`:""}</div><div><div class="section-label">DETAILS</div><ul class="meta-list"><li><b>${esc(noLbl||"No.")}:</b> ${esc(docNo)}</li><li><b>Order:</b> ${esc(ordNo)}</li><li><b>Date:</b> ${esc(date)}</li>${curr?`<li><b>Currency:</b> ${esc(curr)}</li>`:""}</ul></div></div>`;}

export function portBar(pol,pod,terms){return`<div class="trade-terms-bar"><span>POL: ${esc(pol)||"-"}</span><span>POD: ${esc(pod)||"-"}</span><span>Terms: ${esc(terms)||"-"} (Incoterms® 2020)</span></div>`;}

export function bankCard(bk,curr){
  var cur=String(curr||"").toUpperCase();
  var isCNY=cur==="CNY"||cur==="RMB";
  var acct=isCNY?(bk.rmbAccount||bk.cnyAccount||""):(bk.usdAccount||"");
  var acctLabel=isCNY?"Account No. (CNY)":"Account No. (USD)";
  return`<div class="details-box"><h4>BANKING INFORMATION</h4>Beneficiary: ${esc(bk.beneficiary||bk.accountName||"")}<br>Bank: ${esc(bk.bankName)}<br>SWIFT: ${esc(bk.swift)}<br>${bk.bankAddr?`Bank Address: ${esc(bk.bankAddr)}<br>`:""}${acct?`${acctLabel}: ${esc(acct)}<br>`:""}<span style="color:red;font-size:10px;font-weight:bold">* Please verify bank info before payment.</span></div>`;
}

export function termsCard(ts){
  // Strip Chinese + " / " separators from terms. Keep English portion only.
  function _en(t){ var s=String(t||""); if(s.indexOf("/")>=0) s=s.split("/").pop(); return s.replace(/[\u4e00-\u9fff:：]/g,"").trim(); }
  return`<div class="details-box"><h4>TERMS &amp; CONDITIONS</h4>${ts.map(function(t,i){return(i+1)+". "+esc(_en(t));}).join("<br>")}</div>`;
}

export function sigBlock(sealUrl){
  // Auto-stamp: overlay the seller's company seal (公章) on the SELLER box.
  // 110px ≈ 40mm on A4 — standard Chinese company seal diameter.
  var seal = sealUrl ? `<img src="${sealUrl}" alt="seal" style="position:absolute;right:14px;bottom:8px;width:110px;height:110px;opacity:.88;pointer-events:none"/>` : "";
  return`<div class="signature-grid"><div class="sig-box"><span>BUYER AUTHORIZED SIGNATURE</span><span style="font-weight:normal;font-size:9px">(Signature / Company Seal)</span></div><div class="sig-box" style="position:relative;min-height:110px;padding-bottom:80px">${seal}<span>SELLER AUTHORIZED SIGNATURE</span><span style="font-weight:normal;font-size:9px">(Signature / Company Seal)</span></div></div>`;}

export function productRows(prods,cols){
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

export function getProds(raw){return Array.isArray(raw.products)?raw.products:Array.isArray(raw.items)?raw.items:[];}
// getCanonicalProds — SINGLE SOURCE OF TRUTH for document line items.
// 2026-07-09: server-side exports (documents/export-pdf/export-excel) were reading the
// stale `raw.products` snapshot (often fewer rows + outdated prices, e.g. 40-DG-2 showed
// 2 rows @ wrong price instead of 3 @ correct selling price). The canonical array is the
// TOP-LEVEL orders.products column — exactly what the front-end doc-editor reads
// (o.products). This aligns all outputs to one source.
//   • Item SET + qty + selling price/subtotal  ← top-level o.products (authoritative)
//   • rich fields (hs_code, declaration_*, weights, cbm, factoryPrice) missing from the
//     lean canonical array are inherited from the raw.products snapshot BY SKU/barcode
//     (so PO factory pricing etc. are preserved — no regression). Rows only present in the
//     canonical array (the previously-dropped ones) fall through to enrichProdsFromMaster.
//   • Legacy orders with no top-level column fall back to raw.products / raw.items.
export function getCanonicalProds(o, raw){
  raw = raw || {};
  var top = (o && Array.isArray(o.products)) ? o.products : null;
  if(!top && o && typeof o.products === "string"){ try{ var _p=JSON.parse(o.products); if(Array.isArray(_p)) top=_p; }catch(e){} }
  var rawList = Array.isArray(raw.products) ? raw.products : (Array.isArray(raw.items) ? raw.items : []);
  if(!Array.isArray(top) || !top.length) return rawList; // legacy: no canonical column
  var bySku = {};
  rawList.forEach(function(p){ if(!p) return; if(p.sku) bySku[p.sku]=p; if(p.barcode) bySku[p.barcode]=p; if(p.code) bySku[p.code]=p; });
  return top.map(function(p){
    if(!p) return p;
    var base = (p.sku && bySku[p.sku]) || ((p.barcode||p.code) && bySku[p.barcode||p.code]) || null;
    // Canonical wins for every key it defines (name/qty/unitPrice/subtotal); inherit the
    // rest (hs_code, declaration_*, weights, cbm, factoryPrice, ...) from the snapshot.
    return base ? Object.assign({}, base, p) : p;
  });
}
export function getTotal(prods,order){return prods.reduce(function(s,p){var sub=Number(p.subtotal||p.amount||0);if(!sub&&p.qty)sub=Number(p.qty)*Number(resolveUnitPrice(p));return s+sub;},0)||Number(order.total_amount)||0;}

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
