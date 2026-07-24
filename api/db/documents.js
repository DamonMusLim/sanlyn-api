// /api/db/documents.js  — Sanlyn OS Unified Document Generator
// TERMS_VERSION v1.1.0 · 2026-06-22 — PI 9条→6条(CIETAC厦门/14天索赔/Force Majeure独立); PO质检加2%豁免/争议去财产保全
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
import { renderCreditNote } from "./credit-note-doc.js"; // 贷记单 CN 独立渲染器 2026-06-28
import { htmlToPdf } from "./_html-to-pdf.js"; // format=pdf 真PDF渲染 2026-06-28
import { renderPureFreightDoc } from "./doc-pure-freight.js";
import { renderPurePortChargeDoc } from "./doc-pure-portcharge.js";
import { loadContainerWeightSources, resolveContainerGrossWeight, scaleGrossWeightsToContainer } from "./customs-weight-source.js";

// ── W0-3 customer-facing scrub ────────────────────────────────────────────────
// Memory rule (HARD): feedback_customer_code_anti_counterfeit.md
//   company_code / issuing_company_code / factory_code = internal 防伪 ID,
//   MUST NOT appear in any document a customer / factory / forwarder sees.
// Also strips: vault, pricing_snapshot, middleman_*, profit/margin numbers.
// Applied to the final rendered HTML right before res.send. Conservative regex
// scrub — removes obviously-leaked tokens. Does NOT change layout / labels /
// boxes (订单明细锁定规矩 order_detail_locked_and_shipping_fields).
import { CSS, esc, fmtM, fmtD, pick, resolveAddr, resolveUnitPrice, wrap, sellerNamePx,
  docHdr, buyerBlock, portBar, bankCard, termsCard, sigBlock, productRows, getProds,
  getCanonicalProds, getTotal } from "./doc-helpers.js";
import { scrubCustomerFacingHtml, loadSellerCfg, enrichProdsFromMaster,
  loadDocColConfig, buildColsFromConfig } from "./doc-data.js";

function customerDocNo(raw, order, fallback) {
  raw = raw || {};
  order = order || {};
  var po = pick(raw.customerPO, raw.customer_po, raw.customerPo, order.customer_po, order.customer_po_no);
  if (po && po !== order.order_no) return po;
  var fs = pick(raw.fs_no, raw.fsNo, raw.internal_no, raw.internalNo, order.contract_no, fallback);
  var m = String(fs || "").match(/\bFS[0-9A-Z-]+\b/i);
  return m ? m[0].toUpperCase() : fs;
}

var FORWARDERS = {
  default: {
    nameCN: "上海洋宝宝国际物流有限公司", nameEN: "SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.",
    bank: { accountName: "SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.", bankName: "BANK OF CHINA XIAMEN BRANCH", swift: "BKCHCNBJ73A", bankAddr: "No. 40 North Hubin Road, Xiamen", usdAccount: "433849630299", cnyAccount: "433849860868" },
    contact: "Damon", email: "damon@petbaby.cc",
  },
};


export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if(req.method==="OPTIONS") return res.status(200).end();
  if(!requireAuth(req, res)) return; // S18.1: 401 if no valid JWT
  if(req.method!=="GET") return res.status(405).end();

  // ── Token auth ── must pass ?token=DOCS_SECRET or X-Docs-Token header
  var DOC_TOKEN = process.env.DOCS_SECRET || "";
  var reqToken = req.query.token || req.headers["x-docs-token"] || "";
  // requireAuth (above) already mandates a valid JWT; req.user is set for any
  // logged-in caller. The legacy DOCS_SECRET token is only enforced for
  // unauthenticated (public-link) access — logged-in users skip it so the
  // standard doc-open paths (?token=JWT / Bearer) work. 2026-06-28.
  if(DOC_TOKEN && reqToken !== DOC_TOKEN && !req.user){
    return res.status(401).send("<h1>401 Unauthorized</h1><p>Missing or invalid access token.</p>");
  }

  var{type,id,ids,company:qco,print:ap,format,contract_no,bl_no,limit,audience:_audReq,fmt:_fmtVariant,style:_styleVariant}=req.query;

  // 2026-07-01 type=pack 浏览器视图 → 正版可编辑模版(export-docs-template)：海关单行(产品汇总真值)+PORT+可编辑+盖章。
  // PDF/xlsx 导出仍走下方服务端渲染,不受影响。&mode=detail 走逐SKU明细。
  if (type === "pack") {
    var _pf = (Array.isArray(format) ? format : [format]).map(function(f){ return String(f||"").toLowerCase(); });
    if (_pf.indexOf("pdf") === -1 && _pf.indexOf("xlsx") === -1) {
      var _ptok = req.query.token || reqToken || "";
      var _pmode = (req.query.customs === "1" || req.query.mode === "customs") ? "" : "&mode=detail";
      var _ppage = /^(pl|sc|iv)$/.test(String(req.query.page||"").toLowerCase()) ? String(req.query.page).toLowerCase() : "";
      var _plang = (String(req.query.lang||"").toLowerCase() === "en") ? "&lang=en" : "";
      var _pctn = req.query.container_no ? "&container_no=" + encodeURIComponent(String(req.query.container_no)) : "";
      return res.redirect(302, "/templates/export-docs-template.html?order_no=" + encodeURIComponent(id||"")
        + "&ids=" + encodeURIComponent(ids||id||"") + _pmode + _plang + _pctn
        + (_ppage ? "&page=" + encodeURIComponent(_ppage) : "")
        + "&token=" + encodeURIComponent(_ptok));
    }
  }

  let _dlBase = null; // 自定义下载文件名(CN单据用 CN-{客户PO})
  // PDF 输出拦截(2026-06-28):后续各单据仍 return res.send(html),这里统一渲染成真 PDF。
  // 只处理 format=pdf 且 body 是 HTML;format=xlsx 和普通 HTML 不受影响。
  if ((Array.isArray(format) ? format : [format]).some(function(f){ return String(f).toLowerCase() === "pdf"; })) {
    const origSend = res.send.bind(res);
    res.send = (body) => {
      if (typeof body === "string" && /<html|<!doctype/i.test(body)) {
        htmlToPdf(body)
          .then((pdf) => {
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", 'attachment; filename="' + (_dlBase || ((type || "document") + "-" + (id || ""))) + '.pdf"');
            origSend(pdf);
          })
          .catch((e) => { console.error("[pdf]", e.message); origSend(body); });
        return res;
      }
      return origSend(body);
    };
  }
  // ── Legacy frontend type aliases → canonical renderers (2026-06-28) ──
  // Frontend buttons historically pointed at types the backend never had,
  // causing 400s. Map them to the real renderers without a frontend rebuild.
  //   cd      = 报关底稿 Customs Draft   → PL rendered in customs audience
  //   freight = 客户运费单              → freight-quote renderer
  if(type==="cd"){ type="pl"; if(!_audReq) _audReq="customs"; }
  if(type==="freight"){ type="freight-quote"; }
  if (type === "freight_only" || type === "portcharge_only") {
    const html = type === "freight_only"
      ? await renderPureFreightDoc(getPool(), id)
      : await renderPurePortChargeDoc(getPool(), id);
    if (!html) return res.status(404).send("<h1>Shipment not found: " + esc(id) + "</h1>");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    return res.send(html);
  }
  // 贷记通知单 Credit Note → 独立模块渲染(读 credit_notes)
  if(type==="cn"){
    try{ const _pq = await getPool().query("SELECT o.customer_po, o.customer_po_no FROM credit_notes c LEFT JOIN orders o ON o.order_no=c.order_no WHERE c.cn_no=$1 OR c.id::text=$1 LIMIT 1", [id]); const _pr=_pq.rows[0]; const _ppo=_pr && (_pr.customer_po || _pr.customer_po_no); _dlBase = _ppo ? ('CN-'+_ppo) : String(id||''); }catch(e){ _dlBase = String(id||''); }
    var _cnXlsx = (Array.isArray(format)?format:[format]).some(function(f){return String(f).toLowerCase()==="xlsx";});
    if(_cnXlsx){
      try{
        var _pool=getPool();
        var _cr=await _pool.query("SELECT * FROM credit_notes WHERE cn_no=$1 OR id::text=$1 LIMIT 1",[id]);
        if(!_cr.rows.length) return res.status(404).send("Credit Note not found");
        var _cn=_cr.rows[0];
        var _items=Array.isArray(_cn.items)?_cn.items:(typeof _cn.items==="string"?(function(){try{return JSON.parse(_cn.items);}catch(e){return [];}})():[]);
        var _po="",_fs="";
        try{var _o=await _pool.query("SELECT customer_po,customer_po_no,raw->>'fs_no' AS fs_no FROM orders WHERE order_no=$1 LIMIT 1",[_cn.order_no]);if(_o.rows[0]){_po=_o.rows[0].customer_po||_o.rows[0].customer_po_no||"";_fs=_o.rows[0].fs_no||"";}}catch(e){}
        var _addr="";
        try{var _c=await _pool.query("SELECT address FROM companies WHERE code=$1 LIMIT 1",[_cn.company_code]);if(_c.rows[0])_addr=_c.rows[0].address||"";}catch(e){}
        var ExcelJS=(await import("exceljs")).default;
        var wb=new ExcelJS.Workbook();
        var ws=wb.addWorksheet("Credit Note "+_cn.cn_no);
        ws.columns=[{width:6},{width:46},{width:12},{width:10},{width:14},{width:16}];
        ws.addRow(["XIAMEN PET BABY IMPORT AND EXPORT CO., LTD"]);
        ws.addRow(["贷记通知单 / CREDIT NOTE"]);
        ws.addRow([]);
        ws.addRow(["收款方 TO:", _cn.company_name||""]);
        if(_addr) ws.addRow(["地址 Address:", _addr]);
        ws.addRow(["贷记单号 CN No.:", _cn.cn_no]);
        ws.addRow(["订单号 Order:", _po||_cn.order_no||""]);
        ws.addRow(["合同号 Contract:", _fs||_cn.contract_no||""]);
        ws.addRow(["日期 Date:", (_cn.issued_date?String(_cn.issued_date).slice(0,10):"")]);
        ws.addRow([]);
        var hdr=ws.addRow(["NO.","货物 DESCRIPTION","数量 QTY","单位 UNIT","单价差 DIFF","贷记金额 AMOUNT"]);
        hdr.font={bold:true};
        var _tot=0;
        _items.forEach(function(it,i){
          var amt=Number(it.amount)||0;_tot+=amt;
          ws.addRow([i+1,(it.desc||it.product||it.product_name||""),(it.qty!=null?it.qty:""),(it.qty_unit||it.unit||""),(it.price_diff!=null?it.price_diff:(it.unit_price_diff!=null?it.unit_price_diff:"")),amt]);
        });
        var tr=ws.addRow(["","贷记总额 TOTAL CREDIT ("+(_cn.currency||"CNY")+")","","","",Number(_tot.toFixed(2))]);
        tr.font={bold:true};
        if(_cn.note){ws.addRow([]);ws.addRow(["备注 Remarks:", _cn.note]);}
        var buf=await wb.xlsx.writeBuffer();
        res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition",'attachment; filename="'+String(_dlBase||("CN-"+_cn.cn_no)).replace(/[^A-Za-z0-9._-]/g,"_")+'.xlsx"');
        return res.send(Buffer.from(buf));
      }catch(e){
        console.error("[documents] cn xlsx error:", e.message);
        return res.status(500).send("CN xlsx error: "+e.message);
      }
    }
    try{
      var _cnHtml = await renderCreditNote(getPool(), id, { print: ap });
      if(!_cnHtml) return res.status(404).send("<h1>Credit Note not found: "+esc(id)+"</h1>");
      return res.send(scrubCustomerFacingHtml(_cnHtml));
    }catch(e){
      console.error("[documents] cn render error:", e.message);
      return res.status(500).send("<h1>Credit Note render error</h1>");
    }
  }
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

    // ── 厂检单 (工厂检验报告) — type=fi&id=ORDER ──
    // 表头自动带入(公司/样品名/数重量); 检测项目+技术要求=品类标准; 检验结果留空(工厂实测,绝不造数)
    if(type==="fi"){
      const { renderFi } = await import("./docs/fi.js");
      return renderFi({ pool, id, res, esc, pick, fmtD });
    }

    // ── QC 质检报告 (客户用) — type=qc&id=ORDER ──
    // 标准已降以防逐批担保风险(Damon 2026-06-04): 蒙脱石≥50/吸水≥200典型250/结团≥90/除臭≥70/沉底≤5s/容重0.8-1.1/含水≤13
    // 安全指标(重金属/微生物)不降。实测列留空(QC实测填)。盖巴匕babi章。
    if(type==="qc"){
      const { renderQc } = await import("./docs/qc.js");
      return renderQc({ pool, id, res, esc, pick, fmtD });
    }

    if(["sc","iv","pl","po","pi","pack","cpo"].includes(type)){
      var oR=await pool.query("SELECT * FROM orders WHERE id::text=$1 OR _id=$1 OR contract_no=$1 OR customer_po=$1 OR order_no=$1 LIMIT 1",[id]);
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
      raw = Object.assign({}, raw, {
        issuing_company_id: o.issuing_company_id || raw.issuing_company_id,
        customer_company_id: o.customer_company_id || raw.customer_company_id,
        factory_company_id: o.factory_company_id || raw.factory_company_id,
      });
      var cfg=await loadSellerCfg(pool,raw,qco);
      var cust=pick(o.company_name_en,raw.companyNameEN,raw.companyNameCN,o.customer);
      var caddr=resolveAddr(cust,pick(raw.customerAddress,raw.deliveryAddress));
      var ctel=raw.phone||"";
      var ordNo=customerDocNo(raw,o,pick(o.contract_no,id));
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
      var _primaryContractNo="";
      var _v2_vessel="", _v2_voyage="", _v2_carrier="", _v2_etd="";
      try{
        var _spR=await pool.query(
          "SELECT pol,pod,bl_no,vessel,voyage,shipping_line,carrier_code,etd,primary_contract_no FROM shipping_plans WHERE NULLIF($1,'') IS NOT NULL AND (bl_no=$1 OR contract_no=$1 OR order_contract_nos ILIKE '%'||$1||'%') OR (NULLIF($2,'') IS NOT NULL AND (contract_no=$2 OR order_contract_nos ILIKE '%'||$2||'%')) ORDER BY tracking_updated_at DESC NULLS LAST, eta DESC NULLS LAST LIMIT 1",
          [o.contract_no||"", o.order_no||""]
        );
        if(_spR.rows[0]){
          var _spRow0=_spR.rows[0];
          _spPol=_spRow0.pol||""; _spPod=_spRow0.pod||""; _spBl=_spRow0.bl_no||"";
          _primaryContractNo=_spRow0.primary_contract_no||"";
          _v2_vessel=_spRow0.vessel||""; _v2_voyage=_spRow0.voyage||"";
          _v2_carrier=_spRow0.shipping_line||_spRow0.carrier_code||"";
          _v2_etd=_spRow0.etd?fmtD(_spRow0.etd):"";
        }
      }catch(e){}
      var pol=pick(raw.pol,raw.portOfLoading,_spPol,_facPol,"-");
      var pod=pick(raw.destination,raw.pod,raw.destinationPort,_spPod,"-");
      var inco=pick(raw.tradeTerms,raw.incoterms,"FOB");
      // SSOT (2026-07-09): read canonical top-level orders.products (same source as the
      // front-end doc-editor), inheriting rich fields from the raw.products snapshot by SKU.
      // Fixes stale/partial raw.products (dropped rows + wrong prices, e.g. 40-DG-2).
      var prods=await enrichProdsFromMaster(pool,getCanonicalProds(o,raw));
      // HIGH-1: if products empty, fall back to order_line_items table
      if(!prods.length && (o.id||o._id)){
        try{
          var liR=await pool.query("SELECT * FROM order_line_items WHERE order_id=$1 ORDER BY sort_order,id",[o.id||o._id]);
          if(liR.rows.length){
            var liProds=liR.rows.map(function(li){
              return{
                productName: li.product_name||li.name||(li.raw&&li.raw.productName)||"",
                sku:         li.sku||(li.raw&&li.raw.sku)||"",
                barcode:     li.barcode||(li.raw&&li.raw.barcode)||"",
                qty:         li.qty_ctn||li.qty||0,
                unit:        li.unit||"CTN",
                unitPrice:   li.unit_price||0,
                subtotal:    li.subtotal||0,
                factoryPrice:li.factory_price||li.unit_price||0,
                netWeight:   li.nw_ctn||li.net_weight||0,
                grossWeight: li.gw_ctn||li.gross_weight||0,
                cbm:         li.cbm_ctn||li.cbm||0,
                bgbx:        li.bg_bx||(li.raw&&li.raw.bgBx)||"",
                size:        li.size||(li.raw&&li.raw.size)||"",
                hsCode:      li.hs_code||(li.raw&&li.raw.hsCode)||"",
              };
            });
            prods=await enrichProdsFromMaster(pool,liProds);
          }
        }catch(e){console.warn("[documents] order_line_items fallback failed:",e.message);}
      }
      // ── Look up container assignment from container_bookings subtable ──
      // Source of truth for which container holds which order (plus driver/VGM/trucking).
      // Falls back to orders.raw.containerNo if no booking record yet.
      var _cbMap={}; // contract_no → container_no
      var _cbTypeMap={}; // contract_no → container_type (for v2)
      try {
        var cbR=await pool.query(
          "SELECT contract_no, container_no, container_type FROM container_bookings WHERE contract_no = ANY($1::text[])",
          [[pick(o.contract_no,o.order_no,id)].concat(String(ids||"").split(",").map(function(s){return s.trim();}).filter(Boolean))]
        );
        cbR.rows.forEach(function(row){ if(row.contract_no){ _cbMap[row.contract_no]=row.container_no; _cbTypeMap[row.contract_no]=row.container_type||""; } });
      } catch (e) { console.warn("[documents] container_bookings lookup failed:",e.message); }

      // Tag primary-order products with group metadata (container / customer PO / contract).
      // Used by productRows() to emit a section header when multiple orders are merged.
      var _primaryCno=pick(o.contract_no,o.order_no,id);
      var _primaryContainer=pick(_cbMap[_primaryCno], raw.containerNo, "");
      var _primaryPO=customerDocNo(raw,o,_primaryCno);
      var _primaryCtnType=pick(_cbTypeMap[_primaryCno], raw.containerType, "");
      var _primaryIncoterm=pick(raw.tradeTerms,raw.incoterms,"");
      var _primaryFsNo=pick(raw.fs_no, raw.internal_no, o.contract_no, _primaryCno);
      prods=prods.map(function(p){return Object.assign({},p,{_groupKey:_primaryCno,_containerNo:_primaryContainer,_containerType:_primaryCtnType,_incoterm:_primaryIncoterm,_fsNo:_primaryFsNo,_customerPO:_primaryPO,_contractNo:_primaryCno});});
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
            var sPO=customerDocNo(sRaw,sib,sCno);
            var sContainer=pick(_cbMap[sCno], sRaw.containerNo, "");
            var sCtnType=pick(_cbTypeMap[sCno], sRaw.containerType, "");
            var sIncoterm=pick(sRaw.tradeTerms,sRaw.incoterms,"");
            var sFsNo=pick(sRaw.fs_no, sRaw.internal_no, sib.contract_no, sCno);
            if(sProds.length){
              var tagged=sProds.map(function(p){return Object.assign({},p,{_groupKey:sCno,_containerNo:sContainer,_containerType:sCtnType,_incoterm:sIncoterm,_fsNo:sFsNo,_customerPO:sPO,_contractNo:sCno});});
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
      var _customsWeightSource = null;
      if (audience === "customs" && type !== "po") {
        try {
          _customsWeightSource = await loadContainerWeightSources(pool, {
            blNo: pick(o.bl_no, raw.blNo, raw.bl_no, _spBl),
            orderNos: _mergedPOs.concat([o.order_no]).filter(Boolean),
            contractNos: _mergedCnos.concat([o.contract_no]).filter(Boolean),
          });
        } catch(e) { console.warn("[documents] customs gross weight source lookup failed:",e.message); }

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
        // W0-5: track lines whose declaration_name is missing so we can fail
        // the request when audience===customs (review fix #4) — see check below.
        var _missingDecl = [];
        if (_customsWeightSource) {
          // Damon 2026-07-10(forge任务B): 报关毛重不再按 measured 集装箱实测重缩放(measured 陈旧会偏离真值,本例 104922 != 105915.2),
          // 统一用 Σ gross×qty 真值(与 PL/报关单 loadLines 同源),保证三方审核一致。
          prods.forEach(function(p){ p._customsGrossTotal = Number(p.grossWeight || p.gw || 0) * Number(p.qty || 0); });
        }
        prods.forEach(function(p){
          var sku = p.sku || p.code || p.product_code || "";
          var meta = skuMeta[sku] || {};
          // W0-5 (feedback_declaration_fields_mandatory): NO fallback to "宠物食品".
          // declaration_name MUST come from products table or per-product field —
          // never guessed. Missing → flag and skip (do NOT bucket as blank row).
          var dn = p.declaration_name || p.declarationName || meta.dn || "";
          if (!dn) {
            _missingDecl.push(sku || p.name || "(unnamed)");
            return; // skip this product — don't aggregate into blank group
          }
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
          g.grossWeight += Number(p._customsGrossTotal != null ? p._customsGrossTotal : Number(p.grossWeight||p.gw||0) * Number(p.qty||0));
          g.netWeight   += Number(p.netWeight  ||p.nw||0) * Number(p.qty||0);
          g._cbmTot     += Number(p.cbmPerCtn||p.cbm_per_ctn||p.cbm||0) * Number(p.qty||0);
          g._aggCount += 1;
          if (!g.unitPrice && p.unitPrice) g.unitPrice = p.unitPrice;
        });
        // 合并行 grossWeight/netWeight/_cbmTot 已是该报关品名的「总量」(每箱值×箱数累加)。
        // 下游报关列/合计直接当总量用，不再 ×qty。
        prods = order.map(function(k){ return groups[k]; });
        // W0-5 (review fix #4): STOP when audience===customs AND any line lacks
        // declaration_name. Customs filings with blank/guessed product names →
        // seized goods + fines. Customer audience still renders (warning only).
        if (audience === "customs" && _missingDecl.length) {
          return res.status(400).send(
            "<h1>400 declaration_name_missing</h1>" +
            "<p>Cannot render customs document — the following SKUs lack a declaration_name in the products master table:</p>" +
            "<ul>" + _missingDecl.map(function(s){return "<li>"+esc(String(s))+"</li>";}).join("") + "</ul>" +
            "<p>Fix: ProductsModule → set declaration_name for each SKU, then retry. " +
            "Rule: feedback_declaration_fields_mandatory.</p>"
          );
        }
      }

      var _xlsCapture=null; // populated by sc/iv/pl blocks for xlsx export
      async function _buildPackXlsCaptureFromOLI(){
        var _mode=String(req.query.mode||"").toLowerCase();
        var _customsMode = (String(req.query.customs||"")==="1" || _mode==="customs");
        function _n(v){ return Number(v)||0; }
        function _lineRaw(li){ var r=li&&li.raw; if(typeof r==="string")try{return JSON.parse(r)||{};}catch(e){return{};} return (r&&typeof r==="object")?r:{}; }
        function _cp(li){ var r=_lineRaw(li); return pick(li.cp_code,li.sku,li.code,li.item_code,r.cp_code,r.sku,r.code,r.item_code,""); }
        function _plBarcode(li){ var r=_lineRaw(li), sku=_cp(li); return pick(li.barcode,li.bar_code,r.barcode,r.bar_code,li.product_barcode,li.product_factory_code,sku,""); }
        function _unit(li){ var r=_lineRaw(li); return pick(li.unit,r.unit,li.unitOfMeasure,r.unitOfMeasure,"CTN"); }
        function _qtyUnit(q,u){ return String(_qty(q))+(u||"CTN"); }
        function _decl(li){ var r=_lineRaw(li); return pick(li.declaration_name,li.declarationName,r.declaration_name,r.declarationName,r.blDescription,r.bl_description,"宠物食品"); }
        function _pname(li){ var r=_lineRaw(li); return pick(li.product_name,li.productName,r.productName,r.product_name,li.blDescription,li.bl_description,r.blDescription,r.bl_description,li.name_en,r.name_en,li.sku,r.sku,""); }
        function _size(li){ var r=_lineRaw(li); return pick(li.size,li.spec,r.size,r.spec,""); }
        function _uniqJoin(a){ var seen={},out=[]; (a||[]).forEach(function(v){ v=String(v||"").trim(); if(v&&!seen[v]){seen[v]=1;out.push(v);} }); return out.join(" / "); }
        function _shortNo(no){ return String(no||"").replace(/^\d+-/,""); }
        function _orderRaw(orow){ var r=orow&&orow.raw; if(typeof r==="string")try{return JSON.parse(r)||{};}catch(e){return{};} return (r&&typeof r==="object")?r:{}; }
        function _fsFromOrder(orow){
          var r=_orderRaw(orow), vals=[r.fs_no,r.fsNo,r.internal_no,r.internalNo,orow&&orow.fs_no,orow&&orow.internal_no,orow&&orow.contract_no,orow&&orow.order_no];
          for(var i=0;i<vals.length;i++){ var m=String(vals[i]||"").match(/\bFS[0-9A-Z-]+\b/i); if(m) return m[0].toUpperCase(); }
          return "";
        }
        function _orderTerms(orow){ var r=_orderRaw(orow); return pick(orow&&orow.trade_terms,r.trade_terms,orow&&orow.incoterm,r.incoterm,""); }
        function _normCno(v){ return String(v||"").trim().toUpperCase(); }
        function _rowFromLine(li){
          var q=_n(li.qty_ctn||li.qty), nw=_n(li.nw_ctn||li.net_weight)*q, gw=_n(li.gw_ctn||li.gross_weight)*q, cbm=_n(li.cbm_ctn||li.cbm)*q;
          var up=_n(li.unit_price||li.unitPrice), amt=_n(li.subtotal); if(!amt) amt=q*up;
          var name=_pname(li)||_cp(li)||"-", sz=_size(li); if(sz) name += " ("+sz+")";
          var cp=_cp(li);
          return {cp:cp,code:cp,barcode:_plBarcode(li),name:name,qty:q,unit:_unit(li),nw:nw,gw:gw,cbm:cbm,price:up,amt:amt};
        }
        function _tot(rows){ return (rows||[]).reduce(function(t,r){ t.qty+=_n(r.qty);t.nw+=_n(r.nw);t.gw+=_n(r.gw);t.cbm+=_n(r.cbm);t.amt+=_n(r.amt);return t; },{qty:0,nw:0,gw:0,cbm:0,amt:0}); }
        function _aggregate(lines){
          var groups={},order=[];
          lines.forEach(function(li){
            var q=_n(li.qty_ctn||li.qty); if(!q) return;
            var name=_decl(li), key=name;
            if(!groups[key]){ groups[key]={cp:[],name:name,qty:0,nw:0,gw:0,cbm:0,amt:0}; order.push(key); }
            var g=groups[key], up=_n(li.unit_price||li.unitPrice), amt=_n(li.subtotal); if(!amt) amt=q*up;
            g.cp.push(_cp(li)); g.qty+=q; g.nw+=_n(li.nw_ctn||li.net_weight)*q; g.gw+=_n(li._packCustomsGrossTotal!=null?li._packCustomsGrossTotal:_lineGrossTotal(li)); g.cbm+=_n(li.cbm_ctn||li.cbm)*q; g.amt+=amt;
          });
          return order.map(function(k){ var g=groups[k]; return {cp:_uniqJoin(g.cp),name:g.name,qty:g.qty,nw:g.nw,gw:g.gw,cbm:g.cbm,price:g.qty?g.amt/g.qty:0,amt:g.amt}; });
        }
        function _ctnBits(rows,k){ return _uniqJoin((rows||[]).map(function(r){return r&&r[k];})); }
        function _groupLabel(orders,ctns,terms){
          orders=Array.isArray(orders)?orders:[orders];
          ctns=Array.isArray(ctns)?ctns:[];
          var nos=_uniqJoin(orders.map(function(orow){return _shortNo((orow&&orow.order_no)||(orow&&orow.contract_no));}));
          var cno=_ctnBits(ctns,"container_no"), seal=_ctnBits(ctns,"seal_no");
          return ["ORDER "+nos,cno||"",_ctnBits(ctns,"container_type"),seal||"",terms||""].filter(Boolean).join(" · ");
        }
        function _orderContainers(orow,ctnMap){
          var ctns=ctnMap[orow&&orow.contract_no]||ctnMap[orow&&orow.order_no]||ctnMap[orow&&orow.id]||[];
          return Array.isArray(ctns)?ctns:(ctns?[ctns]:[]);
        }
        function _orderHasContainer(orow,ctnMap,containerNo){
          var want=_normCno(containerNo);
          if(!want)return true;
          return _orderContainers(orow,ctnMap).some(function(c){return _normCno(c&&c.container_no)===want;});
        }
        function _lineGrossTotal(li){
          return _n(li.gw_ctn||li.gross_weight)*_n(li.qty_ctn||li.qty);
        }
        function _applyCustomsGrossScale(lines,orderById){
          if(!_customsMode || !_customsWeightSource)return;
          var groups={},order=[];
          (lines||[]).forEach(function(li){
            var orow=orderById[String(li.order_id||"")]||{};
            var cno=_customsWeightSource.containerFor({orderNo:orow.order_no,contractNo:orow.contract_no});
            var key=cno||orow.contract_no||orow.order_no||String(li.order_id||"");
            if(!groups[key]){ groups[key]={containerNo:cno,orderNo:orow.order_no,contractNo:orow.contract_no,lines:[]}; order.push(key); }
            groups[key].lines.push(li);
          });
          order.forEach(function(k){
            var g=groups[k], oli=g.lines.map(_lineGrossTotal);
            var oliSum=oli.reduce(function(s,v){return s+v;},0);
            var measured=_customsWeightSource.measuredFor({containerNo:g.containerNo,orderNo:g.orderNo,contractNo:g.contractNo});
            var scaled=scaleGrossWeightsToContainer(oli,resolveContainerGrossWeight(measured,oliSum),oliSum);
            g.lines.forEach(function(li,i){ li._packCustomsGrossTotal=scaled[i]; });
          });
        }
        function _detailRows(orderRows,lines,ctnMap){
          var byOrder={};
          (lines||[]).forEach(function(li){ var k=String(li.order_id||""); (byOrder[k]||(byOrder[k]=[])).push(li); });
          var out=[],groups={},order=[];
          (orderRows||[]).forEach(function(orow){
            var oid=String(orow.id||orow._id||""), ctns=_orderContainers(orow,ctnMap);
            var cnos=(ctns||[]).map(function(c){return String(c&&c.container_no||"").trim();}).filter(Boolean);
            var key=_uniqJoin(cnos)||("__order__"+(orow.id||orow._id||orow.contract_no||orow.order_no||order.length));
            if(!groups[key]){ groups[key]={orders:[],emptyOrders:[],ctns:[],terms:"",items:[]}; order.push(key); }
            var g=groups[key];
            (ctns||[]).forEach(function(c){g.ctns.push(c);});
            if(!g.terms)g.terms=_orderTerms(orow);
            var itemRows=(byOrder[oid]||[]).map(_rowFromLine).filter(function(r){return r.name||r.qty;});
            if(itemRows.length)g.orders.push(orow);else g.emptyOrders.push(orow);
            itemRows.forEach(function(r){g.items.push(r);});
          });
          order.forEach(function(k){
            var g=groups[k];
            if(!g.items.length)return;
            out.push({isHeader:true,label:_groupLabel(g.orders.concat(g.emptyOrders),g.ctns,g.terms)});
            g.items.forEach(function(r){out.push(r);});
          });
          return out;
        }
        var orderRows=[o], xids=String(autoIds||ids||"").split(",").map(function(s){return s.trim();}).filter(function(s){return s&&s!==id;});
        if(xids.length){
          var xr=await pool.query("SELECT * FROM orders WHERE contract_no = ANY($1::text[]) OR customer_po = ANY($1::text[]) OR order_no = ANY($1::text[])",[xids]);
          xr.rows.forEach(function(r){ if(!orderRows.some(function(or){return String(or.id)===String(r.id);})){ orderRows.push(r); } });
        }
        var orderById={};
        orderRows.forEach(function(r){ if(r&&r.id)orderById[String(r.id)]=r; });
        var orderIds=orderRows.map(function(r){return Number(r.id||r._id)||0;}).filter(Boolean);
        var lines=[];
        if(orderIds.length){
          var lr=await pool.query("SELECT li.*, p.barcode AS product_barcode, p.factory_code AS product_factory_code FROM order_line_items li LEFT JOIN LATERAL (SELECT barcode, factory_code FROM products WHERE (id = li.product_id) OR (li.product_id IS NULL AND sku = li.sku) LIMIT 1) p ON true WHERE li.order_id = ANY($1::int[]) ORDER BY li.order_id, li.sort_order, li.id",[orderIds]);
          lines=lr.rows||[];
        }
        var ctnMap={}, onlyContainer=String(req.query.container_no||"").trim();
        if(!_customsMode || onlyContainer){
          var contracts=orderRows.map(function(r){return r&&r.contract_no;}).filter(Boolean), byId={};
          orderRows.forEach(function(r){ if(r&&r.id)byId[String(r.id)]=r; });
          if(orderIds.length){
            try{
              var oc=await pool.query(
                "SELECT oc.order_id, c.id AS container_id, c.container_no, c.container_type, c.seal_no FROM order_containers oc JOIN containers c ON c.id=oc.container_id WHERE oc.order_id = ANY($1::int[]) ORDER BY oc.order_id, c.id",
                [orderIds]
              );
              (oc.rows||[]).forEach(function(r){
                var orow=byId[String(r.order_id)]||{};
                if(orow.contract_no)(ctnMap[orow.contract_no]||(ctnMap[orow.contract_no]=[])).push(r);
                if(orow.order_no)(ctnMap[orow.order_no]||(ctnMap[orow.order_no]=[])).push(r);
                if(orow.id)(ctnMap[orow.id]||(ctnMap[orow.id]=[])).push(r);
              });
            }catch(e){ console.warn("[documents] pack xlsx order_containers lookup failed:",e.message); }
          }
          var fallbackContracts=contracts.filter(function(cn){
            var orow=orderRows.find(function(r){return r&&r.contract_no===cn;});
            return !(_orderContainers(orow,ctnMap).length);
          });
          if(fallbackContracts.length){
            try{
              var cr=await pool.query("SELECT contract_no, container_no, container_type, seal_no FROM container_bookings WHERE contract_no = ANY($1::text[]) ORDER BY contract_no, id",[fallbackContracts]);
              (cr.rows||[]).forEach(function(r){ (ctnMap[r.contract_no]||(ctnMap[r.contract_no]=[])).push(r); });
            }catch(e){ console.warn("[documents] pack xlsx container_bookings fallback lookup failed:",e.message); }
          }
        }
        if(onlyContainer){
          orderRows=orderRows.filter(function(orow){return _orderHasContainer(orow,ctnMap,onlyContainer);});
          var keepIds={}; orderRows.forEach(function(orow){ if(orow&&orow.id)keepIds[String(orow.id)]=1; });
          lines=(lines||[]).filter(function(li){return keepIds[String(li.order_id||"")];});
        }
        _applyCustomsGrossScale(lines,orderById);
        var rows=_customsMode?_aggregate(lines):_detailRows(orderRows,lines,ctnMap);
        var total=_tot(rows), baseNo=(ordNo||cno||id||"PACK");
        var fsNo=_uniqJoin(orderRows.map(_fsFromOrder)) || _fsFromOrder(o) || baseNo;
        if(_primaryContractNo) fsNo=_primaryContractNo;
        var packCurr=_uniqJoin(orderRows.map(function(orow){return orow&&orow.currency;})) || o.currency || curr || "CNY";
        var orderNoText=_uniqJoin(orderRows.map(function(orow){return _shortNo((orow&&orow.order_no)||(orow&&orow.contract_no));}));
        function _money(v){ return parseFloat((_n(v)).toFixed(2))||0; }
        function _qty(v){ return parseFloat((_n(v)).toFixed(0))||0; }
        function _cbm(v){ return parseFloat((_n(v)).toFixed(3))||0; }
        var common={buyer:cust,buyerAddr:caddr,date:date,cno:cno,curr:packCurr,pol:pol,pod:pod,incoterm:inco,poNo:(orderNoText||ordNo),seller:{nameEN:cfg.nameEN,address:cfg.address,tel:cfg.tel,email:cfg.email}};
        var pricedKeys=[{k:"cp"},{k:"name"},{k:"qty",fn:function(p){return _qty(p.qty);}},{k:"price",fn:function(p){return _money(p.price);}},{k:"amt",fn:function(p){return _money(p.amt);}}];
        var plHeaders=_customsMode?["NO.","CP Code","Description & Size","QTY","TOTAL NW (KG)","TOTAL GW (KG)","CBM (CU.M.)"]:["NO.","BARCODE","Description & Size","QTY","TOTAL NW (KG)","TOTAL GW (KG)","CBM (CU.M.)"];
        var plColKeys=_customsMode?[{k:"cp"},{k:"name"},{k:"qty",fn:function(p){return _qtyUnit(p.qty,"CTN");}},{k:"nw",fn:function(p){return _money(p.nw);}},{k:"gw",fn:function(p){return _money(p.gw);}},{k:"cbm",fn:function(p){return _cbm(p.cbm);}}]:[{k:"barcode"},{k:"name"},{k:"qty",fn:function(p){return _qtyUnit(p.qty,p.unit||"CTN");}},{k:"nw",fn:function(p){return _money(p.nw);}},{k:"gw",fn:function(p){return _money(p.gw);}},{k:"cbm",fn:function(p){return _cbm(p.cbm);}}];
        var plTotals=_customsMode?["","","GRAND TOTAL:",_qtyUnit(total.qty,"CTN"),_money(total.nw),_money(total.gw),_cbm(total.cbm)]:["","","GRAND TOTAL:",_qtyUnit(total.qty,"CTN"),_money(total.nw),_money(total.gw),_cbm(total.cbm)];
        return {docNo:(fsNo||baseNo)+"_PACK",sheets:[
          Object.assign({},common,{sheetName:"Packing List",docNo:fsNo,noLabel:"No.:",hideCurrency:true,incoterm:"",headers:plHeaders,colKeys:plColKeys,rows:rows,totals:plTotals}),
          Object.assign({},common,{sheetName:"Sales Contract",docNo:fsNo,noLabel:"No.:",terms:cfg.terms.sc,bank:cfg.bank,headers:["NO.","CP Code","Description & Size","CTN","Unit Price ("+packCurr+")","Amount ("+packCurr+")"],colKeys:pricedKeys,rows:rows,totals:["","","GRAND TOTAL:",_qty(total.qty),"",_money(total.amt)]}),
          Object.assign({},common,{sheetName:"Invoice",docNo:fsNo,noLabel:"No.:",terms:cfg.terms.iv,bank:cfg.bank,headers:["NO.","CP Code","Description & Size","CTN","Unit Price ("+packCurr+")","Amount ("+packCurr+")"],colKeys:pricedKeys,rows:rows,totals:["","","GRAND TOTAL:",_qty(total.qty),"",_money(total.amt)]})
        ]};
      }
      var tot=getTotal(prods,o);
      // 总箱数/总净重/总毛重：直接带订单字段表（total_qty/net_weight/gross_weight），不重算。
      var tqty=Number(o.total_qty)||prods.reduce(function(s,p){return s+Number(p.qty||0);},0)||Number(raw.totalQty||0);
      var tgw=(audience==="customs"?prods.reduce(function(s,p){return s+Number(p.grossWeight||p.gw||0);},0):(Number(o.gross_weight)||prods.reduce(function(s,p){return s+Number(p.grossWeight||p.gw||0)*Number(p.qty||0);},0)))||Number(raw.grossWeight||0);
      var tnw=Number(o.net_weight)||prods.reduce(function(s,p){return s+Number(p.netWeight||p.nw||0)*Number(p.qty||0);},0)||Number(raw.netWeight||0);

      // 2026-05-19: discount support — read raw.discounts[] {label, amount} and netAmount
      var _disc = Array.isArray(raw.discounts) ? raw.discounts : [];
      var _discSum = _disc.reduce(function(s,d){return s+Number(d.amount||0);},0);
      var _netAmt = (raw.netAmount != null) ? Number(raw.netAmount) : (tot + _discSum); // discounts are negative
      // Dynamic total row — colspan computed from actual column count so
      // adding/removing/reordering columns via Template Center never misaligns.
      function mkTotRow(_nTot){
        var _lab=Math.max(1,(_nTot||5)-1);
        if (_disc.length > 0) {
          var _discRows = _disc.map(function(d){
            return `<tr class="total-row"><td colspan="${_lab}" class="text-right" style="color:#888;font-size:10px;">${esc(d.label||'Discount')}:</td><td class="text-right" style="color:#c44;font-size:11px;">${fmtM(Number(d.amount||0))}</td></tr>`;
          }).join('');
          return `<tr class="total-row"><td colspan="${_lab}" class="text-right" style="color:#777;font-size:10px;">GROSS AMOUNT (${esc(curr)}):</td><td class="text-right" style="color:#777;font-size:12px;">${fmtM(tot)}</td></tr>`
              + _discRows
              + `<tr class="total-row" style="border-top:2px solid #000;"><td colspan="${_lab}" class="text-right" style="font-size:11px;">NET PAYABLE (${esc(curr)}):</td><td class="text-right" style="font-size:16px;font-weight:800;">${fmtM(_netAmt)}</td></tr>`;
        }
        return `<tr class="total-row"><td colspan="${_lab}" class="text-right" style="color:#555;font-size:11px;">TOTAL AMOUNT (${esc(curr)}):</td><td class="text-right" style="font-size:16px;font-weight:800;">${fmtM(tot)}</td></tr>`;
      }
      var totRow = mkTotRow(5);

      // ── V2 template (2026-05-25, Damon locked layout) ────────────────────────
      // Per /Users/mac/Desktop/SANLYN_REAL_ORDER_CUSTOMS_RESCUE/print/merged/
      // Triggers ONLY when ?style=v2 explicitly. Default path unchanged for
      // backwards compat (HARMONIOUS / PETSOME / JJ PET etc still get legacy).
      // Supports type ∈ {iv, sc, pl, pack}. PI/PO/SO/etc unaffected.
      if(String(_styleVariant||"").toLowerCase()==="v2" && ["iv","sc","pl","pack"].includes(type)){
        var _v2ColConfig = await Promise.all([loadDocColConfig(pool, "pl"), loadDocColConfig(pool, "iv"), loadDocColConfig(pool, "sc")]);
                var V2 = (function(){
                  var V2_CSS = "<style>"
                    +"body{font-family:'Helvetica','Arial','PingFang SC',sans-serif;color:#000;margin:0;padding:30px;font-size:11px;line-height:1.4;}"
                    +".v2-container{max-width:880px;margin:auto;}"
                    +".v2-banner{background:#16a34a;color:#fff;text-align:center;padding:6px;font-weight:700;font-size:11px;letter-spacing:1px;margin-bottom:18px;border-radius:3px;}"
                    +".v2-print-btn{position:fixed;top:18px;right:18px;background:#1e40af;color:#fff;padding:8px 14px;border:none;border-radius:4px;font-weight:700;cursor:pointer;font-size:12px;box-shadow:0 2px 6px rgba(0,0,0,.2);}"
                    +".v2-header{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #000;padding-bottom:15px;margin-bottom:22px;}"
                    +".v2-seller-info{flex:1;}"
                    +".v2-seller-name{font-weight:900;text-transform:uppercase;font-size:14px;margin-bottom:5px;}"
                    +".v2-doc-type{text-align:right;}"
                    +".v2-doc-type h1{margin:0;font-size:26px;font-weight:900;letter-spacing:1px;}"
                    +".v2-meta-grid{display:grid;grid-template-columns:1.2fr 0.8fr;gap:40px;margin-bottom:18px;}"
                    +".v2-section-label{font-size:10px;font-weight:bold;text-transform:uppercase;border-bottom:1px solid #000;padding-bottom:3px;margin-bottom:8px;color:#444;}"
                    +".v2-meta-list{list-style:none;padding:0;margin:0;}"
                    +".v2-meta-list li{margin-bottom:4px;display:flex;}"
                    +".v2-meta-list li b{width:130px;font-weight:bold;}"
                    +".v2-trade-terms-bar{border:2px solid #000;padding:10px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:22px;font-weight:bold;font-size:11px;}"
                    +".v2-trade-terms-bar span{display:block;}"
                    +".v2-tbl{width:100%;border-collapse:collapse;margin-bottom:22px;}"
                    +".v2-tbl th{background:#000;color:#fff;padding:8px;text-align:left;font-size:10px;text-transform:uppercase;}"
                    +".v2-tbl td{padding:7px 8px;border-bottom:1px solid #ccc;vertical-align:top;font-size:10.5px;}"
                    +".v2-tr{text-align:right;} .v2-tc{text-align:center;}"
                    +".v2-subsec td{background:#1e40af;color:#fff;font-weight:700;padding:8px;font-size:11px;letter-spacing:.02em;border-bottom:none;}"
                    +".v2-subtotal td{background:#eef2ff;font-weight:700;border-bottom:2px solid #1e40af;}"
                    +".v2-total td{background:#000;color:#fff;font-size:13px;font-weight:900;padding:10px;}"
                    +".v2-desc-en{font-weight:600;}"
                    +".v2-details-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:14px;}"
                    +".v2-details-box{border:1px solid #000;padding:12px;font-size:10.5px;}"
                    +".v2-details-box h4{margin:0 0 8px 0;font-size:11px;text-transform:uppercase;text-decoration:underline;}"
                    +".v2-sig-grid{display:flex;justify-content:space-between;margin-top:40px;}"
                    +".v2-sig-box{width:45%;border-top:2px solid #000;padding-top:10px;text-align:center;height:90px;font-weight:bold;display:flex;flex-direction:column;justify-content:space-between;font-size:11px;}"
                    +".v2-slogan{text-align:center;margin-top:40px;font-size:9px;color:#888;border-top:1px dashed #ccc;padding-top:12px;letter-spacing:1px;}"
                    +"@media print{body{padding:0;}.v2-container{max-width:100%;}.v2-print-btn,.no-print{display:none;}.v2-banner{-webkit-print-color-adjust:exact;print-color-adjust:exact;}}"
                    +"</style>";

                  // Strip prefixes per Damon spec: no "40-" no "PL-/SC-" no "IV-"
                  function stripPrefix(s){
                    if(!s) return "";
                    s = String(s);
                    return s.replace(/^40-/,"").replace(/^(PL|SC|IV)-/i,"");
                  }
                  function joinUniq(arr,sep){
                    var seen={}, out=[];
                    (arr||[]).forEach(function(v){ if(v && !seen[v]){ seen[v]=1; out.push(v); } });
                    return out.join(sep||" / ");
                  }

                  // Display values
                  var v2_buyer = cust || "[BUYER]";
                  var v2_buyerAddr = caddr || "";
                  var v2_date = date || fmtD(new Date());
                  var v2_curr = curr || "CNY";
                  // FS numbers (Invoice/PL/SC No.) — join all FS_NOs across orders, no PL-/SC- prefix
                  var v2_fsList = [];
                  (prods||[]).forEach(function(p){ if(p._fsNo) v2_fsList.push(p._fsNo); });
                  if(!v2_fsList.length) v2_fsList.push(raw.fs_no || raw.internal_no || cno);
                  var v2_docNo = joinUniq(v2_fsList.map(stripPrefix), " / ");
                  if(_primaryContractNo) v2_docNo=_primaryContractNo;
                  // Order list — strip "40-" prefix, join unique
                  var v2_orderList = [];
                  (prods||[]).forEach(function(p){ if(p._customerPO) v2_orderList.push(stripPrefix(p._customerPO)); });
                  if(!v2_orderList.length) v2_orderList.push(stripPrefix(ordNo||cno));
                  var v2_order = joinUniq(v2_orderList, " / ");

                  var v2_bl = pick(_spBl, o.bl_no, raw.blNo, raw.bl_no, "");
                  var v2_vessel = _v2_vessel; var v2_voyage = _v2_voyage;
                  var v2_vesselStr = v2_vessel + (v2_voyage?(" / "+v2_voyage):"");
                  var v2_carrier = _v2_carrier;
                  var v2_pol = pol; var v2_pod = pod;
                  var v2_etd = _v2_etd || "";

                  function v2DocLabel(t){
                    if(t==="iv") return {h1:"COMMERCIAL INVOICE", noLbl:"Invoice No."};
                    if(t==="sc") return {h1:"SALES CONTRACT",     noLbl:"SC No."};
                    if(t==="pl") return {h1:"PACKING LIST",       noLbl:"PL No."};
                    return {h1:"DOCUMENT", noLbl:"Doc No."};
                  }
                  function v2Header(t){
                    var lbl = v2DocLabel(t);
                    return ""
                      +"<div class=\"v2-banner\">OFFICIAL DOCUMENT — FOR CUSTOMS DECLARATION</div>"
                      +"<div class=\"v2-header\"><div class=\"v2-seller-info\">"
                      +"<div class=\"v2-seller-name\">"+esc(cfg.nameEN)+"</div>"
                      +"<p style=\"margin:2px 0\">"+esc(cfg.address)+"</p>"
                      +(cfg.tel||cfg.email||cfg.taxNo
                        ? "<p style=\"margin:2px 0;font-size:10px;color:#444\">"
                          +(cfg.tel?"Tel: "+esc(cfg.tel):"")
                          +(cfg.email?" | Email: "+esc(cfg.email):"")
                          +(cfg.taxNo?" | USCC: "+esc(cfg.taxNo):"")
                          +"</p>"
                        : "")
                      +"</div><div class=\"v2-doc-type\"><h1>"+esc(lbl.h1)+"</h1></div></div>"
                      +"<div class=\"v2-meta-grid\">"
                      +"<div><div class=\"v2-section-label\">BUYER (BILL TO)</div>"
                      +"<p style=\"font-size:13px;font-weight:bold;margin:0\">"+esc(v2_buyer)+"</p>"
                      +"<p style=\"margin:5px 0\">"+esc(v2_buyerAddr)+"</p></div>"
                      +"<div><div class=\"v2-section-label\">DETAILS</div>"
                      +"<ul class=\"v2-meta-list\">"
                      +"<li><b>"+esc(lbl.noLbl)+":</b> "+esc(v2_docNo)+"</li>"
                      +"<li><b>Order:</b> "+esc(v2_order)+"</li>"
                      +"<li><b>Date:</b> "+esc(v2_date)+"</li>"
                      +"<li><b>Currency:</b> "+esc(v2_curr)+"</li>"
                      +"</ul></div></div>"
                      +"<div class=\"v2-trade-terms-bar\">"
                      +"<span>BL: "+esc(v2_bl||"-")+"</span>"
                      +"<span>Vessel: "+esc(v2_vesselStr||"-")+"</span>"
                      +"<span>Carrier: "+esc(v2_carrier||"-")+"</span>"
                      +"<span>POL: "+esc(v2_pol||"-")+"</span>"
                      +"<span>POD: "+esc(v2_pod||"-")+"</span>"
                      +"<span>ETD: "+esc(v2_etd||"-")+"</span>"
                      +"</div>";
                  }

                  // Group products by _groupKey (per-order section)
                  function groupProds(){
                    var groups = {}, order = [];
                    (prods||[]).forEach(function(p){
                      var k = p._groupKey || p._contractNo || "_default";
                      if(!groups[k]){
                        groups[k] = {
                          key: k,
                          contractNo: p._contractNo || k,
                          customerPO: p._customerPO || "",
                          containerNo: p._containerNo || "",
                          containerType: p._containerType || "",
                          fsNo: p._fsNo || "",
                          incoterm: p._incoterm || "",
                          items: []
                        };
                        order.push(k);
                      }
                      groups[k].items.push(p);
                    });
                    return order.map(function(k){ return groups[k]; });
                  }

                  function v2NameOf(p){
                    // English-only product name; no Chinese small line
                    var n = pick(p.productName, p.name, p.description, p.blDescription, p.bl_description, "-");
                    // Remove any "ZH | EN" → EN only
                    if(typeof n === "string" && n.indexOf("|") > -1){
                      var parts = n.split("|").map(function(s){return s.trim();});
                      // Pick the part that has ASCII letters
                      var en = parts.filter(function(s){return /[A-Za-z]/.test(s);})[0];
                      if(en) n = en;
                    }
                    return n;
                  }

                  var _v2DbColsPL = _v2ColConfig[0] || [];
                  var _v2DbColsIV = _v2ColConfig[1] || [];
                  var _v2DbColsSC = _v2ColConfig[2] || [];

                  function v2PLMetrics(p){
                    var qty = Number(p.qty||0);
                    var nwPer = Number(p.netWeight||p.nw||0);
                    var gwPer = Number(p.grossWeight||p.gw||0);
                    var cbmPer = Number(p.cbmPerCtn||p.cbm_per_ctn||0);
                    var nwTot, gwTot, cbmTot;
                    if(audience==="customs"){
                      nwTot = Number(p.netWeight||p.nw||0);
                      gwTot = Number(p.grossWeight||p.gw||0);
                      cbmTot = Number(p._cbmTot||p.cbm||0);
                    } else {
                      nwTot = (nwPer*qty)||nwPer;
                      gwTot = (gwPer*qty)||gwPer;
                      cbmTot = cbmPer>0 ? cbmPer*qty : Number(p.cbm||p.volume||0);
                    }
                    return {qty:qty, nw:nwTot, gw:gwTot, cbm:cbmTot};
                  }

                  function v2AmtMetrics(p){
                    var qty = Number(p.qty||0);
                    var up = Number(resolveUnitPrice(p)||0);
                    var amt = Number(p.subtotal||p.amount||0);
                    if(!amt && qty) amt = qty * up;
                    return {qty:qty, price:up, amt:amt};
                  }
                  function v2UnitOf(p){ return p.unit||p.unitOfMeasure||"CTN"; }
                  function v2QtyUnit(q,u){ return String(Math.round(Number(q)||0))+(u||"CTN"); }

                  var _v2PLFnMap = {
                    sku:{fn:function(p){return p.sku||p.code||p.item_code||p.product_code||"-";},defaultAlign:"center",defaultWidth:"70px"},
                    name:{fn:function(p){return v2NameOf(p);},defaultAlign:""},
                    qty:{fn:function(p){return v2QtyUnit(p.qty,audience==="customs"?"CTN":v2UnitOf(p));},defaultAlign:"center",defaultWidth:"70px"},
                    unit:{fn:v2UnitOf,defaultAlign:"center",defaultWidth:"50px"},
                    nw:{fn:function(p){return fmtM(v2PLMetrics(p).nw);},defaultAlign:"right",defaultWidth:"85px"},
                    gw:{fn:function(p){return fmtM(v2PLMetrics(p).gw);},defaultAlign:"right",defaultWidth:"85px"},
                    cbm:{fn:function(p){return fmtM(v2PLMetrics(p).cbm,3);},defaultAlign:"right",defaultWidth:"80px"},
                    price:{fn:function(p){return fmtM(v2AmtMetrics(p).price);},defaultAlign:"right",defaultWidth:"95px"},
                    amt:{fn:function(p){return fmtM(v2AmtMetrics(p).amt);},defaultAlign:"right",defaultWidth:"110px"}
                  };

                  var _v2AmtFnMap = {
                    sku:_v2PLFnMap.sku,
                    name:_v2PLFnMap.name,
                    qty:_v2PLFnMap.qty,
                    unit:_v2PLFnMap.unit,
                    price:_v2PLFnMap.price,
                    amt:_v2PLFnMap.amt,
                    nw:_v2PLFnMap.nw,
                    gw:_v2PLFnMap.gw,
                    cbm:_v2PLFnMap.cbm
                  };

                  var _v2FallbackColsPL = [
                    {k:"sku",al:"center",w:"70px",fn:_v2PLFnMap.sku.fn,lbl:"CP Code"},
                    {k:"name",al:"",fn:_v2PLFnMap.name.fn,lbl:"Description & Size"},
                    {k:"qty",al:"center",w:"70px",fn:_v2PLFnMap.qty.fn,lbl:"QTY (CTN)"},
                    {k:"unit",al:"center",w:"50px",fn:_v2PLFnMap.unit.fn,lbl:"Unit"},
                    {k:"nw",al:"right",w:"85px",fn:_v2PLFnMap.nw.fn,lbl:"N.W. (KG)"},
                    {k:"gw",al:"right",w:"85px",fn:_v2PLFnMap.gw.fn,lbl:"G.W. (KG)"},
                    {k:"cbm",al:"right",w:"80px",fn:_v2PLFnMap.cbm.fn,lbl:"CBM (M³)"}
                  ];

                  var _v2FallbackColsAmt = [
                    {k:"sku",al:"center",w:"70px",fn:_v2AmtFnMap.sku.fn,lbl:"CP Code"},
                    {k:"name",al:"",fn:_v2AmtFnMap.name.fn,lbl:"Description & Size"},
                    {k:"qty",al:"center",w:"70px",fn:_v2AmtFnMap.qty.fn,lbl:"QTY (CTN)"},
                    {k:"unit",al:"center",w:"50px",fn:_v2AmtFnMap.unit.fn,lbl:"Unit"},
                    {k:"price",al:"right",w:"95px",fn:_v2AmtFnMap.price.fn,lbl:"Unit Price ("+v2_curr+")"},
                    {k:"amt",al:"right",w:"110px",fn:_v2AmtFnMap.amt.fn,lbl:"Amount ("+v2_curr+")"}
                  ];

                  var v2ColsPL = buildColsFromConfig(_v2DbColsPL, _v2PLFnMap, _v2FallbackColsPL);
                  var v2ColsIV = buildColsFromConfig(_v2DbColsIV, _v2AmtFnMap, _v2FallbackColsAmt);
                  var v2ColsSC = buildColsFromConfig(_v2DbColsSC, _v2AmtFnMap, _v2FallbackColsAmt);

                  function v2ColStyle(c){
                    var s = [];
                    if(c.w) s.push("width:"+c.w);
                    if(c.al==="right") s.push("text-align:right");
                    else if(c.al==="center") s.push("text-align:center");
                    return s.length ? " style=\""+s.join(";")+"\"" : "";
                  }

                  function v2TdClass(c){
                    if(c.al==="right") return " class=\"v2-tr\"";
                    if(c.al==="center") return " class=\"v2-tc\"";
                    return "";
                  }

                  function v2TableHead(cols){
                    return "<thead><tr><th style=\"width:34px\">NO.</th>"
                      + cols.map(function(c){return "<th"+v2ColStyle(c)+">"+esc(String(c.lbl||c.k||""))+"</th>";}).join("")
                      + "</tr></thead>";
                  }

                  function v2CellValue(c, p, vals){
                    if(vals && Object.prototype.hasOwnProperty.call(vals, c.k)) return vals[c.k];
                    if(typeof c.fn==="function") return c.fn(p);
                    return p[c.k] == null ? "" : p[c.k];
                  }

                  function v2DataRow(seq, cols, p, vals){
                    return "<tr><td>"+String(seq).padStart(2,"0")+"</td>"
                      + cols.map(function(c){
                        var v = v2CellValue(c, p, vals);
                        if(c.k==="name") return "<td"+v2TdClass(c)+"><span class=\"v2-desc-en\">"+esc(String(v))+"</span></td>";
                        return "<td"+v2TdClass(c)+">"+esc(String(v))+"</td>";
                      }).join("")
                      + "</tr>";
                  }

                  function v2SummaryRow(cls, label, cols, values){
                    var first = -1;
                    cols.forEach(function(c,i){
                      if(first < 0 && Object.prototype.hasOwnProperty.call(values, c.k)) first = i;
                    });
                    if(first < 0){
                      return "<tr class=\""+cls+"\"><td colspan=\""+(cols.length+1)+"\" class=\"v2-tr\">"+esc(label)+"</td></tr>";
                    }
                    var html = "<tr class=\""+cls+"\"><td colspan=\""+(first+1)+"\" class=\"v2-tr\">"+esc(label)+"</td>";
                    for(var i=first;i<cols.length;i++){
                      var c = cols[i];
                      var val = Object.prototype.hasOwnProperty.call(values, c.k) ? values[c.k] : "";
                      html += "<td"+v2TdClass(c)+">"+esc(String(val))+"</td>";
                    }
                    return html + "</tr>";
                  }

                  // Sub-section banner
                  function v2Subsec(g, colspan){
                    var seal = ""; // SEAL omitted per spec
                    var bits = [
                      "ORDER " + stripPrefix(g.customerPO || g.contractNo),
                      g.containerNo ? "CONTAINER " + g.containerNo : "",
                      g.containerType || "",
                      g.fsNo ? stripPrefix(g.fsNo) : "",
                      g.incoterm || ""
                    ].filter(Boolean);
                    return "<tr class=\"v2-subsec\"><td colspan=\""+colspan+"\">"+esc(bits.join(" · "))+"</td></tr>";
                  }

                  function v2BodyIVorSC(t, cols){
                    cols = (cols && cols.length) ? cols : _v2FallbackColsAmt;
                    var groups = groupProds();
                    var rows = "";
                    var seq = 0;
                    var grandQty = 0, grandAmt = 0;
                    var showSubsec = groups.length > 1;
                    groups.forEach(function(g){
                      if(showSubsec) rows += v2Subsec(g, cols.length + 1);
                      g.items.forEach(function(p){
                        seq++;
                        var m = v2AmtMetrics(p);
                        grandQty += m.qty; grandAmt += m.amt;
                        rows += v2DataRow(seq, cols, p, {
                          sku: p.sku||p.code||p.item_code||p.product_code||"-",
                          name: v2NameOf(p),
                          qty: fmtM(m.qty,0),
                          unit: p.unit||p.unitOfMeasure||"CTN",
                          price: fmtM(m.price),
                          amt: fmtM(m.amt)
                        });
                      });
                    });
                    rows += v2SummaryRow("v2-total", "GRAND TOTAL:", cols, {
                      qty: fmtM(grandQty,0)+" CTN",
                      price: v2_curr,
                      amt: fmtM(grandAmt)
                    });

                    var tbl = "<table class=\"v2-tbl\">"+v2TableHead(cols)+"<tbody>"+rows+"</tbody></table>";

                    var footer = "<div class=\"v2-details-grid\">"
                      +"<div class=\"v2-details-box\"><h4>TERMS &amp; CONDITIONS</h4>"
                      +"1. Export standard cartons; goods shipped as per agreed specifications.<br>"
                      +"2. Shipment within 30 days of deposit received.<br>"
                      +"3. Payment: 30% Deposit, 70% balance against BL copy (unless otherwise agreed).<br>"
                      +"4. Claims must be raised within 30 days of arrival at POD."
                      +"</div>"
                      +"<div class=\"v2-details-box\"><h4>BANKING INFORMATION</h4>"
                      +"Beneficiary: "+esc(cfg.bank.beneficiary||cfg.nameEN)+"<br>"
                      +"Bank: "+esc(cfg.bank.bankName||"")+"<br>"
                      +"A/C No. ("+esc(v2_curr)+"): "+esc(cfg.bank.rmbAccount||cfg.bank.usdAccount||"")+"<br>"
                      +(cfg.bank.swift?"SWIFT: "+esc(cfg.bank.swift)+"<br>":"")
                      +(cfg.bank.bankAddr?"Bank Address: "+esc(cfg.bank.bankAddr)+"<br>":"")
                      +"<span style=\"color:red;font-size:10px;font-weight:bold\">* Please verify bank info before payment.</span>"
                      +"</div></div>"
                      +"<div class=\"v2-sig-grid\">"
                      +"<div class=\"v2-sig-box\"><span>BUYER AUTHORIZED SIGNATURE</span><span style=\"font-weight:normal;font-size:9px\">(Signature / Company Seal)</span></div>"
                      +"<div class=\"v2-sig-box\"><span>SELLER AUTHORIZED SIGNATURE</span><span style=\"font-weight:normal;font-size:9px\">(Signature / Company Seal)</span></div>"
                      +"</div>"
                      +"<div class=\"v2-slogan\">Generated &amp; Verified by <b>Sanlyn OS Supply Chain Engine</b> · OFFICIAL CUSTOMS DOCUMENT</div>";
                    return v2Header(t)+tbl+footer;
                  }

                  function v2BodyPL(cols){
                    cols = (cols && cols.length) ? cols : _v2FallbackColsPL;
                    var groups = groupProds();
                    var rows = "";
                    var seq = 0;
                    var grandQty = 0, grandNW = 0, grandGW = 0, grandCBM = 0;
                    var showSubsec = groups.length > 1;
                    groups.forEach(function(g){
                      if(showSubsec) rows += v2Subsec(g, cols.length + 1);
                      var subQty = 0, subNW = 0, subGW = 0, subCBM = 0;
                      g.items.forEach(function(p){
                        seq++;
                        var m = v2PLMetrics(p);
                        subQty+=m.qty; subNW+=m.nw; subGW+=m.gw; subCBM+=m.cbm;
                        rows += v2DataRow(seq, cols, p, {
                          sku: p.sku||p.code||p.item_code||p.product_code||"-",
                          name: v2NameOf(p),
                          qty: v2QtyUnit(m.qty,audience==="customs"?"CTN":v2UnitOf(p)),
                          unit: v2UnitOf(p),
                          nw: fmtM(m.nw),
                          gw: fmtM(m.gw),
                          cbm: fmtM(m.cbm,3)
                        });
                      });
                      if(showSubsec){
                        rows += v2SummaryRow("v2-subtotal", "Sub-Total ("+stripPrefix(g.customerPO||g.contractNo)+"):", cols, {
                          qty: v2QtyUnit(subQty,"CTN"),
                          nw: fmtM(subNW),
                          gw: fmtM(subGW),
                          cbm: fmtM(subCBM,3)
                        });
                      }
                      grandQty+=subQty; grandNW+=subNW; grandGW+=subGW; grandCBM+=subCBM;
                    });
                    // Prefer order-table totals if available (more authoritative)
                    var totQty = Number(o.total_qty)||grandQty;
                    var totNW = Number(o.net_weight)||grandNW;
                    var totGW = audience==="customs" ? grandGW : (Number(o.gross_weight)||grandGW);
                    var totCBM = Number(o.total_cbm)||grandCBM;
                    rows += v2SummaryRow("v2-total", "GRAND TOTAL:", cols, {
                      qty: v2QtyUnit(totQty,"CTN"),
                      nw: fmtM(totNW),
                      gw: fmtM(totGW),
                      cbm: fmtM(totCBM,3)
                    });

                    var tbl = "<table class=\"v2-tbl\">"+v2TableHead(cols)+"<tbody>"+rows+"</tbody></table>";
                    var footer = "<div class=\"v2-sig-grid\">"
                      +"<div class=\"v2-sig-box\"><span>BUYER AUTHORIZED SIGNATURE</span><span style=\"font-weight:normal;font-size:9px\">(Signature / Company Seal)</span></div>"
                      +"<div class=\"v2-sig-box\"><span>SELLER AUTHORIZED SIGNATURE</span><span style=\"font-weight:normal;font-size:9px\">(Signature / Company Seal)</span></div>"
                      +"</div>"
                      +"<div class=\"v2-slogan\">Generated &amp; Verified by <b>Sanlyn OS Supply Chain Engine</b> · OFFICIAL CUSTOMS DOCUMENT</div>";
                    return v2Header("pl")+tbl+footer;
                  }

                  function v2Page(body){
                    return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><title>"
                      +esc(v2DocLabel(type).h1+" — "+v2_order)+"</title>"+V2_CSS+"</head>"
                      +"<body><button class=\"v2-print-btn no-print\" onclick=\"window.print()\">Print</button>"
                      +"<div class=\"v2-container\">"+body+"</div></body></html>";
                  }

                  if(type==="iv") return v2Page(v2BodyIVorSC("iv", v2ColsIV));
                  if(type==="sc") return v2Page(v2BodyIVorSC("sc", v2ColsSC));
                  if(type==="pl") return v2Page(v2BodyPL(v2ColsPL));
                  if(type==="pack"){
                    // Combined 3-up: PL → SC → IV, each on its own page
                    var pages = "<div class=\"v2-container\">"+v2BodyPL(v2ColsPL)+"</div>"
                      +"<div class=\"v2-container\" style=\"page-break-before:always\">"+v2BodyIVorSC("sc", v2ColsSC)+"</div>"
                      +"<div class=\"v2-container\" style=\"page-break-before:always\">"+v2BodyIVorSC("iv", v2ColsIV)+"</div>";
                    var screenCss = "<style>@media screen{body{background:#e5e7eb;padding:24px 0;}.v2-container{box-shadow:0 3px 16px rgba(0,0,0,.18);margin:0 auto 28px;padding:42px;background:#fff;}}</style>";
                    return "<!DOCTYPE html><html lang=\"en\"><head><meta charset=\"UTF-8\"><title>"
                      +esc((v2_order||id)+" 报关 PL·SC·IV")+"</title>"+V2_CSS+screenCss+"</head>"
                      +"<body><button class=\"v2-print-btn no-print\" onclick=\"window.print()\">Print</button>"
                      +pages+"</body></html>";
                  }
                  return "";
                })();
        if(V2){
          res.setHeader("Content-Type","text/html; charset=utf-8");
          res.setHeader("Cache-Control","no-store");
          return res.send(V2);
        }
      }

      var _PACK = (type==="pack"); var _packBodies = {};
      if(type==="sc"||_PACK){
        var no=cno.split(" / ").map(function(c){return c.replace(/[^A-Z0-9-]/gi,"").slice(0,20);}).join(" / ");
        var _scNameFn=function(p){
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          };
        var _scFnMap={
          sku:{fn:function(p){return p.sku||p.code||p.item_code||p.product_code||"-";},defaultAlign:"center",defaultWidth:"70px"},
          name:{fn:_scNameFn,defaultAlign:""},
          qty:{defaultAlign:"center",defaultWidth:"70px"},
          unit:{fn:function(p){return p.unit||p.unitOfMeasure||"CTN";},defaultAlign:"center",defaultWidth:"50px"},
          price:{fn:function(p){return fmtM(resolveUnitPrice(p));},defaultAlign:"right",defaultWidth:"95px"},
          amt:{fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},defaultAlign:"right",defaultWidth:"110px"},
        };
        var _fbColsSC=[
          {k:"name",al:"",fn:_scNameFn,lbl:"Description &amp; Size"},
          {k:"qty",al:"center",w:"70px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:_scFnMap.price.fn,lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"110px",fn:_scFnMap.amt.fn,lbl:"Amount"},
        ];
        var colsSC=buildColsFromConfig(await loadDocColConfig(pool,"sc"),_scFnMap,_fbColsSC);
        totRow=mkTotRow(colsSC.length+1);
        var _fsNoSC = (raw.fs_no || raw.internal_no || (ordNo||no)) + "-SC";
        _packBodies.sc=`
          ${docHdr(cfg,"销售合同","SALES CONTRACT",audience)}
          ${buyerBlock(cust,caddr,ctel,(_primaryContractNo||no),"Contract No.",ordNo,date,curr)}
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
        var _ivNameFn=function(p){
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          };
        var _ivFnMap={
          sku:{fn:function(p){return p.sku||p.code||p.item_code||p.product_code||"-";},defaultAlign:"center",defaultWidth:"70px"},
          name:{fn:_ivNameFn,defaultAlign:""},
          qty:{defaultAlign:"center",defaultWidth:"70px"},
          unit:{fn:function(p){return p.unit||p.unitOfMeasure||"CTN";},defaultAlign:"center",defaultWidth:"50px"},
          price:{fn:function(p){return fmtM(resolveUnitPrice(p));},defaultAlign:"right",defaultWidth:"95px"},
          amt:{fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},defaultAlign:"right",defaultWidth:"110px"},
        };
        var _fbColsIV=[
          {k:"name",al:"",fn:_ivNameFn,lbl:"Description &amp; Size"},
          {k:"qty",al:"center",w:"70px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:_ivFnMap.price.fn,lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"110px",fn:_ivFnMap.amt.fn,lbl:"Amount"},
        ];
        var colsIV=buildColsFromConfig(await loadDocColConfig(pool,"iv"),_ivFnMap,_fbColsIV);
        totRow=mkTotRow(colsIV.length+1);
        var _fsNoIV = (raw.fs_no || raw.internal_no || (ordNo||noIV)) + "-IV";
        _packBodies.iv=`
          ${docHdr(cfg,"商业发票","COMMERCIAL INVOICE",audience)}
          ${buyerBlock(cust,caddr,ctel,(_primaryContractNo||noIV),"Invoice No.",ordNo,date,curr)}
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

      // ── CPO: Customer Purchase Order ──────────────────────────────────────────
      // Direction: Customer (buyer) → Sanlyn (seller). Generated by Sanlyn on behalf
      // of the customer so small buyers have a signed PO for their own records.
      // Layout = IV skeleton + payment schedule block at bottom.
      if(type==="cpo"){
        const { renderCpo } = await import("./docs/cpo.js");
        ({ html, _xlsCapture, totRow } = await renderCpo({ pool, raw, ordNo, cno, curr, cfg, cust, caddr, ctel, date, pol, pod, inco, prods, tot, html, _xlsCapture, totRow, audience, ap, esc, pick, fmtM, wrap, docHdr, buyerBlock, portBar, productRows, sigBlock, loadDocColConfig, buildColsFromConfig, resolveUnitPrice, mkTotRow }));
      }

      if(type==="pl"||_PACK){
	        var noPL=cno.split(" / ").map(function(c){return c.replace(/[^A-Z0-9-]/gi,"").slice(0,20);}).join(" / ");
	        // CBM resolution: prefer explicit per-CTN field × qty; fall back to p.cbm (line total) for legacy rows
	        var cbmOf=function(p){if(audience==='customs')return Number(p._cbmTot||p.cbm||0);var perCtn=Number(p.cbmPerCtn||p.cbm_per_ctn||0);var q=Number(p.qty||0);if(perCtn>0&&q>0)return perCtn*q;return Number(p.cbm||p.volume||0);};
	        var tcbmPL=Number(o.total_cbm)||prods.reduce(function(s,p){return s+cbmOf(p);},0)||Number(raw.totalCBM||raw.cbm||0);
	        var _plMaster={};
	        var _plSkus=prods.map(function(p){return p&&p.sku;}).filter(Boolean);
	        if(_plSkus.length){
	          try{
	            var _plMR=await pool.query("SELECT sku, barcode, factory_code FROM products WHERE sku = ANY($1::text[])",[_plSkus]);
	            (_plMR.rows||[]).forEach(function(r){ if(r.sku)_plMaster[r.sku]=r; });
	          }catch(e){ console.warn("[documents] PL product barcode lookup failed:",e.message); }
	        }
	        function _plSkuOf(p){ return p.sku||p.code||p.item_code||p.product_code||"-"; }
	        function _plBarcodeOf(p){ var sku=_plSkuOf(p), m=_plMaster[sku]||{}; return pick(p.barcode,p.bar_code,m.barcode,m.factory_code,sku,""); }
	        function _plUnitOf(p){ return p.unit||p.unitOfMeasure||"CTN"; }
	        function _plQtyUnit(q,u){ return String(Math.round(Number(q)||0))+(u||"CTN"); }
	        var _plFnMap={
	          sku:{fn:function(p){return _plSkuOf(p);},defaultAlign:"center",defaultWidth:"70px"},
	          code:{fn:function(p){return _plSkuOf(p);},defaultAlign:"center",defaultWidth:"70px"},
	          barcode:{fn:function(p){return _plBarcodeOf(p);},defaultAlign:"center",defaultWidth:"110px"},
	          name:{fn:function(p){var n=pick(p.productName,p.name,p.description,"-");var sz=p.size||p.spec||"";return sz?n+" ("+sz+")":n;},defaultAlign:""},
          qty:{fn:function(p){return _plQtyUnit(p.qty,audience==="customs"?"CTN":_plUnitOf(p));},defaultAlign:"center",defaultWidth:"55px"},
          unit:{fn:_plUnitOf,defaultAlign:"center",defaultWidth:"50px"},
          nw:{fn:function(p){var pn=Number(p.netWeight||p.nw||0);var q=Number(p.qty||0);return fmtM(audience==='customs'?pn:(pn*q||pn));},defaultAlign:"right",defaultWidth:"80px"},
          gw:{fn:function(p){var pg=Number(p.grossWeight||p.gw||0);var q=Number(p.qty||0);return fmtM(audience==='customs'?pg:(pg*q||pg));},defaultAlign:"right",defaultWidth:"80px"},
          cbm:{fn:function(p){return fmtM(cbmOf(p),3);},defaultAlign:"right",defaultWidth:"70px"},
        };
	        var _fallbackColsPL=(audience==="customs")?[
	          {k:"sku",al:"center",w:"70px",fn:_plFnMap.sku.fn,lbl:"CP Code"},
	          {k:"name",al:"",fn:_plFnMap.name.fn,lbl:"Description &amp; Size"},
	          {k:"qty",al:"center",w:"55px",lbl:"CTN"},
	          {k:"unit",al:"center",w:"50px",fn:_plFnMap.unit.fn,lbl:"Unit"},
	          {k:"nw",al:"right",w:"80px",fn:_plFnMap.nw.fn,lbl:"TOTAL NW (KG)"},
	          {k:"gw",al:"right",w:"80px",fn:_plFnMap.gw.fn,lbl:"TOTAL GW (KG)"},
	          {k:"cbm",al:"right",w:"70px",fn:_plFnMap.cbm.fn,lbl:"CBM (CU.M.)"},
	        ]:[
	          {k:"barcode",al:"center",w:"120px",fn:_plFnMap.barcode.fn,lbl:"BARCODE"},
	          {k:"name",al:"",fn:_plFnMap.name.fn,lbl:"Description &amp; Size"},
	          {k:"qty",al:"center",w:"75px",fn:_plFnMap.qty.fn,lbl:"QTY"},
	          {k:"nw",al:"right",w:"85px",fn:_plFnMap.nw.fn,lbl:"N.W. (KG)"},
	          {k:"gw",al:"right",w:"85px",fn:_plFnMap.gw.fn,lbl:"G.W. (KG)"},
	          {k:"cbm",al:"right",w:"75px",fn:_plFnMap.cbm.fn,lbl:"CBM (M³)"},
	        ];
	        var _dbColsPL=await loadDocColConfig(pool,"pl");
	        var colsPL=(audience==="customs")?buildColsFromConfig(_dbColsPL,_plFnMap,_fallbackColsPL):_fallbackColsPL;
        // 2026-05-19: PL 不显示 Currency (无金额信息); buyer label = "Buyer / Consignee"
        // Doc No + Issued 移到 footer via wrap docRef
        var _fsNoPL = (raw.fs_no || raw.internal_no || (ordNo||noPL)) + "-PL";
        _packBodies.pl=`
          ${docHdr(cfg,"装箱单","PACKING LIST",audience)}
          ${buyerBlock(cust,caddr,ctel,(_primaryContractNo||noPL),"Contract No.",ordNo,date,"")}
          <table><thead><tr><th style="width:36px">NO.</th>${colsPL.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
	          <tbody>${productRows(prods,colsPL,curr)}
	          ${audience==="customs"?`<tr class="total-row"><td colspan="3" class="text-right" style="color:#555;font-size:11px">SHIPPING MARKS: N/M &nbsp;&nbsp; TOTAL:</td><td style="text-align:center">${_plQtyUnit(tqty,"CTN")}</td><td></td><td class="text-right">${fmtM(tnw)}</td><td class="text-right">${fmtM(tgw)}</td><td class="text-right">${fmtM(tcbmPL,3)}</td></tr>`:`<tr class="total-row"><td colspan="3" class="text-right" style="color:#555;font-size:11px">SHIPPING MARKS: N/M &nbsp;&nbsp; TOTAL:</td><td style="text-align:center">${_plQtyUnit(tqty,"CTN")}</td><td class="text-right">${fmtM(tnw)}</td><td class="text-right">${fmtM(tgw)}</td><td class="text-right">${fmtM(tcbmPL,3)}</td></tr>`}
	          </tbody></table>${sigBlock(cfg.seal_url)}`; html=wrap((ordNo||noPL)+"_PL",_packBodies.pl,ap,{docNo:_fsNoPL,date:date});

      if(_PACK){
        // 不自己拼版式：复用现有单据模板，每张各放一个原样 .container（跟单张完全一致），
        // 用 page-break 分成 3 页。
        var _ct =function(b){return b?'<div class="container">'+b+'</div>':'';};
        var _ctp=function(b){return b?'<div class="container" style="page-break-before:always">'+b+'</div>':'';};
        // 屏幕上：灰底 + 每张白纸带阴影间距 → 看着就是 3 张分开的纸；打印/存PDF = 3 页。
        var _packCss='<style>@media screen{body{background:#e5e7eb;padding:24px 0;}.container{box-shadow:0 3px 16px rgba(0,0,0,.18);margin:0 auto 28px;padding:42px;}}@media print{.no-print{display:none!important;}}</style>';
        var _btn='<div class="no-print" style="position:fixed;top:12px;right:12px;z-index:9999;display:flex;gap:8px">'
          +'<button onclick="var u=location.href;location.href=u+(u.indexOf(\'?\')<0?\'?\':\'&\')+\'format=pdf\'" style="padding:9px 18px;background:#2563eb;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.3)">⬇ 下载 PDF（3页）</button>'
          +'<button onclick="window.print()" style="padding:9px 18px;background:#111;color:#fff;border:none;border-radius:8px;cursor:pointer;font-size:13px;box-shadow:0 2px 8px rgba(0,0,0,.3)">🖨 打印</button>'
          +'</div>';
        html=`<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${esc((ordNo||id)+" 报关 PL·SC·IV")}</title>${CSS}${_packCss}</head><body>${_btn}`
          +_ct(_packBodies.pl)+_ctp(_packBodies.sc)+_ctp(_packBodies.iv)
          +`</body></html>`;
      }
	        var _plDetailXlsx=(audience!=="customs");
	        _xlsCapture={sheetName:"Packing List",docNo:(ordNo||noPL)+"_PL",buyer:cust,buyerAddr:caddr,date:date,cno:cno,curr:"",pol:pol,pod:pod,incoterm:inco,poNo:ordNo,seller:{nameEN:cfg.nameEN,address:cfg.address,tel:cfg.tel,email:cfg.email},
	          headers:_plDetailXlsx?["NO.","BARCODE","Description & Size","QTY","TOTAL NW (KG)","TOTAL GW (KG)","CBM (CU.M.)"]:["NO.","CP Code","Description & Size","QTY","Unit","TOTAL NW (KG)","TOTAL GW (KG)","CBM (CU.M.)"],
	          colKeys:(_plDetailXlsx?[{k:"barcode",fn:function(p){return _plBarcodeOf(p);}}]:[{k:"sku",fn:function(p){return _plSkuOf(p);}}]).concat([{k:"name",fn:function(p){
	            // PL Excel — same rule: always real product name (see colsPL above)
	            var n = pick(p.productName, p.name, p.description, "-");
	            var sz = p.size || p.spec || "";
	            return sz ? n + " (" + sz + ")" : n;
	          }},{k:"qty",fn:function(p){return _plQtyUnit(p.qty,_plDetailXlsx?_plUnitOf(p):"CTN");}}]).concat(_plDetailXlsx?[]:[{k:"unit",fn:function(p){return p.unit||p.unitOfMeasure||"CTN";}}]).concat([{k:"nw",fn:function(p){var pn=Number(p.netWeight||p.nw||0);var q=Number(p.qty||0);return parseFloat((pn*q||pn).toFixed(2))||0;}},{k:"gw",fn:function(p){var pg=Number(p.grossWeight||p.gw||0);var q=Number(p.qty||0);return parseFloat(((audience==='customs')?pg:(pg*q||pg)).toFixed(2))||0;}},{k:"cbm",fn:function(p){return parseFloat(cbmOf(p).toFixed(3))||0;}}]),
	          rows:prods,totals:_plDetailXlsx?["","","GRAND TOTAL:",_plQtyUnit(tqty,"CTN"),parseFloat(tnw.toFixed(2)),parseFloat(tgw.toFixed(2)),parseFloat(tcbmPL.toFixed(3))]:["","","GRAND TOTAL:",_plQtyUnit(tqty,"CTN"),"",parseFloat(tnw.toFixed(2)),parseFloat(tgw.toFixed(2)),parseFloat(tcbmPL.toFixed(3))]};
        if(_PACK && format==="xlsx"){
          _xlsCapture=await _buildPackXlsCaptureFromOLI();
        }
      }

      if(type==="pi"){
        const { renderPi } = await import("./docs/pi.js");
        ({ html, _xlsCapture, totRow } = await renderPi({ pool, raw, order:o, ordNo, cno, curr, cfg, cust, caddr, ctel, date, pol, pod, inco, prods, tot, html, _xlsCapture, totRow, audience, ap, esc, pick, fmtM, wrap, docHdr, buyerBlock, productRows, termsCard, bankCard, sigBlock, loadDocColConfig, buildColsFromConfig, resolveUnitPrice, mkTotRow }));
      }

      if(type==="po"){
        const { renderPo } = await import("./docs/po.js");
        ({ html, _xlsCapture, totRow } = await renderPo({ pool, o, raw, prods, tqty, cfg, ordNo, cno, id, html, _xlsCapture, totRow, ap, esc, pick, fmtM, fmtD, wrap }));
      }
    }

    if(["so","debit","freight-quote","sq","tr"].includes(type)){
      // 2026-05-19: accept _id / shipment_no / contract_no / bl_no
      var spR=await pool.query(
        "SELECT * FROM shipping_plans WHERE _id=$1 OR shipment_no=$1 OR contract_no=$1 OR bl_no=$1 OR id::text=$1 OR order_contract_nos ILIKE '%'||$1||'%' LIMIT 1",
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
        const { renderSo } = await import("./docs/so.js");
        ({ html, _xlsCapture, totRow } = await renderSo({ sp, spraw, cfg3, fwd, shipper, consignee, consAddr, vessel, voyage, polSp, podSp, etd, cutoff, ctype, cqty, tgwSp, tcbm, soNo, cargoByOrder, cargoLines, _cargoHTML, html, _xlsCapture, totRow, ap, esc, pick, fmtD, wrap }));
      }

      if(type==="debit"){
        const { renderDebit } = await import("./docs/debit.js");
        html = renderDebit({
          sp, spraw, cust, _fmtVariant, soNo, cqty, cfg3, consignee, consAddr,
          fmtD, etd, vessel, voyage, polSp, podSp, fmtM, esc, ap, pick,
        });
      }

      // ──────────────────────────────────────────────────────────────────────
      // SO 海运单 Shipping Order / SQ 海运确认报价 Freight Quote
      // 2026-05-19: 用现有模板库设计 (freight-quote-enrich-2026-04.html)
      // 同一 dark-theme 模板，标题/内容不同；自动从 shipping_plans 填字段
      // ──────────────────────────────────────────────────────────────────────
      if(type==="so" || type==="freight-quote" || type==="sq"){
        const { renderSoSqFreight } = await import("./docs/so-sq-freight.js");
        ({ html, _xlsCapture, totRow } = await renderSoSqFreight({ type, sp, spraw, raw, cfg3, soNo, html, _xlsCapture, totRow, ap, esc, pick, fmtD }));
      }

      if(type==="tr"){
        const { renderTr } = await import("./docs/tr.js");
        ({ html, _xlsCapture, totRow } = await renderTr({ sp, spraw, cfg3, fwd, vessel, voyage, polSp, podSp, soNo, html, _xlsCapture, totRow, ap, esc, pick, fmtD }));
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
      if(Array.isArray(_xlsCapture.sheets)&&_xlsCapture.sheets.length){
        var _CLM=function(n){var s="";while(n>0){var m=(n-1)%26;s=String.fromCharCode(65+m)+s;n=Math.floor((n-1)/26);}return s;};
        var _GREY2="FF8A94A6",_DARK2="FF1A1A1A";
        function _stripCN2(t){var s=String(t||"");if(s.indexOf("/")>=0)s=s.split("/").pop();return s.replace(/[\u4e00-\u9fff:：]/g,"").trim();}
        function _addSheet(cap){
          var ws=wb.addWorksheet(cap.sheetName||cap.docNo);
          var _sel=cap.seller||{}, _LC=(cap.headers||[]).length||5, _RC=_CLM(_LC), _half=Math.max(1,Math.floor(_LC/2)), _HC=_CLM(_half), _RC2=_CLM(_half+1);
          ws.pageSetup={paperSize:9,orientation:"portrait",fitToPage:true,fitToWidth:1,fitToHeight:0,
            margins:{left:0.4,right:0.4,top:0.45,bottom:0.45,header:0.2,footer:0.2}};
          ws.mergeCells("A1:"+_HC+"1");
          var _co=ws.getCell("A1");
          _co.value={richText:[{text:(_sel.nameEN||"SANLYN").toUpperCase()+"\n",font:{bold:true,size:10,color:{argb:_DARK2}}},{text:(_sel.address||""),font:{size:7.5,color:{argb:_GREY2}}}]};
          _co.alignment={vertical:"middle",wrapText:true};
          ws.mergeCells(_RC2+"1:"+_RC+"1");
          var _tt=ws.getCell(_RC2+"1"); _tt.value=(cap.sheetName||"").toUpperCase();
          _tt.font={bold:true,size:18,color:{argb:_DARK2}}; _tt.alignment={horizontal:"right",vertical:"middle"};
          ws.getRow(1).height=40;
          ws.mergeCells("A2:"+_HC+"2"); ws.mergeCells(_RC2+"2:"+_RC+"2");
          ws.getCell("A2").value="BUYER (BILL TO)"; ws.getCell("A2").font={bold:true,size:7.5,color:{argb:_GREY2}};
          ws.getCell(_RC2+"2").value="DETAILS"; ws.getCell(_RC2+"2").font={bold:true,size:7.5,color:{argb:_GREY2}};
          ws.mergeCells("A3:"+_HC+"3"); ws.mergeCells(_RC2+"3:"+_RC+"3");
          ws.getCell("A3").value=cap.buyer||""; ws.getCell("A3").font={bold:true,size:9,color:{argb:_DARK2}};
          ws.getCell(_RC2+"3").value={richText:[{text:(cap.noLabel||"No.:")+" ",font:{bold:true,size:8,color:{argb:_GREY2}}},{text:String(cap.docNo||""),font:{size:8.5,color:{argb:_DARK2}}}]};
          ws.mergeCells("A4:"+_HC+"5");
          ws.getCell("A4").value=cap.buyerAddr||""; ws.getCell("A4").font={size:8,color:{argb:_DARK2}}; ws.getCell("A4").alignment={wrapText:true,vertical:"top"};
          ws.mergeCells(_RC2+"4:"+_RC+"4");
          ws.getCell(_RC2+"4").value={richText:[{text:"Order: ",font:{bold:true,size:8,color:{argb:_GREY2}}},{text:String(cap.poNo||cap.cno||""),font:{size:8.5,color:{argb:_DARK2}}}]};
          ws.mergeCells(_RC2+"5:"+_RC+"5");
          ws.getCell(_RC2+"5").value=cap.hideCurrency
            ? {richText:[{text:"Date: ",font:{bold:true,size:8,color:{argb:_GREY2}}},{text:String(cap.date||""),font:{size:8.5,color:{argb:_DARK2}}}]}
            : {richText:[{text:"Date: ",font:{bold:true,size:8,color:{argb:_GREY2}}},{text:String(cap.date||""),font:{size:8.5,color:{argb:_DARK2}}},{text:"   Currency: ",font:{bold:true,size:8,color:{argb:_GREY2}}},{text:String(cap.curr||""),font:{size:8.5,color:{argb:_DARK2}}}]};
          for(var _sc=1;_sc<=_LC;_sc++){ ws.getCell(5,_sc).border={bottom:{style:"thin",color:{argb:_DARK2}}}; }

          var hdrRow=ws.addRow(cap.headers);
          hdrRow.eachCell(function(c){c.font={bold:true,color:{argb:"FFFFFFFF"}};c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF111111"}};c.alignment={horizontal:"center",vertical:"middle"};c.border={top:{style:"thin",color:{argb:"FF999999"}},bottom:{style:"thin",color:{argb:"FF999999"}},left:{style:"thin",color:{argb:"FFCCCCCC"}},right:{style:"thin",color:{argb:"FFCCCCCC"}}};});
          ws.getColumn(1).width=6;
          var _nameIdx=2+cap.colKeys.findIndex(function(k){return k.k==="name";});
	          if(_nameIdx>=2){ws.getColumn(_nameIdx).width=34;ws.getColumn(_nameIdx).alignment={wrapText:true,vertical:"top"};}
	          cap.colKeys.forEach(function(k,i){
	            var col=ws.getColumn(i+2);
	            if(k.k==="code") col.width=12;
	            if(k.k==="barcode") col.width=18;
	          });
          var _lastColL=_CLM(_LC);
          var rowNum=0;
          (cap.rows||[]).forEach(function(p){
            if(p&&p.isHeader){
              var gr=ws.addRow([p.label||""]);
              ws.mergeCells("A"+gr.number+":"+_lastColL+gr.number);
              gr.height=18;
              gr.getCell(1).font={bold:true,size:9,color:{argb:"FF1e40af"}};
              gr.getCell(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFe8eeff"}};
              gr.getCell(1).alignment={horizontal:"left",vertical:"middle",wrapText:true};
              gr.getCell(1).border={top:{style:"thin",color:{argb:"FFb8c4e8"}},bottom:{style:"thin",color:{argb:"FFb8c4e8"}}};
              return;
            }
            rowNum++;
            var cells=[String(rowNum).padStart(2,"0")];
	            cap.colKeys.forEach(function(k){ var v=k.fn?k.fn(p):(p[k.k]||""); var s=String(v).replace(/,/g,""); var n=/^-?\d+(\.\d+)?$/.test(s)?parseFloat(s):NaN; cells.push((k.k==="barcode"||k.k==="code")?String(v||""):(isNaN(n)?v:n)); });
            var dr=ws.addRow(cells), alt=(rowNum%2===0);
            dr.eachCell(function(c,ci){
              c.border={top:{style:"hair",color:{argb:"FFDDDDDD"}},bottom:{style:"hair",color:{argb:"FFDDDDDD"}},left:{style:"hair",color:{argb:"FFEEEEEE"}},right:{style:"hair",color:{argb:"FFEEEEEE"}}};
              var k=(ci>=2&&cap.colKeys[ci-2])?cap.colKeys[ci-2].k:null;
	              c.alignment={horizontal:(ci===1||k==="cp"||k==="code"||k==="barcode"||k==="qty")?"center":(k==="name"?"left":"right"),vertical:"middle",wrapText:(k==="name"||k==="cp"||k==="code"||k==="barcode")};
              if(!c.font)c.font={size:10};
              if(alt)c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFFAFAFA"}};
            });
          });
          ws.addRow([]);
          var tRow=ws.addRow(cap.totals);
          tRow.eachCell(function(c){c.font={bold:true};});
	          for(var ci=3;ci<=_LC;ci++){ if(ci!==_nameIdx && ws.getColumn(ci).width===9) ws.getColumn(ci).width=16; }
          function _sec(title){ ws.addRow([]); var r=ws.addRow([title]); ws.mergeCells("A"+r.number+":"+_lastColL+r.number); r.getCell(1).font={bold:true,size:11,color:{argb:"FFFFFFFF"}}; r.getCell(1).fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF111111"}}; }
          function _kv(label,value){ var r=ws.addRow([label,value]); r.getCell(1).font={bold:true,size:10}; r.getCell(2).font={size:10}; ws.mergeCells("B"+r.number+":"+_lastColL+r.number); }
          if(cap.incoterm){ ws.addRow([]); _kv("Trade Terms:","("+cap.incoterm+") Incoterms® 2020"); }
          if(Array.isArray(cap.terms)&&cap.terms.length){ _sec("TERMS & CONDITIONS"); cap.terms.forEach(function(t,i){ var r=ws.addRow([(i+1)+". "+_stripCN2(t)]); ws.mergeCells("A"+r.number+":"+_lastColL+r.number); r.getCell(1).alignment={wrapText:true,vertical:"top"}; r.getCell(1).font={size:10}; }); }
          var bk=cap.bank;
          if(bk&&(bk.beneficiary||bk.accountName||bk.bankName||bk.swift)){ _sec("BANKING INFORMATION"); _kv("Beneficiary:",bk.beneficiary||bk.accountName||""); if(bk.bankName)_kv("Bank:",bk.bankName); if(bk.swift)_kv("SWIFT:",bk.swift); if(bk.bankAddr)_kv("Bank Address:",bk.bankAddr); if(bk.usdAccount)_kv("Account No.:",bk.usdAccount); }
          ws.addRow([]); ws.addRow([]);
          var sigMid=Math.max(2,Math.ceil(_LC/2)), sigR1=ws.addRow([]);
          for(var si=1;si<=_LC;si++){ sigR1.getCell(si).border={top:{style:"medium",color:{argb:"FF000000"}}}; }
          var sigR2=ws.addRow([]); sigR2.getCell(1).value="BUYER AUTHORIZED SIGNATURE"; sigR2.getCell(sigMid+1).value="SELLER AUTHORIZED SIGNATURE";
          ws.mergeCells("A"+sigR2.number+":"+_CLM(sigMid)+sigR2.number); ws.mergeCells(_CLM(sigMid+1)+sigR2.number+":"+_lastColL+sigR2.number);
          sigR2.getCell(1).font={bold:true,size:10}; sigR2.getCell(sigMid+1).font={bold:true,size:10}; sigR2.getCell(1).alignment={horizontal:"center"}; sigR2.getCell(sigMid+1).alignment={horizontal:"center"};
        }
        _xlsCapture.sheets.forEach(_addSheet);
        res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition","attachment; filename=\""+(_xlsCapture.docNo||"PACK")+".xlsx\"");
        res.setHeader("Cache-Control","no-store");
        var mbuf=await wb.xlsx.writeBuffer();
        return res.status(200).send(Buffer.from(mbuf));
      }
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

      // ── 紧凑头部 + A4打印(2026-06-29 对齐Damon参考模板,去SHIPPER/CONSIGNEE蓝块)──
      ws.pageSetup={paperSize:9,orientation:"portrait",fitToPage:true,fitToWidth:1,fitToHeight:0,
        margins:{left:0.4,right:0.4,top:0.45,bottom:0.45,header:0.2,footer:0.2}};
      var _RC=_CL(_LC), _HC=_CL(_half), _RC2=_CL(_half+1);
      ws.mergeCells("A1:"+_HC+"1");
      var _co=ws.getCell("A1");
      _co.value={richText:[{text:(_sel.nameEN||"SANLYN").toUpperCase()+"\n",font:{bold:true,size:10,color:{argb:_DARK}}},{text:(_sel.address||""),font:{size:7.5,color:{argb:_GREY}}}]};
      _co.alignment={vertical:"middle",wrapText:true};
      ws.mergeCells(_RC2+"1:"+_RC+"1");
      var _tt=ws.getCell(_RC2+"1");_tt.value=(_xlsCapture.sheetName||"").toUpperCase();
      _tt.font={bold:true,size:18,color:{argb:_DARK}};_tt.alignment={horizontal:"right",vertical:"middle"};
      ws.getRow(1).height=40;
      ws.mergeCells("A2:"+_HC+"2");ws.mergeCells(_RC2+"2:"+_RC+"2");
      var _b2=ws.getCell("A2");_b2.value="BUYER (BILL TO)";_b2.font={bold:true,size:7.5,color:{argb:_GREY}};
      var _d2=ws.getCell(_RC2+"2");_d2.value="DETAILS";_d2.font={bold:true,size:7.5,color:{argb:_GREY}};
      ws.getRow(2).height=13;
      ws.mergeCells("A3:"+_HC+"3");ws.mergeCells(_RC2+"3:"+_RC+"3");
      var _bn=ws.getCell("A3");_bn.value=_xlsCapture.buyer||"";_bn.font={bold:true,size:9,color:{argb:_DARK}};
      ws.getCell(_RC2+"3").value={richText:[{text:"No.: ",font:{bold:true,size:8,color:{argb:_GREY}}},{text:String(_xlsCapture.docNo||""),font:{size:8.5,color:{argb:_DARK}}}]};
      ws.getRow(3).height=13;
      ws.mergeCells("A4:"+_HC+"5");
      var _ba=ws.getCell("A4");_ba.value=_xlsCapture.buyerAddr||"";_ba.font={size:8,color:{argb:_DARK}};_ba.alignment={wrapText:true,vertical:"top"};
      ws.mergeCells(_RC2+"4:"+_RC+"4");
      ws.getCell(_RC2+"4").value={richText:[{text:"Order: ",font:{bold:true,size:8,color:{argb:_GREY}}},{text:String(_xlsCapture.poNo||_xlsCapture.cno||""),font:{size:8.5,color:{argb:_DARK}}}]};
      ws.mergeCells(_RC2+"5:"+_RC+"5");
      ws.getCell(_RC2+"5").value={richText:[{text:"Date: ",font:{bold:true,size:8,color:{argb:_GREY}}},{text:String(_xlsCapture.date||""),font:{size:8.5,color:{argb:_DARK}}},{text:"   Currency: ",font:{bold:true,size:8,color:{argb:_GREY}}},{text:String(_xlsCapture.curr||""),font:{size:8.5,color:{argb:_DARK}}}]};
      ws.getRow(4).height=13;ws.getRow(5).height=13;
      for(var _sc=1;_sc<=_LC;_sc++){ws.getCell(5,_sc).border={bottom:{style:"thin",color:{argb:_DARK}}};}

      // Header
      var hdrRow=ws.addRow(_xlsCapture.headers);
      hdrRow.eachCell(function(c){c.font={bold:true,color:{argb:"FFFFFFFF"}};c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FF111111"}};c.alignment={horizontal:"center",vertical:"middle"};c.border={top:{style:"thin",color:{argb:"FF999999"}},bottom:{style:"thin",color:{argb:"FF999999"}},left:{style:"thin",color:{argb:"FFCCCCCC"}},right:{style:"thin",color:{argb:"FFCCCCCC"}}};});hdrRow.height=20;
      ws.getColumn(1).width=6;
      // 动态定位品名列(col1=NO,之后按colKeys顺序;加了CP Code后品名不再固定在col2)
      var _nameIdx=2+_xlsCapture.colKeys.findIndex(function(k){return k.k==="name";});
	      if(_nameIdx>=2){ws.getColumn(_nameIdx).width=34;ws.getColumn(_nameIdx).alignment={wrapText:true,vertical:"top"};}
	      _xlsCapture.colKeys.forEach(function(k,i){
	        var col=ws.getColumn(i+2);
	        if(k.k==="code") col.width=12;
	        if(k.k==="barcode") col.width=18;
	      });

      // Data rows
      var rowNum=0;
      var lastGrp="";
      _xlsCapture.rows.forEach(function(p){
        if(p&&p.isHeader){
          var hRow=ws.addRow(["",p.label||""]);
          hRow.eachCell(function(c){c.font={bold:true,color:{argb:"FF1e40af"}};c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFe8eeff"}};c.alignment={horizontal:"left",vertical:"middle"};});
          ws.mergeCells("B"+hRow.number+":"+_CL(_LC)+hRow.number);
          return;
        }
        // Group header
        var grp=p._groupKey||"";
        if(grp&&grp!==lastGrp){
          var gRow=ws.addRow(["","ORDER "+(p._customerPO||"")+(p._containerNo?" · "+p._containerNo:"")+(p._contractNo?" · "+p._contractNo:"")]);
          gRow.eachCell(function(c){c.font={bold:true,color:{argb:"FF1e40af"}};c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFe8eeff"}};});
          ws.mergeCells("B"+gRow.number+":"+_CL(_LC)+gRow.number);
          lastGrp=grp;
        }
        rowNum++;
        var cells=[String(rowNum).padStart(2,"0")];
        _xlsCapture.colKeys.forEach(function(k){
	          var v=k.fn?k.fn(p):(p[k.k]||"");
	          // Strip commas from numbers
	          var s=String(v).replace(/,/g,"");
	          var n=/^-?\d+(\.\d+)?$/.test(s)?parseFloat(s):NaN;
	          cells.push((k.k==="barcode"||k.k==="code")?String(v||""):(isNaN(n)?v:n));
        });
        var dr=ws.addRow(cells);
        var _alt=(rowNum%2===0);
        dr.eachCell(function(c,ci){
          c.border={top:{style:"hair",color:{argb:"FFDDDDDD"}},bottom:{style:"hair",color:{argb:"FFDDDDDD"}},left:{style:"hair",color:{argb:"FFEEEEEE"}},right:{style:"hair",color:{argb:"FFEEEEEE"}}};
          var _key=(ci>=2&&_xlsCapture.colKeys[ci-2])?_xlsCapture.colKeys[ci-2].k:null;
	          var h=(ci===1)?"center":(_key==="name")?"left":(_key==="sku"||_key==="code"||_key==="barcode"||_key==="unit"||_key==="qty")?"center":"right";
          // ALIGN-FIX-2026-05-20: keep vertical:middle for ALL cells incl. numeric
          // (the old override loop dropped it → numbers floated to bottom).
	          c.alignment={horizontal:h,vertical:"middle",wrapText:(_key==="name"||_key==="code"||_key==="barcode")};
          if(!c.font)c.font={size:10};
          if(_alt)c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFFAFAFA"}};
        });
      });

      // Totals row
      ws.addRow([]);
      var tRow=ws.addRow(_xlsCapture.totals);
      tRow.eachCell(function(c,ci){c.font={bold:true};if(ci===tRow.cellCount)c.numFmt="#,##0.00";});

      // Column widths for numeric cols
	      for(var ci=3;ci<=_xlsCapture.headers.length;ci++){ if(ci!==_nameIdx && ws.getColumn(ci).width===9) ws.getColumn(ci).width=16; }

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
        var puppeteer=(await import("puppeteer-core")).default;
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
        var _pdfNameOverride = "";
        // 2026-07-02 type=pack 的 PDF 改成 puppeteer 直接 goto 正版可编辑模版(export-docs)
        // 渲染,与浏览器视图/在线查看一致(海关分组/品名明细/港口回退/自动盖章),不再用旧服务端HTML。
        if (type === "pack") {
          var _pmode2 = (req.query.customs === "1" || req.query.mode === "customs") ? "" : "&mode=detail";
          var _ptok2 = req.query.token || reqToken || "";
          var _ppage2 = /^(pl|sc|iv)$/.test(String(req.query.page||"").toLowerCase()) ? String(req.query.page).toLowerCase() : "";
          var _plang2 = (String(req.query.lang||"").toLowerCase() === "en") ? "&lang=en" : "";
          var _pctn2 = req.query.container_no ? "&container_no=" + encodeURIComponent(String(req.query.container_no)) : "";
          var _tplUrl = "https://api.sanlyn.cn/templates/export-docs-template.html?order_no=" + encodeURIComponent(id||"")
            + "&ids=" + encodeURIComponent(ids||id||"") + _pmode2 + _plang2 + _pctn2
            + (_ppage2 ? "&page=" + encodeURIComponent(_ppage2) : "")
            + "&token=" + encodeURIComponent(_ptok2);
          await page.goto(_tplUrl, {waitUntil:"networkidle0", timeout:60000});
          await new Promise(function(r){ setTimeout(r, 1800); });
          try { _pdfNameOverride = await page.title(); } catch (_) {}
        } else {
          // W0-3: scrub leaked codes BEFORE rendering to PDF (default = customer-facing).
          var _pdfHtml = (String(_audReq||"").toLowerCase() === "customs") ? html : scrubCustomerFacingHtml(html);
          await page.setContent(_pdfHtml,{waitUntil:"networkidle0"});
        }
        var pdfBuf=await page.pdf({
          format:"A4",
          printBackground:true,
          margin:{top:"14mm",bottom:"14mm",left:"12mm",right:"12mm"},
        });
        await browser.close();
        // Infer a filename from the html (grab first <title> tag)
        var titleMatch=html.match(/<title[^>]*>([^<]+)<\/title>/i);
        var pdfName=((_pdfNameOverride || (titleMatch&&titleMatch[1]) || "document").replace(/[^A-Za-z0-9_\-\.]/g,"_"))+".pdf";
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
    // W0-3: scrub leaked codes from customer-facing HTML (default).
    // Only audience=customs (internal broker) sees raw codes.
    var _outHtml = (String(_audReq||"").toLowerCase() === "customs") ? html : scrubCustomerFacingHtml(html);
    return res.status(200).send(_outHtml);
  }catch(err){
    return res.status(500).send("<h1>Error: "+esc(err.message)+"</h1>");
  }
}
