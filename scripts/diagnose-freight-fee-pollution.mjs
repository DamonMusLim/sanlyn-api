import "dotenv/config";
import fs from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;

const CSV_A = "/tmp/list_A_miscategorized.csv";
const CSV_B = "/tmp/list_B_dup_same_fee.csv";
const CSV_C = "/tmp/list_C_cross_currency.csv";
const MD_PATH = "/tmp/freight_fee_pollution_diagnosis.md";
const SQL_PATH = "/tmp/fix_miscategorized.sql";

const FIELDS = ["bl_no", "cost_category", "currency", "amount", "qty", "unit_price", "supplier", "source_row", "suggested_action"];

function getPool() {
  const dsn = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL;
  if (dsn) return new Pool({ connectionString: dsn, max: 3 });
  if (!process.env.PG_HOST || !process.env.PG_DATABASE || !process.env.PG_USER) throw new Error("DATABASE_URL/POSTGRES_URL/PG_URL or PG_HOST+PG_DATABASE+PG_USER required");
  return new Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT || 5432), database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD, ssl: process.env.PGSSL === "true" || process.env.PG_SSL === "true" ? { rejectUnauthorized: false } : false, max: 3 });
}

function n(v) {
  if (v === null || v === undefined || v === "") return null;
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function money(v) {
  const x = n(v);
  return x === null ? null : Math.round((x + Number.EPSILON) * 100) / 100;
}

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function mdCell(v) {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function sqlLit(v) {
  return String(v ?? "").replace(/'/g, "''");
}

function normCategory(v) {
  return String(v || "").trim();
}

function normCurrency(v) {
  return String(v || "").trim().toUpperCase();
}

function standardCategory(category) {
  const s = normCategory(category);
  if (!s) return "";
  if (s.includes("驳船")) return "驳船费";
  if (s.includes("铁路")) return "铁路费";
  if (s.includes("拖车") || s.includes("土地燃油附加费") || s.includes("提货费")) return "拖车费";
  if (["综合服务费", "出口服务费", "服务费", "套柜费", "内转外服务费"].includes(s)) return "操作费";
  if (["作业费", "安保费", "超时费", "港口作业费", "码头操作费", "港口包干费"].includes(s)) return "港杂费";
  if (["转关费", "申报费"].includes(s)) return "报关费";
  if (["晚单费", "信息费", "信息传输费", "传输费", "海关数据传输服务费", "文件费", "打单费"].includes(s)) return "单证费";
  if (["进提费", "提箱操作费"].includes(s)) return "提箱费";
  if (["铅封费", "封条费"].includes(s)) return "封签费";
  if (["箱单费", "舱单信息费", "EDI"].includes(s)) return "舱单费";
  if (s === "堆存费") return "场站费";
  if (s === "设备交接单费") return "设备交接费";
  return "";
}

function hasTransportSignal(category) {
  const s = normCategory(category);
  return ["驳船", "铁路", "拖车"].filter((key) => s.includes(key));
}

function isOceanCategory(category) {
  const s = normCategory(category).toLowerCase();
  if (!s) return false;
  if (hasTransportSignal(s).length) return false;
  return s === "海运费" || s === "ocean freight" || s === "freight" || s === "ocean";
}

function exactBasisKey(row) {
  const amount = n(row.amount), qty = n(row.qty), unit = n(row.unit_price);
  if (amount === null || qty === null || unit === null) return null;
  return `${amount}|${qty}|${unit}`;
}

function rowOut(row, action) {
  return {
    bl_no: row.bl_no,
    cost_category: row.cost_category,
    currency: row.currency,
    amount: money(row.amount),
    qty: n(row.qty),
    unit_price: money(row.unit_price),
    supplier: row.supplier,
    source_row: row.source_row,
    suggested_action: action,
    id: row.id,
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

function writeCsv(path, rows) {
  return fs.writeFile(path, [FIELDS.join(","), ...rows.map((r) => FIELDS.map((f) => csvCell(r[f])).join(","))].join("\n") + "\n");
}

async function fetchBills(pool) {
  const { rows } = await pool.query(`
    SELECT id::text, bl_no, cost_category, currency, amount, qty, unit_price, supplier, source_row
    FROM freight_supplier_bills
    WHERE COALESCE(rebill_status,'') <> 'voided'
    ORDER BY bl_no, cost_category, currency, amount, id
  `);
  return rows;
}

function buildListA(rows) {
  const out = [];
  const hardSql = [];
  const byBl = groupBy(rows, (r) => r.bl_no);
  for (const sameBl of byBl.values()) {
    const nonOceanByBasis = groupBy(sameBl.filter((r) => !isOceanCategory(r.cost_category)), exactBasisKey);
    for (const oceanRow of sameBl.filter((r) => isOceanCategory(r.cost_category))) {
      const key = exactBasisKey(oceanRow);
      const match = key ? (nonOceanByBasis.get(key) || []).find((r) => standardCategory(r.cost_category)) : null;
      if (!match) continue;
      const target = standardCategory(match.cost_category);
      out.push(rowOut(oceanRow, `建议改 cost_category=${target};依据=同BL存在同amount/qty/unit的${match.cost_category};match_id=${match.id}`));
      if (["拖车费", "铁路费", "驳船费"].includes(target) && hasTransportSignal(match.cost_category).length === 1) {
        hardSql.push({ row: oceanRow, target, basis: match });
      }
    }
    for (const row of sameBl) {
      const target = standardCategory(row.cost_category);
      if (!normCategory(row.cost_category).includes("海运") || !target || target === "海运费") continue;
      out.push(rowOut(row, `建议改 cost_category=${target};依据=费目名含运输细分词且混入海运`));
    }
  }
  return { rows: out, hardSql };
}

function buildListB(rows) {
  const out = [];
  const groups = groupBy(rows, (r) => [r.bl_no, normCategory(r.cost_category), normCurrency(r.currency)].join("|"));
  for (const sameFee of groups.values()) {
    const amounts = new Set(sameFee.map((r) => String(n(r.amount))).filter((v) => v !== "null"));
    if (amounts.size <= 1) continue;
    for (const row of sameFee) out.push(rowOut(row, "同BL同费目同币种存在不同金额;人工核对是否拆分/重复/补备注"));
  }
  return out;
}

function buildListC(rows) {
  const out = [];
  const groups = groupBy(rows, (r) => [r.bl_no, normCategory(r.cost_category)].join("|"));
  for (const sameFee of groups.values()) {
    const currencies = new Set(sameFee.map((r) => normCurrency(r.currency)).filter(Boolean));
    if (!(currencies.has("CNY") && currencies.has("USD"))) continue;
    for (const row of sameFee) out.push(rowOut(row, "同BL同费目同时存在CNY和USD;任何汇总必须按币种分组"));
  }
  return out;
}

function buildSql(hardSql) {
  const lines = [
    "-- Freight supplier bill fee taxonomy fix candidates.",
    "-- Basis: same BL has an ocean-fee row and a non-ocean row with exactly the same amount, qty, and unit_price.",
    "-- Scope: only cost_category changes; amount/currency/qty/unit_price are not changed.",
    `-- Impact rows: ${hardSql.length}`,
    "-- Rollback: use the commented UPDATE statements under each change to restore the recorded original value.",
    "-- Recommended manual run wrapper: BEGIN; run reviewed UPDATE lines; verify; COMMIT.",
  ];
  for (const item of hardSql) {
    lines.push("");
    lines.push(`-- id=${item.row.id}; BL=${item.row.bl_no}; duplicate_basis_row=${item.basis.id}; old_cost_category='${sqlLit(item.row.cost_category)}'; new_cost_category='${sqlLit(item.target)}'`);
    lines.push(`UPDATE freight_supplier_bills SET cost_category='${sqlLit(item.target)}' WHERE id='${sqlLit(item.row.id)}';`);
    lines.push(`-- ROLLBACK: UPDATE freight_supplier_bills SET cost_category='${sqlLit(item.row.cost_category)}' WHERE id='${sqlLit(item.row.id)}';`);
  }
  return lines.join("\n") + "\n";
}

function mdTable(title, rows) {
  const table = [`## ${title} (${rows.length})`, "", "| bl_no | cost_category | currency | amount | qty | unit_price | supplier | source_row | suggested_action |", "|---|---|---|---:|---:|---:|---|---|---|"];
  for (const row of rows.slice(0, 80)) table.push(`| ${mdCell(row.bl_no)} | ${mdCell(row.cost_category)} | ${mdCell(row.currency)} | ${mdCell(row.amount)} | ${mdCell(row.qty)} | ${mdCell(row.unit_price)} | ${mdCell(row.supplier)} | ${mdCell(row.source_row)} | ${mdCell(row.suggested_action)} |`);
  return table.join("\n");
}

async function main() {
  const pool = getPool();
  try {
    const bills = await fetchBills(pool);
    const listA = buildListA(bills);
    const listB = buildListB(bills);
    const listC = buildListC(bills);
    await Promise.all([
      writeCsv(CSV_A, listA.rows),
      writeCsv(CSV_B, listB),
      writeCsv(CSV_C, listC),
      fs.writeFile(SQL_PATH, buildSql(listA.hardSql)),
      fs.writeFile(MD_PATH, `# Freight Fee Pollution Diagnosis\n\nGenerated at: ${new Date().toISOString()}\n\n${mdTable("A. miscategorized ocean fee", listA.rows)}\n\n${mdTable("B. duplicate same fee with different amount", listB)}\n\n${mdTable("C. cross currency same fee", listC)}\n`),
    ]);
    console.log(`list_A=${CSV_A}\trows=${listA.rows.length}`);
    console.log(`list_B=${CSV_B}\trows=${listB.length}`);
    console.log(`list_C=${CSV_C}\trows=${listC.length}`);
    console.log(`sql=${SQL_PATH}\tupdates=${listA.hardSql.length}`);
    console.log(`md=${MD_PATH}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
