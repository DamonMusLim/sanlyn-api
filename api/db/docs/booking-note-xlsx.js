// 托书 / 出口货物委托单 (Booking Instruction) Excel —— 按 Damon 认可格式（第一单·订舱用）。
// 数据驱动：发货人issuing_company / 收货人订单customer / 请帮忙订船东carriers / 成交方式freight_term(EXW/FOB)。
export async function renderBookingNoteXlsx(d) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("委托单");
  ws.columns = [{width:22},{width:16},{width:14},{width:26},{width:12},{width:14},{width:16}];
  const thin = { style:"thin", color:{argb:"FF999999"} };
  const bd = { top:thin, left:thin, bottom:thin, right:thin };
  const bold = { bold:true };
  const wrap = { wrapText:true, vertical:"top" };
  const num = (v,dp)=> (v===null||v===undefined||v==="") ? "" : Number(v).toLocaleString("en-US",{minimumFractionDigits:dp||0,maximumFractionDigits:dp||0});
  const R = (cells)=>ws.addRow(cells);

  // 标题
  let r = R(["出口货物委托单"]); ws.mergeCells(r.number,1,r.number,7);
  r.getCell(1).font={bold:true,size:14}; r.getCell(1).alignment={horizontal:"center"};
  r = R(["","","","","","托运日期:", d.bookingDate||""]); r.getCell(6).font=bold;
  // Shipper / D/R
  r = R(["Shipper（发货人）","","","D/R NO.(编号)"]); r.getCell(1).font=bold; r.getCell(4).font=bold;
  R([d.shipperName||"","","","请在提单待确认样上注明:"]);
  R(["ADD: "+(d.shipperAddr||"")]);
  R([]);
  // Consignee + 订船东信息块（右侧）
  r = R(["Consignee（收货人）","","","请帮忙订船东: "+(d.carrierBook||"")]); r.getCell(1).font=bold; r.getCell(4).font={bold:true,color:{argb:"FF1D4ED8"}};
  R([d.consignee||"","","","船名航次: "+([d.vessel,d.voyage].filter(Boolean).join(" / "))]);
  r = R([d.consAddr||"","","","ETD "+(d.etd||"")+(d.loadDate?"（"+d.loadDate+"装柜）":"")]); r.getCell(1).alignment=wrap;
  R(["","","","出单方式: "+(d.releaseType||"")]);
  R([]);
  // Notify
  r = R(["Notify Party（通知人）"]); r.getCell(1).font=bold;
  R([d.notify||""]);
  R([]);
  // 船名/装货港
  r = R(["Ocean vessel（船名）Voy.No.（航次）","","Port of Loading（装货港）"]); r.getCell(1).font=bold; r.getCell(3).font=bold;
  R([[d.vessel,d.voyage].filter(Boolean).join(" / "),"", d.pol||""]);
  r = R(["Port of Discharge（卸货港）","","Place of Delivery（交货地点）","","Final Destination for the Merchant"]); [1,3,5].forEach(i=>r.getCell(i).font=bold);
  R([d.pod||"","", d.placeOfDelivery||d.pod||"","", d.finalDest||d.pod||""]);
  R([]);
  // 货物表
  r = R(["Container No.（集装箱号）\nSeal No.（封志号）Marks & Nos.","No. of containers","King of Packages\nDescription of Goods","","","Gross Weight\n毛重(KGS)","Measurement\n尺码(立方米)"]);
  r.font=bold; r.eachCell(c=>{ c.border=bd; c.alignment={wrapText:true,vertical:"middle"}; c.fill={type:"pattern",pattern:"solid",fgColor:{argb:"FFF2F2F2"}}; });
  r = R([(d.containerSummary||""), (d.ctnLine||""), (d.goodsDesc||""),"","", num(d.gwKg,0), num(d.cbm,3)]);
  r.getCell(3).font={color:{argb:"FFB91C1C"}}; r.eachCell(c=>{ c.border=bd; c.alignment=wrap; });
  R([]);
  // 底栏
  r = R(["船期","", d.sailing||"","运费", d.freight||"FREIGHT PREPAID","集装箱数量", d.ctnQty||""]);
  [1,4,6].forEach(i=>r.getCell(i).font=bold);
  r = R(["运输条款", d.term||"CY-CY","成交方式(Incoterm)", d.incoterm||""]);
  [1,3].forEach(i=>r.getCell(i).font=bold);

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

// HTML 预览（客户/货代看，不下载）—— 与 excel 同数据
export function renderBookingNoteHtml(d){
  const e = v => v==null?"":String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/\n/g,"<br>");
  const n = (v,dp)=> (v===null||v===undefined||v==="")?"":Number(v).toLocaleString("en-US",{minimumFractionDigits:dp||0,maximumFractionDigits:dp||0});
  return `<!doctype html><html><head><meta charset="utf-8"><title>出口货物委托单/托书</title>
  <style>body{font-family:-apple-system,'PingFang SC',Arial,sans-serif;background:#f0f2f5;margin:0;padding:18px;color:#111}
  .p{max-width:820px;margin:auto;background:#fff;border:1px solid #ddd;border-radius:8px;padding:22px}
  h2{text-align:center;margin:0 0 6px}.d{text-align:right;color:#666;font-size:12px;margin-bottom:10px}
  table{width:100%;border-collapse:collapse;font-size:13px}td,th{border:1px solid #ccc;padding:6px 8px;vertical-align:top}
  .k{color:#666;font-weight:700;width:150px}.b{color:#1d4ed8;font-weight:700}.g th{background:#f4f4f4;font-size:11px}.red{color:#b91c1c}</style></head><body><div class="p">
  <h2>出口货物委托单 / 托书</h2><div class="d">托运日期: ${e(d.bookingDate)}</div>
  <table><tr><td class="k">Shipper 发货人</td><td>${e(d.shipperName)}${d.shipperAddr?"<br>ADD: "+e(d.shipperAddr):""}</td><td class="k">请帮忙订船东</td><td class="b">${e(d.carrierBook)}</td></tr>
  <tr><td class="k">Consignee 收货人</td><td>${e(d.consignee)}${d.consAddr?"<br>"+e(d.consAddr):""}</td><td class="k">船名航次 / 出单方式</td><td>${e([d.vessel,d.voyage].filter(Boolean).join(" / "))} · ${e(d.releaseType)}</td></tr>
  <tr><td class="k">Notify 通知人</td><td>${e(d.notify)}</td><td class="k">ETD</td><td>${e(d.etd)}${d.loadDate?"（"+e(d.loadDate)+"装柜）":""}</td></tr>
  <tr><td class="k">装货港 / 卸货港</td><td>${e(d.pol)} → ${e(d.pod)}</td><td class="k">最终目的地</td><td>${e(d.finalDest||d.pod)}</td></tr></table>
  <table style="margin-top:12px"><tr class="g"><th>集装箱/封号</th><th>No. of containers</th><th>货描 Description</th><th>毛重(KGS)</th><th>体积(CBM)</th></tr>
  <tr><td>${e(d.containerSummary)}</td><td>${e(d.ctnLine)}</td><td class="red">${e(d.goodsDesc)}</td><td>${d.gwKg?n(d.gwKg,0):""}</td><td>${d.cbm?n(d.cbm,3):""}</td></tr></table>
  <table style="margin-top:12px"><tr><td class="k">运费</td><td>${e(d.freight||"FREIGHT PREPAID")}</td><td class="k">运输条款</td><td>${e(d.term||"CY-CY")}</td><td class="k">成交方式</td><td>${e(d.incoterm)}</td></tr></table>
  <div style="text-align:center;color:#9ca3af;font-size:11px;margin-top:14px">预览 · 关闭本页回到列表点「下载」可改 Excel</div>
  </div></body></html>`;
}
