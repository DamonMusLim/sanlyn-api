// 提单样单 / 补料 (BL Sample) Excel —— 按 Damon 认可模版「OOCL 提单样单/补料」。
// 可下载可编辑，客户改完我方复用。数据驱动：出货人/收货人/HS/船名/港口/柜/重量全取系统。
export async function renderBlSampleXlsx(d) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("样单");
  ws.columns = [{width:20},{width:22},{width:16},{width:16},{width:14},{width:14},{width:14}];
  const thin = { style:"thin", color:{argb:"FF999999"} };
  const border = { top:thin, left:thin, bottom:thin, right:thin };
  const bold = { bold:true };
  const fill = (argb)=>({ type:"pattern", pattern:"solid", fgColor:{argb} });

  const merge = (r,c1,c2)=>ws.mergeCells(r,c1,r,c2);
  const setRow = (cells)=>ws.addRow(cells);
  const num = (v,dp)=> (v===null||v===undefined||v==="") ? "" : Number(v).toLocaleString("en-US",{minimumFractionDigits:dp||0,maximumFractionDigits:dp||0});

  // 标题
  let r = setRow(["Shipper（发货人）","OOCL 提单样单 / 补料"]); r.font=bold; r.getCell(2).alignment={horizontal:"right"};
  setRow([d.shipperName||""]);
  r = setRow(["ADD: "+(d.shipperAddrEn||""),"","提单号", d.blNo||""]); r.getCell(3).font=bold;
  r = setRow(["","","出单方式", d.releaseType||""]); r.getCell(3).font=bold;
  r = setRow(["","","付款方式", d.payTerm||"P（待确认）"]); r.getCell(3).font=bold;
  setRow([]);
  r = setRow(["Consignee（收货人）","","HS CODE", d.hsCode||""]); r.font=bold;
  setRow([d.consignee||""]);
  r = setRow([d.consAddr||"","","显示 HS CODE", d.showHs?"是 ( V )    否 (   )":"是 (   )    否 ( V )"]);
  setRow([]);
  r = setRow(["Notify Party（通知人）"]); r.font=bold;
  setRow([d.notify||"SAME AS CONSIGNEE"]);
  setRow([]);
  r = setRow(["Ocean Vessel / Voy. No.（船名航次）","","Port of Loading（装货港）"]); r.font=bold;
  setRow([[d.vessel,d.voyage].filter(Boolean).join(" "),"", d.pol||""]);
  r = setRow(["Port of Discharge（卸货港）","","Final Destination（最终目的地）"]); r.font=bold;
  setRow([d.pod||"","", d.finalDest||d.pod||""]);
  setRow([]);
  // 货描表头
  r = setRow(["MARKS（唛头）","NO OF PKGS（总件数）","DESCRIPTION OF GOODS（货描）","GROSS WEIGHT（总重）","MEASUREMENT（体积）"]);
  r.font=bold; r.eachCell(c=>{ c.border=border; c.fill=fill("FFF2F2F2"); c.alignment={wrapText:true,vertical:"middle"}; });
  r = setRow([d.marks||"N/M", (d.totalCtn?num(d.totalCtn)+" CARTONS":""), (d.description||"")+(d.hsCode?"\nHS: "+d.hsCode:""), (d.gwKg?num(d.gwKg,2)+" KGS":""), (d.cbm?num(d.cbm,3)+" CBM":"")]);
  r.eachCell(c=>{ c.border=border; c.alignment={wrapText:true,vertical:"top"}; });
  setRow([]);
  setRow(["以下为分箱信息（VGM = 货重 + 柜皮重，皮重取柜门实印）"]);
  r = setRow(["CONTAINER NO","SEAL NO","TYPE","VGM (KGS)","NO OF PKGS","GROSS WEIGHT","MEASUREMENT"]);
  r.font=bold; r.eachCell(c=>{ c.border=border; c.fill=fill("FFF2F2F2"); });
  (d.containers||[]).forEach(c=>{
    const row = setRow([c.no||"", c.seal||"", c.type||"", num(c.vgm,2), num(c.pkgs), num(c.gw,2), num(c.cbm,3)]);
    row.eachCell(cc=>{ cc.border=border; });
  });
  setRow([]);
  (d.warnings||[]).forEach(w=>{ const wr=setRow([w]); wr.getCell(1).font={color:{argb:"FFB45309"}}; });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
