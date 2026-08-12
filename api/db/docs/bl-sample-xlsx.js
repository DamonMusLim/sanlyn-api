// 提单样单 / 补料 (BL Sample / SI) —— 直接填 Damon 认可的模版 (templates/bl-sample-template.xlsx)，
// 保留模版原格式(合并/边框/字体)，只覆盖数据单元格。数据驱动：出货人/收货人/HS/船名/港口/柜/VGM。
import { fileURLToPath } from "url";
export async function renderBlSampleXlsx(d) {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const tplPath = fileURLToPath(new URL("./templates/bl-sample-template.xlsx", import.meta.url));
  await wb.xlsx.readFile(tplPath);
  const ws = wb.getWorksheet(1) || wb.worksheets[0];
  const num = (v,dp)=> (v===null||v===undefined||v==="") ? "" : Number(v).toLocaleString("en-US",{minimumFractionDigits:dp||0,maximumFractionDigits:dp||0});
  const set = (addr,val)=>{ ws.getCell(addr).value = (val===undefined||val===null)?"":val; };

  set("A2", (d.shipperName||"") + (d.shipperAddrEn?("\nADD: "+d.shipperAddrEn):""));
  set("F2", d.blNo);
  set("F3", d.releaseType||"SWB 海运单");
  set("F4", d.payTerm||"P（待确认）");
  set("F5", d.hsCode);
  set("F6", d.showHs ? "是 ( V )    否 (   )" : "是 (   )    否 ( V )");
  set("A6", (d.consignee||"") + (d.consAddr?("\n"+d.consAddr):""));
  set("A10", d.notify||"SAME AS CONSIGNEE");
  set("A12", [d.vessel,d.voyage].filter(Boolean).join(" "));
  set("E12", d.pol);
  set("A14", d.pod);
  set("E14", d.finalDest||d.pod);
  set("A16", d.marks||"N/M");
  set("B16", d.totalCtn ? (num(d.totalCtn)+" CARTONS") : "");
  set("C16", (d.description||"") + (d.hsCode?("\nHS: "+d.hsCode):""));
  set("E16", d.gwKg ? (num(d.gwKg,2)+" KGS") : "");
  set("G16", d.cbm ? (num(d.cbm,3)+" CBM") : "");

  // 分箱信息：模版第 19 行是第一柜；先写警告(21/22/23)再插多柜(splice 会自动把警告下移)
  set("A21", "");   // 套柜对调是票特定手工备注，非本票默认清空
  set("A22", "⚠ 付款方式 P/C 请确认后再发（成交方式需与客户核对）");
  set("A23", "VGM 称重方式：Method 2 累加计算法（货重 = 净重 + 纸箱 + 托盘）");

  const ctns = Array.isArray(d.containers) ? d.containers : [];
  const fillCtn = (rn,c)=>{ set("A"+rn,c.no); set("B"+rn,c.seal); set("C"+rn,c.type); set("D"+rn,num(c.vgm,2)); set("E"+rn,num(c.pkgs)); set("F"+rn,num(c.gw,2)); set("G"+rn,num(c.cbm,3)); };
  fillCtn(19, ctns[0]||{});
  for (let i=1;i<ctns.length;i++){
    const nr = 19+i;
    ws.spliceRows(nr, 0, [[]]);                    // 在第一柜下插入一行
    const src = ws.getRow(19);
    const dst = ws.getRow(nr);
    for (let col=1; col<=7; col++){ try{ dst.getCell(col).style = { ...src.getCell(col).style }; }catch(e){} }
    fillCtn(nr, ctns[i]);
  }

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}
