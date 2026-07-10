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

  var issuer = clean(firstOrderValue(orders, "issuing_company", "issuingCompany"));
  var company = await loadCompany(pool, issuer);
  var shipper = sellerLabel(issuer, company);

  var customer = firstOrderValue(orders, "customer", "customer");
  // 合同协议号用我们的 FS 号(内部号),优先取 FS 开头的合同号;都没有才退回原始 contract_no
  var contractNo = (function () {
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
    <div>预录入编号: ${blank(opts.preEntryNo || "")}</div>
    <div>海关编号: ${blank(opts.customsNo || "")} ${blank(opts.customsName || "")}</div>
    <div style="text-align:right">页码: 1/1</div>
  </div>

  <div class="grid4">
    ${cell("境内发货人", shipper)}
    ${cell("出境关别", "")}
    ${cell("出口日期", fmtDate(pick(plan.etd, praw.etd)))}
    ${cell("申报日期", today)}
    ${cell("备案号", "")}
  </div>
  <div class="grid4 row2">
    ${cell("境外收货人", customer)}
    ${cell("运输方式", "水路运输")}
    ${cell("运输工具名称及航次号", vesselVoyage)}
    ${cell("提运单号", blNo)}
  </div>
  <div class="grid4 row3">
    ${cell("生产销售单位", shipper)}
    ${cell("监管方式", tradeMode)}
    ${cell("征免性质", levyNature)}
    ${cell("许可证号", "")}
  </div>
  <div class="grid4 row4">
    ${cell("合同协议号", contractNo)}
    ${cell("贸易国(地区)", destination)}
    ${cell("运抵国(地区)", destination)}
    ${cell("指运港", pod)}
    ${cell("离境口岸", "")}
  </div>
  <div class="grid4 row5">
    ${cell("包装种类", "纸箱", "small")}
    ${cell("件数", totalCtn ? fmtInt(totalCtn) : "", "small")}
    ${cell("毛重(千克)", fmtM(grossWeight, 0), "small")}
    ${cell("净重(千克)", fmtM(netWeight, 0), "small")}
    ${cell("成交方式", "FOB", "small")}
    ${cell("运费", "", "small")}
    ${cell("保费", "", "small")}
    ${cell("杂费", "", "small")}
  </div>
  ${bigCell("随附单证及编号", "")}
  ${bigCell("标记唛码及备注", notes)}

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
    <tbody>${cargoRows(lines, destination)}</tbody>
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
<div style="text-align:right;font-size:9px;color:#999;margin-top:6px">报关单模版 v1 · 2026-07-10 13:04</div>
<script src="/templates/customs-declaration-editor.js"></script>
</body>
</html>`;
}
