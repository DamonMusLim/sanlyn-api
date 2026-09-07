import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { normalizeFeeRows } from "./lib/fee-normalize.mjs";
const SOURCE_FILE = "/tmp/carrier_tariff.xlsx";
const SOURCE_NOTE = "来源:船司人民币收费标准完整版.xlsx(微信 2026-07)";
const POL = "青岛";
const TYPES = ["20GP", "40GP", "40HQ"];
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
async function loadPackage(name) {
  try {
    return await import(name);
  } catch (importError) {
    const roots = [
      process.env.CARRIER_TARIFF_NODE_MODULES,
      path.join(process.cwd(), "node_modules"),
      path.join(__dirname, "..", "node_modules"),
      "/opt/sanlyn-api/node_modules",
      "/opt/sanlyn-api-test/node_modules",
      "/tmp/order-copy-api-check.TCjMnq/node_modules",
    ].filter(Boolean);
    for (const root of roots) {
      try {
        return require(path.join(root, name));
      } catch {}
    }
    throw importError;
  }
}
function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value instanceof Date) return localDate(value);
  if (value.richText) return value.richText.map((part) => part.text || "").join("").trim();
  if (value.text) return String(value.text).trim();
  if (value.result != null) return String(value.result).trim();
  return String(value).trim();
}
function compact(value) { return String(value || "").replace(/[\s'’"＇]/g, "").toUpperCase(); }
function cleanText(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function parseCarrierCode(sheetName) {
  const match = sheetName.trim().match(/^([A-Za-z0-9]+)/);
  return match ? match[1].toUpperCase() : null;
}
function containerTypeFromParts(size, type) {
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
function findWideHeaders(ws) {
  const headers = [];
  for (let rowNo = 1; rowNo <= ws.rowCount; rowNo += 1) {
    const typeCols = {};
    ws.getRow(rowNo).eachCell({ includeEmpty: false }, (cell, colNo) => {
      const type = containerTypeFromParts("", cellText(cell));
      if (type && !typeCols[type]) typeCols[type] = colNo;
    });
    if (TYPES.every((type) => typeCols[type])) headers.push({ rowNo, typeCols });
  }
  return headers;
}
function findMatrixHeaders(ws) {
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
function parseRateParts(value) {
  if (value == null || value === "") return [];
  if (typeof value === "number" && Number.isFinite(value)) return [{ rate: value, notes: [] }];
  const raw = cleanText(value).replace(/[,，]/g, "");
  if (!raw || /^(FREE|DEPORT)$/i.test(raw)) return [];
  const moneyText = raw.replace(/^(?:CNY|RMB|¥|￥)\s*/i, "").trim();
  const exact = moneyText.match(/^(-?\d+(?:\.\d+)?)(?:\/([^\s/]+))?$/i);
  if (exact) return [{ rate: Number(exact[1]), notes: exact[2] ? [`计价单位:${exact[2]}`] : [] }];
  const paren = raw.match(/^¥?￥?R?M?B?\s*(-?\d+(?:\.\d+)?)\s*[（(]([^）)]+)[）)]$/i);
  if (paren) {
    const inner = paren[2];
    const innerNum = inner.match(/(-?\d+(?:\.\d+)?)/);
    if (innerNum) {
      const area = cleanText(inner.replace(innerNum[1], "")) || "括号价";
      return [
        { rate: Number(paren[1]), notes: ["航区:非台湾"] },
        { rate: Number(innerNum[1]), categorySuffix: `(${area})`, notes: [`航区:${area}`] },
      ];
    }
  }
  const leading = raw.match(/^(?:CNY|RMB|¥|￥)?\s*(-?\d+(?:\.\d+)?)(.+)$/i);
  if (leading && !/[+$]/.test(raw)) {
    const unit = leading[2].replace(/^[/／]/, "").trim();
    return [{ rate: Number(leading[1]), notes: unit ? [`计价单位:${unit}`, `原始值:${raw}`] : [`原始值:${raw}`] }];
  }
  return [];
}
function extractArea(category) {
  const match = category.match(/THC[（(]([^）)]+)[）)]/i);
  if (!match) return null;
  return match[1].split(/[、,，/／]/).map((part) => part.trim()).filter(Boolean).join("/");
}
function makeNote(sheetName, category, extra = []) {
  const area = extractArea(category);
  const parts = [SOURCE_NOTE, `sheet:${sheetName}`];
  if (area) parts.push(`航区:${area}`);
  parts.push(...extra.filter(Boolean));
  return [...new Set(parts)].join(" | ");
}
function pushRows(rows, skips, base, category, rawValue, extraNotes = []) {
  const parsed = parseRateParts(rawValue);
  if (parsed.length === 0) {
    if (rawValue) skips.push({ reason: "non_numeric_rate", sheet: base.sheet, rowNo: base.rowNo, category, container_type: base.container_type, raw: rawValue });
    else skips.push({ reason: "empty_rate", sheet: base.sheet, rowNo: base.rowNo, category, container_type: base.container_type, raw: "" });
    return;
  }
  for (const item of parsed) {
    const costCategory = `${category}${item.categorySuffix || ""}`;
    rows.push({
      carrier_code: base.carrier_code,
      pol: POL,
      container_type: base.container_type,
      cost_category: costCategory,
      rate: item.rate,
      currency: "CNY",
      sample_count: null,
      note: makeNote(base.sheet, costCategory, [...extraNotes, ...item.notes]),
      sheet: base.sheet,
      rowNo: base.rowNo,
      stations: base.station ? [base.station] : [],
      raw: String(rawValue),
    });
  }
}
function categoryFromRow(row, firstTypeCol) {
  for (let colNo = firstTypeCol - 1; colNo >= 1; colNo -= 1) {
    const text = cleanText(cellText(row.getCell(colNo)));
    if (text) return text;
  }
  return "";
}
function parseWideSheet(ws, headers) {
  const rows = [];
  const skips = [];
  for (let h = 0; h < headers.length; h += 1) {
    const header = headers[h];
    const endRow = h + 1 < headers.length ? headers[h + 1].rowNo - 1 : ws.rowCount;
    const firstTypeCol = Math.min(...Object.values(header.typeCols));
    let blankStreak = 0;
    for (let rowNo = header.rowNo + 1; rowNo <= endRow; rowNo += 1) {
      const row = ws.getRow(rowNo);
      const rowText = [];
      row.eachCell({ includeEmpty: false }, (cell) => rowText.push(cellText(cell)));
      if (/DND|Port Country/i.test(rowText.join(" "))) break;
      const category = categoryFromRow(row, firstTypeCol);
      if (!category) {
        blankStreak += 1;
        if (blankStreak >= 3) break;
        continue;
      }
      blankStreak = 0;
      if (/^(费用|标准收费|收费项目|项目)$/i.test(category)) continue;
      for (const containerType of TYPES) {
        const colNo = header.typeCols[containerType];
        pushRows(rows, skips, { sheet: ws.name, rowNo, carrier_code: parseCarrierCode(ws.name), container_type: containerType }, category, cellText(row.getCell(colNo)));
      }
    }
  }
  return { rows, skips };
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
  const rows = [];
  const skips = [];
  const duplicateColumns = [];
  const fills = [];
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
        const info = meta.get(colNo), category = info?.category || "";
        const raw = cleanText(cellText(row.getCell(colNo)));
        if (info?.base === "场站" && raw && parseRateParts(raw).length === 0) station = raw;
      }
      for (let colNo = firstCategoryCol; colNo <= ws.columnCount; colNo += 1) {
        const info = meta.get(colNo);
        const category = info?.category || "";
        if (!category || /^(备注|SW BILL)$/i.test(category)) continue;
        const cell = row.getCell(colNo);
        const raw = cleanText(cellText(cell));
        if (info.base === "场站" && raw && parseRateParts(raw).length === 0) continue;
        const notes = station ? [`场站:${station}`] : [];
        if (info?.duplicate && info.base !== "场站") notes.push("⚠️原表同名两列待人工判");
        const fillNote = fillNoteForCell(cell, rowNo);
        if (fillNote && raw) {
          notes.push(fillNote);
          fills.push({ sheet: ws.name, rowNo, fromRow: cell.master.row, category, container_type: containerType, raw });
        }
        if (info?.duplicate && info.base !== "场站") duplicateColumns.push({ sheet: ws.name, rowNo, category, container_type: containerType, raw });
        pushRows(rows, skips, { sheet: ws.name, rowNo, carrier_code: parseCarrierCode(ws.name), container_type: containerType, station }, category, raw, notes);
      }
    }
  }
  return { rows, skips, duplicateColumns, fills };
}
function parseSheet(ws) {
  const wideHeaders = findWideHeaders(ws);
  if (wideHeaders.length > 0) return parseWideSheet(ws, wideHeaders);
  const matrixHeaders = findMatrixHeaders(ws);
  if (matrixHeaders.length > 0) return parseMatrixSheet(ws, matrixHeaders);
  return { rows: [], skips: [{ reason: "header_missing", sheet: ws.name, count: 1 }] };
}
function addSkip(skips, reason, count = 1) { skips.set(reason, (skips.get(reason) || 0) + count); }
function keyOf(row) { return [row.carrier_code, row.pol, row.container_type, row.cost_category].join("\u0001"); }
function sameRate(a, b) { return Number(a) === Number(b); }
function mergeNote(row) {
  const stations = [...new Set(row.stations || [])].filter(Boolean);
  const base = row.note.split(" | ").filter((part) => !part.startsWith("场站:")).join(" | ");
  return stations.length ? `${base} | 场站:${stations.join("/")}` : base;
}
function conflictCategory(row) {
  const stations = [...new Set(row.stations || [])].filter(Boolean).join("/");
  return stations ? `${row.cost_category}(${stations})` : `${row.cost_category}(价格冲突${row.rate})`;
}
function dedupeParsed(rows, skipCounts) {
  const seen = new Map();
  const conflicts = [];
  for (const row of rows) {
    let key = keyOf(row);
    const old = seen.get(key);
    if (!old) {
      seen.set(key, { ...row, stations: [...(row.stations || [])], sourceRows: [row.rowNo] });
      continue;
    }
    if (sameRate(old.rate, row.rate)) {
      old.stations.push(...(row.stations || []));
      old.sourceRows.push(row.rowNo);
      old.note = mergeNote(old);
      addSkip(skipCounts, "parsed_duplicate_same_rate");
    } else {
      const baseCategory = row.cost_category;
      const alt = [...seen.entries()].find(([, r]) => r.carrier_code === row.carrier_code && r.pol === row.pol && r.container_type === row.container_type && sameRate(r.rate, row.rate) && r.cost_category.startsWith(`${baseCategory}(`));
      row.cost_category = conflictCategory(row);
      row.note = makeNote(row.sheet, row.cost_category, row.stations?.length ? [`场站:${row.stations.join("/")}`] : []);
      key = keyOf(row);
      const renamed = alt?.[1] || seen.get(key);
      if (renamed) {
        renamed.stations.push(...(row.stations || []));
        renamed.sourceRows.push(row.rowNo);
        if (alt) {
          seen.delete(alt[0]);
          renamed.cost_category = conflictCategory({ ...renamed, cost_category: baseCategory });
          seen.set(keyOf(renamed), renamed);
          row.cost_category = renamed.cost_category;
        }
        renamed.note = mergeNote({ ...renamed, note: makeNote(row.sheet, renamed.cost_category) });
      } else seen.set(key, { ...row, stations: [...(row.stations || [])], sourceRows: [row.rowNo] });
      conflicts.push({ old, next: row });
      addSkip(skipCounts, "parsed_duplicate_conflict");
    }
  }
  return { rows: [...seen.values()].map((row) => ({ ...row, note: mergeNote(row) })), conflicts };
}
function summarizeBySheet(parsed) {
  for (const item of parsed) {
    const categories = new Set(item.rows.map((row) => row.cost_category)).size;
    const types = new Set(item.rows.map((row) => row.container_type)).size;
    const combos = new Set(item.rows.map((row) => `${row.cost_category}\u0001${row.container_type}`)).size;
    console.log(`${item.sheet}: ${categories} 费目 x ${types} 柜型 = ${combos} 组合 / ${item.rows.length} 行`);
  }
}
function printRows(title, rows) {
  console.log("");
  console.log(title);
  for (const row of rows) {
    console.log(`${row.carrier_code}\t${row.pol}\t${row.container_type}\t${row.cost_category}\t${row.rate}\t${row.currency}\t${row.note}`);
  }
}
function printConflicts(conflicts) {
  console.log("");
  console.log(`价格冲突拆行结果(parsed_duplicate_conflict) 全量: ${conflicts.length}`);
  for (const item of conflicts) {
    console.log(`${item.next.sheet}\t行${item.old.rowNo}/行${item.next.rowNo}\t${item.next.cost_category}\t${item.next.container_type}\t${item.old.rate}\t${item.next.rate}`);
  }
}
function printList(title, rows, format) {
  console.log("");
  console.log(`${title}: ${rows.length}`);
  for (const row of rows) console.log(format(row));
}
function printNonNumeric(skips) {
  const bad = skips.filter((skip) => skip.reason === "non_numeric_rate");
  console.log("");
  console.log(`non_numeric_rate 全量: ${bad.length}`);
  for (const skip of bad) console.log(`${skip.sheet}\t行${skip.rowNo || ""}\t${skip.category || ""}\t${skip.container_type || ""}\t${skip.raw || ""}`);
}
function writeTsv(file, rows) {
  const cols = ["carrier_code", "pol", "container_type", "cost_category", "fee_code", "rate", "currency", "note"];
  const escape = (v) => String(v ?? "").replace(/\t/g, " ").replace(/\r?\n/g, " ");
  fs.writeFileSync(file, [cols.join("\t"), ...rows.map((row) => cols.map((col) => escape(row[col])).join("\t"))].join("\n"));
}
async function loadExisting(pool) {
  const { rows } = await pool.query(
    `SELECT id, carrier_code, pol, container_type, cost_category, rate, note
       FROM public.freight_port_rates
      WHERE pol = $1`,
    [POL],
  );
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}
function makePlan(parsedRows, existing, skipCounts) {
  const plan = { inserts: [], updates: [], unchanged: [], duplicates: [] };
  for (const row of parsedRows) {
    const matches = existing.get(keyOf(row)) || [];
    if (matches.length === 0) plan.inserts.push(row);
    else if (matches.some((old) => sameRate(old.rate, row.rate))) plan.unchanged.push(row);
    else plan.updates.push({ next: row, prev: matches[0] });
    if (matches.length > 1) plan.duplicates.push({ row, ids: matches.map((m) => m.id) });
  }
  addSkip(skipCounts, "existing_same_rate", plan.unchanged.length);
  addSkip(skipCounts, "existing_duplicate_keys", plan.duplicates.length);
  return plan;
}
async function reconcile(rows, skipCounts) {
  let pgMod;
  try {
    pgMod = await loadPackage("pg");
  } catch (error) {
    return { error: `pg 加载失败: ${error.message}` };
  }
  const dotenv = await loadPackage("dotenv").catch(() => null);
  dotenv?.config?.();
  const Pool = pgMod.default?.Pool || pgMod.Pool;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL,
    host: process.env.PG_HOST,
    port: process.env.PG_PORT ? Number(process.env.PG_PORT) : undefined,
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: process.env.PGSSL === "true" || process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 2,
    connectionTimeoutMillis: 1500,
  });
  try {
    return { plan: makePlan(rows, await loadExisting(pool), skipCounts) };
  } catch (error) {
    return { error: error.message };
  } finally {
    await pool.end().catch(() => {});
  }
}
function argValue(name) {
  const exact = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}
async function main() {
  if (process.argv.includes("--commit")) throw new Error("--commit 已禁用；本脚本只做 dry-run 解析和只读对账");
  const xlsxFile = argValue("--file") || SOURCE_FILE;
  const outFile = argValue("--out");
  if (!fs.existsSync(xlsxFile)) throw new Error(`xlsx not found: ${xlsxFile}`);
  const ExcelJS = (await loadPackage("exceljs")).default || (await loadPackage("exceljs"));
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxFile);
  const skipCounts = new Map();
  const badCarrierSheets = [];
  const parsedRaw = [];
  const duplicateColumns = [];
  const fills = [];
  for (const ws of workbook.worksheets.slice(1)) {
    const carrier = parseCarrierCode(ws.name);
    if (!carrier) {
      badCarrierSheets.push(ws.name);
      addSkip(skipCounts, "carrier_code_missing_sheet");
      continue;
    }
    const result = parseSheet(ws);
    for (const skip of result.skips) addSkip(skipCounts, skip.reason, skip.count || 1);
    parsedRaw.push({ sheet: ws.name, rows: result.rows, skips: result.skips });
    duplicateColumns.push(...(result.duplicateColumns || []));
    fills.push(...(result.fills || []));
  }
  const deduped = [];
  const conflicts = [];
  for (const item of parsedRaw) {
    const result = dedupeParsed(item.rows, skipCounts);
    deduped.push({ sheet: item.sheet, rows: result.rows, skips: item.skips });
    conflicts.push(...result.conflicts);
  }
  const normalized = normalizeFeeRows(deduped.flatMap((item) => item.rows));
  const allRows = normalized.rows;
  if (outFile) writeTsv(outFile, allRows);
  const recon = await reconcile(allRows, skipCounts);
  console.log(`模式: dry-run | 文件: ${xlsxFile} | 运行日: ${localDate()}`);
  summarizeBySheet(deduped);
  printConflicts(conflicts);
  printList("同名列冲突 全量", duplicateColumns, (r) => `${r.sheet}\t行${r.rowNo}\t${r.container_type}\t${r.category}\t${r.raw}`);
  printList("跨柜型补值全量", fills, (r) => `${r.sheet}\t行${r.rowNo}\t从行${r.fromRow}\t${r.container_type}\t${r.category}\t${r.raw}`);
  printList("费目名映射不上全量", normalized.unknown, (r) => `${r.sheet}\t${r.category}\t${r.count}`);
  console.log("");
  console.log(`fee_code 已映射: ${normalized.stats.mappedRows} 行 (${normalized.stats.mappedCategories} 个费目)`);
  console.log(`fee_code 留空:   ${normalized.stats.blankRows} 行 → 全部属于「待新增」清单`);
  printList("建议新增到 hgj_fee_master 的费目", normalized.suggested, (r) => `${r.category}\t${r.carriers.join("/")}\t${r.amounts}`);
  printNonNumeric(parsedRaw.flatMap((item) => item.skips));
  printRows("COSCO 青岛解析结果:", allRows.filter((row) => row.carrier_code === "COSCO"));
  console.log("");
  console.log(`合计解析行: ${allRows.length}`);
  console.log(`将新增: ${recon.plan ? recon.plan.inserts.length : "DB不可达，未计算"}`);
  console.log(`将更新: ${recon.plan ? recon.plan.updates.length : "DB不可达，未计算"}`);
  console.log(`跳过: ${[...skipCounts.values()].reduce((sum, n) => sum + n, 0)}`);
  for (const [reason, count] of [...skipCounts.entries()].sort()) console.log(`- ${reason}: ${count}`);
  console.log(`取不出 carrier_code 的 sheet: ${badCarrierSheets.length ? badCarrierSheets.join(" / ") : "(无)"}`);
  if (outFile) console.log(`TSV已导出: ${outFile}`);
  if (recon.error) console.log(`DB只读对账失败，已跳过: ${recon.error}`);
  console.log("dry-run: 未写库；不会 DELETE。");
}
main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
