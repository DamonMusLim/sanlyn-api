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
