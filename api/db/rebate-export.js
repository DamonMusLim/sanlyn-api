import ExcelJS from "exceljs";
import { existsSync } from "fs";
import { fileURLToPath } from "url";

const CHECK_NO = /物流|货运|运输|货代/;
const TEMPLATE_DIR = "../../assets/rebate-templates/";
const EXPORT_TEMPLATE = "export-detail-template.xlsx";
const PURCHASE_TEMPLATE = "purchase-detail-template.xlsx";
const CHECKLIST_TEMPLATE = "invoice-checklist-template.xlsx";

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function pct(v) {
  return Math.round(n(v) * 1000000) / 10000;
}

function dateOnly(v) {
  if (!v) return "";
  // pg parses DATE columns to a Date meant to be read via LOCAL getters
  // (new Date(year,month,day) under the hood) — toISOString() (UTC) loses
  // a day on positive-offset timezones (Asia/Shanghai here). See same fix
  // in rebate-customs-import.js's excelDate().
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(v).slice(0, 10);
}

function textCell(cell, value) {
  cell.numFmt = "@";
  cell.value = value == null ? "" : String(value);
}

function isReady(row) {
  return row.status === "matched" || row.status === "needs_review";
}

function templatePath(name) {
  const p = fileURLToPath(new URL(`${TEMPLATE_DIR}${name}`, import.meta.url));
  if (!existsSync(p)) throw new Error(`退税官方模板缺失: assets/rebate-templates/${name}`);
  return p;
}

function rowText(row, idx, value) {
  textCell(row.getCell(idx), value);
}

function rowNumber(row, idx, value, fmt = null) {
  const cell = row.getCell(idx);
  cell.value = n(value);
  if (fmt) cell.numFmt = fmt;
}

function customsItemNo(row) {
  const customsNo = String(row.customs_no || "");
  const itemNo = String(row.item_no || "").replace(/[^0-9]/g, "").padStart(3, "0").slice(-3);
  return `${customsNo}${itemNo}`;
}

function setDownloads(res, filename, buffer) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(Buffer.from(buffer));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function zipDateTime() {
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { date, time };
}

function u16(v) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(v);
  return b;
}

function u32(v) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v >>> 0);
  return b;
}

function buildZip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  const dt = zipDateTime();
  for (const f of files) {
    const name = Buffer.from(f.name);
    const data = Buffer.from(f.data);
    const crc = crc32(data);
    const localHeader = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name,
    ]);
    local.push(localHeader, data);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(dt.time), u16(dt.date),
      u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += localHeader.length + data.length;
  }
  const body = Buffer.concat(local);
  const dir = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(dir.length), u32(body.length), u16(0),
  ]);
  return Buffer.concat([body, dir, end]);
}

function setZip(res, filename, files) {
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return res.status(200).send(buildZip(files));
}

async function loadBatch(pool, batchId) {
  const r = await pool.query(`SELECT * FROM rebate_batches WHERE id=$1`, [batchId]);
  if (!r.rows[0]) throw new Error("batch not found");
  return r.rows[0];
}

async function loadRows(pool, batchId) {
  const r = await pool.query(
    `SELECT m.*, l.customs_no,l.item_no,l.hs_code_8,l.hs_code_10,l.name_cn,l.legal_unit,l.legal_qty,
            l.usd_fob,l.export_invoice_no,l.export_date,l.deal_amount_cny,
            inv.seller_name,inv.seller_tax_id,inv.amount_ex_tax,inv.total_tax,inv.amount_incl_tax,
            inv.tax_rate,inv.issue_date,inv.currency
       FROM rebate_matching m
       JOIN rebate_customs_lines l ON l.id=m.customs_line_id
       LEFT JOIN finance_invoices_in inv ON inv.invoice_no=m.invoice_no
      WHERE m.batch_id=$1
      ORDER BY l.customs_no,l.item_no,m.id`,
    [batchId]
  );
  return r.rows;
}

export function buildShortage(rows) {
  const readyRows = rows.filter(isReady);
  const needsReview = rows.filter((x) => x.status === "needs_review");
  const blocked = rows.filter((x) => x.status && !isReady(x));
  const ready = [...new Set(readyRows.map((x) => x.customs_no))];
  return {
    ready_customs_nos: ready,
    needs_review: needsReview.map((x) => ({
      customs_no: x.customs_no,
      item_no: x.item_no,
      invoice_no: x.invoice_no,
      note: x.note,
    })),
    blocked_or_review: blocked.map((x) => ({
      customs_no: x.customs_no,
      item_no: x.item_no,
      invoice_no: x.invoice_no,
      status: x.status,
      note: x.note,
    })),
  };
}

export async function exportWorkbook(batch, rows) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath(EXPORT_TEMPLATE));
  const ws = wb.getWorksheet("模板");
  if (!ws) throw new Error("退税官方模板缺少sheet: 模板");
  const byLine = new Map();
  for (const row of rows.filter(isReady)) {
    if (!byLine.has(row.customs_line_id)) byLine.set(row.customs_line_id, row);
  }
  let idx = 9;
  for (const row of byLine.values()) {
    const r = ws.getRow(idx++);
    rowText(r, 1, batch.declare_ym);
    rowText(r, 2, batch.declare_batch);
    rowText(r, 3, row.link_no);
    rowText(r, 4, customsItemNo(row));
    r.getCell(5).value = "";
    rowText(r, 6, row.export_invoice_no);
    r.getCell(7).value = dateOnly(row.export_date);
    rowText(r, 8, row.hs_code_8);
    r.getCell(9).value = row.name_cn || "";
    r.getCell(10).value = row.legal_unit || "";
    rowNumber(r, 11, row.legal_qty);
    rowNumber(r, 12, row.usd_fob);
    r.commit();
  }
  return wb.xlsx.writeBuffer();
}

export async function purchaseWorkbook(batch, rows) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath(PURCHASE_TEMPLATE));
  const ws = wb.getWorksheet("模板");
  if (!ws) throw new Error("退税官方模板缺少sheet: 模板");
  let idx = 9;
  for (const row of rows.filter(isReady)) {
    const r = ws.getRow(idx++);
    rowText(r, 1, batch.declare_ym);
    rowText(r, 2, batch.declare_batch);
    rowText(r, 3, row.link_no);
    r.getCell(4).value = "V";
    r.getCell(5).value = "02";
    rowText(r, 6, row.invoice_no);
    r.getCell(7).value = dateOnly(row.issue_date);
    rowText(r, 8, row.seller_tax_id);
    rowText(r, 9, row.hs_code_8);
    r.getCell(10).value = row.name_cn || "";
    r.getCell(11).value = row.legal_unit || "";
    rowNumber(r, 12, row.alloc_qty || row.legal_qty);
    rowNumber(r, 13, row.alloc_amount);
    rowNumber(r, 14, pct(row.tax_rate), "0.0000");
    rowNumber(r, 15, pct(row.rebate_rate), "0.0000");
    rowNumber(r, 16, row.alloc_rebate);
    r.commit();
  }
  return wb.xlsx.writeBuffer();
}

export async function checklistWorkbook(rows) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(templatePath(CHECKLIST_TEMPLATE));
  const ws = wb.getWorksheet("sheet1");
  if (!ws) throw new Error("退税官方模板缺少sheet: sheet1");
  const invoices = new Map();
  for (const row of rows.filter((x) => isReady(x) && x.invoice_no)) invoices.set(row.invoice_no, row);
  let idx = 2;
  let seq = 1;
  for (const row of invoices.values()) {
    const r = ws.getRow(idx++);
    r.getCell(1).value = seq++;
    r.getCell(2).value = CHECK_NO.test(row.name_cn || row.seller_name || "") ? "否" : "是";
    r.getCell(3).value = "";
    rowText(r, 4, row.invoice_no);
    r.getCell(5).value = "";
    rowText(r, 6, row.invoice_no);
    r.getCell(7).value = dateOnly(row.issue_date);
    rowText(r, 8, row.seller_tax_id);
    r.getCell(9).value = row.seller_name || "";
    rowNumber(r, 10, row.amount_ex_tax);
    rowNumber(r, 11, row.total_tax);
    r.commit();
  }
  return wb.xlsx.writeBuffer();
}

export async function generateRebateExport(pool, batchId) {
  const batch = await loadBatch(pool, batchId);
  const rows = await loadRows(pool, batchId);
  const matched = rows.filter(isReady);
  const files = {
    export_detail: await exportWorkbook(batch, rows),
    purchase_detail: await purchaseWorkbook(batch, rows),
    invoice_checklist: await checklistWorkbook(rows),
  };
  const total = matched.reduce((s, x) => s + n(x.alloc_rebate), 0);
  const updated = await pool.query(
    `UPDATE rebate_batches
        SET status='generated', total_rebate=$2, export_line_count=$3, import_line_count=$4, updated_at=now()
      WHERE id=$1
      RETURNING *`,
    [batchId, Math.round(total * 100) / 100, new Set(matched.map((x) => x.customs_line_id)).size, matched.length]
  );
  return { success: true, batch: updated.rows[0] || batch, files, shortage: buildShortage(rows) };
}

export async function handleGenerate(req, res, pool, batchId) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const pkg = await generateRebateExport(pool, batchId);
  const which = req.query.file || req.body?.file || "all";
  if (which === "json") {
    return res.json({ success: true, batch: pkg.batch, shortage: pkg.shortage });
  }
  const name = `${which}-${pkg.batch.declare_ym}-${pkg.batch.declare_batch}.xlsx`;
  if (which !== "all") return setDownloads(res, name, pkg.files[which] || pkg.files.export_detail);
  return setZip(res, `rebate-${pkg.batch.declare_ym}-${pkg.batch.declare_batch}.zip`, [
    { name: "出口明细.xlsx", data: pkg.files.export_detail },
    { name: "进货明细.xlsx", data: pkg.files.purchase_detail },
    { name: "勾选清单.xlsx", data: pkg.files.invoice_checklist },
  ]);
}
