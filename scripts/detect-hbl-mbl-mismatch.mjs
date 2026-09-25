import fs from "node:fs";
import pg from "pg";

const { Pool } = pg;
const DEFAULT_PAIR = ["EMIVCHNXIM015166", "ESLCHNXIM030005"];
const PLACEHOLDER_VESSEL_RE = /^(TEST[-\s_]*VESSEL|TBA|TBN|UNKNOWN|PLACEHOLDER|待定)$/i;

function loadDotenv() {
  try {
    const txt = fs.readFileSync(".env", "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
    }
  } catch {
    // Prefer explicit env vars; .env is optional for read-only checks.
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

function clean(v) {
  return String(v ?? "").trim();
}

function norm(v) {
  return clean(v).toUpperCase();
}

function arr(v) {
  if (Array.isArray(v)) return v.map(norm).filter(Boolean);
  return clean(v).split(/[,+/，、\s]+/).map(norm).filter(Boolean);
}

function money(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  const da = new Date(a);
  const db = new Date(b);
  if (Number.isNaN(da.getTime()) || Number.isNaN(db.getTime())) return null;
  return Math.abs(da.getTime() - db.getTime()) / 86400000;
}

function intersects(a, b) {
  const bs = new Set(b);
  return a.filter((x) => bs.has(x));
}

function hasPlaceholder(v) {
  return PLACEHOLDER_VESSEL_RE.test(norm(v));
}

function recommendation(score) {
  if (score >= 8) return "auto_exclude_hbl_mbl_mismatch_suspected";
  if (score >= 5) return "manual_review_suspected";
  return "do_not_exclude";
}

function scorePair(a, b) {
  const signals = [];
  let total = 0;
  const add = (name, points, hit, detail) => {
    if (hit) total += points;
    signals.push({ name, points: hit ? points : 0, max_points: points, hit, detail });
  };

  const orderHits = intersects([...arr(a.order_nos), ...arr(a.contract_nos)], [...arr(b.order_nos), ...arr(b.contract_nos)]);
  add("same_order", 3, orderHits.length > 0, orderHits.join(", "));

  add("same_voyage", 2, norm(a.voyage) && norm(a.voyage) === norm(b.voyage), [a.voyage, b.voyage].filter(Boolean).join(" / "));

  const ca = money(a.freight_cost);
  const cb = money(b.freight_cost);
  add("same_cost_nonzero", 2, ca !== null && ca > 0 && ca === cb, ca === null ? "" : String(ca));

  const containerHits = intersects(arr(a.container_no), arr(b.container_no));
  if (containerHits.length) {
    add("same_container_no", 2, true, containerHits.join(", "));
    signals.push({ name: "same_container_qty", points: 0, max_points: 1, hit: false, detail: "skipped: container_no matched" });
  } else {
    add("same_container_no", 2, false, "");
    const qa = money(a.container_qty);
    const qb = money(b.container_qty);
    add("same_container_qty", 1, qa !== null && qa > 0 && qa === qb, qa === null ? "" : String(qa));
  }

  const etdDays = daysBetween(a.etd, b.etd);
  add("etd_within_3_days", 1, etdDays !== null && etdDays <= 3, etdDays === null ? "" : `${Math.round(etdDays * 100) / 100} days`);

  const onePlaceholder = hasPlaceholder(a.vessel) !== hasPlaceholder(b.vessel);
  add("one_placeholder_vessel", 1, onePlaceholder, [a.vessel, b.vessel].filter(Boolean).join(" / "));

  return { ticket_a: a.bl_no || a.shipment_no || a._id, ticket_b: b.bl_no || b.shipment_no || b._id, signals, total_score: total, suggested_action: recommendation(total) };
}

async function loadPlans(pool, keys) {
  const r = await pool.query(
    `SELECT id, _id, shipment_no, bl_no, order_nos, contract_nos, voyage, vessel, etd,
            container_no, container_qty, freight_cost
       FROM shipping_plans
      WHERE deleted_at IS NULL
        AND (
          _id = ANY($1::text[])
          OR shipment_no = ANY($1::text[])
          OR bl_no = ANY($1::text[])
        )
      ORDER BY id`,
    [keys]
  );
  return r.rows;
}

async function main() {
  const keys = process.argv.slice(2);
  const pair = keys.length >= 2 ? keys.slice(0, 2) : DEFAULT_PAIR;
  loadDotenv();
  const pool = poolFromEnv();
  try {
    const rows = await loadPlans(pool, pair);
    const byKey = new Map();
    for (const row of rows) {
      for (const key of [row._id, row.shipment_no, row.bl_no].filter(Boolean)) byKey.set(key, row);
    }
    const a = byKey.get(pair[0]);
    const b = byKey.get(pair[1]);
    if (!a || !b) {
      console.log(JSON.stringify({
        pair,
        found: rows.map((r) => r.bl_no || r.shipment_no || r._id),
        note: "One or both tickets were not found under shipping_plans.deleted_at IS NULL. If the 0822 merged row is now soft-deleted, this confirms the filter is working.",
      }, null, 2));
      return;
    }
    console.log(JSON.stringify(scorePair(a, b), null, 2));
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
