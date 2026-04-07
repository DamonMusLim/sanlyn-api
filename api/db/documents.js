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

var COMPANIES = {
  petbaby: {
    nameCN: "厦门巴匕进出口有限公司",
    nameEN: "XIAMEN PET BABY IMPORT AND EXPORT CO., LTD",
    address: "4th Floor, 26-9# Huarong Road, Huli, Xiamen, China",
    tel: "+86 186 0905 8888", email: "info@petbaby.cn",
    bank: { beneficiary: "XIAMEN PET BABY IMPORT AND EXPORT CO., LTD", bankName: "BANK OF CHINA XIAMEN BRANCH", swift: "BKCHCNBI73A", bankAddr: "No. 40 North Hubin Road, Xiamen, China", usdAccount: "4299 8287 9286", rmbAccount: "4312 7991 8006" },
    taxNo: "", buyerBank: "中国银行厦门分行",
    terms: { sc: ["PACKAGING: Export standard cartons.","SHIPMENT: Within 30 days after receipt of the deposit.","PAYMENT: 30% deposit via T/T, 70% balance against copy of B/L.","QUALITY CLAIM: Claims must be made within 30 days after cargo arrival at the destination port.","VALIDITY: This invoice is valid for 7 days from the date of issue.","FORCE MAJEURE: The Seller shall not be held responsible for delays due to Force Majeure.","ARBITRATION: All disputes shall be submitted to CIETAC for arbitration."], iv: ["PACKAGING: Export standard cartons.","SHIPMENT: Within 30 days after receipt of the deposit.","PAYMENT: 30% deposit via T/T, 70% balance against copy of B/L.","QUALITY CLAIM: Claims must be made within 30 days after cargo arrival.","VALIDITY: This invoice is valid for 7 days from the date of issue."] },
  },
  sanlyn: {
    nameCN: "厦门三麟进出口有限公司",
    nameEN: "XIAMEN SANLYN IMPORT AND EXPORT CO., LTD",
    address: "Xiamen, Fujian, China", tel: "+86 186 0905 8888", email: "info@sanlyn.cn",
    bank: { beneficiary: "XIAMEN SANLYN IMPORT AND EXPORT CO., LTD", bankName: "BANK OF CHINA XIAMEN BRANCH", swift: "BKCHCNBI73A", bankAddr: "No. 40 North Hubin Road, Xiamen, China", usdAccount: "[USD Account]", rmbAccount: "[RMB Account]" },
    taxNo: "", buyerBank: "中国银行厦门分行",
    terms: { sc: ["PACKAGING: Export standard cartons.","SHIPMENT: Within 30 days after receipt of the deposit.","PAYMENT: 30% deposit via T/T, 70% balance against copy of B/L.","QUALITY CLAIM: Claims within 30 days of arrival.","FORCE MAJEURE: Not responsible for delays due to force majeure.","ARBITRATION: All disputes submitted to CIETAC."], iv: ["PACKAGING: Export standard cartons.","SHIPMENT: Within 30 days.","PAYMENT: 30% deposit, 70% against B/L copy.","QUALITY CLAIM: Claims within 30 days of arrival."] },
  },
};
var DEFAULT_CO = "petbaby";

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

function resolveCo(raw,q){ if(q&&COMPANIES[q])return COMPANIES[q]; var h=(raw.issuingCompanyEN||raw.issuingCompany||"").toLowerCase(); if(h.includes("sanlyn"))return COMPANIES.sanlyn; return COMPANIES[DEFAULT_CO]; }

var CUST_ADDRS={
  "petsome":"LOT 1716, JALAN SG LONG, BATU 11, SG LONG, 43000 KAJANG, SELANGOR, MALAYSIA",
  "dibaq":"LOT 1716, JALAN SG LONG, BATU 11, SG LONG, 43000 KAJANG, SELANGOR, MALAYSIA",
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

var CSS = `<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter','Noto Sans SC',Arial,sans-serif;color:#222;background:#f0f0f0;font-size:13px;}
.page{background:#fff;width:210mm;min-height:297mm;margin:0 auto;padding:14mm 14mm 10mm 14mm;}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;}
.co-name{font-size:18px;font-weight:800;color:#111;}
.co-sub{font-size:9px;color:#888;margin-top:2px;}
.co-addr{font-size:10px;color:#555;margin-top:4px;line-height:1.5;}
.title-r{text-align:right;}
.title-cn{font-size:22px;font-weight:800;letter-spacing:2px;}
.title-en{font-size:12px;font-weight:700;letter-spacing:2px;color:#555;margin-top:3px;}
.title-main{font-size:20px;font-weight:900;letter-spacing:2px;color:#111;white-space:nowrap;}
hr.div{border:none;border-top:2px solid #111;margin:16px 0 12px 0;}
.info-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:10px;}
.info-box{border:1px solid #ddd;border-radius:2px;}
.ibox-hdr{font-size:9px;font-weight:700;letter-spacing:1px;color:#888;padding:4px 8px;border-bottom:1px solid #eee;background:#fafafa;text-transform:uppercase;}
.ibox-body{padding:8px;}
.buyer-name{font-size:13px;font-weight:700;color:#111;margin-bottom:3px;}
.buyer-addr{font-size:10.5px;color:#444;line-height:1.5;}
.dg{display:grid;grid-template-columns:auto 1fr;gap:3px 8px;align-items:baseline;}
.dl{font-size:10px;color:#888;white-space:nowrap;}
.dv{font-size:12px;font-weight:600;}
.port-banner{border:2px solid #111;color:#111;background:#fff;display:flex;border-radius:2px;margin-bottom:10px;}
.pc{flex:1;padding:8px 12px;border-right:1px solid #ddd;}
.pc:last-child{border-right:none;}
.pl{font-size:8.5px;font-weight:700;letter-spacing:1px;color:#888;text-transform:uppercase;margin-bottom:2px;}
.pv{font-size:12px;font-weight:700;color:#111;}
table.items{width:100%;border-collapse:collapse;margin-bottom:0;}
table.items thead tr{background:#111;color:#fff;}
table.items th{padding:8px 10px;font-size:10.5px;font-weight:700;letter-spacing:0.5px;text-align:center;}
table.items th.tl{text-align:left;}
table.items td{padding:7px 10px;border-bottom:1px solid #eee;font-size:12px;}
table.items td.tc{text-align:center;}
table.items td.tr{text-align:right;}
table.items tr.tot td{border-top:2px solid #111;border-bottom:none;padding-top:10px;font-weight:700;font-size:13px;}
table.items tr:nth-child(even) td{background:#fafafa;}
.btm{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;}
.btm-card{border:1px solid #ddd;border-radius:2px;}
.btm-hdr{font-size:9.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;padding:5px 10px;border-bottom:1px solid #eee;background:#fafafa;}
.btm-body{padding:10px;font-size:10.5px;color:#444;line-height:1.7;}
.btm-body ol{padding-left:14px;}
.bk-row{display:flex;gap:4px;margin-bottom:3px;}
.bk-l{color:#888;min-width:80px;font-size:10px;}
.bk-v{color:#111;font-weight:500;font-size:10.5px;}
.bk-warn{color:#c00;font-size:9.5px;margin-top:6px;font-weight:600;}
.sig-row{display:flex;justify-content:space-between;margin-top:16px;}
.sig-b{width:44%;text-align:center;}
.sig-line{border-top:1px solid #aaa;margin-bottom:6px;padding-top:6px;}
.sig-lbl{font-size:10px;font-weight:700;letter-spacing:0.5px;color:#444;text-transform:uppercase;}
.sig-sub{font-size:9px;color:#999;margin-top:3px;}
.sig-sp{height:44px;}
.footer{margin-top:14px;text-align:center;font-size:9px;color:#bbb;border-top:1px solid #eee;padding-top:6px;}
.footer span{color:#f9ab00;font-weight:700;}
@media print{body{background:#fff;}.page{width:100%;padding:10mm;}}
</style>`;

function wrap(title,body,ap){ return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc(title)}</title>${CSS}${ap?'<script>window.onload=function(){window.print()}<\/script>':""}</head><body><div class="page">${body}<div class="footer"><span>⚡</span> Generated &amp; Verified by <span>Sanlyn OS Supply Chain Engine</span></div></div></body></html>`; }

function docHdr(cfg,cn,en){ return `<div class="hdr"><div><div class="co-name">${esc(cfg.nameEN)}</div><div class="co-sub">Global Sourcing &amp; Supply Chain Partner</div><div class="co-addr">${esc(cfg.address)}<br>Tel: ${esc(cfg.tel)} | Email: ${esc(cfg.email)}</div></div><div class="title-r">${cn?`<div class="title-cn">${esc(cn)}</div><div class="title-en">${esc(en)}</div>`:`<div class="title-main">${esc(en)}</div>`}</div></div><hr class="div">`; }

function buyerBlock(cust,addr,tel,docNo,noLbl,ordNo,date,curr){ return `<div class="info-row"><div class="info-box"><div class="ibox-hdr">BUYER (BILL TO)</div><div class="ibox-body"><div class="buyer-name">${esc(cust)||"[BUYER]"}</div><div class="buyer-addr">${esc(addr)||""}${tel?`<br>Tel: ${esc(tel)}`:""}</div></div></div><div class="info-box"><div class="ibox-hdr">DETAILS</div><div class="ibox-body"><div class="dg"><div class="dl">${esc(noLbl||"No.")}:</div><div class="dv">${esc(docNo)}</div><div class="dl">Order:</div><div class="dv">${esc(ordNo)}</div><div class="dl">Date:</div><div class="dv">${esc(date)}</div>${curr?`<div class="dl">Currency:</div><div class="dv">${esc(curr)}</div>`:""}</div></div></div></div>`; }

function portBar(pol,pod,terms){ return `<div class="port-banner"><div class="pc"><div class="pl">PORT OF LOADING</div><div class="pv">${esc(pol)||"-"}</div></div><div class="pc"><div class="pl">PORT OF DESTINATION</div><div class="pv">${esc(pod)||"-"}</div></div><div class="pc"><div class="pl">TERMS (Incoterms® 2020)</div><div class="pv">${esc(terms)||"-"}</div></div></div>`; }

function bankCard(bk){ return `<div class="btm-card"><div class="btm-hdr">BANKING INFORMATION</div><div class="btm-body"><div class="bk-row"><div class="bk-l">Beneficiary:</div><div class="bk-v">${esc(bk.beneficiary||bk.accountName||"")}</div></div><div class="bk-row"><div class="bk-l">Bank:</div><div class="bk-v">${esc(bk.bankName)}</div></div><div class="bk-row"><div class="bk-l">SWIFT:</div><div class="bk-v">${esc(bk.swift)}</div></div><div class="bk-row"><div class="bk-l">Bank Addr:</div><div class="bk-v">${esc(bk.bankAddr)}</div></div>${bk.usdAccount?`<div class="bk-row"><div class="bk-l">USD Acct:</div><div class="bk-v">${esc(bk.usdAccount)}</div></div>`:""}<div class="bk-row"><div class="bk-l">${bk.cnyAccount?"CNY":"RMB"} Acct:</div><div class="bk-v">${esc(bk.rmbAccount||bk.cnyAccount||"")}</div></div><div class="bk-warn">* Please verify bank details carefully before remittance.</div></div></div>`; }

function termsCard(ts){ return `<div class="btm-card"><div class="btm-hdr">TERMS &amp; CONDITIONS</div><div class="btm-body"><ol>${ts.map(function(t){return"<li>"+esc(t)+"</li>";}).join("")}</ol></div></div>`; }

function sigBlock(){ return `<div class="sig-row"><div class="sig-b"><div class="sig-sp"></div><div class="sig-line"></div><div class="sig-lbl">Buyer Authorized Signature / Stamp</div></div><div class="sig-b"><div class="sig-sp"></div><div class="sig-line"></div><div class="sig-lbl">Seller Authorized Signature / Stamp</div></div></div>`; }

function productRows(prods,cols,currency){
  if(!prods.length) return `<tr><td class="no">01</td><td colspan="${cols.length}" style="color:#ccc;text-align:center;font-style:italic;padding:20px">— Product details auto-filled from order —</td></tr>`;
  var rows=prods.map(function(p,i){return`<tr><td style="text-align:center;color:#888;width:36px">${String(i+1).padStart(2,"0")}</td>${cols.map(function(c){var v=c.fn?c.fn(p):(p[c.k]||"-");return`<td class="${c.al==="right"?"tr":c.al==="center"?"tc":""}">${esc(String(v))}</td>`;}).join("")}</tr>`;}).join("");
  var filler=prods.length<3?Array(3-prods.length).fill(0).map(function(_,i){return`<tr><td style="color:#ddd;text-align:center">${String(prods.length+i+1).padStart(2,"0")}</td>${cols.map(function(){return"<td></td>";}).join("")}</tr>`;}).join(""):"";
  return rows+filler;
}

function getProds(raw){ return Array.isArray(raw.products)?raw.products:Array.isArray(raw.items)?raw.items:[]; }
function getTotal(prods,order){ return prods.reduce(function(s,p){var sub=Number(p.subtotal||p.amount||0);if(!sub&&p.qty&&p.unitPrice)sub=Number(p.qty)*Number(p.unitPrice);return s+sub;},0)||Number(order.total_amount)||0; }

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(req.method!=="GET") return res.status(405).end();

  // ── Token auth ── must pass ?token=DOCS_SECRET or X-Docs-Token header
  var DOC_TOKEN = process.env.DOCS_SECRET || "";
  var reqToken = req.query.token || req.headers["x-docs-token"] || "";
  if(DOC_TOKEN && reqToken !== DOC_TOKEN){
    return res.status(401).send("<h1>401 Unauthorized</h1><p>Missing or invalid access token.</p>");
  }

  var{type,id,company:qco,print:ap}=req.query;
  if(!type||!id) return res.status(400).send("<h1>Missing type or id</h1>");

  try {
    var pool=getPool(), html="";

    if(["sc","iv","pl","po"].includes(type)){
      var oR=await pool.query("SELECT * FROM orders WHERE _id=$1 OR contract_no=$1 OR customer_po=$1 LIMIT 1",[id]);
      if(!oR.rows.length) return res.status(404).send("<h1>Order not found: "+esc(id)+"</h1>");
      var o=oR.rows[0], raw=o.raw||{};
      if(typeof raw==="string")try{raw=JSON.parse(raw);}catch(e){raw={};}
      var cfg=resolveCo(raw,qco);
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
      var prods=getProds(raw);
      var tot=getTotal(prods,o);
      var tqty=prods.reduce(function(s,p){return s+Number(p.qty||0);},0)||Number(raw.totalQty||0);
      var tgw=prods.reduce(function(s,p){return s+Number(p.grossWeight||p.gw||0);},0)||Number(raw.grossWeight||0);
      var tnw=prods.reduce(function(s,p){return s+Number(p.netWeight||p.nw||0);},0)||Number(raw.netWeight||0);

      var totRow=`<tr class="tot"><td colspan="3" style="text-align:right;color:#555;font-size:11px;">TOTAL AMOUNT (${esc(curr)}):</td><td colspan="2" style="text-align:right;font-size:16px;font-weight:800;">${fmtM(tot)}</td></tr>`;

      if(type==="sc"){
        var no=cno;
        var colsSC=[
          {k:"name",al:"",fn:function(p){return pick(p.productName,p.name,p.description,"-");},lbl:"Description"},
          {k:"size",al:"center",w:"100px",fn:function(p){return p.size||p.spec||"-";},lbl:"Size"},
          {k:"qty",al:"center",w:"60px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:function(p){return fmtM(resolveUnitPrice(p));},lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"95px",fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},lbl:"Amount"},
        ];
        html=wrap("Sales Contract — "+no,`
          ${docHdr(cfg,null,"SALES CONTRACT")}
          ${buyerBlock(cust,caddr,ctel,no,"Contract No.",ordNo,date,curr)}
          ${portBar(pol,pod,inco)}
          <table class="items"><thead><tr><th style="width:36px">NO.</th>${colsSC.map(function(c){return`<th class="tl"${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}">${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsSC,curr)}${totRow}</tbody></table>
          <div class="btm">${termsCard(cfg.terms.sc)}${bankCard(cfg.bank)}</div>${sigBlock()}`,ap);
      }

      if(type==="iv"){
        var noIV=cno;
        var colsIV=[
          {k:"name",al:"",fn:function(p){return pick(p.productName,p.name,p.description,"-");},lbl:"Description"},
          {k:"size",al:"center",w:"100px",fn:function(p){return p.size||p.spec||"-";},lbl:"Size"},
          {k:"qty",al:"center",w:"60px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:function(p){return fmtM(resolveUnitPrice(p));},lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"95px",fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},lbl:"Amount"},
        ];
        html=wrap("Commercial Invoice — "+noIV,`
          ${docHdr(cfg,null,"COMMERCIAL INVOICE")}
          ${buyerBlock(cust,caddr,ctel,noIV,"Invoice No.",ordNo,date,curr)}
          ${portBar(pol,pod,inco)}
          <table class="items"><thead><tr><th style="width:36px">NO.</th>${colsIV.map(function(c){return`<th class="tl"${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}">${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsIV,curr)}${totRow}</tbody></table>
          <div class="btm">${termsCard(cfg.terms.iv)}${bankCard(cfg.bank)}</div>${sigBlock()}`,ap);
      }

      if(type==="pl"){
        var noPL=cno;
        var tcbmPL=prods.reduce(function(s,p){return s+Number(p.cbm||p.volume||0);},0)||Number(raw.totalCBM||raw.cbm||0);
        var colsPL=[
          {k:"name",al:"",fn:function(p){return pick(p.productName,p.name,p.description,"-");},lbl:"Description"},
          {k:"size",al:"center",w:"90px",fn:function(p){return p.size||p.spec||"-";},lbl:"Size"},
          {k:"qty",al:"center",w:"55px",lbl:"QTY"},
          {k:"gw",al:"right",w:"75px",fn:function(p){return fmtM(p.grossWeight||p.gw||0);},lbl:"G.W (KG)"},
          {k:"nw",al:"right",w:"75px",fn:function(p){return fmtM(p.netWeight||p.nw||0);},lbl:"N.W (KG)"},
          {k:"cbm",al:"right",w:"65px",fn:function(p){return fmtM(p.cbm||p.volume||0,3);},lbl:"CBM (M³)"},
        ];
        html=wrap("Packing List — "+noPL,`
          ${docHdr(cfg,null,"PACKING LIST")}
          ${buyerBlock(cust,caddr,ctel,noPL,"P/L No.",ordNo,date,null)}
          ${portBar(pol,pod,inco)}
          <table class="items"><thead><tr><th style="width:36px">NO.</th>${colsPL.map(function(c){return`<th class="${c.al==='right'?'':'tl'}"${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}">${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsPL,curr)}
          <tr class="tot"><td colspan="2" style="text-align:right;color:#555;font-size:11px">SHIPPING MARKS: N/M &nbsp;&nbsp; Total:</td><td class="tc">${fmtM(tqty,0)}</td><td class="tr">${fmtM(tgw)}</td><td class="tr">${fmtM(tnw)}</td><td class="tr">${fmtM(tcbmPL,3)}</td></tr>
          </tbody></table>${sigBlock()}`,ap);
      }

      if(type==="po"){
        var noPO=pick(o.order_no,o.contract_no,id);
        var factory=pick(raw.factory,raw.factoryName,raw.supplier,"[FACTORY]");
        var buyerTaxNo=pick(cfg.taxNo,raw.sellerTaxNo,"");
        var vendorTaxNo=pick(raw.factoryTaxNo,raw.vendorTaxNo,"");
        html=wrap("Purchase Order — "+noPO,`
          <div style="text-align:center;margin-bottom:14px"><div style="font-size:20px;font-weight:800;letter-spacing:4px">采 购 合 同</div><div style="font-size:12px;color:#666;letter-spacing:1px">PURCHASE ORDER (PO)</div></div>
          <div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:11px;padding:8px;background:#f9f9f9;border:1px solid #eee;border-radius:2px">
            <div><b>Order:</b> ${esc(ordNo)}</div><div><b>合同号 Contract No.:</b> ${esc(cno)}</div><div><b>期待交货日 Delivery:</b> ${esc(date)}</div>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:12px">
            <div style="border:1px solid #ddd;border-radius:2px">
              <div style="font-size:9.5px;font-weight:700;letter-spacing:1px;padding:5px 10px;border-bottom:1px solid #eee;background:#111;color:#fff">买方信息 Buyer / Bill To</div>
              <div style="padding:10px;font-size:11px;line-height:1.9">
                <div><b>公司名称:</b> ${esc(cfg.nameCN)}<br><span style="color:#666;font-size:10px">${esc(cfg.nameEN)}</span></div>
                ${buyerTaxNo?`<div><b>税号:</b> ${esc(buyerTaxNo)}</div>`:""}
                <div><b>地址:</b> ${esc(cfg.address)}</div>
                <div><b>开户银行:</b> ${esc(cfg.buyerBank||cfg.bank.bankName)}</div>
                <div><b>银行账户:</b> ${esc(cfg.bank.rmbAccount)}</div>
              </div>
            </div>
            <div style="border:1px solid #ddd;border-radius:2px">
              <div style="font-size:9.5px;font-weight:700;letter-spacing:1px;padding:5px 10px;border-bottom:1px solid #eee;background:#111;color:#fff">供应商信息 Vendor / Ship From</div>
              <div style="padding:10px;font-size:11px;line-height:1.9">
                <div><b>公司名称:</b> ${esc(factory)}</div>
                ${vendorTaxNo?`<div><b>税号:</b> ${esc(vendorTaxNo)}</div>`:""}
                ${raw.factoryAddress?`<div><b>地址:</b> ${esc(raw.factoryAddress)}</div>`:""}
                ${raw.factoryBank?`<div><b>开户银行:</b> ${esc(raw.factoryBank)}</div>`:""}
                ${raw.factoryAccount?`<div><b>银行账户:</b> ${esc(raw.factoryAccount)}</div>`:""}
              </div>
            </div>
          </div>
          <table class="items"><thead><tr><th style="width:36px">NO.</th><th class="tl">品名 Item Description</th><th style="width:70px;text-align:center">数量 Qty</th><th style="width:90px;text-align:right">单价 Unit Price</th><th style="width:100px;text-align:right">金额 Amount</th><th style="width:90px;text-align:center">条形码 Code</th></tr></thead>
          <tbody>
            ${prods.length===0?`<tr><td class="tc">01</td><td colspan="5" style="color:#ccc;text-align:center;font-style:italic;padding:20px">— 产品明细将自动填入 —</td></tr>`:
              prods.map(function(p,i){
                var fp=pick(p.factoryPrice,p.unitPrice,p.price);
                var sub=Number(p.subtotalFactory||p.subtotal||0);if(!sub&&p.qty&&fp)sub=Number(p.qty)*Number(fp);
                return`<tr><td class="tc">${String(i+1).padStart(2,"0")}</td><td>${esc(pick(p.productName,p.name,"-"))}</td><td class="tc">${esc(String(p.qty||"-"))}</td><td class="tr">${fmtM(fp)}</td><td class="tr">${fmtM(sub)}</td><td class="tc" style="font-size:10px;color:#666">${esc(p.barcode||p.code||"")}</td></tr>`;
              }).join("")}
            <tr class="tot"><td colspan="2" style="text-align:right;color:#555;font-size:11px">合计 Total:</td><td class="tc">${fmtM(tqty,0)}</td><td></td><td class="tr" style="font-size:14px">${fmtM(tot)}</td><td></td></tr>
          </tbody></table>
          <div style="margin-top:12px;border:1px solid #ddd;border-radius:2px">
            <div style="font-size:9.5px;font-weight:700;letter-spacing:1px;padding:5px 10px;border-bottom:1px solid #eee;background:#fafafa">备注及条款 Remarks &amp; Terms</div>
            <div style="padding:10px;font-size:10px;color:#444;line-height:1.8"><ol>
              <li><b>质量 Quality:</b> 供方须保证产品符合约定规格。终端客户投诉有据可查时，供方承担退款或补货责任。<i>(Supplier guarantees specs; liable for refund/replacement on verified defects.)</i></li>
              <li><b>交期 Delivery:</b> 如有延误，须提前5个工作日书面通知。逾期导致的亏舱费、改船费、客户索赔由供方承担。<i>(5 working days written notice required for delays. Supplier liable for resulting losses.)</i></li>
              <li><b>系统声明:</b> 本合同由 Sanlyn OS 供应链引擎自动生成，作为双方商业确认之有效凭证。</li>
            </ol></div>
          </div>
          <div class="sig-row"><div class="sig-b"><div class="sig-sp"></div><div class="sig-line"></div><div class="sig-lbl">买方代表 Buyer Representative</div><div class="sig-sub">批准签章 / Authorized Stamp</div></div><div class="sig-b"><div class="sig-sp"></div><div class="sig-line"></div><div class="sig-lbl">卖方代表 Seller Representative</div><div class="sig-sub">批准签章 / Authorized Stamp</div></div></div>
        `,ap);
      }
    }

    if(["so","debit"].includes(type)){
      var spR=await pool.query("SELECT * FROM shipping_plans WHERE _id=$1 OR shipment_no=$1 LIMIT 1",[id]);
      if(!spR.rows.length) return res.status(404).send("<h1>Shipment not found: "+esc(id)+"</h1>");
      var sp=spR.rows[0], spraw=sp.raw||{};
      if(typeof spraw==="string")try{spraw=JSON.parse(spraw);}catch(e){spraw={};}
      var cfg3=resolveCo(spraw,qco);
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
      // Cargo, HS code from linked orders
      var cargo=pick(spraw.cargoDescription,sp.cargo_description,"SAID TO CONTAIN");
      var hsCodes="";
      if(sp.order_nos&&sp.order_nos.length){
        var loR=await pool.query("SELECT raw FROM orders WHERE order_no = ANY($1::text[])",[sp.order_nos]);
        var descs=[],hsList=[];
        loR.rows.forEach(function(r){
          var rr=r.raw||{};if(typeof rr==="string")try{rr=JSON.parse(rr);}catch(e){rr={};}
          var d=rr.blDescription||rr.cargoDescription||""; if(d)descs.push(d);
          var hs=rr.hsCode||rr.hs_code||rr.hscode||""; if(hs&&hsList.indexOf(hs)<0)hsList.push(hs);
          // also check products array
          var prods=rr.products||rr.items||[];
          prods.forEach(function(p){var ph=p.hsCode||p.hs_code||p.hscode||""; if(ph&&hsList.indexOf(ph)<0)hsList.push(ph);});
        });
        if(descs.length)cargo=descs.join("; ");
        hsCodes=hsList.join(", ");
      }

      if(type==="so"){
        html=wrap("Booking Note — "+soNo,`
          <div style="text-align:center;padding:10px 0 8px 0;border-bottom:2px solid #111;margin-bottom:12px">
            <div style="font-size:16px;font-weight:800">${esc(fwd.nameCN)}</div>
            <div style="font-size:10px;color:#666;margin-top:2px">${esc(fwd.nameEN)}</div>
            <div style="font-size:14px;font-weight:700;margin-top:6px;letter-spacing:2px">出口货物委托书 SHIPPING ORDER</div>
          </div>
          <div style="display:flex;justify-content:space-between;margin-bottom:8px;font-size:11px">
            <span><b>D/R No.:</b> ${esc(soNo)}</span><span><b>托运日期 Date:</b> ${esc(fmtD(sp.created_at))}</span>
          </div>
          <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
            ${[
              ["Shipper / 发货人", shipper+"<br><span style='font-size:10px;color:#666'>"+esc(cfg3.address)+"</span>", "请在提单待确认样上注明:<br><span style='color:#c00;font-size:11px'>申请目的港最长免箱时间，至少申请免箱 21 天</span>"],
              ["Consignee / 收货人", consignee+(consAddr?"<br>"+esc(consAddr):""), "Notify Party / 通知人<br>"+esc(consignee)+(consAddr?"<br>"+esc(consAddr):"")],
            ].map(function(r){return`<tr>${r.map(function(c){return`<td style="border:1px solid #aaa;padding:8px 10px;font-size:12px;vertical-align:top;width:50%">${c}</td>`;}).join("")}</tr>`;}).join("")}
          </table>
          <table style="width:100%;border-collapse:collapse;margin-bottom:10px">
            <tr>
              <td style="border:1px solid #aaa;padding:8px;font-size:12px;width:50%"><div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:3px">Ocean Vessel / 船名 &nbsp;&nbsp; Voyage / 航次</div>${esc(vessel)} / ${esc(voyage)}</td>
              <td style="border:1px solid #aaa;padding:8px;font-size:12px"><div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:3px">Port of Loading / 装货港</div>${esc(polSp)}</td>
            </tr>
            <tr>
              <td style="border:1px solid #aaa;padding:8px;font-size:12px"><div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:3px">Port of Discharge / 卸货港</div>${esc(podSp)}</td>
              <td style="border:1px solid #aaa;padding:8px;font-size:12px"><div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase;margin-bottom:3px">Place of Delivery / 交货地</div>${esc(podSp)}</td>
            </tr>
          </table>
          <table style="width:100%;border-collapse:collapse;font-size:11px">
            <thead><tr style="background:#111;color:#fff">
              <th style="padding:8px;font-size:10px;font-weight:700;text-align:center">Container No.<br>集装箱号</th>
              <th style="padding:8px;font-size:10px;font-weight:700;text-align:center">Seal No.<br>封志号</th>
              <th style="padding:8px;font-size:10px;font-weight:700;text-align:center">Pkgs/件数</th>
              <th style="padding:8px;font-size:10px;font-weight:700;text-align:left">HS Code &amp; Description<br>HS编码 &amp; 货描</th>
              <th style="padding:8px;font-size:10px;font-weight:700;text-align:center">G.W (KG)<br>毛重</th>
              <th style="padding:8px;font-size:10px;font-weight:700;text-align:center">CBM (M³)<br>方数</th>
            </tr></thead>
            <tbody><tr>
              <td style="border:1px solid #ddd;padding:7px 8px;text-align:center">${esc(pick(sp.container_no,spraw.containerNo,""))}</td>
              <td style="border:1px solid #ddd;padding:7px 8px;text-align:center">${esc(pick(sp.seal_no,spraw.sealNo,""))}</td>
              <td style="border:1px solid #ddd;padding:7px 8px;text-align:center">${esc(String(cqty)+" × "+ctype)}</td>
              <td style="border:1px solid #ddd;padding:7px 8px;text-align:left">${hsCodes?`<div style="font-weight:700;margin-bottom:3px">${esc(hsCodes)}</div>`:""}${esc(cargo)}</td>
              <td style="border:1px solid #ddd;padding:7px 8px;text-align:center;font-weight:700">${esc(String(tgwSp))}</td>
              <td style="border:1px solid #ddd;padding:7px 8px;text-align:center;font-weight:700">${esc(String(tcbm))}</td>
            </tr></tbody>
          </table>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:10px;font-size:11px">
            ${[["船期 ETD",etd],["截关日 Cut-off",cutoff||"-"],["运费 Freight","FREIGHT PREPAID"],["船公司 Carrier",pick(sp.shipping_line,spraw.shippingLine,"-")],["柜型 Container",ctype],["柜量 Qty",String(cqty)]].map(function(b){return`<div style="border:1px solid #ddd;padding:7px 10px;border-radius:2px"><div style="font-size:9px;color:#888;font-weight:700;text-transform:uppercase">${b[0]}</div><div style="font-weight:600;font-size:12px;margin-top:2px">${esc(b[1])}</div></div>`;}).join("")}
          </div>
          <div style="margin-top:12px;font-size:10.5px;padding-top:8px;border-top:1px solid #eee;display:flex;justify-content:space-between">
            <div><b>制单:</b> ${esc(cfg3.nameEN)}</div><div><b>Contact:</b> ${esc(fwd.contact)} | <b>Email:</b> ${esc(fwd.email)}</div>
          </div>
        `,ap);
      }

      if(type==="debit"){
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
            </div>
            <div>
              <div class="section-label">单据详情 / DETAILS</div>
              <ul class="meta-list">
                <li><b>账单编号 DB No.:</b>${esc(dbNo)}</li>
                ${blNo?`<li><b>提单号 B/L No.:</b>${esc(blNo)}</li>`:""}
                <li><b>日期 Date:</b>${fmtD(new Date())}</li>
                <li><b>ETD:</b>${esc(etd)}</li>
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

    if(!html) return res.status(400).send("<h1>Unknown type: "+esc(type)+"</h1>");
    res.setHeader("Content-Type","text/html; charset=utf-8");
    res.setHeader("Cache-Control","no-store");
    return res.status(200).send(html);
  }catch(err){
    return res.status(500).send("<h1>Error: "+esc(err.message)+"</h1>");
  }
}
