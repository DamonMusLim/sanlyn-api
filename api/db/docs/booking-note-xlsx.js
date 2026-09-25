import fs from "fs";
import path from "path";
import zlib from "zlib";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = path.resolve(__dirname, "../templates/booking-order-hgj.xlsx");

const PLACEHOLDERS = [
  "billForm", "bookingProxyName", "boxSizeNumber", "companyEnName", "companyName",
  "consigneeInfo", "date", "deckPhone", "email", "estimatedTimeDeparture", "etd",
  "goodsName", "grossWeight", "marks", "notifierInfo", "number", "outerOrderNo",
  "payWay", "portArrive", "portStart", "portUnloading", "remark", "shipperInfo",
  "shippingCompany", "transportItems", "unitOfWeight", "userName", "vesselName",
  "volume", "voyage"
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

function readZipEntries(buf) {
  const entries = [];
  let off = 0;
  while (off + 30 <= buf.length && buf.readUInt32LE(off) === 0x04034b50) {
    const flags = buf.readUInt16LE(off + 6);
    const method = buf.readUInt16LE(off + 8);
    const compressedSize = buf.readUInt32LE(off + 18);
    const uncompressedSize = buf.readUInt32LE(off + 22);
    const nameLen = buf.readUInt16LE(off + 26);
    const extraLen = buf.readUInt16LE(off + 28);
    const name = buf.slice(off + 30, off + 30 + nameLen).toString("utf8");
    const dataStart = off + 30 + nameLen + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (flags & 0x08) throw new Error("xlsx template uses unsupported data descriptors");
    const compressed = buf.slice(dataStart, dataEnd);
    let data;
    if (method === 0) data = compressed;
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error("xlsx template uses unsupported ZIP method: " + method);
    if (data.length !== uncompressedSize) throw new Error("bad xlsx entry size: " + name);
    entries.push({ name, data, isDir: name.endsWith("/") });
    off = dataEnd;
  }
  return entries;
}

function writeZip(entries) {
  const now = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = entry.isDir ? Buffer.alloc(0) : Buffer.from(entry.data);
    const compressed = entry.isDir ? Buffer.alloc(0) : zlib.deflateRawSync(data);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(entry.isDir ? 0 : 8, 8);
    local.writeUInt16LE(now.time, 10);
    local.writeUInt16LE(now.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    locals.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(entry.isDir ? 0 : 8, 10);
    central.writeUInt16LE(now.time, 12);
    central.writeUInt16LE(now.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(entry.isDir ? 0x10 : 0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + compressed.length;
  }

  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, end]);
}

function escapeXml(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeSharedString(v) {
  return escapeXml(v).replace(/\r\n|\r|\n/g, "&#10;");
}

function escapeDrawingText(v) {
  return escapeXml(v).replace(/\r\n|\r|\n/g, '</a:t></a:r><a:br/><a:r><a:rPr lang="zh-CN"/><a:t>');
}

function replacePlaceholders(xml, data, escaper = escapeXml) {
  return xml.replace(/\{\{([A-Za-z0-9]+)\}\}/g, (_m, key) => escaper(data[key] ?? ""));
}

function removeRepeatMarkers(xml) {
  return xml.replace(/\[\[\/-&gt;\s*\]\]/g, "").replace(/\[\[\/->\s*\]\]/g, "");
}

const EMPTY_LABELS = [
  ["etd", "货好时间:"],
  ["billForm", "提 单 形 式:&#10;Type of B/L:"],
  ["transportItems", "运 输 条 款:&#10;Transport Items:"],
  ["payWay", "付款方式:&#10;(pp/cc):"],
  ["shippingCompany", "船 公 司:&#10;Carrier:"],
  ["boxSizeNumber", "箱 型 箱 量:&#10;Contr Qty:"],
  ["remark", "订 舱 备 注  Remark:"],
  ["userName", "联系人(Attn):"],
  ["deckPhone", "电话(Tel):"],
  ["email", "邮箱（E-mail):"]
];

function escapeRegExp(v) {
  return String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clearEmptyValueLabels(xml, data) {
  let out = xml;
  for (const [key, label] of EMPTY_LABELS) {
    if (String(data[key] ?? "").trim() !== "") continue;
    const labelPattern = escapeRegExp(label);
    out = out.replace(
      new RegExp(`(<si>\\s*<t[^>]*>)${labelPattern}(<\\/t>\\s*<\\/si>)`, "g"),
      "$1$2"
    );
  }
  return out;
}

function contentTypesWithoutImages(xml) {
  return xml.replace(/<Default[^>]+Extension="png"[^>]*\/>/g, "");
}

function drawingWithoutPictures(xml) {
  const parts = xml.split(/(?=<xdr:twoCellAnchor)/);
  return parts.filter(p => !p.includes("<xdr:pic>")).join("");
}

function relationshipsWithoutImages(xml) {
  return xml.replace(/<Relationship\b[^>]+Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image"[^>]*\/>/g, "");
}

export function commonPrefix(codes) {
  const uniq = Array.from(new Set((Array.isArray(codes) ? codes : String(codes || "").split(/[,;\s]+/))
    .map(x => String(x || "").trim())
    .filter(Boolean)));
  if (uniq.length === 0) return "";
  if (uniq.length === 1) return uniq[0];
  let prefix = uniq[0];
  for (const code of uniq.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < code.length && prefix[i] === code[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix.length >= 4 ? prefix : "";
}

export function goodsNameWithHs(description, hsCodes) {
  const desc = String(description || "").trim();
  const hs = commonPrefix(hsCodes);
  return [desc, hs ? "HS:" + hs : ""].filter(Boolean).join("\n");
}

export async function renderBookingNoteXlsx(d) {
  const source = fs.readFileSync(TEMPLATE_PATH);
  const entries = readZipEntries(source);
  const data = {};
  for (const key of PLACEHOLDERS) data[key] = d && d[key] != null ? d[key] : "";

  const out = [];
  for (const entry of entries) {
    if (entry.name.startsWith("xl/media/")) continue;
    if (entry.name === "xl/sharedStrings.xml") {
      let xml = entry.data.toString("utf8");
      xml = xml.replace(/<t>ETD:<\/t>/g, '<t>货好时间:</t>');
      xml = clearEmptyValueLabels(xml, data);
      xml = replacePlaceholders(xml, data, escapeSharedString);
      xml = removeRepeatMarkers(xml);
      out.push({ ...entry, data: Buffer.from(xml, "utf8") });
    } else if (entry.name === "xl/drawings/drawing1.xml") {
      let xml = replacePlaceholders(drawingWithoutPictures(entry.data.toString("utf8")), data, escapeDrawingText);
      xml = removeRepeatMarkers(xml);
      out.push({ ...entry, data: Buffer.from(xml, "utf8") });
    } else if (entry.name === "xl/drawings/_rels/drawing1.xml.rels") {
      out.push({ ...entry, data: Buffer.from(relationshipsWithoutImages(entry.data.toString("utf8")), "utf8") });
    } else if (entry.name === "[Content_Types].xml") {
      out.push({ ...entry, data: Buffer.from(contentTypesWithoutImages(entry.data.toString("utf8")), "utf8") });
    } else {
      out.push(entry);
    }
  }
  return writeZip(out);
}

export function renderBookingNoteHtml(d) {
  const e = v => v == null ? "" : String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>");
  return `<!doctype html><html><head><meta charset="utf-8"><title>海运出口订舱委托书</title>
  <style>body{font-family:-apple-system,'PingFang SC',Arial,sans-serif;background:#f0f2f5;margin:0;padding:18px;color:#111}.p{max-width:820px;margin:auto;background:#fff;border:1px solid #ddd;padding:22px}h2{text-align:center;margin:0 0 10px}table{width:100%;border-collapse:collapse;font-size:12px}td,th{border:1px solid #999;padding:6px 8px;vertical-align:top}.k{font-weight:700;background:#f6f6f6}.wide{white-space:pre-line}</style></head><body><div class="p">
  <h2>订 舱 委 托 书（BOOKING ORDER)</h2>
  <table><tr><td colspan="6">${e(d.companyName)}<br>${e(d.companyEnName)}</td><td colspan="4" class="k">TO:${e(d.bookingProxyName)}</td></tr>
  <tr><td class="k" colspan="2">订单编号</td><td colspan="8">${e(d.outerOrderNo)}</td></tr>
  <tr><td class="k">起运港</td><td>${e(d.portStart)}</td><td class="k">卸货港</td><td>${e(d.portUnloading)}</td><td class="k">目的港</td><td colspan="5">${e(d.portArrive)}</td></tr>
  <tr><td class="k">船名/航次</td><td colspan="4">${e(d.vesselName)}/${e(d.voyage)}</td><td class="k">ETD</td><td colspan="4">${e(d.estimatedTimeDeparture)}</td></tr>
  <tr><th>Marks</th><th>Pkgs</th><th colspan="4">Description of goods</th><th>G.W</th><th colspan="3">VOL</th></tr>
  <tr><td>${e(d.marks)}</td><td>${e(d.number)}</td><td colspan="4" class="wide">${e(d.goodsName)}</td><td>${e(d.grossWeight)}/${e(d.unitOfWeight)}</td><td colspan="3">${e(d.volume)} CBM</td></tr>
  <tr><td class="k" colspan="2">Shipper</td><td colspan="8" class="wide">${e(d.shipperInfo)}</td></tr>
  <tr><td class="k" colspan="2">Consignee</td><td colspan="8" class="wide">${e(d.consigneeInfo)}</td></tr>
  <tr><td class="k" colspan="2">Notify Party</td><td colspan="8" class="wide">${e(d.notifierInfo)}</td></tr>
  <tr><td class="k">Type of B/L</td><td>${e(d.billForm)}</td><td class="k">Transport</td><td>${e(d.transportItems)}</td><td class="k">PP/CC</td><td>${e(d.payWay)}</td><td class="k">Carrier</td><td colspan="3">${e(d.shippingCompany)}</td></tr>
  <tr><td class="k">Contr Qty</td><td>${e(d.boxSizeNumber)}</td><td class="k">Remark</td><td colspan="7">${e(d.remark)}</td></tr>
  <tr><td class="k">Attn</td><td>${e(d.userName)}</td><td class="k">Tel</td><td>${e(d.deckPhone)}</td><td class="k">E-mail</td><td colspan="3">${e(d.email)}</td><td class="k">Date</td><td>${e(d.date)}</td></tr>
  </table></div></body></html>`;
}
