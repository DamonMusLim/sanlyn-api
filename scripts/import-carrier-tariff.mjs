import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { normalizeFeeRows } from "./lib/fee-normalize.mjs";
import { localDate, makeNote, parseCarrierCode, parseSheet, POL } from "./lib/tariff-parse.mjs";
const SOURCE_FILE = "/tmp/carrier_tariff.xlsx";
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
function addSkip(skips, reason, count = 1) { skips.set(reason, (skips.get(reason) || 0) + count); }
function keyOf(row) { return [row.carrier_code, row.pol, row.container_type, row.cost_category, row.currency || "CNY"].join("\u0001"); }
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
function findDuplicateKeys(rows) {
  const seen = new Map();
  const duplicates = [];
  for (const row of rows) {
    const key = [row.carrier_code, row.container_type, row.cost_category, row.currency || "CNY"].join("\u0001");
    const old = seen.get(key);
    if (old) duplicates.push({ old, row });
    else seen.set(key, row);
  }
  return duplicates;
}
function printDuplicateKeyCheck(duplicates) {
  console.log("");
  if (!duplicates.length) {
    console.log("重复键自检: 无重复");
    return;
  }
  console.log(`重复键自检: 发现 ${duplicates.length} 组`);
  for (const item of duplicates) {
    const r = item.row;
    console.log(`${r.carrier_code}\t${r.container_type}\t${r.cost_category}\t${r.currency}\t行${item.old.rowNo}/行${r.rowNo}`);
  }
}
function printNonNumeric(skips) {
  const bad = skips.filter((skip) => skip.reason === "non_numeric_rate");
  console.log("");
  console.log(`non_numeric_rate 全量: ${bad.length}`);
  for (const skip of bad) console.log(`${skip.sheet}\t行${skip.rowNo || ""}\t${skip.category || ""}\t${skip.container_type || ""}\t${skip.raw || ""}`);
}
function printUnparsedFees(parsed) {
  console.log("");
  console.log("原表出现但未解析出的费目:");
  for (const item of parsed) {
    const missing = (item.seenFees || []).filter((fee) => !fee.parsed);
    if (!missing.length) {
      console.log(`${item.sheet}: 无`);
      continue;
    }
    console.log(`${item.sheet}: ${missing.map((fee) => `${fee.category}(行${fee.rowNo})`).join(" / ")}`);
  }
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
  const footnoteRates = [];
  for (const ws of workbook.worksheets.slice(1)) {
    const carrier = parseCarrierCode(ws.name);
    if (!carrier) {
      badCarrierSheets.push(ws.name);
      addSkip(skipCounts, "carrier_code_missing_sheet");
      continue;
    }
    const result = parseSheet(ws);
    for (const skip of result.skips) addSkip(skipCounts, skip.reason, skip.count || 1);
    parsedRaw.push({ sheet: ws.name, rows: result.rows, skips: result.skips, seenFees: result.seenFees || [] });
    duplicateColumns.push(...(result.duplicateColumns || []));
    fills.push(...(result.fills || []));
    footnoteRates.push(...(result.footnoteRates || []));
  }
  const deduped = [];
  const conflicts = [];
  for (const item of parsedRaw) {
    const result = dedupeParsed(item.rows, skipCounts);
    deduped.push({ sheet: item.sheet, rows: result.rows, skips: item.skips, seenFees: item.seenFees });
    conflicts.push(...result.conflicts);
  }
  const normalized = normalizeFeeRows(deduped.flatMap((item) => item.rows));
  const allRows = normalized.rows;
  const duplicateKeys = findDuplicateKeys(allRows);
  if (duplicateKeys.length) {
    printDuplicateKeyCheck(duplicateKeys);
    throw new Error("重复键自检失败");
  }
  if (outFile) writeTsv(outFile, allRows);
  const recon = await reconcile(allRows, skipCounts);
  console.log(`模式: dry-run | 文件: ${xlsxFile} | 运行日: ${localDate()}`);
  summarizeBySheet(deduped);
  printUnparsedFees(deduped);
  printDuplicateKeyCheck(duplicateKeys);
  printList("原表脚注含费率(需人工录入)", footnoteRates, (r) => `${r.sheet}\t行${r.rowNo}\t${r.text}`);
  printConflicts(conflicts);
  printList("同名列冲突 全量", duplicateColumns, (r) => `${r.sheet}\t行${r.rowNo}\t${r.container_type}\t${r.category}\t${r.raw}`);
  printList("跨柜型补值全量", fills, (r) => `${r.sheet}\t行${r.rowNo}\t从行${r.fromRow}\t${r.container_type}\t${r.category}\t${r.raw}`);
  printList("费目名映射不上全量", normalized.unknown, (r) => `${r.sheet}\t${r.category}\t${r.count}`);
  console.log("");
  console.log(`fee_code 已映射: ${normalized.stats.mappedRows} 行 (${normalized.stats.mappedCategories} 个费目)`);
  console.log(`fee_code 留空:   ${normalized.stats.blankRows} 行 → 全部属于「待新增」清单`);
  printList("建议新增到 hgj_fee_master 的费目", normalized.suggested, (r) => `${r.category}\t${r.carriers.join("/")}\t${r.amounts}`);
  printNonNumeric(parsedRaw.flatMap((item) => item.skips));
  printRows("ONE 全量解析结果:", allRows.filter((row) => row.carrier_code === "ONE"));
  printRows("YML THC 航区回归:", allRows.filter((row) => row.carrier_code === "YML" && row.cost_category.startsWith("THC")));
  printRows("YML 封志费回归:", allRows.filter((row) => row.carrier_code === "YML" && row.cost_category.startsWith("封志费")));
  printList("PIL 同名列回归", duplicateColumns.filter((row) => row.sheet.startsWith("PIL")), (r) => `${r.sheet}\t行${r.rowNo}\t${r.container_type}\t${r.category}\t${r.raw}`);
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
