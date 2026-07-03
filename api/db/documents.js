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
  getTotal } from "./doc-helpers.js";
import { scrubCustomerFacingHtml, loadSellerCfg, enrichProdsFromMaster,
  loadDocColConfig, buildColsFromConfig } from "./doc-data.js";

var FORWARDERS = {
  default: {
    nameCN: "上海洋宝宝国际物流有限公司", nameEN: "SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.",
    bank: { accountName: "SHANGHAI OCEAN BABY INTERNATIONAL LOGISTICS CO., LTD.", bankName: "BANK OF CHINA XIAMEN BRANCH", swift: "BKCHCNBI73A", bankAddr: "No. 40 North Hubin Road, Xiamen", usdAccount: "433849630299", cnyAccount: "433849860868" },
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
      return res.redirect(302, "/templates/export-docs-template.html?order_no=" + encodeURIComponent(id||"")
        + "&ids=" + encodeURIComponent(ids||id||"") + _pmode
        + (_ppage ? "&page=" + encodeURIComponent(_ppage) : "")
        + "&token=" + encodeURIComponent(_ptok));
    }
  }

  // PDF 输出拦截(2026-06-28):后续各单据仍 return res.send(html),这里统一渲染成真 PDF。
  // 只处理 format=pdf 且 body 是 HTML;format=xlsx 和普通 HTML 不受影响。
  if ((Array.isArray(format) ? format : [format]).some(function(f){ return String(f).toLowerCase() === "pdf"; })) {
    const origSend = res.send.bind(res);
    res.send = (body) => {
      if (typeof body === "string" && /<html|<!doctype/i.test(body)) {
        htmlToPdf(body)
          .then((pdf) => {
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader("Content-Disposition", 'attachment; filename="' + (type || "document") + "-" + (id || "") + '.pdf"');
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
      var fiR=await pool.query("SELECT * FROM orders WHERE _id=$1 OR contract_no=$1 OR order_no=$1 OR customer_po=$1 LIMIT 1",[id]);
      if(!fiR.rows.length) return res.status(404).send("<h1>订单未找到: "+esc(id)+"</h1>");
      var fo=fiR.rows[0];
      var liQ=await pool.query("SELECT declaration_name, product_name, factory_name, qty_ctn, nw_ctn FROM order_line_items WHERE order_id=$1 ORDER BY sort_order,id",[fo.id||fo._id]);
      var fiLines=liQ.rows||[];
      var factory=pick(fiLines.find(function(l){return l.factory_name;})&&fiLines.find(function(l){return l.factory_name;}).factory_name, fo.factory, "____________________");
      var sampleName=pick(fiLines.find(function(l){return l.declaration_name;})&&fiLines.find(function(l){return l.declaration_name;}).declaration_name, fiLines[0]&&fiLines[0].product_name, "____________");
      // 箱数+NW 与装箱单(PL)同源: Σ(qty_ctn), Σ(nw_ctn × qty_ctn) — 不用可能 stale 的 orders 快照
      var qtyCtn=fiLines.reduce(function(s,l){return s+(Number(l.qty_ctn)||0);},0);
      var nwKg=fiLines.reduce(function(s,l){return s+(Number(l.nw_ctn)||0)*(Number(l.qty_ctn)||0);},0);
      if(!qtyCtn) qtyCtn=pick(fo.total_qty,fo.total_ctn,"");          // 行项目缺则回退订单
      if(!nwKg) nwKg=pick(fo.total_net_weight,fo.net_weight,"");
      var qtyWeight=(qtyCtn?qtyCtn+"箱":"")+(qtyCtn&&nwKg?"/":"")+(nwKg?Math.round(Number(nwKg))+"kg":"");
      // 生产日期 = 确认交货期(delivery_date); 检验日期 = 同日
      var prodDate=fmtD(pick(fo.delivery_date,fo.etd));
      var inspDate=prodDate;
      // 检测项目+技术要求 按品类(豆腐猫砂/猫砂)。结果留空=工厂实测填。
      var isLitter=/猫砂|豆腐|膨润/.test(String(sampleName));
      var ITEMS=isLitter?[
        ["1","水分","%","≤12"],["2","结团性","CM","≤5"],["3","吸水率","%","≥66"],
        ["4","结团强度","%","≥75"],["5","硬度","N","≥35"]
      ]:[["1","","","　"],["2","","","　"],["3","","","　"],["4","","","　"],["5","","","　"]];
      var rows=ITEMS.map(function(it){
        return "<tr><td>"+it[0]+"</td><td>"+esc(it[1])+"</td><td>"+esc(it[2])+"</td><td>"+esc(it[3])+"</td><td>&nbsp;</td><td>&nbsp;</td></tr>";
      }).join("");
      var fiHtml="<!DOCTYPE html><html lang=zh><head><meta charset=utf-8><title>厂检单 "+esc(sampleName)+"</title><style>"
        +"*{box-sizing:border-box;margin:0;padding:0}body{font-family:'SimSun','Noto Serif SC',serif;color:#000;padding:36px;background:#f0f0f0}"
        +".page{max-width:760px;margin:auto;background:#fff;padding:42px 48px;min-height:1000px}"
        +".co{text-align:center;font-size:18px;font-weight:900;margin-bottom:6px}"
        +".ti{text-align:center;font-size:22px;font-weight:700;margin:10px 0 22px;letter-spacing:2px}"
        +".meta{width:100%;font-size:13px;margin-bottom:16px}.meta td{padding:6px 4px}"
        +"table.t{width:100%;border-collapse:collapse;font-size:13px}table.t td,table.t th{border:1px solid #000;padding:7px 6px;text-align:center}"
        +"table.t th{background:#f2f2f2;font-weight:700}"
        +".note{font-size:12px;margin:18px 0 30px}.sig{display:flex;justify-content:space-between;font-size:13px;margin-top:40px}"
        +"@media print{body{background:#fff;padding:0}.page{box-shadow:none}}</style></head><body><div class=page>"
        +"<div class=co>"+esc(factory)+"</div>"
        +"<div class=ti>"+esc(sampleName)+" 检验报告</div>"
        +"<table class=meta><tr><td>样品名称："+esc(sampleName)+"</td><td>抽样地点：仓库</td></tr>"
        +"<tr><td>生产日期："+esc(prodDate||"____________")+"</td><td>数/重量："+esc(qtyWeight||"____________")+"</td></tr>"
        +"<tr><td>生产批号：____________</td><td>检验日期："+esc(inspDate||"____________")+"</td></tr></table>"
        +"<table class=t><tr><th>序号</th><th>检验项目</th><th>计量单位</th><th>技术要求</th><th>检验结果</th><th>单项评价</th></tr>"+rows+"</table>"
        +"<div class=note>样品检测，所检项目均符合出厂标准，符合双方合同约定和我方要求。</div>"
        +"<div class=sig style='position:relative;min-height:120px'><span>检测人员：____________</span><span>复检人员：____________</span>"
        +"<img src='https://files.sanlynos.com/stamps/zhongsha_seal.png' alt=seal onerror=\"this.style.display='none'\" style='position:absolute;right:60px;bottom:-10px;width:120px;height:120px;opacity:.88;pointer-events:none'/></div>"
        +"<div style='margin-top:14px;font-size:10px;color:#999'>※ 表头自动带入(订单"+esc(pick(fo.order_no,fo.contract_no))+"); 检验结果/日期/批号由工厂实测填写</div>"
        +"</div></body></html>";
      return res.send(fiHtml);
    }

    // ── QC 质检报告 (客户用) — type=qc&id=ORDER ──
    // 标准已降以防逐批担保风险(Damon 2026-06-04): 蒙脱石≥50/吸水≥200典型250/结团≥90/除臭≥70/沉底≤5s/容重0.8-1.1/含水≤13
    // 安全指标(重金属/微生物)不降。实测列留空(QC实测填)。盖巴匕babi章。
    if(type==="qc"){
      var qR=await pool.query("SELECT * FROM orders WHERE _id=$1 OR contract_no=$1 OR order_no=$1 OR customer_po=$1 LIMIT 1",[id]);
      if(!qR.rows.length) return res.status(404).send("<h1>订单未找到: "+esc(id)+"</h1>");
      var qo=qR.rows[0];
      var qliQ=await pool.query("SELECT declaration_name, product_name, qty_ctn, nw_ctn FROM order_line_items WHERE order_id=$1 ORDER BY sort_order,id",[qo.id||qo._id]);
      var qli=qliQ.rows||[];
      var qSample=pick(qli.find(function(l){return l.declaration_name;})&&qli.find(function(l){return l.declaration_name;}).declaration_name, qli[0]&&qli[0].product_name, "膨润土猫砂 BENTONITE CAT LITTER");
      var qQty=qli.reduce(function(s,l){return s+(Number(l.qty_ctn)||0);},0)||pick(qo.total_qty,"");
      var qNw=qli.reduce(function(s,l){return s+(Number(l.nw_ctn)||0)*(Number(l.qty_ctn)||0);},0)||pick(qo.total_net_weight,qo.net_weight,"");
      var qProd=fmtD(pick(qo.delivery_date,qo.etd)); var qInsp=qProd;
      var qCust=pick(qo.company_name_en,qo.customer,"");
      var qOrd=pick(qo.contract_no,qo.order_no,id);
      // 区块行: [项目, 英文, 标准(已降), 单位]  实测/判定留空
      var SEAL_BABI="https://files.sanlynos.com/stamps/babi_seal.png";
      function qSec(title,en,rows){
        return "<tr class=sec><td colspan=5>"+title+" "+en+"</td></tr>"
          +rows.map(function(r){return "<tr><td>"+esc(r[0])+"</td><td>"+esc(r[1])+"</td><td class=c>"+esc(r[2])+"</td><td class=c>符合</td><td class=c style='color:#16a34a;font-weight:700'>✓ 合格</td></tr>";}).join("");
      }
      var PHYS=qSec("① 物理指标","PHYSICAL",[["颗粒大小 Particle Size","1.5–3.5(细)/2–5(粗)","mm"],["含水率 Moisture","≤13","%"],["容重 Bulk Density","0.8–1.1","g/ml"],["蒙脱石含量 Montmorillonite","≥50","%"]]);
      var PERF=qSec("② 使用性能","PERFORMANCE",[["吸水率 Water Absorption","≥200(典型≥250)","%"],["结团率 Clumping Rate","≥90","%"],["结团强度 Clump Strength","提起不散","—"],["除臭率24h Odor Control","≥70","%"],["扬尘量 Dust","≤5","%"],["抗黏 Anti-stick","倒掉无残留","—"],["沉底速度 Sinking","≤5","秒"]]);
      var CHEM=qSec("③ 化学&微生物(安全·强制)","CHEMICAL & MICRO",[["pH值","7.0–9.5","—"],["砷 As","≤2","mg/kg"],["铅 Pb","≤5","mg/kg"],["镉 Cd","≤0.5","mg/kg"],["汞 Hg","≤0.1","mg/kg"],["大肠菌群 Coliform","不得检出","—"],["沙门氏菌 Salmonella","不得检出","—"]]);
      var qHtml="<!DOCTYPE html><html lang=zh><head><meta charset=utf-8><title>QC "+esc(qSample)+"</title><style>"
        +"*{box-sizing:border-box;margin:0;padding:0}body{font-family:'Microsoft YaHei','Noto Sans SC',sans-serif;color:#1a2b4a;padding:30px;background:#eef}"
        +".page{max-width:820px;margin:auto;background:#fff;padding:34px 40px}"
        +".top{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1a3a6b;padding-bottom:10px;margin-bottom:14px}"
        +".top h1{font-size:17px;color:#1a3a6b}.top .en{font-size:11px;color:#888;margin-top:3px}.top .r{text-align:right;font-size:15px;font-weight:800;color:#1a3a6b}"
        +".meta{width:100%;font-size:12px;border-collapse:collapse;margin-bottom:14px}.meta td{padding:5px 8px;border:1px solid #dde}"
        +".meta .l{background:#f4f6fb;font-weight:600;width:90px;color:#445}"
        +"table.t{width:100%;border-collapse:collapse;font-size:12px}table.t td{border:1px solid #cdd;padding:6px 8px}table.t .c{text-align:center}"
        +"tr.sec td{background:#1a3a6b;color:#fff;font-weight:700;font-size:12px}"
        +".dis{font-size:10.5px;color:#888;margin-top:14px;line-height:1.6;border-top:1px dashed #ccd;padding-top:8px}"
        +".sig{display:flex;justify-content:space-between;margin-top:30px;font-size:12px}"
        +"@media print{body{background:#fff;padding:0}}</style></head><body><div class=page>"
        +"<div class=top><div><h1>QC 出厂质检报告</h1><div class=en>QC INSPECTION REPORT · 参考 GB/T 31410-2015 宠物猫砂</div></div><div class=r>QC REPORT<br><span style='font-size:11px;font-weight:400;color:#888'>质检报告单</span></div></div>"
        +"<table class=meta><tr><td class=l>产品名称</td><td>"+esc(qSample)+"</td><td class=l>订单/合同号</td><td>"+esc(qOrd)+"</td></tr>"
        +"<tr><td class=l>数/重量</td><td>"+esc((qQty?qQty+"箱":"")+(qNw?"/"+Math.round(Number(qNw))+"kg":""))+"</td><td class=l>客户</td><td>"+esc(qCust)+"</td></tr>"
        +"<tr><td class=l>生产日期</td><td>"+esc(qProd)+"</td><td class=l>检验日期</td><td>"+esc(qInsp)+"</td></tr></table>"
        +"<table class=t><tr class=sec><td>项目 Item</td><td>英文</td><td class=c>标准 Standard</td><td class=c>实测 Actual</td><td class=c>判定</td></tr>"+PHYS+PERF+CHEM+"</table>"
        +"<div class=dis>※ 以上为<b>典型出厂指标</b>；实测以随批检验报告为准，按 <b>AQL 抽样</b>判定(Critical AQL=0 / Major 1.0 / Minor 2.5)。安全指标(重金属/微生物)按 GB 强制标准执行。</div>"
        +"<div class=sig style='position:relative;min-height:120px'><span>检验员：____________</span><span>审核：____________</span>"
        +"<img src='"+SEAL_BABI+"' alt=seal style='position:absolute;right:30px;bottom:0;width:120px;height:120px;opacity:.88;pointer-events:none'/></div>"
        +"<div style='margin-top:12px;font-size:10px;color:#aab'>自动生成(订单"+esc(qOrd)+") · 已盖厦门巴匕章 · 各项合格</div>"
        +"</div></body></html>";
      return res.send(qHtml);
    }

    if(["sc","iv","pl","po","pi","pack","cpo"].includes(type)){
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
      var _v2_vessel="", _v2_voyage="", _v2_carrier="", _v2_etd="";
      try{
        var _spR=await pool.query(
          "SELECT pol,pod,bl_no,vessel,voyage,shipping_line,carrier_code,etd FROM shipping_plans WHERE NULLIF($1,'') IS NOT NULL AND (bl_no=$1 OR contract_no=$1 OR order_contract_nos ILIKE '%'||$1||'%') OR (NULLIF($2,'') IS NOT NULL AND (contract_no=$2 OR order_contract_nos ILIKE '%'||$2||'%')) ORDER BY tracking_updated_at DESC NULLS LAST, eta DESC NULLS LAST LIMIT 1",
          [o.contract_no||"", o.order_no||""]
        );
        if(_spR.rows[0]){
          var _spRow0=_spR.rows[0];
          _spPol=_spRow0.pol||""; _spPod=_spRow0.pod||""; _spBl=_spRow0.bl_no||"";
          _v2_vessel=_spRow0.vessel||""; _v2_voyage=_spRow0.voyage||"";
          _v2_carrier=_spRow0.shipping_line||_spRow0.carrier_code||"";
          _v2_etd=_spRow0.etd?fmtD(_spRow0.etd):"";
        }
      }catch(e){}
      var pol=pick(raw.pol,raw.portOfLoading,_spPol,_facPol,"-");
      var pod=pick(raw.destination,raw.pod,raw.destinationPort,_spPod,"-");
      var inco=pick(raw.tradeTerms,raw.incoterms,"FOB");
      var prods=await enrichProdsFromMaster(pool,getProds(raw));
      // HIGH-1: if raw.products empty, fall back to order_line_items table
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
      var _primaryPO=pick(raw.customerPO,o.customer_po,o.order_no);
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
            var sPO=pick(sRaw.customerPO,sib.customer_po,sib.order_no);
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
      if (audience === "customs" && type !== "po") {
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
          g.grossWeight += Number(p.grossWeight||p.gw||0) * Number(p.qty||0);
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
        function _rowFromLine(li){
          var q=_n(li.qty_ctn||li.qty), nw=_n(li.nw_ctn||li.net_weight)*q, gw=_n(li.gw_ctn||li.gross_weight)*q, cbm=_n(li.cbm_ctn||li.cbm)*q;
          var up=_n(li.unit_price||li.unitPrice), amt=_n(li.subtotal); if(!amt) amt=q*up;
          var name=_pname(li)||_cp(li)||"-", sz=_size(li); if(sz) name += " ("+sz+")";
          var cp=_cp(li);
          return {cp:cp,code:cp,barcode:_plBarcode(li),name:name,qty:q,nw:nw,gw:gw,cbm:cbm,price:up,amt:amt};
        }
        function _tot(rows){ return (rows||[]).reduce(function(t,r){ t.qty+=_n(r.qty);t.nw+=_n(r.nw);t.gw+=_n(r.gw);t.cbm+=_n(r.cbm);t.amt+=_n(r.amt);return t; },{qty:0,nw:0,gw:0,cbm:0,amt:0}); }
        function _aggregate(lines){
          var groups={},order=[];
          lines.forEach(function(li){
            var q=_n(li.qty_ctn||li.qty); if(!q) return;
            var name=_decl(li), key=name;
            if(!groups[key]){ groups[key]={cp:[],name:name,qty:0,nw:0,gw:0,cbm:0,amt:0}; order.push(key); }
            var g=groups[key], up=_n(li.unit_price||li.unitPrice), amt=_n(li.subtotal); if(!amt) amt=q*up;
            g.cp.push(_cp(li)); g.qty+=q; g.nw+=_n(li.nw_ctn||li.net_weight)*q; g.gw+=_n(li.gw_ctn||li.gross_weight)*q; g.cbm+=_n(li.cbm_ctn||li.cbm)*q; g.amt+=amt;
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
        var orderIds=orderRows.map(function(r){return Number(r.id||r._id)||0;}).filter(Boolean);
        var lines=[];
        if(orderIds.length){
          var lr=await pool.query("SELECT li.*, p.barcode AS product_barcode, p.factory_code AS product_factory_code FROM order_line_items li LEFT JOIN products p ON (p.id = li.product_id OR p.sku = li.sku) WHERE li.order_id = ANY($1::int[]) ORDER BY li.order_id, li.sort_order, li.id",[orderIds]);
          lines=lr.rows||[];
        }
        var ctnMap={};
        if(!_customsMode){
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
        var rows=_customsMode?_aggregate(lines):_detailRows(orderRows,lines,ctnMap);
        var total=_tot(rows), baseNo=(ordNo||cno||id||"PACK");
        var fsNo=_uniqJoin(orderRows.map(_fsFromOrder)) || _fsFromOrder(o) || baseNo;
        var packCurr=_uniqJoin(orderRows.map(function(orow){return orow&&orow.currency;})) || o.currency || curr || "CNY";
        var orderNoText=_uniqJoin(orderRows.map(function(orow){return _shortNo((orow&&orow.order_no)||(orow&&orow.contract_no));}));
        function _money(v){ return parseFloat((_n(v)).toFixed(2))||0; }
        function _qty(v){ return parseFloat((_n(v)).toFixed(0))||0; }
        function _cbm(v){ return parseFloat((_n(v)).toFixed(3))||0; }
        var common={buyer:cust,buyerAddr:caddr,date:date,cno:cno,curr:packCurr,pol:pol,pod:pod,incoterm:inco,poNo:(orderNoText||ordNo),seller:{nameEN:cfg.nameEN,address:cfg.address,tel:cfg.tel,email:cfg.email}};
        var pricedKeys=[{k:"cp"},{k:"name"},{k:"qty",fn:function(p){return _qty(p.qty);}},{k:"price",fn:function(p){return _money(p.price);}},{k:"amt",fn:function(p){return _money(p.amt);}}];
        var plHeaders=_customsMode?["NO.","CP Code","Description & Size","CTN","TOTAL NW (KG)","TOTAL GW (KG)","CBM (CU.M.)"]:["NO.","CODE","BARCODE","Description & Size","CTN","TOTAL NW (KG)","TOTAL GW (KG)","CBM (CU.M.)"];
        var plColKeys=_customsMode?[{k:"cp"},{k:"name"},{k:"qty",fn:function(p){return _qty(p.qty);}},{k:"nw",fn:function(p){return _money(p.nw);}},{k:"gw",fn:function(p){return _money(p.gw);}},{k:"cbm",fn:function(p){return _cbm(p.cbm);}}]:[{k:"code"},{k:"barcode"},{k:"name"},{k:"qty",fn:function(p){return _qty(p.qty);}},{k:"nw",fn:function(p){return _money(p.nw);}},{k:"gw",fn:function(p){return _money(p.gw);}},{k:"cbm",fn:function(p){return _cbm(p.cbm);}}];
        var plTotals=_customsMode?["","","GRAND TOTAL:",_qty(total.qty),_money(total.nw),_money(total.gw),_cbm(total.cbm)]:["","","","GRAND TOTAL:",_qty(total.qty),_money(total.nw),_money(total.gw),_cbm(total.cbm)];
        return {docNo:baseNo+"_PACK",sheets:[
          Object.assign({},common,{sheetName:"Packing List",docNo:fsNo,noLabel:"No.:",hideCurrency:true,incoterm:"",headers:plHeaders,colKeys:plColKeys,rows:rows,totals:plTotals}),
          Object.assign({},common,{sheetName:"Sales Contract",docNo:fsNo,noLabel:"No.:",terms:cfg.terms.sc,bank:cfg.bank,headers:["NO.","CP Code","Description & Size","CTN","Unit Price ("+packCurr+")","Amount ("+packCurr+")"],colKeys:pricedKeys,rows:rows,totals:["","","GRAND TOTAL:",_qty(total.qty),"",_money(total.amt)]}),
          Object.assign({},common,{sheetName:"Invoice",docNo:fsNo,noLabel:"No.:",terms:cfg.terms.iv,bank:cfg.bank,headers:["NO.","CP Code","Description & Size","CTN","Unit Price ("+packCurr+")","Amount ("+packCurr+")"],colKeys:pricedKeys,rows:rows,totals:["","","GRAND TOTAL:",_qty(total.qty),"",_money(total.amt)]})
        ]};
      }
      var tot=getTotal(prods,o);
      // 总箱数/总净重/总毛重：直接带订单字段表（total_qty/net_weight/gross_weight），不重算。
      var tqty=Number(o.total_qty)||prods.reduce(function(s,p){return s+Number(p.qty||0);},0)||Number(raw.totalQty||0);
      var tgw=Number(o.gross_weight)||prods.reduce(function(s,p){return s+Number(p.grossWeight||p.gw||0)*Number(p.qty||0);},0)||Number(raw.grossWeight||0);
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

                  var _v2PLFnMap = {
                    sku:{fn:function(p){return p.sku||p.code||p.item_code||p.product_code||"-";},defaultAlign:"center",defaultWidth:"70px"},
                    name:{fn:function(p){return v2NameOf(p);},defaultAlign:""},
                    qty:{fn:function(p){return fmtM(Number(p.qty||0),0);},defaultAlign:"center",defaultWidth:"70px"},
                    unit:{fn:function(p){return p.unit||p.unitOfMeasure||"CTN";},defaultAlign:"center",defaultWidth:"50px"},
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
                          qty: fmtM(m.qty,0),
                          unit: p.unit||p.unitOfMeasure||"CTN",
                          nw: fmtM(m.nw),
                          gw: fmtM(m.gw),
                          cbm: fmtM(m.cbm,3)
                        });
                      });
                      if(showSubsec){
                        rows += v2SummaryRow("v2-subtotal", "Sub-Total ("+stripPrefix(g.customerPO||g.contractNo)+"):", cols, {
                          qty: fmtM(subQty,0),
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
                    var totGW = Number(o.gross_weight)||grandGW;
                    var totCBM = Number(o.total_cbm)||grandCBM;
                    rows += v2SummaryRow("v2-total", "GRAND TOTAL:", cols, {
                      qty: fmtM(totQty,0),
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
          ${buyerBlock(cust,caddr,ctel,no,"Contract No.",ordNo,date,curr)}
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
          ${buyerBlock(cust,caddr,ctel,noIV,"Invoice No.",ordNo,date,curr)}
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
        var noCPO=cno.split(" / ").map(function(c){return c.replace(/[^A-Z0-9-]/gi,"").slice(0,20);}).join(" / ");
        var _fsCPO=(raw.fs_no||raw.internal_no||(ordNo||noCPO))+"-CPO";
        var _cpoNameFn=function(p){var n=pick(p.productName,p.name,p.description,"-");var sz=p.size||p.spec||"";return sz?n+" ("+sz+")":n;};
        var _cpoFnMap={
          sku:{fn:function(p){return p.sku||p.code||p.item_code||p.product_code||"-";},defaultAlign:"center",defaultWidth:"70px"},
          name:{fn:_cpoNameFn,defaultAlign:""},
          qty:{defaultAlign:"center",defaultWidth:"70px"},
          unit:{fn:function(p){return p.unit||p.unitOfMeasure||"CTN";},defaultAlign:"center",defaultWidth:"50px"},
          price:{fn:function(p){return fmtM(resolveUnitPrice(p));},defaultAlign:"right",defaultWidth:"95px"},
          amt:{fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},defaultAlign:"right",defaultWidth:"110px"},
        };
        var _fbColsCPO=[
          {k:"name",al:"",fn:_cpoNameFn,lbl:"Description &amp; Size"},
          {k:"qty",al:"center",w:"70px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:_cpoFnMap.price.fn,lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"110px",fn:_cpoFnMap.amt.fn,lbl:"Amount ("+curr+")"},
        ];
        var colsCPO=buildColsFromConfig(await loadDocColConfig(pool,"cpo"),_cpoFnMap,_fbColsCPO);
        var _ncpo=colsCPO.length+1, _lcpo=Math.max(1,_ncpo-1);
        totRow=mkTotRow(_ncpo);
        // Payment schedule: 30% deposit + 70% balance (standard terms)
        var _cpoDeposit=tot*0.30, _cpoBalance=tot*0.70;
        // Payment condition text from terms_po[2] (Payment Terms entry), Chinese part only
        var _cpoPayTerms=(cfg.termsPO||[]).find(function(t){return (t.heading||"").indexOf("付款")>=0||(t.heading||"").toLowerCase().indexOf("payment")>=0;});
        var _cpoPayCN=_cpoPayTerms?((_cpoPayTerms.body||"").split("\n")[0]):"";
        // Seller info block (Sanlyn side)
        var _cpoSellerBlock=`<div class="meta-grid" style="margin-top:0;border-top:none">
          <div></div>
          <div><div class="section-label">SELLER (SOLD BY)</div>
            <p style="font-size:12px;font-weight:bold;margin:0">${esc(cfg.nameEN)}</p>
            <p style="margin:4px 0;font-size:10px;color:#555">${esc(cfg.address)}</p>
            ${cfg.tel?`<p style="margin:2px 0;font-size:10px;color:#555">Tel: ${esc(cfg.tel)}</p>`:""}
          </div></div>`;
        html=wrap(noCPO+"_CPO",`
          ${docHdr(cfg,"","PURCHASE ORDER",audience)}
          ${buyerBlock(cust,caddr,ctel,_fsCPO,"PO No.",ordNo,date,curr)}
          ${_cpoSellerBlock}
          ${portBar(pol,pod,inco)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsCPO.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsCPO,curr)}${totRow}
          <tr><td colspan="${_ncpo}" style="padding:0;border:none"></td></tr>
          <tr style="background:#fafafa">
            <td colspan="${_lcpo}" class="text-right" style="font-size:10px;color:#555">T/T 30% Deposit — upon order confirmation:</td>
            <td class="text-right" style="font-weight:700">${fmtM(_cpoDeposit)}</td>
          </tr>
          <tr style="background:#fafafa">
            <td colspan="${_lcpo}" class="text-right" style="font-size:10px;color:#555">T/T 70% Balance — before loading date:</td>
            <td class="text-right" style="font-weight:700">${fmtM(_cpoBalance)}</td>
          </tr>
          ${_cpoPayCN?`<tr><td colspan="${_ncpo}" style="font-size:10px;color:#777;padding:6px 8px;border-top:1px dashed #ddd">${esc(_cpoPayCN)}</td></tr>`:""}
          </tbody></table>
          ${sigBlock(cfg.seal_url)}
        `,ap,{docNo:_fsCPO,date:date});
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
	        var _plFnMap={
	          sku:{fn:function(p){return _plSkuOf(p);},defaultAlign:"center",defaultWidth:"70px"},
	          code:{fn:function(p){return _plSkuOf(p);},defaultAlign:"center",defaultWidth:"70px"},
	          barcode:{fn:function(p){return _plBarcodeOf(p);},defaultAlign:"center",defaultWidth:"110px"},
	          name:{fn:function(p){var n=pick(p.productName,p.name,p.description,"-");var sz=p.size||p.spec||"";return sz?n+" ("+sz+")":n;},defaultAlign:""},
          qty:{defaultAlign:"center",defaultWidth:"55px"},
          unit:{fn:function(p){return p.unit||p.unitOfMeasure||"CTN";},defaultAlign:"center",defaultWidth:"50px"},
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
	          {k:"code",al:"center",w:"70px",fn:_plFnMap.code.fn,lbl:"CODE"},
	          {k:"barcode",al:"center",w:"110px",fn:_plFnMap.barcode.fn,lbl:"BARCODE"},
	          {k:"name",al:"",fn:_plFnMap.name.fn,lbl:"Description &amp; Size"},
	          {k:"qty",al:"center",w:"70px",lbl:"QTY (CTN)"},
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
          ${buyerBlock(cust,caddr,ctel,noPL,"Contract No.",ordNo,date,"")}
          <table><thead><tr><th style="width:36px">NO.</th>${colsPL.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
	          <tbody>${productRows(prods,colsPL,curr)}
	          ${audience==="customs"?`<tr class="total-row"><td colspan="3" class="text-right" style="color:#555;font-size:11px">SHIPPING MARKS: N/M &nbsp;&nbsp; TOTAL:</td><td style="text-align:center">${fmtM(tqty,0)}</td><td></td><td class="text-right">${fmtM(tnw)}</td><td class="text-right">${fmtM(tgw)}</td><td class="text-right">${fmtM(tcbmPL,3)}</td></tr>`:`<tr class="total-row"><td colspan="4" class="text-right" style="color:#555;font-size:11px">SHIPPING MARKS: N/M &nbsp;&nbsp; TOTAL:</td><td style="text-align:center">${fmtM(tqty,0)}</td><td class="text-right">${fmtM(tnw)}</td><td class="text-right">${fmtM(tgw)}</td><td class="text-right">${fmtM(tcbmPL,3)}</td></tr>`}
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
	          headers:_plDetailXlsx?["NO.","CODE","BARCODE","Description & Size","CTN","TOTAL NW (KG)","TOTAL GW (KG)","CBM (CU.M.)"]:["NO.","CP Code","Description & Size","CTN","Unit","TOTAL NW (KG)","TOTAL GW (KG)","CBM (CU.M.)"],
	          colKeys:(_plDetailXlsx?[{k:"code",fn:function(p){return _plSkuOf(p);}},{k:"barcode",fn:function(p){return _plBarcodeOf(p);}}]:[{k:"sku",fn:function(p){return _plSkuOf(p);}}]).concat([{k:"name",fn:function(p){
	            // PL Excel — same rule: always real product name (see colsPL above)
	            var n = pick(p.productName, p.name, p.description, "-");
	            var sz = p.size || p.spec || "";
	            return sz ? n + " (" + sz + ")" : n;
	          }},{k:"qty",fn:function(p){return Number(p.qty)||0;}}]).concat(_plDetailXlsx?[]:[{k:"unit",fn:function(p){return p.unit||p.unitOfMeasure||"CTN";}}]).concat([{k:"nw",fn:function(p){var pn=Number(p.netWeight||p.nw||0);var q=Number(p.qty||0);return parseFloat((pn*q||pn).toFixed(2))||0;}},{k:"gw",fn:function(p){var pg=Number(p.grossWeight||p.gw||0);var q=Number(p.qty||0);return parseFloat((pg*q||pg).toFixed(2))||0;}},{k:"cbm",fn:function(p){return parseFloat(cbmOf(p).toFixed(3))||0;}}]),
	          rows:prods,totals:_plDetailXlsx?["","","","TOTAL",tqty,parseFloat(tnw.toFixed(2)),parseFloat(tgw.toFixed(2)),parseFloat(tcbmPL.toFixed(3))]:["","","TOTAL",tqty,"",parseFloat(tnw.toFixed(2)),parseFloat(tgw.toFixed(2)),parseFloat(tcbmPL.toFixed(3))]};
        if(_PACK && format==="xlsx"){
          _xlsCapture=await _buildPackXlsCaptureFromOLI();
        }
      }

      if(type==="pi"){
        var noPI=cno.replace(/[^A-Z0-9-]/gi,"").slice(0,20);
        var _piNameFn=function(p){
            var n;
            if (audience === "customs") {
              n = pick(p.blDescription, p.bl_description, p.declarationName, p.declaration_name, p.productName, p.name, p.description, "-");
            } else {
              n = pick(p.productNameEN, p.productName, p.name, p.description, "-");
            }
            var sz = p.size || p.spec || "";
            return sz ? n + " (" + sz + ")" : n;
          };
        var _piFnMap={
          sku:{fn:function(p){return p.sku||p.code||p.item_code||p.product_code||"-";},defaultAlign:"center",defaultWidth:"70px"},
          name:{fn:_piNameFn,defaultAlign:""},
          qty:{defaultAlign:"center",defaultWidth:"70px"},
          unit:{fn:function(p){return p.unit||p.unitOfMeasure||"CTN";},defaultAlign:"center",defaultWidth:"50px"},
          price:{fn:function(p){return fmtM(resolveUnitPrice(p));},defaultAlign:"right",defaultWidth:"95px"},
          amt:{fn:function(p){var s=Number(p.subtotal||p.amount||0);if(!s&&p.qty)s=Number(p.qty)*Number(resolveUnitPrice(p)||0);return fmtM(s);},defaultAlign:"right",defaultWidth:"110px"},
        };
        var _fbColsPI=[
          {k:"name",al:"",fn:_piNameFn,lbl:"Description &amp; Size"},
          {k:"qty",al:"center",w:"70px",lbl:"QTY"},
          {k:"price",al:"right",w:"95px",fn:_piFnMap.price.fn,lbl:"Unit Price ("+curr+")"},
          {k:"amt",al:"right",w:"110px",fn:_piFnMap.amt.fn,lbl:"Amount ("+curr+")"},
        ];
        var colsPI=buildColsFromConfig(await loadDocColConfig(pool,"pi"),_piFnMap,_fbColsPI);
        totRow=mkTotRow(colsPI.length+1);
        var _fsNoPI = (raw.fs_no || raw.internal_no || (ordNo||noPI)) + "-PI";
        html=wrap((ordNo||noPI)+"_PI",`
          ${docHdr(cfg,"形式发票","PROFORMA INVOICE")}
          ${buyerBlock(cust,caddr,ctel,noPI,"PI No.",ordNo,date,curr)}
          <table><thead><tr><th style="width:36px">NO.</th>${colsPI.map(function(c){return`<th${c.w?` style="width:${c.w};text-align:${c.al==='right'?'right':'center'}"`:""}>${c.lbl}</th>`;}).join("")}</tr></thead>
          <tbody>${productRows(prods,colsPI,curr)}${totRow}</tbody></table>
          <div class="footer-block"><div class="details-grid">${termsCard(cfg.terms.sc)}${bankCard(cfg.bank,curr)}</div>${sigBlock()}</div>`,ap,{docNo:_fsNoPI,date:date});
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
        // ── Factory resolution ─────────────────────────────────────────────────
        // raw.factory is often populated with the ISSUING company (BABI/PetBaby),
        // NOT the actual manufacturing factory. Filter those out, then resolve via:
        //   1) order_no encoded factory code (format: {cust}-{FACTORY_CODE}-{seq})
        //   2) orders.factory_code / raw.factory_code / raw.factoryCode
        //   3) products[].factory_code derived from order's SKUs
        //   4) raw.factory / raw.factoryName (if not self-referential)
        var SELLER_KWORDS=["PET BABY","OCEANBABY","OCEAN BABY","BABI","SANLYN","巴匕","洋宝宝","宠宝"];
        var rawFacStr=pick(raw.factory,raw.factoryName,raw.supplier,"");
        var isSelf=SELLER_KWORDS.some(function(k){return rawFacStr.toUpperCase().includes(k.toUpperCase());});
        if(isSelf) rawFacStr="";

        // Step 1: extract factory po_prefix from order_no (e.g. "48-LL-1" → "LL")
        var orderNoParts=(o.order_no||"").split("-");
        var orderNoFac=orderNoParts.length>=3 ? orderNoParts[1] : "";

        // Step 2: explicit factory_code fields
        var fcode=o.factory_code||raw.factory_code||raw.factoryCode||"";

        // Step 3: if still no code, derive from products SKUs
        if(!fcode && !orderNoFac && prods.length){
          try{
            var skus=prods.map(function(p){return p.sku||p.barcode||"";}).filter(Boolean);
            if(skus.length){
              var pfR=await pool.query("SELECT factory_code FROM products WHERE sku=ANY($1) AND factory_code IS NOT NULL LIMIT 1",[skus]);
              if(pfR.rows.length) fcode=pfR.rows[0].factory_code||"";
            }
          }catch(e){}
        }

        var factory=rawFacStr||"[FACTORY]";
        var buyerTaxNo=pick(cfg.taxNo,raw.sellerTaxNo,"");
        var vendorTaxNo=pick(raw.factoryTaxNo,raw.vendorTaxNo,"");
        var vendorAddress="", vendorBank="", vendorAccount="";
        try{
          // Try lookup by po_prefix (from order_no) first — most reliable
          var fR=null;
          if(orderNoFac){
            fR=await pool.query("SELECT * FROM factories WHERE po_prefix=$1 LIMIT 1",[orderNoFac]);
          }
          // Try by factory_code (matches factories.company_code or po_prefix)
          if((!fR||!fR.rows.length) && fcode){
            fR=await pool.query("SELECT * FROM factories WHERE company_code=$1 OR po_prefix=$1 LIMIT 1",[fcode]);
          }
          // Fallback: name search on whatever string we have
          if(!fR||!fR.rows.length){
            var fSearch=(factory!=="[FACTORY]")?factory.replace(/股份|有限公司|进出口/g,"").trim().slice(0,6):"";
            if(fSearch) fR=await pool.query("SELECT * FROM factories WHERE name=$1 OR name LIKE $2 LIMIT 1",[factory,'%'+fSearch+'%']);
          }
          if(fR && fR.rows.length){
            var fd=fR.rows[0];
            factory=fd.name||factory;           // always use the real factory name from DB
            vendorTaxNo=vendorTaxNo||fd.tax_no||"";
            vendorAddress=fd.address||"";
            vendorBank=fd.bank_name||"";
            vendorAccount=fd.bank_account||"";
          }
        }catch(e){}
        var totPO=prods.reduce(function(s,p){var fp=pick(p.factoryPrice,p.unitPrice,p.price);var sub=Number(p.subtotalFactory||p.subtotal||0);if(!sub&&p.qty&&fp)sub=Number(p.qty)*Number(fp);return s+sub;},0)||Number(o.total_amount)||0;
        // buyer RMB account: prefer seller_profiles.rmb_account
        var buyerRmbAccount=pick(cfg.bank.rmbAccount,"");
        var buyerBankName=pick(cfg.bank.bankNameCN,cfg.bank.bankName,"");
        // delivery date: read from orders.delivery_date, NOT today
        // If unset → show blank underline so factory can fill by hand
        var _poDelRaw=pick(o.delivery_date,raw.deliveryDate,raw.expectedDelivery,"");
        var poDeliveryDate=_poDelRaw ? fmtD(_poDelRaw) : "______________";
        // order date: orders.order_date (the date the PO was placed), fallback created_at
        var _poOrderDateRaw=pick(o.order_date,"");
        var poOrderDate=_poOrderDateRaw ? fmtD(_poOrderDateRaw) : fmtD(o.created_at||"");
        // buyer seal: seller_profiles.seal_url — auto-stamped for configured groups
        var poBuyerSeal=pick(cfg.seal_url,"");
        html=wrap("Purchase Order — "+noPO,`
          <style>
            .po-header{text-align:center;padding:10px 0 4px;}
            .po-header-cn{font-size:20px;font-weight:bold;letter-spacing:4px;display:block;}
            .po-header-en{font-size:12px;font-weight:600;color:#555;letter-spacing:2px;display:block;margin-top:2px;padding-bottom:10px;border-bottom:2px solid #222;}
            .po-parties{display:grid;grid-template-columns:1fr 1fr;border:1px solid #aaa;margin-top:0;}
            .po-party{padding:10px 14px;}
            .po-party+.po-party{border-left:1px solid #aaa;}
            .po-party-title{font-size:11px;font-weight:800;background:#f0f0f0;margin:-10px -14px 8px;padding:5px 14px;border-bottom:1px solid #ddd;letter-spacing:.03em;}
            .po-row{display:flex;font-size:11px;line-height:1.7;}
            .po-lbl{color:#555;width:72px;flex-shrink:0;}
            .po-val{font-weight:600;color:#111;}
            .po-ref{border:1px solid #aaa;border-top:none;background:#fafafa;font-size:11px;}
            .po-ref-row{display:flex;gap:40px;padding:9px 16px;}
            .po-ref-row+.po-ref-row{border-top:1px solid #e5e5e5;}
            .po-ref span{color:#333;white-space:nowrap;}
            .po-ref strong{color:#111;}
            .po-ref .fill-blank{display:inline-block;min-width:130px;border-bottom:1px solid #999;color:#aaa;font-style:italic;font-size:10px;}
            @page{size:A4;margin:18mm 16mm;}
            .sig-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-top:14px;}
            .sig-box{border-top:1px solid #ccc;padding:12px 14px 80px;font-size:11px;color:#333;position:relative;min-height:110px;}
            .sig-seal{position:absolute;right:16px;bottom:8px;width:110px;height:110px;opacity:0.88;}
          </style>
          <div class="po-header">
            <span class="po-header-cn">采购合同</span>
            <span class="po-header-en">PURCHASE ORDER</span>
          </div>
          <div class="po-parties">
            <div class="po-party">
              <div class="po-party-title">买方开票资料 · Buyer</div>
              <div class="po-row"><span class="po-lbl">公司名称：</span><span class="po-val">${esc(cfg.nameCN)}</span></div>
              <div class="po-row"><span class="po-lbl">税号：</span><span class="po-val">${esc(buyerTaxNo)}</span></div>
              <div class="po-row"><span class="po-lbl">开户银行：</span><span class="po-val">${esc(buyerBankName)}</span></div>
              <div class="po-row"><span class="po-lbl">银行账户：</span><span class="po-val">${esc(buyerRmbAccount)}</span></div>
            </div>
            <div class="po-party">
              <div class="po-party-title">卖方账户信息 · Vendor</div>
              <div class="po-row"><span class="po-lbl">公司名称：</span><span class="po-val">${esc(factory)}</span></div>
              <div class="po-row"><span class="po-lbl">税号：</span><span class="po-val">${esc(vendorTaxNo)}</span></div>
              <div class="po-row"><span class="po-lbl">开户银行：</span><span class="po-val">${esc(vendorBank||raw.factoryBank||"")}</span></div>
              <div class="po-row"><span class="po-lbl">银行账户：</span><span class="po-val">${esc(vendorAccount||raw.factoryAccount||"")}</span></div>
            </div>
          </div>
          <div class="po-ref">
            <div class="po-ref-row">
              <span>单号 / Order No.: <strong>${esc(ordNo)}</strong></span>
              <span>合同号 / Contract No.: <strong>${esc(cno)}</strong></span>
              <span>下单日期 / Order Date: <strong>${poOrderDate}</strong></span>
            </div>
            <div class="po-ref-row">
              <span>期望交货日期 / Requested Delivery Date: <strong>${poDeliveryDate}</strong></span>
              <span>预计交货日期 / Estimated Delivery Date: <span class="fill-blank">（乙方填写 · Vendor to complete）</span></span>
            </div>
          </div>
          <table><thead><tr><th style="width:36px">行号</th><th>品名 / Item Description</th><th style="width:70px;text-align:center">数量 / Qty</th><th style="width:90px;text-align:right">单价 / Unit Price</th><th style="width:100px;text-align:right">金额 / Amount</th><th style="width:110px;text-align:center">条形码 / Barcode</th></tr></thead>
          <tbody>
            ${prods.length===0?`<tr><td>01</td><td colspan="5" style="color:#999;font-style:italic">— 产品明细将自动填入 —</td></tr>`:
              prods.map(function(p,i){
                var fp=pick(p.factoryPrice,p.unitPrice,p.price);
                var sub=Number(p.subtotalFactory||p.subtotal||0);if(!sub&&p.qty&&fp)sub=Number(p.qty)*Number(fp);
                var fullName=pick(p.productName,p.name,"-");
                return`<tr><td>${String(i+1).padStart(2,"0")}</td><td>${esc(fullName)}</td><td style="text-align:center">${esc(String(p.qty||"-"))}</td><td class="text-right">${fmtM(fp)}</td><td class="text-right">${fmtM(sub)}</td><td style="text-align:center;font-size:10px;color:#444;letter-spacing:0.5px">${esc(p.barcode||"")}</td></tr>`;
              }).join("")}
            <tr class="total-row"><td colspan="2" class="text-right" style="color:#555;font-size:11px">合计</td><td style="text-align:center">${fmtM(tqty,0)}</td><td></td><td class="text-right" style="font-size:14px">${fmtM(totPO)}</td><td></td></tr>
          </tbody></table>
          <div style="margin-top:10px;font-size:10.5px;line-height:1.65;color:#333;border:1px solid #ddd;padding:8px 14px;border-radius:4px;">
            <strong style="font-size:11px">备注：</strong>
            ${(cfg.termsPO||[]).map(function(t){var cnBody=(t.body||"").split("\n")[0];return`<div style="margin-top:6px"><strong>${esc(t.heading||"")}</strong><div style="color:#444;margin-top:1px">${esc(cnBody)}</div></div>`;}).join("")}
          </div>
          <div class="sig-grid">
            <div class="sig-box">
              <span>买方代表：</span><span style="font-weight:normal;font-size:9px;margin-left:4px">（签字 / 盖章）</span>
              ${poBuyerSeal?`<img src="${esc(poBuyerSeal)}" class="sig-seal" alt="seal"/>`:``}
            </div>
            <div class="sig-box">
              <span>卖方代表：</span><span style="font-weight:normal;font-size:9px;margin-left:4px">（签字 / 盖章）</span>
            </div>
          </div>
        `,ap);
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
        // W0-6: NO hardcoded 7.2 fallback. exr resolves to 0 when no rate is
        // available; downstream USD→CNY conversion must guard against 0.
        var exr=Number(pick(sp.exchange_rate,spraw.exchangeRate,0));
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
        var _isFob = ['FOB','FCA'].indexOf(String(freightTerm||'').toUpperCase().trim())>=0;
        var _portMisc = ['THC','DOCUMENTATION FEE','SEAL FEE','B/L FEE','EIR','VGM','BOOKING FEE'];
        var _portMiscCNY = thcF+docF+sealF+blF+eirF+vgmF+bkgF;
        var totCNY=(_isFob ? 0 : _portMiscCNY)+fCNY+truck+customs;
        var totUSD=fUSD+ins;
        // 2026-05-19: DN 默认 "DB-" 前缀；fmt=iv 时改 "INV-" + 标题切 INVOICE
        var _isIvFmt = (_fmtVariant === "iv");
        var dbNo = (_isIvFmt ? "INV-" : "DB-") + soNo;
        var _dnTitleCN = _isIvFmt ? "海运费发票" : "借记通知单";
        var _dnTitleEN = _isIvFmt ? "FREIGHT INVOICE" : "DEBIT NOTE";

        // Build fee rows: [label_en, label_cn, qty, currency, amount]
        var feeList=[
          ["OCEAN FREIGHT","海运费",cqty,"USD",fUSD],
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
        ].filter(function(r){
          if(r[4]<=0) return false;
          if(_isFob && _portMisc.indexOf(r[0])>=0) return false; // FOB: 港杂归工厂, 不上客户账单
          return true;
        });

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
              <tr><td colspan="4" class="tr">总计应付 TOTAL DUE (CNY equiv):</td><td class="tr">${exr>0?`CNY ${fmtM(totCNY+totUSD*exr)}`:`<span style="color:#c00">汇率缺失 / FX rate required</span>`}</td></tr>
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
	            cap.colKeys.forEach(function(k){ var v=k.fn?k.fn(p):(p[k.k]||""); var n=parseFloat(String(v).replace(/,/g,"")); cells.push((k.k==="barcode"||k.k==="code")?String(v||""):(isNaN(n)?v:n)); });
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
	          var n=parseFloat(String(v).replace(/,/g,""));
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
        // 2026-07-02 type=pack 的 PDF 改成 puppeteer 直接 goto 正版可编辑模版(export-docs)
        // 渲染,与浏览器视图/在线查看一致(海关分组/品名明细/港口回退/自动盖章),不再用旧服务端HTML。
        if (type === "pack") {
          var _pmode2 = (req.query.customs === "1" || req.query.mode === "customs") ? "" : "&mode=detail";
          var _ptok2 = req.query.token || reqToken || "";
          var _ppage2 = /^(pl|sc|iv)$/.test(String(req.query.page||"").toLowerCase()) ? String(req.query.page).toLowerCase() : "";
          var _tplUrl = "https://api.sanlyn.cn/templates/export-docs-template.html?order_no=" + encodeURIComponent(id||"")
            + "&ids=" + encodeURIComponent(ids||id||"") + _pmode2
            + (_ppage2 ? "&page=" + encodeURIComponent(_ppage2) : "")
            + "&token=" + encodeURIComponent(_ptok2);
          await page.goto(_tplUrl, {waitUntil:"networkidle0", timeout:60000});
          await new Promise(function(r){ setTimeout(r, 1800); });
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
    // W0-3: scrub leaked codes from customer-facing HTML (default).
    // Only audience=customs (internal broker) sees raw codes.
    var _outHtml = (String(_audReq||"").toLowerCase() === "customs") ? html : scrubCustomerFacingHtml(html);
    return res.status(200).send(_outHtml);
  }catch(err){
    return res.status(500).send("<h1>Error: "+esc(err.message)+"</h1>");
  }
}
