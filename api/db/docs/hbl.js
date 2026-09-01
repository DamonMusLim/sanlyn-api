export async function renderHbl(ctx){
  let { sp, spraw, cfg3, fwd, vessel, voyage, polSp, podSp, soNo, html, _xlsCapture, totRow, ap, esc, pick, fmtD, bl, containers, type, docType, portNames } = ctx;

  sp = sp || {};
  spraw = spraw || {};
  cfg3 = cfg3 || {};
  bl = bl || {};
  containers = Array.isArray(containers) ? containers : [];
  var variant = String(type || docType || "hbl");
  var overlay = variant === "hbl_overlay";
  var watermark = variant === "hbl_copy" ? "COPY  NON-NEGOTIABLE" : (variant === "hbl_tr" ? "TELEX RELEASE / SURRENDERED" : "");

  function val(){
    for(var i=0;i<arguments.length;i++){
      var x = arguments[i];
      if(x !== undefined && x !== null && String(x).trim() !== "") return x;
    }
    return "";
  }
  function out(x){ return esc(val(x)); }
  function lines(){
    var a = [];
    for(var i=0;i<arguments.length;i++){
      var x = val(arguments[i]);
      if(x !== "") a.push(out(x));
    }
    return a.length ? a.join("<br>") : "&nbsp;";
  }
  function fmtNum(x, suffix){
    if(x === undefined || x === null || String(x).trim() === "") return "";
    var n = Number(x);
    var s = Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : String(x);
    return suffix ? s + suffix : s;
  }
  function words1to99(n){
    n = Number(n);
    if(!Number.isFinite(n) || n < 1 || n > 99) return String(n || "");
    var ones = ["","ONE","TWO","THREE","FOUR","FIVE","SIX","SEVEN","EIGHT","NINE","TEN","ELEVEN","TWELVE","THIRTEEN","FOURTEEN","FIFTEEN","SIXTEEN","SEVENTEEN","EIGHTEEN","NINETEEN"];
    var tens = ["","","TWENTY","THIRTY","FORTY","FIFTY","SIXTY","SEVENTY","EIGHTY","NINETY"];
    if(n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
  }
  function payIsCollect(x){
    x = String(x || "").toLowerCase();
    return x.indexOf("collect") >= 0 || x.indexOf("到付") >= 0;
  }
  function payIsPrepaid(x){
    x = String(x || "").toLowerCase();
    return x.indexOf("prepaid") >= 0 || x.indexOf("预付") >= 0;
  }
  function blFormText(x){
    x = String(x || "").trim();
    if(!x) return "";
    if(/copy/i.test(x)) return "COPY";
    if(/telex|surrender|电放/i.test(x)) return "TELEX RELEASE";
    if(/waybill|sea waybill/i.test(x)) return "SEA WAYBILL";
    return x;
  }
  function portText(x){
    var raw = val(x);
    if(!raw) return "";
    var k = String(raw);
    return val(portNames && portNames[k], portNames && portNames[k.toUpperCase()], portNames && portNames[k.toLowerCase()], raw);
  }

  var blNo = val(bl.bl_no, bl.hbl_no, sp.hbl_no, sp.bl_no, spraw.blNo, spraw.bl_no);
  var mblNo = val(bl.mbl_no, sp.mbl_no);
  var shipperInfo = lines(val(bl.shipper_name, cfg3.nameEN), val(bl.shipper_address, cfg3.address));
  var consigneeInfo = lines(val(bl.consignee_name, sp.customer_en, sp.customer), val(bl.consignee_address));
  var notifyInfo = lines(bl.notify_name, bl.notify_address);
  var alsoNotify = "&nbsp;";
  var destAgent = lines(bl.overseas_delivery_address);
  var marks = val(bl.marks, spraw.marks);
  var goods = val(bl.cargo_name_en, sp.cargo_description);
  var pkgs = val(bl.pkgs, sp.total_cartons);
  var pkgUnit = val(bl.pkg_unit);
  var pkgText = [fmtNum(pkgs, ""), pkgUnit].filter(Boolean).join(" ");
  var gross = fmtNum(val(bl.gross_weight_kg, sp.gross_weight_kg, sp.actual_gross_weight_kg), "KGS");
  var cbm = fmtNum(val(bl.cbm, sp.total_cbm, sp.actual_cbm), "");
  var barge = [val(sp.barge_vessel), val(sp.barge_voyage)].filter(Boolean).join("/");
  var bargeHarbor = portText(val(sp.barge_port, sp.place_of_receipt));
  var ocean = [val(vessel, sp.vessel), val(voyage, sp.voyage)].filter(Boolean).join("/");
  var pol = portText(val(polSp, sp.pol));
  var discharge = portText(val(sp.discharge_port, podSp, sp.pod));
  var delivery = portText(val(sp.place_of_delivery));
  var destination = portText(val(sp.pod, podSp));
  var terms = val(bl.transport_terms, sp.transport_terms);
  var payWay = val(bl.payment_method, sp.freight_payment);
  var issuePlace = val(bl.issue_place);
  var issueDate = bl.issue_date ? fmtD(bl.issue_date) : "";
  var paymentAddress = val(bl.payment_address);
  var etd = val(sp.etd, spraw.etd);
  var etdText = etd ? fmtD(etd) : "";
  var formText = blFormText(val(bl.bl_form, sp.release_type));
  var countForWords = Number(containers.length ? containers.length : pkgs);
  var unitForWords = containers.length ? "CONTAINERS" : (String(pkgUnit || "PACKAGES").toUpperCase());
  var sayWords = countForWords && (containers.length || pkgUnit) ? words1to99(countForWords) + " (" + countForWords + ") " + unitForWords : "";
  var boxLines = containers.slice(0, 8).map(function(c){
    return [val(c.container_no), val(c.seal_no), val(c.container_type)].filter(Boolean).map(out).join(" / ");
  }).filter(Boolean);
  if(containers.length > 8) boxLines.push(out("AND " + (containers.length - 8) + " MORE"));
  var boxText = boxLines.length ? boxLines.join("<br>") : "&nbsp;";
  var titleNo = blNo || soNo || "";

  function cell(cls, r, c, rs, cs, content){
    return `<div class="${cls}" style="grid-row:${r}/span ${rs || 1};grid-column:${c}/span ${cs || 1}">${content || "&nbsp;"}</div>`;
  }
  function label(r, c, rs, cs, content){
    return overlay ? "" : cell("lbl", r, c, rs, cs, out(content));
  }
  function data(r, c, rs, cs, content, extra){
    return `<div class="dat ${extra || ""}" style="grid-row:${r}/span ${rs || 1};grid-column:${c}/span ${cs || 1}">${content || "&nbsp;"}</div>`;
  }

  var css = `<style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,'Times New Roman',serif;color:#000;background:#f0f0f0;padding:12px}
    .page{position:relative;width:210mm;height:297mm;margin:auto;background:#fff;padding:8mm}
    .sheet{display:grid;grid-template-columns:repeat(16,1fr);grid-template-rows:repeat(44,5.95mm);width:100%;height:100%;border:1px solid ${overlay ? "transparent" : "#000"}}
    .lbl,.dat{border-right:1px solid ${overlay ? "transparent" : "#000"};border-bottom:1px solid ${overlay ? "transparent" : "#000"};padding:1mm 1.3mm;font-size:9px;line-height:1.25;overflow:hidden;white-space:pre-wrap}
    .lbl{font-weight:700}
    .dat{font-size:10px}
    .top{font-size:13px;font-weight:700;text-align:center;align-self:center}
    .title{font-size:16px;font-weight:900;text-align:center;align-self:center;letter-spacing:0}
    .small{font-size:8px}
    .mid{font-size:9px}
    .goods{font-size:9px;line-height:1.18}
    .watermark{position:absolute;left:14mm;right:14mm;top:115mm;text-align:center;font-size:34px;font-weight:900;color:rgba(0,0,0,.16);transform:rotate(-24deg);pointer-events:none}
    @page{size:A4;margin:0}
    @media print{body{background:#fff;padding:0}.page{margin:0;padding:8mm;page-break-after:avoid}.watermark{color:rgba(0,0,0,.18)}}
  </style>`;

  html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>HBL ${out(titleNo)}</title>${css}${ap?'<script>window.onload=function(){window.print()}<\/script>':""}</head><body><div class="page">
    ${watermark ? `<div class="watermark">${out(watermark)}</div>` : ""}
    <div class="sheet">
      ${overlay ? "" : data(1, 2, 1, 6, out(cfg3.nameEN), "top")}
      ${overlay ? "" : data(2, 1, 1, 16, out("COMBINED TRANSPORT BILL OF LADING"), "title")}
      ${label(3, 1, 1, 6, "Shipper")}${label(3, 7, 1, 10, "B/L NO.")}
      ${data(4, 1, 3, 6, shipperInfo)}${data(4, 7, 1, 10, out(blNo))}
      ${label(5, 7, 1, 10, "Export reference")}${data(6, 7, 1, 10, out(mblNo))}
      ${label(7, 1, 1, 6, "Consignee")}${label(7, 7, 1, 10, "Destination Agent")}
      ${data(8, 1, 1, 6, consigneeInfo)}${data(8, 7, 1, 10, destAgent)}
      ${label(9, 1, 1, 6, "Notify Party")}${label(9, 7, 1, 10, "Also Notify Party")}
      ${data(10, 1, 3, 6, notifyInfo)}${data(10, 7, 3, 10, alsoNotify)}
      ${label(13, 1, 1, 4, "Pre-carriage by")}${label(13, 5, 1, 2, "Place of Receipt")}
      ${data(14, 1, 1, 4, out(barge))}${data(14, 5, 1, 2, out(bargeHarbor))}
      ${label(15, 1, 1, 4, "Ocean Vessel/Voy.No.")}${label(15, 5, 1, 2, "Port of Loading")}${label(15, 7, 1, 10, "Routing of Transportation")}
      ${data(16, 1, 1, 4, out(ocean))}${data(16, 5, 1, 2, out(pol))}${data(16, 7, 1, 10, out(terms))}
      ${label(17, 1, 1, 4, "Port of Discharge")}${label(17, 5, 1, 2, "Place of Delivery")}${label(17, 7, 1, 10, "Final Destination(For The Merchant's Reference Only)")}
      ${data(18, 1, 1, 4, out(discharge))}${data(18, 5, 1, 2, out(delivery))}${data(18, 7, 1, 10, out(destination))}
      ${label(19, 1, 1, 16, "Particular Furnished By Shipper")}
      ${label(20, 1, 1, 3, "Marks and Numbers")}${label(20, 4, 1, 2, "No.of Pkgs.")}${label(20, 6, 1, 4, "Description of Packages and Goods")}${label(20, 10, 1, 1, "Gross Weight")}${label(20, 11, 1, 6, "Measurement")}
      ${label(21, 1, 1, 3, "Container No.and Seal No.")}${label(21, 4, 1, 2, "or Containers")}${label(21, 6, 1, 4, "Type or Kind of Packages or Containers")}
      ${data(22, 1, 3, 3, out(marks), "goods")}${data(22, 4, 3, 2, out(pkgText), "goods")}${data(22, 6, 3, 4, out(goods), "goods")}${data(22, 10, 3, 1, out(gross), "goods")}${data(22, 11, 3, 6, out(cbm ? cbm + "CBM" : ""), "goods")}
      ${overlay ? "" : data(24, 10, 1, 7, out("SHIPPED ON BOARD:"), "mid")}${data(25, 10, 1, 7, out(etdText))}
      ${data(26, 1, 6, 9, boxText, "goods")}${data(26, 10, 1, 7, out(terms))}
      ${data(27, 10, 1, 7, out(payWay))}${data(28, 10, 1, 7, out(sayWords))}
      ${label(32, 1, 1, 2, "Total number of Containers or Packages (in words)")}${data(32, 3, 1, 14, sayWords ? out("SAY " + sayWords + " ONLY") : "&nbsp;", "mid")}
      ${label(33, 1, 1, 3, "Freight and Charges / Revenue Tons Rate Per")}${label(33, 4, 1, 2, "Prepaid")}${label(33, 6, 1, 2, "Collect")}
      ${data(34, 4, 1, 2, payIsPrepaid(payWay) ? out(payWay) : "&nbsp;")}${data(34, 6, 1, 2, payIsCollect(payWay) ? out(payWay) : "&nbsp;")}
      ${label(39, 8, 1, 9, "Place of B(s)/L Issued Dated")}
      ${label(40, 1, 1, 1, "Total amount")}${data(40, 8, 1, 9, out([issuePlace, issueDate].filter(Boolean).join("/")))}
      ${label(41, 1, 1, 1, "Ex.Rate")}${label(41, 2, 1, 4, "Prepaid at")}${label(41, 6, 1, 2, "Payable at")}${label(41, 8, 1, 9, "Laden on Board the Vessel")}
      ${data(42, 6, 1, 2, out(paymentAddress))}${label(42, 8, 1, 1, "Date:")}${data(42, 9, 1, 8, out(etdText))}
      ${label(43, 2, 1, 4, "Total Prepaid in Currency")}${label(43, 6, 1, 2, "No.of original Waybill(s)")}${label(43, 8, 1, 9, "As agent for the Carrier:")}
      ${data(44, 6, 1, 2, out(formText))}${data(44, 8, 1, 9, out(cfg3.nameEN))}
    </div>
  </div></body></html>`;

  totRow = 44;
  return { html, _xlsCapture, totRow };
}
