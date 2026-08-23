import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Pool } = pg;
const EPS = 0.01;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_DIRS = ["api", "public"];
const BUSINESS_KEY_RE = /(qty|quantity|amount|price|unit|basis|currency|rate|paid|receive|payment|total)/i;
const SYNONYMS = {
  amount: ["amount", "paid_amount", "this_amount", "sale_amount", "total_amount"],
  receivedamount: ["amount", "paid_amount", "this_amount", "received_amount"],
  received_amount: ["amount", "paid_amount", "this_amount"],
  paidamount: ["amount", "paid_amount", "this_amount"],
  thisamount: ["amount", "paid_amount", "this_amount"],
  sale_qty: ["qty", "quantity", "sale_qty"],
  saleqty: ["qty", "quantity", "sale_qty"],
  qty: ["qty", "quantity"],
  quantity: ["qty", "quantity"],
  unit_price: ["unit_price", "price", "sale_unit_price"],
  unitprice: ["unit_price", "price", "sale_unit_price"],
  price: ["price", "unit_price", "sale_unit_price"],
};

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
    if (/\.bak/i.test(ent.name)) continue;
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

function normalizeName(v) {
  return String(v || "").replace(/[^A-Za-z0-9]/g, "").toLowerCase();
}

function displayPath(file, line) {
  return `${path.relative(ROOT, file)}:${line}`;
}

function lineNumberAt(src, index) {
  return src.slice(0, index).split(/\r?\n/).length;
}

function tableName(v) {
  return String(v || "").replace(/^public\./, "");
}

function quoteIdent(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`unsafe table identifier: ${name}`);
  return `"${name.replace(/"/g, '""')}"`;
}

function parseAliases(src) {
  const aliases = new Map();
  const tables = new Set();
  const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][\w.]*)(?:\s+(?:AS\s+)?([A-Za-z_][\w]*))?/gi;
  let m;
  while ((m = re.exec(src))) {
    const tbl = tableName(m[1]);
    const alias = m[2] && !/^(ON|USING|WHERE|LEFT|RIGHT|FULL|INNER|OUTER|JOIN|GROUP|ORDER|LIMIT|UNION)$/i.test(m[2])
      ? m[2]
      : tbl;
    if (!tbl || /\(/.test(tbl)) continue;
    tables.add(tbl);
    aliases.set(alias, tbl);
    aliases.set(tbl, tbl);
  }
  return { aliases, tables };
}

function rawReferences(src, file) {
  const refs = [];
  const { aliases, tables } = parseAliases(src);
  const re = /\b(?:(\w+)\s*\.\s*)?raw\s*->>\s*['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const key = m[2];
    if (!BUSINESS_KEY_RE.test(key)) continue;
    let table = m[1] ? aliases.get(m[1]) : aliases.get("raw");
    if (!table && !m[1] && tables.size === 1) table = [...tables][0];
    refs.push({ file, line: lineNumberAt(src, m.index), table: table || null, raw_key: key });
  }
  return refs;
}

async function businessRawRefs() {
  const files = [];
  for (const dir of SCAN_DIRS) {
    try {
      await walk(path.join(ROOT, dir), files);
    } catch {
      // Some deployments do not have every scan directory.
    }
  }
  const refs = [];
  for (const file of files) {
    const src = await fs.readFile(file, "utf8");
    refs.push(...rawReferences(src, file));
  }
  const seen = new Set();
  return refs.filter((ref) => {
    const key = `${ref.file}:${ref.line}:${ref.table || ""}:${ref.raw_key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => displayPath(a.file, a.line).localeCompare(displayPath(b.file, b.line)));
}

async function tableExists(pool, table) {
  const r = await pool.query("SELECT to_regclass($1) AS tbl", [`public.${table}`]);
  return Boolean(r.rows[0]?.tbl);
}

async function tableColumns(pool, table) {
  const r = await pool.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table]
  );
  return r.rows.map((x) => x.column_name);
}

function trueColumnsFor(rawKey, columns) {
  const wanted = new Set([rawKey, normalizeName(rawKey), ...(SYNONYMS[rawKey] || []), ...(SYNONYMS[normalizeName(rawKey)] || [])]);
  return columns.filter((col) => wanted.has(col) || wanted.has(normalizeName(col))).filter((col) => col !== "raw");
}

async function rawCoverageCheck(pool) {
  const refs = await businessRawRefs();
  const rows = [];
  const cache = new Map();
  for (const ref of refs) {
    if (!ref.table) {
      rows.push({ level: "UNOWNED", location: displayPath(ref.file, ref.line), table: null, raw_key: ref.raw_key, covered_rows: null, total_rows: null, true_columns: [], note: "alias/table unresolved" });
      continue;
    }
    if (!(await tableExists(pool, ref.table))) {
      rows.push({ level: "UNOWNED", location: displayPath(ref.file, ref.line), table: ref.table, raw_key: ref.raw_key, covered_rows: null, total_rows: null, true_columns: [], note: "table not found" });
      continue;
    }
    if (!cache.has(ref.table)) cache.set(ref.table, await tableColumns(pool, ref.table));
    const trueColumns = trueColumnsFor(ref.raw_key, cache.get(ref.table));
    const r = await pool.query(
      `SELECT COUNT(*)::int AS total_rows,
              COUNT(*) FILTER (WHERE raw ? $1 AND NULLIF(raw->>$1,'') IS NOT NULL)::int AS covered_rows
         FROM ${quoteIdent(ref.table)}`,
      [ref.raw_key]
    );
    const covered = n(r.rows[0]?.covered_rows);
    const total = n(r.rows[0]?.total_rows);
    const pct = total ? covered / total : 0;
    if (covered === 0 || (covered > 0 && pct < 0.2)) {
      rows.push({
        level: covered === 0 ? "RED" : "YELLOW",
        location: displayPath(ref.file, ref.line),
        table: ref.table,
        raw_key: ref.raw_key,
        covered_rows: covered,
        total_rows: total,
        coverage_pct: Math.round(pct * 10000) / 100,
        true_columns: trueColumns,
        note: trueColumns.length ? "same-meaning native column present" : "",
      });
    }
  }
  return { name: "raw_business_key_coverage_by_owner_table", rows };
}

async function marginBargeCheck(pool) {
  const year = process.env.GUARD_YEAR || "2026";
  const sql = `
    WITH bill_groups AS (
      SELECT BTRIM(bl_no) AS bl_no,
             SUM(CASE WHEN UPPER(COALESCE(currency_norm,currency,'USD'))='USD'
                       AND (cost_category ILIKE '%海运%' OR cost_category ILIKE '%ocean%' OR cost_category ILIKE '%freight%')
                      THEN COALESCE(amount,0) ELSE 0 END) AS ocean_cost_usd,
             SUM(CASE WHEN UPPER(COALESCE(currency_norm,currency,'USD'))='CNY'
                       AND (cost_category ILIKE '%驳船%' OR cost_category ILIKE '%barge%')
                      THEN COALESCE(amount,0) ELSE 0 END) AS barge_cost_cny
        FROM active_freight_supplier_bills
       WHERE UPPER(COALESCE(currency_norm,currency,'USD')) IN ('USD','CNY')
         AND NULLIF(BTRIM(bl_no),'') IS NOT NULL
       GROUP BY BTRIM(bl_no)
    ), plan_groups AS (
      SELECT BTRIM(sp.bl_no) AS bl_no,
             MIN(sp.etd) AS etd,
             MAX(sp.freight_sale_usd) AS ocean_sale_usd
        FROM shipping_plans sp
       WHERE sp.deleted_at IS NULL
         AND NULLIF(BTRIM(sp.bl_no),'') IS NOT NULL
         AND sp.bl_no !~ '^[0-9]+-[0-9]+$'
         AND ($1 = '' OR EXTRACT(YEAR FROM sp.etd)::text = $1)
       GROUP BY BTRIM(sp.bl_no)
    )
    SELECT pg.bl_no,
           COALESCE(bg.ocean_cost_usd,0) AS ocean_cost_usd,
           COALESCE(bg.barge_cost_cny,0) AS barge_cost_cny,
           CASE WHEN COALESCE(bg.barge_cost_cny,0) > 0 AND fx.rate IS NULL THEN NULL
                WHEN COALESCE(bg.barge_cost_cny,0) > 0 THEN COALESCE(bg.barge_cost_cny,0) / NULLIF(fx.rate,0)
                ELSE 0 END AS barge_cost_usd,
           COALESCE(pg.ocean_sale_usd,0) AS ocean_sale_usd,
           (COALESCE(bg.barge_cost_cny,0) > 0 AND fx.rate IS NULL) AS fx_missing,
           CASE WHEN COALESCE(bg.barge_cost_cny,0) > 0 AND fx.rate IS NULL THEN NULL
                ELSE ROUND((COALESCE(pg.ocean_sale_usd,0) - COALESCE(bg.ocean_cost_usd,0)
                  - CASE WHEN COALESCE(bg.barge_cost_cny,0) > 0 THEN COALESCE(bg.barge_cost_cny,0) / NULLIF(fx.rate,0) ELSE 0 END)::numeric,2)
            END AS freight_margin_usd
      FROM plan_groups pg
      LEFT JOIN bill_groups bg ON bg.bl_no = pg.bl_no
      LEFT JOIN LATERAL (
        SELECT rate
          FROM exchange_rates
         WHERE currency_pair='USD_CNY'
           AND fetched_at::date <= pg.etd::date
         ORDER BY fetched_at DESC
         LIMIT 1
      ) fx ON TRUE`;
  const rows = (await pool.query(sql, [year])).rows;
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
