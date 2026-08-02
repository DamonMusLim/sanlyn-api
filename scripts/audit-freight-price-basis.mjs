import "dotenv/config";
import fs from "node:fs/promises";
import pg from "pg";

const { Pool } = pg;
const CSV_PATH = "/tmp/freight_price_audit.csv";
const MD_PATH = "/tmp/freight_price_audit.md";
const MONEY_EPS = 0.01;

const FIELDS = ["shipment_no", "bl_no", "customer", "pol", "pod", "container_type", "container_qty", "detected_container_types", "freight_rate_id", "freight_cost", "freight_sale_usd", "snapshot_totals", "bill_ocean_cost", "bill_ocean_sale", "classification", "flags", "reason", "recommended_action"];

function getPool() {
  const dsn = process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.PG_URL;
  if (dsn) return new Pool({ connectionString: dsn, max: 3 });
  if (!process.env.PG_HOST || !process.env.PG_DATABASE || !process.env.PG_USER) throw new Error("DATABASE_URL/POSTGRES_URL/PG_URL or PG_HOST+PG_DATABASE+PG_USER required");
  return new Pool({ host: process.env.PG_HOST, port: Number(process.env.PG_PORT || 5432), database: process.env.PG_DATABASE, user: process.env.PG_USER, password: process.env.PG_PASSWORD, ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false, max: 3 });
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

function approx(a, b, eps = MONEY_EPS) {
  const x = n(a), y = n(b);
  return x !== null && y !== null && Math.abs(x - y) <= eps;
}

function normType(v) {
  const s = String(v || "").trim().toUpperCase();
  if (!s) return null;
  if (s.includes("20")) return "GP20";
  if (s.includes("40") || s.includes("45") || s.includes("HQ") || s.includes("HC")) return "HQ40";
  return s.replace(/\s+/g, "_");
}

function jsonValue(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return {}; }
}

function pick(obj, keys) {
  for (const key of keys) {
    const val = obj?.[key];
    if (val !== undefined && val !== null && val !== "") return val;
  }
  return null;
}

function addDetected(map, type, qty = 1) {
  const t = normType(type);
  const q = Math.max(Number(qty) || 1, 1);
  if (t) map.set(t, (map.get(t) || 0) + q);
}

function detailTypes(containersDetail) {
  const out = new Map();
  const arr = Array.isArray(containersDetail) ? containersDetail : [];
  for (const item of arr) {
    const type = pick(item, ["container_type", "containerType", "type", "ctn_type", "size"]);
    const qty = pick(item, ["qty", "quantity", "count", "container_qty"]);
    addDetected(out, type, qty);
  }
  return out;
}

function snapshotInfo(raw) {
  const snap = jsonValue(raw).freight_rate_snapshot;
  if (!snap || typeof snap !== "object") return { snap: null, hasLines: false, cost: null, sale: null, units: [] };
  const lines = Array.isArray(snap.lines) ? snap.lines : [];
  const lineCost = lines.reduce((sum, line) => sum + (n(pick(line, ["total_cost", "cost_total", "amount_cost", "cost_amount", "amount"])) || 0), 0);
  const lineSale = lines.reduce((sum, line) => sum + (n(pick(line, ["total_sale", "sale_total", "amount_sale", "sale_amount"])) || 0), 0);
  const cost = money(pick(snap, ["total_cost", "cost_total", "freight_cost"]) ?? (lines.length ? lineCost : null));
  const sale = money(pick(snap, ["total_sale", "sale_total", "freight_sale_usd"]) ?? (lines.length ? lineSale : null));
  const units = [];
  for (const key of ["unit_cost", "unit_sale", "gp20", "hq40", "customer_gp20", "customer_hq40"]) {
    const val = n(snap[key] ?? snap.raw_rate?.[key]);
    if (val !== null) units.push(val);
  }
  for (const line of lines) {
    for (const key of ["unit_cost", "unit_sale", "unit_price", "cost_unit", "sale_unit"]) {
      const val = n(line[key]);
      if (val !== null) units.push(val);
    }
  }
  return { snap, hasLines: lines.length > 0, cost, sale, units };
}

function snapshotMatches(row, snap) {
  const costOk = snap.cost === null || row.freight_cost === null || approx(row.freight_cost, snap.cost);
  const saleOk = snap.sale === null || row.freight_sale_usd === null || approx(row.freight_sale_usd, snap.sale);
  return costOk && saleOk;
}

function possibleUnitStored(row, qty, units) {
  if (!qty || qty <= 1) return false;
  for (const amount of [row.freight_cost, row.freight_sale_usd]) {
    const m = n(amount);
    if (m === null) continue;
    if (units.some((unit) => approx(m, unit) && !approx(m, unit * qty))) return true;
  }
  return false;
}

function v1SelfConsistent(row, qty, snap) {
  if (!qty || qty <= 0) return false;
  const costUnit = n(snap.snap?.unit_cost ?? snap.snap?.raw_rate?.gp20 ?? snap.snap?.raw_rate?.hq40);
  const saleUnit = n(snap.snap?.unit_sale ?? snap.snap?.raw_rate?.customer_gp20 ?? snap.snap?.raw_rate?.customer_hq40);
  const costOk = row.freight_cost === null || costUnit === null || approx(row.freight_cost, costUnit * qty);
  const saleOk = row.freight_sale_usd === null || saleUnit === null || approx(row.freight_sale_usd, saleUnit * qty);
  return costOk && saleOk && (costUnit !== null || saleUnit !== null);
}

function classify(row, detected, bill, snap) {
  const qty = n(row.container_qty) || [...detected.values()].reduce((sum, q) => sum + q, 0);
  const flags = [];
  const hasAmount = row.freight_cost !== null || row.freight_sale_usd !== null;
  const hasBillLink = Boolean(row.bl_no || bill.cost !== null || bill.sale !== null);
  const typeCount = detected.size;
  const planTypeCount = normType(row.container_type) ? 1 : 0;
  if (row.freight_cost !== null && row.freight_sale_usd !== null && approx(row.freight_cost, row.freight_sale_usd, 0)) {
    flags.push("zero_margin");
  }
  const units = [...snap.units, ...bill.units].filter((x, i, arr) => arr.findIndex((y) => approx(x, y)) === i);
  let classification;
  let reason;
  let action = "人工核对账单/查微信报价/走adopt重新带入";
  if (!hasAmount || !qty || (!row.container_type && typeCount === 0) || !hasBillLink) {
    classification = "insufficient_data";
    reason = "缺柜型/柜数/金额，或缺少可用 BL/账单关联";
    action = "先补齐BL、柜型柜数和账单关联后再审";
  } else if (typeCount > 1 && (planTypeCount <= 1 || !snap.hasLines)) {
    classification = "mixed_container_needs_manual";
    reason = "明细识别到多种柜型，但票头或快照不是按柜型分行";
    action = "人工按柜型核对报价与账单，必要时走adopt重新带入";
  } else if (snap.snap && !snapshotMatches(row, snap)) {
    classification = "mismatch_snapshot_total";
    reason = "票头金额与 raw.freight_rate_snapshot 总额不一致";
  } else if (possibleUnitStored(row, qty, units)) {
    classification = "possible_unit_price_stored";
    reason = "多柜票票头金额接近单柜价，疑似把单价存成总额";
  } else if (snap.hasLines && snapshotMatches(row, snap)) {
    classification = "trusted_adopt_v2";
    reason = "存在按柜型 lines 快照，且票头总额与快照自洽";
    action = "保留观察；抽样核对账单";
  } else if ((row.freight_rate_id || snap.snap) && v1SelfConsistent(row, qty, snap)) {
    classification = "trusted_adopt_v1_single_type";
    reason = "存在运价引用或旧快照，且单柜价乘柜数与票头总额自洽";
    action = "单柜型票可保留；混柜票仍需人工抽查";
  } else {
    classification = "suspect_manual_or_import";
    reason = "无可验证运价快照，疑似手填或导入金额";
  }
  return { classification, flags: flags.join(";"), reason, recommended_action: action };
}

function csvCell(v) {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function mdCell(v) {
  return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

async function tableExists(pool, name) {
  const { rows } = await pool.query("SELECT to_regclass($1) AS table_name", [`public.${name}`]);
  return Boolean(rows[0]?.table_name);
}

async function fetchPlans(pool) {
  const { rows } = await pool.query(`
    SELECT id::text, _id, shipment_no, bl_no, customer, customer_cn, customer_en, pol, pod,
           container_type, container_qty, freight_rate_id, freight_cost, freight_sale_usd,
           containers_detail, raw
    FROM shipping_plans
    WHERE freight_cost IS NOT NULL OR freight_sale_usd IS NOT NULL
    ORDER BY COALESCE(shipment_no, _id, id::text)
  `);
  return rows;
}

async function fetchBookings(pool) {
  if (!(await tableExists(pool, "container_bookings"))) return [];
  const { rows } = await pool.query(`
    SELECT shipping_plan_id::text AS shipping_plan_id, bl_no, container_type, COUNT(*)::int AS qty
    FROM container_bookings
    WHERE container_type IS NOT NULL AND container_type <> ''
    GROUP BY shipping_plan_id::text, bl_no, container_type
  `);
  return rows;
}

async function fetchBills(pool) {
  const source = await tableExists(pool, "active_freight_supplier_bills") ? "active_freight_supplier_bills" : "freight_supplier_bills";
  const { rows } = await pool.query(`
    SELECT bl_no, link_plan_id::text AS link_plan_id,
           SUM(CASE WHEN COALESCE(cost_category,'') ILIKE ANY (ARRAY['%海运%', '%ocean%', '%freight%']) THEN COALESCE(amount,0) ELSE 0 END) AS ocean_cost,
           SUM(CASE WHEN COALESCE(cost_category,'') ILIKE ANY (ARRAY['%海运%', '%ocean%', '%freight%']) THEN COALESCE(sale_amount,0) ELSE 0 END) AS ocean_sale,
           ARRAY_REMOVE(ARRAY_AGG(DISTINCT unit_price) FILTER (WHERE unit_price IS NOT NULL), NULL) AS units
    FROM ${source}
    GROUP BY bl_no, link_plan_id::text
  `);
  return rows;
}

function indexBy(rows, keys) {
  const map = new Map();
  for (const row of rows) {
    for (const key of keys(row).filter(Boolean)) {
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(row);
    }
  }
  return map;
}

function mergeBill(rows) {
  const out = { cost: null, sale: null, units: [] };
  // 同一账单行可能同时挂在 bl_no 和 link_plan_id 两个索引键上,先按行去重再累加,否则金额翻倍
  const seen = new Set();
  const uniq = (rows || []).filter((r) => {
    const k = String(r.bl_no || "") + "|" + String(r.link_plan_id || "");
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  for (const row of uniq) {
    out.cost = money((out.cost || 0) + (n(row.ocean_cost) || 0));
    out.sale = money((out.sale || 0) + (n(row.ocean_sale) || 0));
    out.units.push(...(row.units || []).map(n).filter((x) => x !== null));
  }
  if (out.cost === 0) out.cost = null;
  if (out.sale === 0) out.sale = null;
  return out;
}

async function main() {
  const pool = getPool();
  try {
    const [plans, bookings, bills] = await Promise.all([fetchPlans(pool), fetchBookings(pool), fetchBills(pool)]);
    const bookingByPlan = indexBy(bookings, (r) => [r.shipping_plan_id]);
    const bookingByBl = indexBy(bookings, (r) => [r.bl_no]);
    const billByKey = indexBy(bills, (r) => [r.bl_no, r.link_plan_id]);
    const output = plans.map((row) => {
      const detected = detailTypes(row.containers_detail);
      for (const b of [...(bookingByPlan.get(row.id) || []), ...(bookingByBl.get(row.bl_no) || [])]) addDetected(detected, b.container_type, b.qty);
      const bill = mergeBill([...(billByKey.get(row.bl_no) || []), ...(billByKey.get(row.id) || []), ...(billByKey.get(row._id) || [])]);
      const snap = snapshotInfo(row.raw);
      const cls = classify(row, detected, bill, snap);
      return {
        shipment_no: row.shipment_no || row._id || row.id,
        bl_no: row.bl_no,
        customer: row.customer || row.customer_cn || row.customer_en,
        pol: row.pol,
        pod: row.pod,
        container_type: row.container_type,
        container_qty: row.container_qty,
        detected_container_types: [...detected.keys()].sort().join(";"),
        freight_rate_id: row.freight_rate_id,
        freight_cost: money(row.freight_cost),
        freight_sale_usd: money(row.freight_sale_usd),
        snapshot_totals: snap.snap ? `cost=${snap.cost ?? ""};sale=${snap.sale ?? ""};lines=${snap.hasLines ? "yes" : "no"}` : "",
        bill_ocean_cost: bill.cost,
        bill_ocean_sale: bill.sale,
        ...cls,
      };
    });
    const counts = output.reduce((acc, row) => ((acc[row.classification] = (acc[row.classification] || 0) + 1), acc), {});
    console.log("classification summary");
    for (const [key, count] of Object.entries(counts).sort()) console.log(`${key}\t${count}`);
    await fs.writeFile(CSV_PATH, [FIELDS.join(","), ...output.map((r) => FIELDS.map((f) => csvCell(r[f])).join(","))].join("\n") + "\n");
    const sections = Object.keys(counts).sort().map((key) => {
      const rows = output.filter((r) => r.classification === key).slice(0, 20);
      const table = ["| shipment_no | bl_no | customer | container | cost | sale | flags | reason |", "|---|---|---|---|---:|---:|---|---|"];
      for (const r of rows) table.push(`| ${mdCell(r.shipment_no)} | ${mdCell(r.bl_no)} | ${mdCell(r.customer)} | ${mdCell([r.container_type, r.container_qty].filter(Boolean).join(" x "))} | ${mdCell(r.freight_cost)} | ${mdCell(r.freight_sale_usd)} | ${mdCell(r.flags)} | ${mdCell(r.reason)} |`);
      return `## ${key} (${counts[key]})\n\n${table.join("\n")}`;
    });
    await fs.writeFile(MD_PATH, `# Freight Price Audit\n\nGenerated at: ${new Date().toISOString()}\n\n${sections.join("\n\n")}\n`);
    console.log(`csv=${CSV_PATH}`);
    console.log(`md=${MD_PATH}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exitCode = 1;
});
