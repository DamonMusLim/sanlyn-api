import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import pg from "pg";
import {
  FALLBACK_SANLYN_ENTITIES,
  buildSanlynEntitySet,
  isFreightAgency,
} from "./lib/external-order.js";

const { Pool } = pg;
const REPO_ROOT = path.resolve(new URL("../..", import.meta.url).pathname);
const ENV_PATHS = [
  path.join(REPO_ROOT, ".env.local"),
  path.join(REPO_ROOT, ".env"),
];
const OUT_DIR = process.env.P0A_OUT_DIR || path.join(os.homedir(), "p0a", "out");
const OUT_FILE = path.join(OUT_DIR, "external-candidates.json");

function parseEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

function loadEnv() {
  const merged = {};
  for (const file of ENV_PATHS) Object.assign(merged, parseEnvFile(file));
  for (const [key, value] of Object.entries(merged)) {
    if (process.env[key] == null) process.env[key] = value;
  }
}

function poolConfig() {
  return {
    host: process.env.PG_HOST || "127.0.0.1",
    port: Number(process.env.PG_PORT || 5432),
    database: process.env.PG_DATABASE,
    user: process.env.PG_USER,
    password: process.env.PG_PASSWORD,
    max: 3,
  };
}

async function tableColumns(pool, tableName) {
  const result = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return new Set(result.rows.map((row) => row.column_name));
}

function collectAliasValues(row) {
  const values = [];
  for (const key of Object.keys(row)) {
    const value = row[key];
    if (value == null) continue;
    if (Array.isArray(value)) values.push(...value);
    else if (typeof value === "object") values.push(...Object.values(value).flat());
    else values.push(value);
  }
  return values.map((value) => String(value).trim()).filter(Boolean);
}

async function loadSanlynNames(pool) {
  const columns = await tableColumns(pool, "companies");
  if (!columns.has("is_sanlyn_entity")) {
    return { names: FALLBACK_SANLYN_ENTITIES, source: "fallback:no_is_sanlyn_entity_column" };
  }

  const wanted = [
    "name_cn",
    "name_en",
    "alias",
    "aliases",
    "alias_names",
    "aliases_json",
  ].filter((column) => columns.has(column));
  const selectList = wanted.length ? wanted.map((c) => `"${c}"`).join(", ") : "name_cn";
  const result = await pool.query(
    `SELECT ${selectList} FROM companies WHERE is_sanlyn_entity = true`
  );
  const names = result.rows.flatMap(collectAliasValues);
  if (!names.length) return { names: FALLBACK_SANLYN_ENTITIES, source: "fallback:no_company_rows" };
  return { names, source: "companies.is_sanlyn_entity" };
}

async function loadPlans(pool) {
  const result = await pool.query(
    `SELECT id, shipment_no, shipper, customer, bl_no, source_system, raw
     FROM shipping_plans
     WHERE NULLIF(TRIM(COALESCE(bl_no, '')), '') IS NOT NULL
     ORDER BY id`
  );
  return result.rows;
}

function candidateRow(plan) {
  const shipper = String(plan.shipper || "").trim();
  return {
    shipment_no: plan.shipment_no || null,
    shipper,
    customer: plan.customer || null,
    bl_no: plan.bl_no || null,
    basis: `shipper=${shipper} not in Sanlyn entity whitelist`,
  };
}

async function main() {
  loadEnv();
  const pool = new Pool(poolConfig());
  try {
    const whitelist = await loadSanlynNames(pool);
    const sanlynEntities = buildSanlynEntitySet(whitelist.names);
    const plans = await loadPlans(pool);
    const summary = {
      marked_external: 0,
      candidate: 0,
      internal: 0,
      unknown_missing_shipper: 0,
    };
    const candidates = [];

    for (const plan of plans) {
      const verdict = isFreightAgency(plan, { sanlynEntities });
      if (verdict === true) summary.marked_external += 1;
      else if (verdict === "candidate") {
        summary.candidate += 1;
        candidates.push(candidateRow(plan));
      } else if (String(plan.shipper || "").trim()) summary.internal += 1;
      else summary.unknown_missing_shipper += 1;
    }

    const payload = {
      generated_at: new Date().toISOString(),
      readonly: true,
      whitelist_source: whitelist.source,
      whitelist_names_count: whitelist.names.length,
      summary,
      candidates,
    };

    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n");

    console.log("isFreightAgency: source_system/raw.order_type are definitive; non-Sanlyn shipper is candidate only.");
    console.log(`dry-run: scanned ${plans.length} BL plans, wrote ${OUT_FILE}`);
    console.log(`marked_external=${summary.marked_external} candidate=${summary.candidate} internal=${summary.internal} unknown_missing_shipper=${summary.unknown_missing_shipper}`);
    for (const row of candidates) {
      console.log(`${row.shipment_no || ""}|${row.shipper}|${row.customer || ""}|${row.bl_no || ""}|${row.basis}`);
    }
    console.log("readonly P0a only: P0b may backfill source_system after Damon confirms candidates.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("[list-external-candidates] failed:", err.message);
  process.exitCode = 1;
});
