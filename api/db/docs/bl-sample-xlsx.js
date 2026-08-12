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

// HTML 预览（客户/货代点"预览"看，不用下载）—— 与 excel 同数据
export function renderBlSampleHtml(d){
  const e = v => v==null?"":String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/\n/g,"<br>");
  const n = (v,dp)=> (v===null||v===undefined||v==="")?"":Number(v).toLocaleString("en-US",{minimumFractionDigits:dp||0,maximumFractionDigits:dp||0});
  const rows = (d.containers||[]).map(c=>`<tr><td>${e(c.no)}</td><td>${e(c.seal)}</td><td>${e(c.type)}</td><td>${n(c.vgm,2)}</td><td>${n(c.pkgs)}</td><td>${n(c.gw,2)}</td><td>${n(c.cbm,3)}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>提单样单/补料 · ${e(d.blNo)}</title>
  <style>body{font-family:-apple-system,'PingFang SC',Arial,sans-serif;background:#f0f2f5;margin:0;padding:18px;color:#111}
  .p{max-width:820px;margin:auto;background:#fff;border:1px solid #ddd;border-radius:8px;padding:22px}
  h2{text-align:center;margin:0 0 14px}.k{color:#666;font-weight:700;width:150px}
  table{width:100%;border-collapse:collapse;font-size:13px}td,th{border:1px solid #ccc;padding:6px 8px;vertical-align:top}
  .g th{background:#f4f4f4;font-size:11px}.no{border:0}.no td{border:0;padding:3px 8px}.w{color:#b45309;font-size:12px}</style></head><body><div class="p">
  <h2>提单样单 / 补料（Shipping Instruction）</h2>
  <table class="no"><tr><td class="k">Shipper 发货人</td><td>${e(d.shipperName)}${d.shipperAddrEn?"<br>ADD: "+e(d.shipperAddrEn):""}</td><td class="k">提单号</td><td>${e(d.blNo)}</td></tr>
  <tr><td class="k">Consignee 收货人</td><td>${e(d.consignee)}${d.consAddr?"<br>"+e(d.consAddr):""}</td><td class="k">出单方式 / HS</td><td>${e(d.releaseType||"SWB 海运单")} · HS ${e(d.hsCode)}</td></tr>
  <tr><td class="k">Notify 通知人</td><td>${e(d.notify||"SAME AS CONSIGNEE")}</td><td class="k">付款方式</td><td>${e(d.payTerm||"P（待确认）")}</td></tr>
  <tr><td class="k">船名航次</td><td>${e([d.vessel,d.voyage].filter(Boolean).join(" "))}</td><td class="k">装货港</td><td>${e(d.pol)}</td></tr>
  <tr><td class="k">卸货港</td><td>${e(d.pod)}</td><td class="k">最终目的地</td><td>${e(d.finalDest||d.pod)}</td></tr></table>
  <table style="margin-top:12px"><tr class="g"><th>唛头</th><th>总件数</th><th>货描</th><th>总重</th><th>体积</th></tr>
  <tr><td>${e(d.marks||"N/M")}</td><td>${d.totalCtn?n(d.totalCtn)+" CARTONS":""}</td><td>${e(d.description)}${d.hsCode?"<br>HS: "+e(d.hsCode):""}</td><td>${d.gwKg?n(d.gwKg,2)+" KGS":""}</td><td>${d.cbm?n(d.cbm,3)+" CBM":""}</td></tr></table>
  <div style="margin:12px 0 6px;font-weight:700">分箱信息（VGM = 货重 + 柜皮重）</div>
  <table class="g"><tr class="g"><th>CONTAINER NO</th><th>SEAL NO</th><th>TYPE</th><th>VGM (KGS)</th><th>NO OF PKGS</th><th>GROSS WEIGHT</th><th>MEASUREMENT</th></tr>${rows}</table>
  <div class="w" style="margin-top:12px">⚠ 付款方式 P/C 请确认后再发（成交方式需与客户核对）<br>VGM 称重方式：Method 2 累加计算法（货重 = 净重 + 纸箱 + 托盘）</div>
  <div style="text-align:center;color:#9ca3af;font-size:11px;margin-top:14px">预览 · 关闭本页回到列表点「下载」可改 Excel</div>
  </div></body></html>`;
}
