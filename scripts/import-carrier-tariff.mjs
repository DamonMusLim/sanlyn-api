import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

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

function cellText(cell) {
  const value = cell?.value;
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value instanceof Date) return localDate(value);
  if (value.richText) return value.richText.map((part) => part.text || "").join("").trim();
  if (value.text) return String(value.text).trim();
  if (value.result != null) return String(value.result).trim();
  if (value.hyperlink && value.text) return String(value.text).trim();
  return String(value).trim();
}

function localDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function normalizeHeader(value) {
  return value.replace(/[\s'’"＇]/g, "").toUpperCase();
}

function parseCarrierCode(sheetName) {
  const match = sheetName.trim().match(/^([A-Za-z0-9]+)/);
  return match ? match[1].toUpperCase() : null;
}

function parseRate(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = String(value).trim().replace(/[,，]/g, "").replace(/^¥|^￥|^RMB/i, "");
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

function extractArea(category) {
  const match = category.match(/THC[（(]([^）)]+)[）)]/i);
  if (!match) return null;
  return match[1]
    .split(/[、,，/／]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("/");
}

function buildNote(sheetName, category) {
  const area = extractArea(category);
  return `${SOURCE_NOTE} | sheet:${sheetName}${area ? ` | 航区:${area}` : ""}`;
}

function findHeaderRows(ws) {
  const headers = [];
  for (let rowNo = 1; rowNo <= ws.rowCount; rowNo += 1) {
    const typeCols = {};
    ws.getRow(rowNo).eachCell({ includeEmpty: false }, (cell, colNo) => {
      const text = normalizeHeader(cellText(cell));
      if (text.includes("20GP")) typeCols["20GP"] = colNo;
      if (text.includes("40GP")) typeCols["40GP"] = colNo;
      if (text.includes("40HQ") || text.includes("40HC")) typeCols["40HQ"] = colNo;
    });
    if (TYPES.every((type) => typeCols[type])) headers.push({ rowNo, typeCols });
  }
  return headers;
}

function containerTypeFromText(text) {
  const clean = normalizeHeader(text);
  if (/^20.*(GP|DC|DG)?$/.test(clean) || clean === "20GP") return "20GP";
  if (/^40.*(GP|DC|DG)?$/.test(clean) || clean === "40GP") return "40GP";
  if (/^40.*(HQ|HC|HDG)$/.test(clean) || clean === "40HC") return "40HQ";
  return null;
}

function findMatrixHeaders(ws) {
  const headers = [];
  for (let rowNo = 1; rowNo <= ws.rowCount; rowNo += 1) {
    let sizeCol = null;
    let typeCol = null;
    ws.getRow(rowNo).eachCell({ includeEmpty: false }, (cell, colNo) => {
      const text = cellText(cell).replace(/\s+/g, "");
      if (text === "尺寸") sizeCol = colNo;
      if (text === "柜型" || text === "櫃型" || text === "箱型") typeCol = colNo;
    });
    if (typeCol) headers.push({ rowNo, sizeCol, typeCol });
  }
  return headers;
}

function rowContainerType(row, header) {
  const typeText = cellText(row.getCell(header.typeCol));
  const direct = containerTypeFromText(typeText);
  if (direct) return direct;
  if (!header.sizeCol) return null;
  const sizeText = cellText(row.getCell(header.sizeCol));
  return containerTypeFromText(`${sizeText}${typeText}`);
}

function categoryFromRow(row, firstTypeCol) {
  for (let colNo = firstTypeCol - 1; colNo >= 1; colNo -= 1) {
    const text = cellText(row.getCell(colNo));
    if (text) return text.replace(/\s+/g, " ").trim();
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
      const category = categoryFromRow(row, firstTypeCol);
      if (!category) {
        blankStreak += 1;
        if (blankStreak >= 3) break;
        continue;
      }
      blankStreak = 0;
      if (/^(费用|标准收费|收费项目|项目)$/i.test(category)) continue;

      for (const containerType of TYPES) {
        const raw = cellText(row.getCell(header.typeCols[containerType]));
        const rate = parseRate(row.getCell(header.typeCols[containerType]).value ?? raw);
        if (rate == null) {
          skips.push({ reason: raw ? "non_numeric_rate" : "empty_rate", count: 1 });
          continue;
        }
        rows.push({
          carrier_code: parseCarrierCode(ws.name),
          pol: POL,
          container_type: containerType,
          cost_category: category,
          rate,
          currency: "CNY",
          sample_count: null,
          note: buildNote(ws.name, category),
          sheet: ws.name,
          rowNo,
        });
      }
    }
  }
  return { rows, skips };
}

function parseMatrixSheet(ws, headers) {
  const rows = [];
  const skips = [];
  for (let h = 0; h < headers.length; h += 1) {
    const header = headers[h];
    const headerRow = ws.getRow(header.rowNo);
    const endRow = h + 1 < headers.length ? headers[h + 1].rowNo - 1 : ws.rowCount;
    const firstCategoryCol = Math.max(header.sizeCol || 0, header.typeCol) + 1;
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
      for (let colNo = firstCategoryCol; colNo <= ws.columnCount; colNo += 1) {
        const category = cellText(headerRow.getCell(colNo));
        if (!category) continue;
        const raw = cellText(row.getCell(colNo));
        const rate = parseRate(row.getCell(colNo).value ?? raw);
        if (rate == null) {
          skips.push({ reason: raw ? "non_numeric_rate" : "empty_rate", count: 1 });
          continue;
        }
        rows.push({
          carrier_code: parseCarrierCode(ws.name),
          pol: POL,
          container_type: containerType,
          cost_category: category,
          rate,
          currency: "CNY",
          sample_count: null,
          note: buildNote(ws.name, category),
          sheet: ws.name,
          rowNo,
        });
      }
    }
  }
  return { rows, skips };
}

function parseSheet(ws) {
  const headers = findHeaderRows(ws);
  if (headers.length > 0) return { headers, ...parseWideSheet(ws, headers) };
  const matrixHeaders = findMatrixHeaders(ws);
  if (matrixHeaders.length > 0) return { headers: matrixHeaders, ...parseMatrixSheet(ws, matrixHeaders) };
  return { headers, rows: [], skips: [{ reason: "header_missing", count: 1 }] };
}

function addSkip(skips, reason, count = 1) {
  skips.set(reason, (skips.get(reason) || 0) + count);
}

function keyOf(row) {
  return [row.carrier_code, row.pol, row.container_type, row.cost_category].join("\u0001");
}

function sameRate(a, b) {
  return Number(a) === Number(b);
}

function summarizeBySheet(parsed) {
  for (const item of parsed) {
    const categories = new Set(item.rows.map((row) => row.cost_category)).size;
    const types = new Set(item.rows.map((row) => row.container_type)).size;
    console.log(`${item.sheet}: ${categories} 费目 x ${types} 柜型 = ${item.rows.length} 行`);
  }
}

function printCosco(rows) {
  console.log("");
  console.log("COSCO 青岛解析结果:");
  for (const row of rows) {
    console.log(
      `${row.carrier_code}\t${row.pol}\t${row.container_type}\t${row.cost_category}\t${row.rate}\t${row.currency}\t${row.note}`,
    );
  }
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
    if (matches.length === 0) {
      plan.inserts.push(row);
      continue;
    }
    if (matches.length > 1) plan.duplicates.push({ row, ids: matches.map((m) => m.id) });
    if (matches.some((old) => sameRate(old.rate, row.rate))) {
      plan.unchanged.push(row);
      continue;
    }
    plan.updates.push({ next: row, prev: matches[0] });
  }
  addSkip(skipCounts, "existing_same_rate", plan.unchanged.length);
  addSkip(skipCounts, "existing_duplicate_keys", plan.duplicates.length);
  return plan;
}

function dedupeParsed(rows, skipCounts) {
  const seen = new Map();
  const kept = [];
  for (const row of rows) {
    const key = keyOf(row);
    const old = seen.get(key);
    if (!old) {
      seen.set(key, row);
      kept.push(row);
      continue;
    }
    addSkip(skipCounts, sameRate(old.rate, row.rate) ? "parsed_duplicate_same_rate" : "parsed_duplicate_conflict");
  }
  return kept;
}

async function applyPlan(pool, plan) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of plan.inserts) {
      await client.query(
        `INSERT INTO public.freight_port_rates
         (carrier_code, pol, container_type, cost_category, rate, currency, sample_count, note, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())`,
        [row.carrier_code, row.pol, row.container_type, row.cost_category, row.rate, row.currency, null, row.note],
      );
    }
    for (const item of plan.updates) {
      const note = `${item.next.note} | 原值 ${item.prev.rate}→${item.next.rate}`;
      await client.query(
        `UPDATE public.freight_port_rates
            SET rate = $1, currency = $2, sample_count = NULL, note = $3, updated_at = NOW()
          WHERE carrier_code = $4 AND pol = $5 AND container_type = $6 AND cost_category = $7
            AND rate IS DISTINCT FROM $1`,
        [
          item.next.rate,
          item.next.currency,
          note,
          item.next.carrier_code,
          item.next.pol,
          item.next.container_type,
          item.next.cost_category,
        ],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const commit = process.argv.includes("--commit");
  const fileArg = process.argv.find((arg) => arg.startsWith("--file="));
  const xlsxFile = fileArg ? fileArg.slice("--file=".length) : SOURCE_FILE;
  if (!fs.existsSync(xlsxFile)) throw new Error(`xlsx not found: ${xlsxFile}`);

  const ExcelJS = (await loadPackage("exceljs")).default || (await loadPackage("exceljs"));
  const pgMod = await loadPackage("pg");
  const dotenv = await loadPackage("dotenv").catch(() => null);
  dotenv?.config?.();
  const Pool = pgMod.default?.Pool || pgMod.Pool;

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxFile);

  const skipCounts = new Map();
  const badCarrierSheets = [];
  const parsed = [];
  for (const ws of workbook.worksheets.slice(1)) {
    const carrier = parseCarrierCode(ws.name);
    if (!carrier) {
      badCarrierSheets.push(ws.name);
      addSkip(skipCounts, "carrier_code_missing_sheet", 1);
      continue;
    }
    const result = parseSheet(ws);
    result.rows.forEach((row) => {
      row.carrier_code = carrier;
    });
    for (const skip of result.skips) addSkip(skipCounts, skip.reason, skip.count);
    parsed.push({ sheet: ws.name, rows: result.rows });
  }

  const allRows = dedupeParsed(parsed.flatMap((item) => item.rows), skipCounts);
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL,
    host: process.env.PG_HOST,
    port: process.env.PG_PORT ? Number(process.env.PG_PORT) : undefined,
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: process.env.PGSSL === "true" || process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false,
    max: 2,
  });

  let shouldClosePool = true;
  try {
    let plan = null;
    let dbError = null;
    try {
      const existing = await loadExisting(pool);
      plan = makePlan(allRows, existing, skipCounts);
    } catch (error) {
      dbError = error;
      if (commit) throw error;
      shouldClosePool = false;
    }

    console.log(`模式: ${commit ? "commit" : "dry-run"} | 文件: ${xlsxFile} | 运行日: ${localDate()}`);
    summarizeBySheet(parsed);
    printCosco(allRows.filter((row) => row.carrier_code === "COSCO"));
    console.log("");
    console.log(`合计解析行: ${allRows.length}`);
    console.log(`将新增: ${plan ? plan.inserts.length : "DB不可达，未计算"}`);
    console.log(`将更新: ${plan ? plan.updates.length : "DB不可达，未计算"}`);
    console.log(`跳过: ${[...skipCounts.values()].reduce((sum, n) => sum + n, 0)}`);
    for (const [reason, count] of [...skipCounts.entries()].sort()) console.log(`- ${reason}: ${count}`);
    console.log(`取不出 carrier_code 的 sheet: ${badCarrierSheets.length ? badCarrierSheets.join(" / ") : "(无)"}`);
    if (dbError) console.log(`DB只读对账失败: ${dbError.message}`);
    if (commit && plan) await applyPlan(pool, plan);
    else console.log("dry-run: 未写库。加 --commit 才会 INSERT/UPDATE；不会 DELETE。");
  } finally {
    if (shouldClosePool) await pool.end();
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
