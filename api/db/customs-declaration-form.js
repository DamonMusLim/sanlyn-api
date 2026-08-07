import {
  bigCell,
  blank,
  cargoRows,
  cell,
  clean,
  countryFromPod,
  firstOrderValue,
  fmtDate,
  fmtInt,
  fmtM,
  loadCompany,
  loadContainersForBl,
  loadLines,
  loadOrders,
  loadOrdersByIds,
  loadPlan,
  parseRaw,
  pick,
  resolveOrdersForContainer,
  sellerLabel,
} from "./customs-declaration-form-lib.js";

export { resolveOrdersForContainer } from "./customs-declaration-form-lib.js";

// 境内货源地。2026-08-04 报关行反馈「辽宁范围太大了，具体是哪里呀」——
// 原实现只从公司名开头正则取省名("辽宁宠爱科技有限公司"→"辽宁")，永远到不了区县，
// 而真地址一直在 companies.address（"辽宁省朝阳市建平县..."）。
// 改为：companies.customs_source_area(人工确认的申报值) → 从 address 抽区县 → 才回退猜名字。
function _provinceOf(name){
  name=String(name||"");
  var d=name.match(/^(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|广西|内蒙古|西藏|宁夏|新疆)/);
  if(d) return d[1];
  var CITY={"烟台":"山东","徐州":"江苏","连云港":"江苏","霸州":"河北"};
  for(var c in CITY){ if(name.indexOf(c)>=0) return CITY[c]; }
  return "";
}

function _areaFromAddress(addr){
  var a=String(addr||"");
  var m=a.match(/([\u4e00-\u9fa5]{2,6}?(?:县|市辖区|区))(?![\u4e00-\u9fa5]*省)/);
  if(m) return m[1].replace(/(县|区)$/,"");
  var c=a.match(/([\u4e00-\u9fa5]{2,6}?)市/);
  return c?c[1]:"";
}

// 按工厂名批量取「境内货源地」：优先人工确认值，其次地址抽取，最后才猜名字
async function _sourceAreaOf(pool, names){
  var out={};
  var uniq=Array.from(new Set((names||[]).filter(Boolean).map(String)));
  if(!uniq.length) return out;
  try{
    var r=await pool.query(
      "SELECT name_cn, customs_source_area, address FROM companies WHERE name_cn = ANY($1::text[])",
      [uniq]);
    r.rows.forEach(function(row){
      out[row.name_cn] = (row.customs_source_area && row.customs_source_area.trim())
        || _areaFromAddress(row.address)
        || _provinceOf(row.name_cn);
    });
  }catch(e){ console.warn("[customs-decl] source area lookup failed:", e.message); }
  uniq.forEach(function(n){ if(!out[n]) out[n]=_provinceOf(n); });
  return out;
}

export async function renderCustomsDeclaration(pool, shipmentId, opts) {
  opts = opts || {};
  var plan = await loadPlan(pool, shipmentId);
  if (!plan) return null;

  var praw = parseRaw(plan.raw);
  var requestedContainerNo = clean(opts.container_no || opts.container);
  var orders = await loadOrders(pool, plan);
  if (requestedContainerNo) {
    var containerOrderIds = await resolveOrdersForContainer(pool, plan, requestedContainerNo);
    orders = await loadOrdersByIds(pool, containerOrderIds);
  }
  var orderIds = orders.map(function (o) { return Number(o.id); }).filter(Boolean);
  var lines = await loadLines(pool, orderIds);
  var _facNames=(orders||[]).map(function(_o){ return _o.factory||_o.factory_name||_o.factory_company_name; }).filter(Boolean);
  var _areaMap=await _sourceAreaOf(pool, _facNames);
  var _srcProvs={}; _facNames.forEach(function(n){ var _p=_areaMap[n]; if(_p) _srcProvs[_p]=1; });
  var _pk=Object.keys(_srcProvs); var _sourceArea=_pk.length===1?_pk[0]:"";  // 多产地留空,不猜

  var issuer = clean(firstOrderValue(orders, "issuing_company", "issuingCompany"));
  var company = await loadCompany(pool, issuer);
  var shipper = sellerLabel(issuer, company);

  var customer = firstOrderValue(orders, "customer", "customer");
  // 合同协议号用我们的 FS 号(内部号),优先取 FS 开头的合同号;都没有才退回原始 contract_no
  var contractNo = clean(plan.primary_contract_no) || (function () {
    var fallback = "";
    for (var i = 0; i < orders.length; i++) {
      var raw = parseRaw(orders[i].raw);
      var candidates = [orders[i].fs_no, raw.fs_no, orders[i].contract_no, orders[i].contractNo, raw.contractNo, raw.contract_no];
      for (var j = 0; j < candidates.length; j++) {
        var v = clean(candidates[j]);
        if (!v) continue;
        if (!fallback) fallback = v;
        if (/^FS/i.test(v)) return v;
      }
    }
    return fallback || firstOrderValue(orders, "contract_no", "contractNo");
  })();
  var currency = firstOrderValue(orders, "currency", "currency") || "CNY";
  var tradeMode = "0110 一般贸易";
  var levyNature = "101 一般征税";
  var pod = pick(plan.pod, praw.pod, praw.destinationPort, "");
  var destination = countryFromPod(firstOrderValue(orders, "country", "country") || pod);
  var vesselVoyage = [pick(plan.vessel, praw.vessel), pick(plan.voyage, praw.voyage)].filter(Boolean).join(" / ");
  var blNo = pick(plan.bl_no, praw.blNo, praw.bl_no);
  // 集装箱号: 指定单柜用它; BL级(未指定)列出该 BL/计划下全部柜号
  var containerNo = requestedContainerNo || pick(plan.container_no, praw.containerNo, praw.container_no);
  if (!requestedContainerNo) {
    var _allCtn = await loadContainersForBl(pool, plan);
    if (_allCtn.length) containerNo = _allCtn.join(", ");
  }
  // 净重/毛重一律从明细 lines 汇总(lines 范围=当前 orders: BL级=全部订单, 单柜级=该柜订单), 与件数同源,
  // 不再只取 plan 单柜值。毛重来源=order_line_items.gw_ctn×qty_ctn(loadLines 已聚合 gross_weight_kg)。
  var _lineNet = lines.reduce(function (s, l) { var n = Number(l.net_weight_kg); return s + (Number.isFinite(n) ? n : 0); }, 0);
  var _lineGross = lines.reduce(function (s, l) { var n = Number(l.gross_weight_kg); return s + (Number.isFinite(n) ? n : 0); }, 0);
  var netWeight = _lineNet || pick(plan.net_weight_kg, plan.net_weight, praw.netWeight, praw.net_weight_kg) || "";
  var grossWeight = _lineGross || pick(plan.gross_weight_kg, plan.gross_weight, praw.grossWeight, praw.gross_weight_kg) || "";
  var totalCtn = lines.reduce(function (s, l) {
    var n = Number(l.qty_ctn);
    return s + (Number.isFinite(n) ? n : 0);
  }, 0);
  var notes = containerNo ? "集装箱号: " + containerNo : "";
  // 2026-08-07 接线: 出境关别/离境口岸/随附单证(法检电子底账B)/订单号
  // 数据来源=订单真实字段(报检时向海关申报的值, orders.raw.ciq + ciq_application_no), 缺则留空不猜
  var _ciqInfo = (function () {
    for (var i = 0; i < orders.length; i++) {
      var _r = parseRaw(orders[i].raw) || {};
      var _c = _r.ciq || {};
      var _no = clean(orders[i].ciq_application_no) || clean(_c.report_no);
      var _edoc = clean(_c.edoc_no) || (_no ? _no + "001" : "");
      if (_no || _edoc) {
        return {
          reportNo: _no,
          edocNo: _edoc,
          despPort: String(clean(_c.despPort) || "").replace(/[0-9]/g, "").trim(),
          declCustoms: clean(_c.declare_customs),
        };
      }
    }
    return { reportNo: "", edocNo: "", despPort: "", declCustoms: "" };
  })();
  // 随附单证及编号: 法检货物填 代码B + 电子底账号, 海关据此自动调取检验检疫申报要素
  var attachedDocs = _ciqInfo.edocNo ? ("B " + _ciqInfo.edocNo) : "";
  var departurePort = _ciqInfo.despPort;
  var exportCustomsOffice = _ciqInfo.declCustoms;
  var orderNosLabel = orders.map(function (o) { return clean(o.order_no); }).filter(Boolean).join(" / ");

  var today = fmtDate(opts.declareDate || new Date());

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>中华人民共和国海关出口货物报关单</title>
<style>
  @page { size: A4 landscape; margin: 8mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: #fff;
    color: #111;
    font-family: "SimSun","Songti SC","Microsoft YaHei",Arial,sans-serif;
    font-size: 11px;
    line-height: 1.25;
  }
  .sheet { width: 281mm; min-height: 194mm; margin: 0 auto; padding: 5mm 6mm; }
  .top { position: relative; text-align: center; margin-bottom: 4px; }
  h1 { margin: 0; font-size: 24px; font-weight: 700; letter-spacing: 2px; }
  .barcode { position: absolute; right: 0; top: 0; width: 48mm; text-align: center; }
  .bars {
    height: 13mm; border: 1px solid #222;
    background: repeating-linear-gradient(90deg,#111 0,#111 1px,#fff 1px,#fff 3px,#111 3px,#111 5px,#fff 5px,#fff 8px);
    opacity: .75;
  }
  .check-only { margin-top: 2px; font-size: 14px; font-weight: 700; }
  .meta { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px; margin: 2mm 0 1.5mm; font-size: 11px; }
  .grid4 { display: grid; grid-template-columns: 1.4fr 1fr 1fr 1fr 1fr; border-top: 1px solid #222; border-left: 1px solid #222; }
  .grid4.row2 { grid-template-columns: 1.4fr 1fr 1.4fr 1fr; }
  .grid4.row3 { grid-template-columns: 1.4fr 1fr 1fr 1fr; }
  .grid4.row4 { grid-template-columns: 1.2fr 1fr 1fr 1fr 1fr; }
  .grid4.row5 { grid-template-columns: .8fr .7fr .9fr .9fr .8fr .8fr .8fr .8fr; }
  .cell { min-height: 13mm; padding: 2px 4px; border-right: 1px solid #222; border-bottom: 1px solid #222; }
  .cell.small { min-height: 10mm; }
  .cell.wide { min-height: 12mm; border-left: 1px solid #222; border-right: 1px solid #222; border-bottom: 1px solid #222; padding: 2px 4px; }
  .lbl { color: #222; font-size: 10px; margin-bottom: 2px; }
  .val { font-size: 12px; white-space: pre-wrap; word-break: break-word; }
  .empty { color: #aaa; }
  table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 0; }
  th, td { border: 1px solid #222; padding: 3px 4px; vertical-align: top; text-align: left; }
  th { text-align: center; font-weight: 700; font-size: 10px; }
  td { height: 19mm; font-size: 11px; }
  .goods th:nth-child(1), .goods td:nth-child(1) { width: 8mm; text-align: center; }
  .goods th:nth-child(2), .goods td:nth-child(2) { width: 24mm; }
  .goods th:nth-child(3), .goods td:nth-child(3) { width: 76mm; }
  .goods th:nth-child(4), .goods td:nth-child(4) { width: 28mm; text-align: center; }
  .goods th:nth-child(5), .goods td:nth-child(5) { width: 27mm; text-align: center; }
  .goods th:nth-child(6), .goods td:nth-child(6) { width: 25mm; text-align: center; }
  .goods th:nth-child(7), .goods td:nth-child(7) { width: 28mm; text-align: center; }
  .goods th:nth-child(8), .goods td:nth-child(8) { width: 28mm; text-align: center; }
  .goods th:nth-child(9), .goods td:nth-child(9) { width: 23mm; text-align: center; }
  .goods-name { line-height: 1.35; }
  .empty-row { text-align: center; color: #aaa; height: 28mm; }
  .confirm-line { display: grid; grid-template-columns: repeat(7, 1fr); border-left: 1px solid #222; font-size: 10px; }
  .confirm-line div { border-right: 1px solid #222; border-bottom: 1px solid #222; padding: 3px 4px; min-height: 7mm; }
  .bottom { display: grid; grid-template-columns: 1.1fr 1.2fr 1.1fr; border-left: 1px solid #222; }
  .bottom .box { min-height: 25mm; border-right: 1px solid #222; border-bottom: 1px solid #222; padding: 4px; }
  .declare { margin-top: 8px; font-size: 12px; line-height: 1.6; }
  .stamp { height: 16mm; margin-top: 4px; display: flex; align-items: flex-end; justify-content: flex-end; }
  @media print {
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .sheet { width: auto; margin: 0; padding: 0; }
  }
</style>
</head>
<body>
<div class="sheet">
  <div class="top">
    <h1>中华人民共和国海关出口货物报关单</h1>
    <div class="barcode"><div class="bars"></div><div class="check-only">仅供核对用</div></div>
  </div>

  <div class="meta">
    <div>预录入编号: ${blank(opts.preEntryNo || "")}${orderNosLabel ? "　订单号: " + orderNosLabel : ""}${_ciqInfo.reportNo ? "　检疫号: " + _ciqInfo.reportNo : ""}</div>
    <div>海关编号: ${blank(opts.customsNo || "")} ${blank(opts.customsName || "")}</div>
    <div style="text-align:right">页码: 1/1</div>
  </div>

  <div class="grid4">
    ${cell("境内发货人", shipper, undefined, "domestic_shipper")}
    ${cell("出境关别", exportCustomsOffice, undefined, "export_customs_office")}
    ${cell("出口日期", fmtDate(pick(plan.etd, praw.etd)), undefined, "export_date")}
    ${cell("申报日期", today, undefined, "declare_date")}
    ${cell("备案号", "", undefined, "record_no")}
  </div>
  <div class="grid4 row2">
    ${cell("境外收货人", customer, undefined, "overseas_consignee")}
    ${cell("运输方式", "水路运输", undefined, "transport_mode")}
    ${cell("运输工具名称及航次号", vesselVoyage, undefined, "vessel_voyage")}
    ${cell("提运单号", blNo, undefined, "bl_no")}
  </div>
  <div class="grid4 row3">
    ${cell("生产销售单位", shipper, undefined, "production_sales_unit")}
    ${cell("监管方式", tradeMode, undefined, "trade_mode")}
    ${cell("征免性质", levyNature, undefined, "levy_nature")}
    ${cell("许可证号", "", undefined, "license_no")}
  </div>
  <div class="grid4 row4">
    ${cell("合同协议号", contractNo, undefined, "contract_no")}
    ${cell("贸易国(地区)", destination, undefined, "trade_country")}
    ${cell("运抵国(地区)", destination, undefined, "arrival_country")}
    ${cell("指运港", pod, undefined, "destination_port")}
    ${cell("离境口岸", departurePort, undefined, "departure_port")}
  </div>
  <div class="grid4 row5">
    ${cell("包装种类", "纸箱", "small", "package_type")}
    ${cell("件数", totalCtn ? fmtInt(totalCtn) : "", "small", "total_ctn")}
    ${/* 2026-08-04: 原为 fmtM(...,0) 整数，把 80,197.50→80198、72,726.60→72727，
          与箱单/提单样单(两位小数)对不上，报关行据此报"毛重不一样"。
          海关报关单毛重/净重字段本身接受小数，改为两位与箱单同口径。 */""}
    ${cell("毛重(千克)", fmtM(grossWeight, 2), "small", "gross_weight")}
    ${cell("净重(千克)", fmtM(netWeight, 2), "small", "net_weight")}
    ${cell("成交方式", "FOB", "small", "trade_terms")}
    ${cell("运费", "", "small", "freight")}
    ${cell("保费", "", "small", "insurance")}
    ${cell("杂费", "", "small", "misc_fee")}
  </div>
  ${bigCell("随附单证及编号", attachedDocs, "attached_docs")}
  ${bigCell("标记唛码及备注", notes, "marks_notes")}

  <table class="goods">
    <thead>
      <tr>
        <th>项号</th>
        <th>商品编号</th>
        <th>商品名称及规格型号</th>
        <th>数量及单位</th>
        <th>单价/总价/币制</th>
        <th>原产国(地区)</th>
        <th>最终目的国(地区)</th>
        <th>境内货源地</th>
        <th>征免</th>
      </tr>
    </thead>
    <tbody>${cargoRows(lines, destination, _sourceArea)}</tbody>
  </table>

  <div class="confirm-line">
    <div>特殊关系确认: 否</div>
    <div>价格影响确认: 否</div>
    <div>支付特许权使用费确认: 否</div>
    <div>公式定价确认: 否</div>
    <div>暂定价格确认: 否</div>
    <div>自报自缴: 否</div>
    <div>水运中转: 否</div>
  </div>

  <div class="bottom">
    <div class="box">
      <div>报关人员: <span class="empty">—</span></div>
      <div>证号: <span class="empty">—</span></div>
      <div>电话: <span class="empty">—</span></div>
      <div class="declare">兹申明对以上内容承担如实申报、依法纳税之法律责任</div>
      <div class="stamp">申报单位(签章)</div>
    </div>
    <div class="box">
      <div>申报单位: <span class="empty">—</span></div>
    </div>
    <div class="box">
      <div>海关批注及签章</div>
    </div>
  </div>
</div>
<div style="text-align:right;font-size:9px;color:#999;margin-top:6px">报关单模版 v4 · 2026-07-14 02:31</div>
<script src="/templates/customs-declaration-editor.js"></script>
</body>
</html>`;
}
