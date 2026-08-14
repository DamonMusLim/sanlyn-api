#!/usr/bin/env node
import crypto from "crypto";

const APP_BASE = (process.env.DOC_SMOKE_BASE_URL || "http://127.0.0.1:9000").replace(/\/+$/, "");
const NTFY_URL = process.env.DOC_SMOKE_NTFY_URL || "https://ntfy.sh/sanlyn-damon-alert";
const DOC_TYPES = ["pack", "pl", "iv", "sc", "tr", "bl_sample", "booking_note"];
const PLAN_TYPES = ["confirm", "si", "customs_decl", "inspection_request", "customs_bundle"];
const MONEY_TYPES = new Set(["iv", "sc"]);
const STATUS_BAD = new Set(["cancelled", "archived", "voided", "deleted"]);
let generateTokenFn = null;

function arg(name, fallback = "") {
  const hit = process.argv.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!hit) return fallback;
  if (hit === `--${name}`) return "1";
  return hit.slice(name.length + 3);
}

function splitList(v) {
  return String(v || "").split(/[,;\s]+/).map((x) => x.trim()).filter(Boolean);
}

function asArr(v) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  if (typeof v === "string") return splitList(v.replace(/[{}"]/g, ""));
  return [];
}

function fmtNum(v, digits = 2) {
  const n = Number(v || 0);
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function plainNumber(v) {
  return String(Number(v || 0).toFixed(2)).replace(/\.00$/, "");
}

function htmlText(buf) {
  return buf.toString("utf8").replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
}

function contentKind(ct, buf) {
  const head = buf.subarray(0, 80).toString("utf8");
  if (/application\/pdf/i.test(ct) || head.startsWith("%PDF")) return "pdf";
  if (/spreadsheet|excel|officedocument/i.test(ct) || head.startsWith("PK")) return "xlsx";
  if (/text\/html/i.test(ct) || /<html|<!doctype/i.test(head)) return "html";
  if (/application\/json/i.test(ct) || /^[\s\r\n]*[{[]/.test(head)) return "json";
  if (/image\//i.test(ct)) return "image";
  return "binary";
}

function safeName(plan) {
  return plan.shipment_no || plan.bl_no || plan._id || `plan-${plan.id}`;
}

function svcJwt() {
  return generateTokenFn({ uid: 90, username: "svc-agent", role: "admin", tv: 1 });
}

function tokenFor(plan) {
  const env = process.env[`DOC_SMOKE_TOKEN_${safeName(plan).replace(/\W+/g, "_").toUpperCase()}`];
  return env || arg("collab-token", "") || process.env.DOC_SMOKE_COLLAB_TOKEN || "";
}

async function fetchBytes(url, headers = {}) {
  const started = Date.now();
  const res = await fetch(url, { headers, redirect: "follow" });
  const buf = Buffer.from(await res.arrayBuffer());
  return {
    url, status: res.status, ok: res.ok, bytes: buf.length,
    ms: Date.now() - started, ct: res.headers.get("content-type") || "",
    cd: res.headers.get("content-disposition") || "", buf,
  };
}

function record(out, level, plan, doc, rule, msg) {
  out.push({ level, plan: safeName(plan), plan_id: plan.id, doc, rule, msg });
}

async function loadPlans(pool) {
  const one = arg("plan", "");
  const days = Number(arg("days", process.env.DOC_SMOKE_DAYS || 45));
  const limit = Number(arg("limit", process.env.DOC_SMOKE_LIMIT || 30));
  const base = `
    SELECT id, _id, shipment_no, bl_no, order_nos, contract_nos, etd,
           shipping_status, status, release_type, raw
      FROM shipping_plans`;
  if (one) {
    const { rows } = await pool.query(`${base}
      WHERE id::text=$1 OR _id=$1 OR shipment_no=$1 OR bl_no=$1 LIMIT 1`, [one]);
    return rows;
  }
  const { rows } = await pool.query(`${base}
    WHERE COALESCE(shipping_status,status,'') <> ALL($1::text[])
      AND (etd IS NULL OR etd >= NOW() - ($2::int || ' days')::interval
           OR COALESCE(shipping_status,status,'') IN ('draft','booked','confirmed','ready','in_transit'))
    ORDER BY COALESCE(etd, NOW()) DESC, id DESC LIMIT $3`, [[...STATUS_BAD], days, limit]);
  return rows;
}

async function loadTruth(pool, plan) {
  const orders = await pool.query(
    `SELECT id, order_no, contract_no, customer_po
       FROM orders WHERE shipping_plan_id=$1 ORDER BY order_no`, [plan.id]);
  const ids = orders.rows.map((o) => o.id);
  let line = { cartons: 0, gross: 0, net: 0, cbm: 0, amount: 0, hs_codes: [] };
  if (ids.length) {
    const { rows } = await pool.query(
      `SELECT
         COALESCE(SUM(COALESCE(qty_ctn,0)),0) AS cartons,
         COALESCE(SUM(COALESCE(gw_ctn,0)*COALESCE(qty_ctn,0)),0) AS gross,
         COALESCE(SUM(COALESCE(nw_ctn,0)*COALESCE(qty_ctn,0)),0) AS net,
         COALESCE(SUM(COALESCE(cbm_ctn,0)*COALESCE(qty_ctn,0)),0) AS cbm,
         COALESCE(SUM(COALESCE(amount, subtotal, qty_ctn*unit_price,0)),0) AS amount,
         ARRAY_REMOVE(ARRAY_AGG(DISTINCT NULLIF(hs_code,'')), NULL) AS hs_codes
       FROM order_line_items WHERE order_id = ANY($1::int[])`, [ids]);
    line = rows[0] || line;
  }
  return { orders: orders.rows, oli: line };
}

function checkTruth(out, plan, truth) {
  const planNos = asArr(plan.order_nos);
  const orderNos = truth.orders.map((o) => o.order_no).filter(Boolean);
  if (planNos.length && planNos.length !== orderNos.length) {
    record(out, "FAIL", plan, "data", "order_count",
      `shipping_plans.order_nos=${planNos.length}, orders.shipping_plan_id=${orderNos.length}`);
  }
  const missing = planNos.filter((x) => !orderNos.includes(x));
  if (missing.length) record(out, "FAIL", plan, "data", "order_members", `order_nos not linked: ${missing.join(",")}`);
  if (!orderNos.length) record(out, "FAIL", plan, "data", "orders", "no orders linked by shipping_plan_id");
  if (Number(truth.oli.cartons) <= 0) record(out, "FAIL", plan, "data", "oli_cartons", "OLI cartons are empty/zero");
}

function checkHttpShape(out, plan, doc, got, expected = []) {
  const kind = contentKind(got.ct, got.buf);
  if (!got.ok) record(out, "FAIL", plan, doc, "http", `HTTP ${got.status}, content-type=${got.ct || "-"}`);
  if (got.bytes < 100) record(out, "FAIL", plan, doc, "body", `response too small: ${got.bytes} bytes`);
  if (kind === "json") record(out, "FAIL", plan, doc, "content_type", `JSON response where document expected: HTTP ${got.status}`);
  if (kind === "html" && /error|unauthorized|forbidden|not found|internal/i.test(htmlText(got.buf).slice(0, 500))) {
    record(out, "FAIL", plan, doc, "html_error", "HTML contains error/unauthorized/not found text");
  }
  if (expected.length && !expected.includes(kind)) {
    record(out, "FAIL", plan, doc, "content_type", `got ${kind}/${got.ct || "-"}, expected ${expected.join("|")}`);
  }
}

function checkDocText(out, plan, doc, got, truth) {
  if (contentKind(got.ct, got.buf) !== "html") return;
  const text = htmlText(got.buf);
  for (const o of truth.orders) {
    const key = o.order_no || o.contract_no;
    if (key && !text.includes(key)) record(out, "FAIL", plan, doc, "order_visible", `missing order ${key} in rendered text`);
  }
  const hs = asArr(truth.oli.hs_codes).slice(0, 8);
  for (const code of hs) {
    if (code && !text.includes(code)) record(out, "FAIL", plan, doc, "hs_visible", `missing HS ${code}`);
  }
  if (["pack", "pl"].includes(doc)) {
    const cartons = plainNumber(truth.oli.cartons);
    if (Number(truth.oli.cartons) > 0 && !text.includes(cartons) && !text.includes(fmtNum(truth.oli.cartons, 0))) {
      record(out, "FAIL", plan, doc, "cartons_visible", `OLI cartons ${cartons} not found in rendered text`);
    }
  }
  if (MONEY_TYPES.has(doc)) {
    const amt = Number(truth.oli.amount || 0);
    if (amt > 0 && !text.includes(fmtNum(amt, 2)) && !text.includes(plainNumber(amt))) {
      record(out, "FAIL", plan, doc, "amount_visible", `OLI amount ${fmtNum(amt, 2)} not found in rendered text`);
    }
  }
}

async function checkDirectDocs(pool, out, plan, truth) {
  const jwt = svcJwt();
  const first = truth.orders[0] && (truth.orders[0].order_no || truth.orders[0].contract_no);
  const ids = truth.orders.map((o) => o.order_no).filter(Boolean).join(",");
  for (const doc of DOC_TYPES) {
    const planLevel = ["tr", "bl_sample", "booking_note"].includes(doc);
    if (!planLevel && !first) {
      record(out, "FAIL", plan, doc, "input", "no linked order to request document");
      continue;
    }
    const id = planLevel ? plan.id : first;
    const qs = new URLSearchParams({ type: doc, id: String(id), token: jwt });
    if (!planLevel && ids) qs.set("ids", ids);
    if (["pack", "pl", "iv", "sc"].includes(doc)) qs.set("audience", "customer");
    const got = await fetchBytes(`${APP_BASE}/api/db/documents?${qs}`);
    checkHttpShape(out, plan, doc, got, ["html", "xlsx", "pdf"]);
    checkDocText(out, plan, doc, got, truth);
    await checkFrozen(out, pool, plan, doc, got);
  }
}

async function checkPlanDocs(out, plan) {
  const jwt = svcJwt();
  for (const doc of PLAN_TYPES) {
    const qs = new URLSearchParams({ id: String(plan.id), type: doc, token: jwt });
    if (doc === "customs_bundle") qs.set("format", "pdf");
    const got = await fetchBytes(`${APP_BASE}/api/db/shipping-plan-pdf?${qs}`);
    checkHttpShape(out, plan, `shipping:${doc}`, got, doc === "customs_bundle" ? ["pdf"] : ["html", "pdf"]);
  }
}

async function checkCollabFile(out, plan) {
  const raw = tokenFor(plan);
  if (!raw) {
    record(out, "UNTESTED", plan, "booking-collab/file", "token", "no recoverable raw magic token; pass --collab-token or DOC_SMOKE_COLLAB_TOKEN");
    return;
  }
  for (const doc of ["pack", "pl", "iv", "sc", "bl_sample", "booking_note", "quarantine"]) {
    const qs = new URLSearchParams({ token: raw, type: doc });
    const got = await fetchBytes(`${APP_BASE}/api/db/booking-collab/file?${qs}`);
    checkHttpShape(out, plan, `file:${doc}`, got, ["html", "xlsx", "pdf", "image", "binary"]);
  }
}

async function checkFrozen(out, pool, plan, doc, got) {
  if (!["pl", "sc", "iv"].includes(doc)) return;
  const exists = await tableExists(pool, "document_canonical_versions");
  if (!exists) {
    record(out, "UNTESTED", plan, doc, "frozen", "document_canonical_versions table missing; frozen drift check not available");
    return;
  }
  const enabled = await frozenEnabled(pool);
  if (!enabled) {
    record(out, "UNTESTED", plan, doc, "frozen", "PL/SC/IV frozen versions not enabled yet");
    return;
  }
  const keys = [String(plan.id), plan.shipment_no, plan._id, plan.bl_no].filter(Boolean);
  const { rows } = await pool.query(
    `SELECT storage_uri, snapshot_json FROM document_canonical_versions
      WHERE doc_type=$1 AND business_key = ANY($2::text[])
        AND status IN ('locked','issued','active')
      ORDER BY version DESC LIMIT 1`, [doc, keys]);
  if (!rows.length) {
    record(out, "FAIL", plan, doc, "frozen", "no locked/issued frozen version for this plan");
    return;
  }
  const snap = rows[0].snapshot_json;
  if (snap && typeof snap === "object") {
    const digest = crypto.createHash("sha256").update(got.buf).digest("hex");
    if (snap.sha256 && snap.sha256 !== digest) {
      record(out, "FAIL", plan, doc, "frozen_drift", `live sha256 ${digest.slice(0, 12)} != frozen ${String(snap.sha256).slice(0, 12)}`);
    }
  }
}

const tableCache = new Map();
async function tableExists(pool, table) {
  if (tableCache.has(table)) return tableCache.get(table);
  const { rows } = await pool.query(
    `SELECT 1 FROM information_schema.tables
      WHERE table_schema='public' AND table_name=$1 LIMIT 1`, [table]);
  const ok = rows.length > 0;
  tableCache.set(table, ok);
  return ok;
}

let frozenSupport = null;
async function frozenEnabled(pool) {
  if (frozenSupport != null) return frozenSupport;
  const { rows } = await pool.query(
    `SELECT 1 FROM document_canonical_versions
      WHERE doc_type = ANY($1::text[]) LIMIT 1`, [["pl", "sc", "iv"]]);
  frozenSupport = rows.length > 0;
  return frozenSupport;
}

async function notify(lines) {
  if (!lines.length || arg("no-push", "") === "1" || process.env.DOC_SMOKE_NO_PUSH === "1") return;
  const body = `Sanlyn document smoke ${new Date().toISOString().slice(0, 10)}\n` + lines.join("\n");
  await fetch(NTFY_URL, {
    method: "POST",
    headers: { Title: encodeURIComponent("Sanlyn document smoke"), Priority: "high" },
    body,
  }).catch((e) => console.error("[doc-smoke-ntfy]", e.message));
}

async function main() {
  if (arg("help", "") === "1" || process.argv.includes("-h")) {
    console.log([
      "Usage: node scripts/doc-download-smoke.mjs [--once] [--plan=CY00417] [--days=45] [--limit=30] [--no-push]",
      "Env: JWT_SECRET, PG_HOST, PG_DATABASE, PG_USER, PG_PASSWORD, DOC_SMOKE_BASE_URL, DOC_SMOKE_COLLAB_TOKEN",
      "Exit: 0 all clear, 1 only UNTESTED, 2 FAIL/ERROR",
    ].join("\n"));
    return;
  }
  const db = await import("../api/db.js");
  const auth = await import("../api/auth.js");
  generateTokenFn = auth.generateToken;
  const pool = db.getPool();
  const out = [];
  try {
    const plans = await loadPlans(pool);
    if (!plans.length) {
      console.log("DOC_SMOKE OK no active plans matched");
      return;
    }
    for (const plan of plans) {
      const truth = await loadTruth(pool, plan);
      checkTruth(out, plan, truth);
      await checkDirectDocs(pool, out, plan, truth);
      await checkPlanDocs(out, plan);
      await checkCollabFile(out, plan);
    }
    const bad = out.filter((x) => x.level !== "OK");
    const lines = bad.map((x) => `${x.level} ${x.plan} ${x.doc} ${x.rule}: ${x.msg}`);
    if (lines.length) {
      console.log(lines.join("\n"));
      await notify(lines.slice(0, 80));
      process.exitCode = bad.some((x) => x.level === "FAIL") ? 2 : 1;
    } else {
      console.log(`DOC_SMOKE OK plans=${plans.length}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`DOC_SMOKE ERROR ${e.message}`);
  process.exit(2);
});
