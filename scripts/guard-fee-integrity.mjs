import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadReconMaster } from "../api/db/recon-master.js";

const { Pool } = pg;
const EPS = 0.01;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function loadDotenv() {
  try {
    const txt = await fs.readFile(path.join(ROOT, ".env"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!m || process.env[m[1]] !== undefined) continue;
      process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // .env is optional; explicit environment variables are preferred.
  }
}

function poolFromEnv() {
  const dsn = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL;
  if (dsn) return new Pool({ connectionString: dsn, max: 2 });
  if (!process.env.PG_HOST || !process.env.PG_DATABASE || !process.env.PG_USER) {
    throw new Error("DATABASE_URL/POSTGRES_URL/PG_URL or PG_HOST+PG_DATABASE+PG_USER required");
  }
  return new Pool({
    host: process.env.PG_HOST,
    port: Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
    max: 2,
  });
}

function n(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function money(v) {
  return Math.round(n(v) * 100) / 100;
}

function mismatch(a, b) {
  return Math.abs(n(a) - n(b)) > EPS;
}

async function walk(dir, out = []) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git" || ent.name.startsWith(".codex")) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) await walk(p, out);
    else if (/\.(js|mjs|cjs|sql)$/.test(ent.name)) out.push(p);
  }
  return out;
}

async function billMathCheck(pool) {
  const sql = `
    WITH normalized AS (
      SELECT id, bl_no, cost_category, currency, amount, sale_amount,
             COALESCE(
               CASE WHEN NULLIF(raw->>'sale_qty','') ~ '^[0-9]+(\\.[0-9]+)?$'
                    THEN NULLIF(raw->>'sale_qty','')::numeric ELSE NULL END,
               qty
             ) AS bill_qty,
             CASE WHEN NULLIF(raw->>'unit_price','') ~ '^[0-9]+(\\.[0-9]+)?$'
                  THEN NULLIF(raw->>'unit_price','')::numeric ELSE NULL END AS raw_unit_price
        FROM active_freight_supplier_bills
       WHERE COALESCE(rebill_status,'') NOT IN ('voided','absorbed')
         AND COALESCE(sale_amount,0) > 0
         AND UPPER(COALESCE(currency,'CNY')) = 'CNY'
         AND cost_category !~* '海运|ocean|freight'
    ), printed AS (
      SELECT *,
             COALESCE(
               CASE WHEN bill_qty > 0
                      AND raw_unit_price IS NOT NULL
                      AND ROUND((raw_unit_price * bill_qty)::numeric,2) = ROUND(sale_amount::numeric,2)
                    THEN raw_unit_price ELSE NULL END,
               sale_amount / NULLIF(bill_qty,0)
             ) AS printed_unit_price
        FROM normalized
    )
    SELECT id, bl_no, cost_category, currency, amount, sale_amount,
           bill_qty AS qty,
           printed_unit_price AS unit_price,
           sale_amount AS bill_amount,
           ROUND((bill_qty * printed_unit_price)::numeric, 2) AS calc_amount
      FROM printed
     WHERE bill_qty IS NOT NULL
       AND printed_unit_price IS NOT NULL
       AND ABS(ROUND((bill_qty * printed_unit_price)::numeric, 2) - ROUND(sale_amount::numeric, 2)) > $1
     ORDER BY bl_no NULLS LAST, id
     LIMIT 200`;
  const rows = (await pool.query(sql, [EPS])).rows;
  return { name: "bill_unit_qty_amount_mismatch", rows };
}

function businessRawKeys(src) {
  const keys = new Set();
  const re = /raw\s*->>\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(src))) {
    const key = m[1];
    if (/(qty|quantity|amount|price|unit|basis|currency|rate)/i.test(key)) keys.add(key);
  }
  return [...keys].sort();
}

async function rawCoverageCheck(pool) {
  const files = await walk(ROOT);
  const keys = new Set();
  for (const file of files) {
    const src = await fs.readFile(file, "utf8");
    for (const key of businessRawKeys(src)) keys.add(key);
  }
  const rows = [];
  for (const key of [...keys].sort()) {
    const r = await pool.query(
      `SELECT COUNT(*) FILTER (WHERE raw ? $1 AND NULLIF(raw->>$1,'') IS NOT NULL)::int AS covered
         FROM freight_supplier_bills`,
      [key]
    );
    if (!n(r.rows[0]?.covered)) rows.push({ table: "freight_supplier_bills", raw_key: key, covered_rows: 0 });
  }
  return { name: "raw_business_key_zero_coverage", rows };
}

async function marginBargeCheck(pool) {
  const rows = await loadReconMaster(pool, { year: process.env.GUARD_YEAR || "2026" });
  const bad = [];
  for (const r of rows) {
    if (n(r.barge_cost_cny) <= 0) continue;
    if (r.fx_missing) {
      if (r.freight_margin_usd !== null && r.freight_margin_usd !== undefined) {
        bad.push({ bl_no: r.bl_no, issue: "fx_missing_but_margin_present", freight_margin_usd: r.freight_margin_usd });
      }
      continue;
    }
    const expected = money(n(r.ocean_sale_usd) - n(r.ocean_cost_usd) - n(r.barge_cost_usd));
    if (mismatch(r.freight_margin_usd, expected)) {
      bad.push({
        bl_no: r.bl_no,
        ocean_sale_usd: r.ocean_sale_usd,
        ocean_cost_usd: r.ocean_cost_usd,
        barge_cost_usd: r.barge_cost_usd,
        freight_margin_usd: r.freight_margin_usd,
        expected_margin_usd: expected,
      });
    }
  }
  return { name: "freight_margin_barge_cost_reconciled", rows: bad.slice(0, 200) };
}

function printResult(result) {
  if (!result.rows.length) {
    console.log(`OK ${result.name}`);
    return;
  }
  console.log(`RED ${result.name}: ${result.rows.length}`);
  console.table(result.rows.slice(0, 30));
}
async function main() {
  await loadDotenv();
  const pool = poolFromEnv();
  try {
    const checks = [
      await billMathCheck(pool),
      await rawCoverageCheck(pool),
      await marginBargeCheck(pool),
    ];
    checks.forEach(printResult);
    process.exitCode = checks.some((x) => x.rows.length) ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`RED guard_failed: ${err.message}`);
  process.exitCode = 2;
});
