const TYPES = ["20GP", "40GP", "40HQ"];
const SOURCE_NOTE = "来源:船司人民币收费标准完整版.xlsx(微信 2026-07)";
export const POL = "青岛";

export function compact(value) { return String(value || "").replace(/[\s'’"＇]/g, "").toUpperCase(); }
export function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }

export function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value instanceof Date) return localDate(value);
  if (value.richText) return value.richText.map((part) => part.text || "").join("").trim();
  if (value.text) return String(value.text).trim();
  if (value.result != null) return String(value.result).trim();
  return String(value).trim();
}

export function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function parseCarrierCode(sheetName) {
  const match = sheetName.trim().match(/^([A-Za-z0-9]+)/);
  return match ? match[1].toUpperCase() : null;
}

export function containerTypeFromParts(size, type) {
  const sizeText = compact(size);
  const typeText = compact(type);
  const merged = `${sizeText}${typeText}`;
  if (/^40(HQ|HC|HDG|HCHDG|HC\/HDG).*$/.test(merged)) return "40HQ";
  if (/^20(GP|DC|DG|DCDG|DC\/DG)?$/.test(merged) || /^20.*(GP|DC|DG)$/.test(merged)) return "20GP";
  if (/^40(GP|DC|DG|DCDG|DC\/DG)?$/.test(merged) || /^40.*(GP|DC|DG)$/.test(merged)) return "40GP";
  if (merged.includes("20GP")) return "20GP";
  if (merged.includes("40GP")) return "40GP";
  if (merged.includes("40HQ") || merged.includes("40HC")) return "40HQ";
  return null;
}

function headerTypes(value) {
  const raw = String(value || "").replace(/\s+/g, "").toUpperCase();
  const text = compact(value);
  if (text === "票" || text === "BILL") return TYPES;
  if (/^20['’＇"]$/.test(raw)) return ["20GP"];
  if (/^40['’＇"]$/.test(raw)) return ["40GP", "40HQ"];
  if (/^\d+(?:\.\d+)?$/.test(text)) return [];
  const direct = containerTypeFromParts("", value);
  return direct ? [direct] : [];
}

function isHeaderLike(ws, rowNo) {
  let typeHits = 0;
  ws.getRow(rowNo).eachCell({ includeEmpty: false }, (cell) => {
    if (headerTypes(cellText(cell)).length) typeHits += 1;
  });
  return typeHits >= 2;
}

export function findWideHeaders(ws) {
  const headers = [];
  for (let rowNo = 1; rowNo <= ws.rowCount; rowNo += 1) {
    const typeCols = {};
    ws.getRow(rowNo).eachCell({ includeEmpty: false }, (cell, colNo) => {
      const text = compact(cellText(cell));
      if (text === "票" || text === "BILL") typeCols.ticket = colNo;
      for (const type of headerTypes(cellText(cell))) if (!typeCols[type]) typeCols[type] = colNo;
    });
    if (Object.keys(typeCols).filter((key) => key !== "ticket").length >= 2) headers.push({ rowNo, typeCols });
  }
  return headers;
}

export function findMatrixHeaders(ws) {
  const headers = [];
  for (let rowNo = 1; rowNo <= ws.rowCount; rowNo += 1) {
    let sizeCol = null;
    let typeCol = null;
    ws.getRow(rowNo).eachCell({ includeEmpty: false }, (cell, colNo) => {
      const text = cellText(cell).replace(/\s+/g, "");
      if (text === "尺寸") sizeCol = colNo;
      if (["柜型", "櫃型", "箱型"].includes(text)) typeCol = colNo;
    });
    if (typeCol) headers.push({ rowNo, sizeCol, typeCol });
  }
  return headers;
}

export function parseRateParts(value) {
  if (value == null || value === "") return [];
  if (typeof value === "number" && Number.isFinite(value)) return [{ rate: value, currency: "CNY", notes: [] }];
  const raw = cleanText(value).replace(/[,，]/g, "");
  if (!raw || /^(FREE|DEPORT)$/i.test(raw)) return [];
  const mixed = [...raw.matchAll(/(\$|USD|CNY|RMB|¥|￥)\s*(-?\d+(?:\.\d+)?)/gi)];
  if (mixed.length > 1) {
    return mixed.map((match) => ({
      rate: Number(match[2]),
      currency: /^\$|USD$/i.test(match[1]) ? "USD" : "CNY",
      notes: [`原值:${raw}`],
    }));
  }
  const moneyText = raw.replace(/^(?:CNY|RMB|¥|￥)\s*/i, "").trim();
  const exact = moneyText.match(/^(-?\d+(?:\.\d+)?)(?:\/([^\s/]+))?$/i);
  if (exact) return [{ rate: Number(exact[1]), currency: "CNY", notes: exact[2] ? [`计价单位:${exact[2]}`] : [] }];
  const paren = raw.match(/^¥?￥?R?M?B?\s*(-?\d+(?:\.\d+)?)\s*[（(]([^）)]+)[）)]$/i);
  if (paren) {
    const inner = paren[2];
    const innerNum = inner.match(/(-?\d+(?:\.\d+)?)/);
    if (innerNum) {
      const area = cleanText(inner.replace(innerNum[1], "")) || "括号价";
      return [
        { rate: Number(paren[1]), currency: "CNY", notes: ["航区:非台湾"] },
        { rate: Number(innerNum[1]), currency: "CNY", categorySuffix: `(${area})`, notes: [`航区:${area}`] },
      ];
    }
  }
  const leading = raw.match(/^(?:CNY|RMB|¥|￥)?\s*(-?\d+(?:\.\d+)?)(.+)$/i);
  if (leading && !/[+$]/.test(raw)) {
    const unit = leading[2].replace(/^[/／]/, "").trim();
    return [{ rate: Number(leading[1]), currency: "CNY", notes: unit ? [`计价单位:${unit}`, `原始值:${raw}`] : [`原始值:${raw}`] }];
  }
  return [];
}

function extractArea(category) {
  const match = category.match(/THC[（(]([^）)]+)[）)]/i);
  if (!match) return null;
  return match[1].split(/[、,，/／]/).map((part) => part.trim()).filter(Boolean).join("/");
}

export function makeNote(sheetName, category, extra = []) {
  const area = extractArea(category);
  const parts = [SOURCE_NOTE, `sheet:${sheetName}`];
  if (area) parts.push(`航区:${area}`);
  parts.push(...extra.filter(Boolean));
  return [...new Set(parts)].join(" | ");
}

function pushRows(rows, skips, base, category, rawValue, extraNotes = []) {
  const parsed = parseRateParts(rawValue);
  if (parsed.length === 0) {
    const reason = rawValue ? "non_numeric_rate" : "empty_rate";
    skips.push({ reason, sheet: base.sheet, rowNo: base.rowNo, category, container_type: base.container_type, raw: rawValue || "" });
    return false;
  }
  for (const item of parsed) {
    const costCategory = `${category}${item.categorySuffix || ""}`;
    rows.push({
      carrier_code: base.carrier_code,
      pol: POL,
      container_type: base.container_type,
      cost_category: costCategory,
      rate: item.rate,
      currency: item.currency || "CNY",
      sample_count: null,
      note: makeNote(base.sheet, costCategory, [...extraNotes, ...item.notes]),
      sheet: base.sheet,
      rowNo: base.rowNo,
      stations: base.station ? [base.station] : [],
      raw: String(rawValue),
    });
  }
  return true;
}

function categoryFromRow(row, firstTypeCol) {
  for (let colNo = firstTypeCol - 1; colNo >= 1; colNo -= 1) {
    const text = cleanText(cellText(row.getCell(colNo)));
    if (text) return text;
  }
  return "";
}

function rowRemark(row, firstTypeCol, columnCount) {
  const parts = [];
  for (let colNo = firstTypeCol + 1; colNo <= columnCount; colNo += 1) {
    const text = cleanText(cellText(row.getCell(colNo)));
    if (text && parseRateParts(text).length === 0) parts.push(text);
  }
  return parts.join("/");
}

function addSeen(seen, sheet, rowNo, category) {
  if (!category || /^(费用|标准收费|收费项目|项目|备注[:：]?|Charges detail)$/i.test(category)) return;
  if (/^(\d+|[一二三四五六七八九十]+)[.．、]/.test(category) || category.startsWith("***")) return;
  if (category.length > 28) return;
  const key = `${sheet}\u0001${rowNo}\u0001${category}`;
  if (!seen.has(key)) seen.set(key, { sheet, rowNo, category, parsed: false });
}

function parseWideSheet(ws, headers) {
  const rows = [];
  const skips = [];
  const seenFees = new Map();
  for (let h = 0; h < headers.length; h += 1) {
    const header = headers[h];
    const endRow = h + 1 < headers.length ? headers[h + 1].rowNo - 1 : ws.rowCount;
    const firstTypeCol = Math.min(...Object.entries(header.typeCols).filter(([key]) => key !== "ticket").map(([, col]) => col));
    let blankStreak = 0;
    for (let rowNo = header.rowNo + 1; rowNo <= endRow; rowNo += 1) {
      if (isHeaderLike(ws, rowNo)) break;
      const row = ws.getRow(rowNo);
      const rowText = [];
      row.eachCell({ includeEmpty: false }, (cell) => rowText.push(cellText(cell)));
      if (/DND|Port Country/i.test(rowText.join(" "))) break;
      const category = categoryFromRow(row, firstTypeCol);
      addSeen(seenFees, ws.name, rowNo, category);
      if (!category) {
        blankStreak += 1;
        if (blankStreak >= 3) break;
        continue;
      }
      blankStreak = 0;
      if (/^(费用|标准收费|收费项目|项目)$/i.test(category)) continue;
      let parsedAny = false;
      const remark = rowRemark(row, firstTypeCol, ws.columnCount);
      const ticketRaw = header.typeCols.ticket ? cellText(row.getCell(header.typeCols.ticket)) : "";
      const useTicket = ticketRaw && parseRateParts(ticketRaw).length > 0;
      for (const containerType of TYPES) {
        const colNo = useTicket ? header.typeCols.ticket : header.typeCols[containerType];
        if (!colNo) continue;
        const notes = useTicket ? ["计价单位:票"] : [];
        if (remark) notes.push(`航区:${remark}`);
        parsedAny = pushRows(rows, skips, { sheet: ws.name, rowNo, carrier_code: parseCarrierCode(ws.name), container_type: containerType }, category, cellText(row.getCell(colNo)), notes) || parsedAny;
      }
      const key = `${ws.name}\u0001${rowNo}\u0001${category}`;
      if (seenFees.has(key)) seenFees.get(key).parsed = parsedAny;
    }
  }
  return { rows, skips, seenFees: [...seenFees.values()] };
}

function rowContainerType(row, header) {
  const typeText = cellText(row.getCell(header.typeCol));
  const direct = containerTypeFromParts("", typeText);
  if (direct) return direct;
  if (!header.sizeCol) return null;
  return containerTypeFromParts(cellText(row.getCell(header.sizeCol)), typeText);
}

function matrixHeaderMeta(headerRow, firstCategoryCol, columnCount) {
  const seen = new Map(), duplicateBases = new Set(), meta = new Map();
  for (let colNo = firstCategoryCol; colNo <= columnCount; colNo += 1) {
    const base = cleanText(cellText(headerRow.getCell(colNo)));
    if (!base) continue;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    if (n > 1) duplicateBases.add(base);
    meta.set(colNo, { base, category: n > 1 ? `${base}(原表第二列)` : base, duplicate: false });
  }
  for (const item of meta.values()) if (duplicateBases.has(item.base)) item.duplicate = true;
  return meta;
}

function fillNoteForCell(cell, rowNo) {
  const master = cell.master;
  return master && master !== cell && master.row !== rowNo ? `按不随柜型变化补(原表仅${master.row}行给出)` : null;
}

function parseMatrixSheet(ws, headers) {
  const rows = [], skips = [], duplicateColumns = [], fills = [], seenFees = new Map();
  for (let h = 0; h < headers.length; h += 1) {
    const header = headers[h];
    const headerRow = ws.getRow(header.rowNo);
    const endRow = h + 1 < headers.length ? headers[h + 1].rowNo - 1 : ws.rowCount;
    const firstCategoryCol = Math.max(header.sizeCol || 0, header.typeCol) + 1;
    const meta = matrixHeaderMeta(headerRow, firstCategoryCol, ws.columnCount);
    let blankStreak = 0;
    for (let rowNo = header.rowNo + 1; rowNo <= endRow; rowNo += 1) {
      const row = ws.getRow(rowNo);
      const containerType = rowContainerType(row, header);
      if (!containerType) {
        blankStreak += 1;
        if (blankStreak >= 3) break;
        continue;
      }
      blankStreak = 0;
      let station = "";
      for (let colNo = firstCategoryCol; colNo <= ws.columnCount; colNo += 1) {
        const info = meta.get(colNo), raw = cleanText(cellText(row.getCell(colNo)));
        if (info?.base === "场站" && raw && parseRateParts(raw).length === 0) station = raw;
      }
      for (let colNo = firstCategoryCol; colNo <= ws.columnCount; colNo += 1) {
        const info = meta.get(colNo);
        const category = info?.category || "";
        if (!category || /^(备注|SW BILL)$/i.test(category)) continue;
        const cell = row.getCell(colNo);
        const raw = cleanText(cellText(cell));
        if (info.base === "场站" && raw && parseRateParts(raw).length === 0) continue;
        addSeen(seenFees, ws.name, rowNo, category);
        const notes = station ? [`场站:${station}`] : [];
        if (info?.duplicate && info.base !== "场站") notes.push("⚠️原表同名两列待人工判");
        const fillNote = fillNoteForCell(cell, rowNo);
        if (fillNote && raw) {
          notes.push(fillNote);
          fills.push({ sheet: ws.name, rowNo, fromRow: cell.master.row, category, container_type: containerType, raw });
        }
        if (info?.duplicate && info.base !== "场站") duplicateColumns.push({ sheet: ws.name, rowNo, category, container_type: containerType, raw });
        const parsed = pushRows(rows, skips, { sheet: ws.name, rowNo, carrier_code: parseCarrierCode(ws.name), container_type: containerType, station }, category, raw, notes);
        const key = `${ws.name}\u0001${rowNo}\u0001${category}`;
        if (seenFees.has(key) && parsed) seenFees.get(key).parsed = true;
      }
    }
  }
  return { rows, skips, duplicateColumns, fills, seenFees: [...seenFees.values()] };
}

export function parseSheet(ws) {
  const wideHeaders = findWideHeaders(ws);
  const matrixHeaders = findMatrixHeaders(ws);
  if (wideHeaders.length > 0) {
    const wide = parseWideSheet(ws, wideHeaders);
    if (wide.rows.length > 0 || matrixHeaders.length === 0) return wide;
  }
  if (matrixHeaders.length > 0) return parseMatrixSheet(ws, matrixHeaders);
  return { rows: [], skips: [{ reason: "header_missing", sheet: ws.name, count: 1 }], seenFees: [] };
}
