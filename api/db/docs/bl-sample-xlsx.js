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
