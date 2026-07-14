import ExcelJS from "exceljs";

import { TAX_ID, TAXPAYER } from "./tax-rebate-taxpayer.js";

const EXPORT_HEADERS = [
  "序号", "关联号", "出口发票号", "出口货物报关单号", "代理出口货物证明号", "出口日期",
  "出口商品代码", "出口商品名称", "计量单位", "出口数量", "美元离岸价", "申报商品代码", "退（免）税业务类型", "备注",
];

const PURCHASE_HEADERS = [
  "序号", "关联号", "税种", "凭证种类", "进货凭证号", "供货方纳税人识别号", "开票日期",
  "出口商品代码", "商品名称", "计量单位", "数量", "计税金额", "征税率（%）", "退税率（%）", "可退税额", "备注",
];

function money(n) {
  const x = Number(n || 0);
  return Math.round(x * 100) / 100;
}

function fmtMoney(n) {
  return money(n).toFixed(2);
}

function fmtRate(n) {
  const x = Number(n || 0);
  return (x > 1 ? x : x * 100).toFixed(4);
}

function periodLabel(period) {
  return `${period.slice(0, 4)}年${period.slice(4, 6)}月`;
}

function styleSheet(ws, colCount) {
  ws.views = [{ state: "frozen", ySplit: 6 }];
  for (let r = 1; r <= 6; r += 1) {
    ws.getRow(r).height = r === 5 ? 8 : 22;
    ws.getRow(r).font = { name: "SimSun", size: r === 6 ? 10 : 11, bold: r === 6 };
  }
  ws.getRow(6).alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  ws.getRow(6).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEFEFEF" } };
    cell.border = border();
  });
  for (let c = 1; c <= colCount; c += 1) {
    ws.getColumn(c).width = c <= 2 ? 12 : 16;
  }
}

function border() {
  return {
    top: { style: "thin" },
    left: { style: "thin" },
    bottom: { style: "thin" },
    right: { style: "thin" },
  };
}

function addTopBlock(ws, title, period, batch, total, colCount) {
  ws.mergeCells(1, 1, 1, colCount);
  ws.mergeCells(2, 1, 2, colCount);
  ws.mergeCells(3, 1, 3, colCount);
  ws.mergeCells(4, 1, 4, colCount);
  ws.getCell(1, 1).value = `纳税人识别号（统一社会信用代码）：${TAX_ID} ｜ 申报年月：${periodLabel(period)} ｜ 申报批次：${batch}`;
  ws.getCell(2, 1).value = `纳税人名称：${TAXPAYER}`;
  ws.getCell(3, 1).value = `申报退税额：${fmtMoney(total)}`;
  ws.getCell(4, 1).value = `其中：增值税 ${fmtMoney(total)} ｜ 消费税 0.00 ｜ 金额单位：元（列至角分）`;
  ws.getCell(5, 1).value = title;
  ws.mergeCells(5, 1, 5, colCount);
  ws.getCell(5, 1).font = { name: "SimSun", size: 12, bold: true };
  ws.getCell(5, 1).alignment = { horizontal: "center" };
}

function addRows(ws, headers, rows) {
  ws.addRow(headers);
  rows.forEach((row) => {
    const r = ws.addRow(row);
    r.eachCell((cell) => {
      cell.border = border();
      cell.font = { name: "SimSun", size: 10 };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    });
  });
}

async function workbookBuffer(sheetName, title, headers, rows, period, batch, total) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Sanlyn";
  wb.created = new Date();
  const ws = wb.addWorksheet(sheetName);
  addTopBlock(ws, title, period, batch, total, headers.length);
  addRows(ws, headers, rows);
  styleSheet(ws, headers.length);
  return wb.xlsx.writeBuffer();
}

export async function renderExportXls({ period, batch, exportRows, totalRebate }) {
  const body = exportRows.map((r, i) => [
    i + 1,
    r.link_no,
    r.export_invoice_no || "",
    `${r.declaration_no}${String(r.sort_order || i + 1).padStart(3, "0")}`,
    "",
    r.export_date || "",
    r.hs_code || "",
    r.goods_name || "",
    r.unit || "",
    r.qty ?? "",
    r.fob_usd == null ? "" : Number(r.fob_usd).toFixed(2),
    r.hs_code || "",
    "01",
    r.note || "",
  ]);
  return workbookBuffer("出口明细表", "外贸企业出口退税出口明细申报表", EXPORT_HEADERS, body, period, batch, totalRebate);
}

export async function renderPurchaseXls({ period, batch, purchaseRows, totalRebate }) {
  const body = purchaseRows.map((r, i) => [
    i + 1,
    r.link_no,
    "增值税",
    "增值税专用发票",
    r.invoice_no || "",
    r.seller_tax_id || "",
    r.issue_date || "",
    r.hs_code || "",
    r.goods_name || "",
    r.unit || "",
    r.qty ?? "",
    fmtMoney(r.taxable_amount),
    fmtRate(r.tax_rate),
    fmtRate(r.rebate_rate),
    fmtMoney(r.rebate_amount),
    r.note || "",
  ]);
  return workbookBuffer("进货明细表", "外贸企业出口退税进货明细申报表", PURCHASE_HEADERS, body, period, batch, totalRebate);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTimeDate(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: dosDate };
}

export function buildZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  const dt = dosTimeDate();
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(dt.time, 10);
    local.writeUInt16LE(dt.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, 30);
    chunks.push(local, data);
    const cd = Buffer.alloc(46 + name.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(dt.time, 12);
    cd.writeUInt16LE(dt.date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    name.copy(cd, 46);
    central.push(cd);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}
