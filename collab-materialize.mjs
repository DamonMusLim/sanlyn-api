#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { loadEnvFile, parseArgs, printRow } from "./collab-doc-utils.mjs";

const args = parseArgs(process.argv);
const API_ROOT = args.apiRoot || process.env.SANLYN_API_ROOT || "/opt/sanlyn-api-test";
const UPLOAD_ROOT = process.env.COLLAB_UPLOAD_ROOT || "/opt/sanlyn-uploads/collab";
const LIMIT = args.limit || 200;

if (args.help) {
  console.log(`Usage: node ~/collab-materialize.mjs [--only <planId|order_no|BL>] [--limit N] [--commit]

Default is dry-run. Writes PDF files and shipping_plans.raw.collab_uploads only with --commit.
Requires DATABASE_URL and JWT_SECRET, normally loaded from /opt/sanlyn-api-test/.env.`);
  process.exit(0);
}

loadEnvFile(path.join(API_ROOT, ".env"));
if (!process.env.DATABASE_URL) throw new Error(`DATABASE_URL missing; expected ${path.join(API_ROOT, ".env")}`);
if (!process.env.JWT_SECRET) throw new Error(`JWT_SECRET missing; expected ${path.join(API_ROOT, ".env")}`);

const requireFromApi = createRequire(path.join(API_ROOT, "package.json"));
const { Pool } = requireFromApi("pg");
const { generateToken } = await import(pathToFileURL(path.join(API_ROOT, "api/auth.js")).href);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const MATERIAL_DOCS = new Set(["pl_sc_iv", "freight_bill", "portcharge_bill"]);

function normString(v) {
  return v == null ? "" : String(v).trim();
}

function normNumber(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? Number(n.toFixed(6)) : null;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
}

function sourceHash(source) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(source))).digest("hex");
}

function parseUploads(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

function latestMaterialized(plan, docType) {
  const list = parseUploads(plan.collab_uploads || plan.raw?.collab_uploads);
  return [...list].reverse().find((u) => u && u.doc_type === docType && u.source === "materialized") || null;
}

function safeStem(v) {
  return normString(v).normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "_").replace(/^_+|_+$/g, "") || "document";
}

function storedName(plan, docType) {
  return `${docType}_${safeStem(plan.bl_no || plan.shipment_no || plan.id)}.pdf`;
}

function displayName(plan, docType) {
  const label = safeStem(plan.bl_no || plan.shipment_no || plan.id);
  if (docType === "pl_sc_iv") return `PL_SC_IV_${label}.pdf`;
  if (docType === "freight_bill") return `海运费单_${label}.pdf`;
  return `港杂费账单_${label}.pdf`;
}

async function listPlans(client) {
  const vals = [];
  let onlySql = "";
  if (args.only) {
    vals.push(String(args.only));
    onlySql = `AND (
      sp.id::text = $1 OR sp._id = $1 OR sp.bl_no = $1 OR sp.shipment_no = $1
      OR EXISTS (SELECT 1 FROM orders o WHERE o.shipping_plan_id = sp.id AND o.order_no = $1)
    )`;
  }
  vals.push(LIMIT);
  const limitIx = vals.length;
  const r = await client.query(
    // 🔒 触发条件（Damon 2026-09-20 改）：有提单号 + 有 BL 真值毛重 → 就生成。
    //    ⛔ 不再死等 customs_entries.status='released' —— 那个信号上游断了：
    //    实测 122 票有提单的只有 9 票有放行记录，113 票客户资料永远不生成。
    //    改成锚 BL 真值，既解开死结，又天然守住「客户资料必须跟 BL 一致」那条铁律
    //    （没 BL 真值 = 没核过 BL = 本来就不该出对外单据）。
    //    放行信息仍带上：LEFT JOIN，有就记，没有不挡路。
    `SELECT DISTINCT ON (sp.id)
            sp.*, sp.raw->'collab_uploads' AS collab_uploads,
            ce.entry_id AS customs_entry_id, ce.released_at AS customs_released_at
       FROM shipping_plans sp
       LEFT JOIN customs_entries ce
              ON ce.shipping_plan_id = sp.id AND ce.status = 'released'
      WHERE COALESCE(sp.bl_no,'') <> ''
        AND COALESCE(sp.actual_gross_weight_kg, 0) > 0
        AND sp.deleted_at IS NULL
        ${onlySql}
      ORDER BY sp.id, ce.released_at DESC NULLS LAST, ce.id DESC
      LIMIT $${limitIx}`,
    vals
  );
  return r.rows;
}

async function orderRows(client, planId) {
  const r = await client.query(
    `SELECT id, order_no, contract_no, company_code, customer
       FROM orders
      WHERE shipping_plan_id = $1
        AND COALESCE(order_no, '') <> ''
      ORDER BY order_no`,
    [planId]
  );
  return r.rows;
}

async function containerRows(client, plan) {
  const r = await client.query(
    `SELECT container_no, seal_no
       FROM container_bookings
      WHERE shipping_plan_id = $1
         OR (contract_no IS NOT NULL AND contract_no = ANY($2::text[]))
      ORDER BY container_no, id`,
    [plan.id, Array.isArray(plan.contract_nos) ? plan.contract_nos : []]
  );
  return r.rows.map((x) => ({ container_no: normString(x.container_no), seal_no: normString(x.seal_no) }))
    .filter((x) => x.container_no || x.seal_no);
}

async function plSource(client, plan) {
  const orders = await orderRows(client, plan.id);
  const orderIds = orders.map((o) => o.id);
  const items = orderIds.length ? (await client.query(
    `SELECT o.order_no,
            COALESCE(oli.barcode, p.barcode, p.factory_code, oli.sku, '') AS barcode,
            COALESCE(oli.bl_description, oli.declaration_name, oli.product_name, p.declaration_name, oli.sku, '') AS description,
            COALESCE(oli.hs_code, p.hs_code, '') AS hs,
            oli.qty_ctn, oli.gw_ctn, oli.id
       FROM order_line_items oli
       JOIN orders o ON o.id = oli.order_id
       LEFT JOIN LATERAL (
         SELECT barcode, factory_code, declaration_name, hs_code
           FROM products
          WHERE (id = oli.product_id) OR (oli.product_id IS NULL AND sku = oli.sku)
          LIMIT 1
       ) p ON true
      WHERE oli.order_id = ANY($1::int[])
      ORDER BY o.order_no, oli.sort_order NULLS LAST, oli.id`,
    [orderIds]
  )).rows : [];
  const containers = await containerRows(client, plan);
  return {
    order_nos: orders.map((o) => o.order_no),
    items: items.map((x) => ({
      barcode: normString(x.barcode),
      description: normString(x.description),
      hs: normString(x.hs),
      ctns: normNumber(x.qty_ctn),
      gw: normNumber(Number(x.gw_ctn || 0) * Number(x.qty_ctn || 0)),
    })),
    consignee_company_code: normString(orders[0]?.company_code || plan.customer_company_id || plan.company_code),
    contract_no: normString(plan.contract_no || orders.map((o) => o.contract_no).filter(Boolean).join(",")),
    bl_no: normString(plan.bl_no),
    container_no: containers.map((x) => x.container_no).filter(Boolean).join(","),
    seal_no: containers.map((x) => x.seal_no).filter(Boolean).join(","),
  };
}

async function freightSource(client, plan) {
  const containers = await freightContainerRows(client, plan);
  const orders = await freightOrderRows(client, plan);
  return {
    freight_sale_usd: normNumber(plan.freight_sale_usd),
    currency: normString(plan.freight_sale_currency || "USD") || "USD",
    containers,
    orders,
  };
}

async function freightContainerRows(client, plan) {
  const r = await client.query(
    `SELECT container_no, seal_no, cargo_weight_kg
       FROM container_bookings
      WHERE shipping_plan_id = $1
      ORDER BY container_no NULLS LAST, seal_no NULLS LAST, id`,
    [plan.id]
  );
  return r.rows.map((x) => ({
    container_no: normString(x.container_no),
    seal_no: normString(x.seal_no),
    cargo_weight_kg: normNumber(x.cargo_weight_kg),
  }));
}

async function freightOrderRows(client, plan) {
  const r = await client.query(
    `SELECT COALESCE(total_cartons, total_qty) AS cartons, gross_weight, total_cbm
       FROM orders
      WHERE shipping_plan_id = $1
      ORDER BY order_no NULLS LAST, id`,
    [plan.id]
  );
  return r.rows.map((x) => ({
    cartons: normNumber(x.cartons),
    gross_weight: normNumber(x.gross_weight),
    total_cbm: normNumber(x.total_cbm),
  }));
}

async function portchargeRows(client, plan) {
  const r = await client.query(
    `SELECT cost_category, amount, sale_amount, container_no, currency, id
       FROM freight_supplier_bills
      WHERE bl_no = $1
        AND cost_category IN ('港杂费', '拖车费', 'THC')
        AND COALESCE(sale_amount, 0) > 0
      ORDER BY cost_category, container_no NULLS LAST, id`,
    [plan.bl_no]
  );
  return r.rows;
}

async function portchargeSource(client, plan) {
  const rows = await portchargeRows(client, plan);
  return rows.map((x) => ({
    cost_category: normString(x.cost_category),
    amount: normNumber(x.amount),
    sale_amount: normNumber(x.sale_amount),
    container_no: normString(x.container_no),
    currency: normString(x.currency || "CNY") || "CNY",
  }));
}

async function docGateAndSource(client, plan, docType) {
  if (docType === "pl_sc_iv") {
    if (!normString(plan.bl_no)) return { gate: "SKIP:no-bl", source: null };
    const source = await plSource(client, plan);
    if (!source.order_nos.length) return { gate: "SKIP:no-orders", source };
    return { gate: "GEN", source };
  }
  if (docType === "freight_bill") {
    const source = await freightSource(client, plan);
    if (!(Number(plan.freight_sale_usd) > 0)) return { gate: "SKIP:no-freight-sale", source };
    return { gate: "GEN", source };
  }
  const source = await portchargeSource(client, plan);
  if (!source.length) return { gate: "SKIP:no-portcharge-sale", source };
  return { gate: "GEN", source };
}

async function packUrl(client, plan, jwt) {
  const orders = await orderRows(client, plan.id);
  const ids = orders.map((o) => o.order_no);
  const id = ids[0] || plan.primary_contract_no || plan.contract_no || plan.bl_no || plan._id || plan.id;
  return `http://127.0.0.1:9000/api/db/documents?type=pack&id=${encodeURIComponent(id)}&ids=${encodeURIComponent(ids.join(",") || id)}&style=v2&format=pdf&token=${encodeURIComponent(jwt)}`;
}

async function docUrl(client, plan, docType) {
  const jwt = generateToken({ uid: 90, username: "svc-agent", role: "admin", tv: 1 });
  if (docType === "pl_sc_iv") return packUrl(client, plan, jwt);
  const type = docType === "freight_bill" ? "fob_invoice" : "fob_portcharge";
  return `http://127.0.0.1:9000/api/db/shipping-plan-pdf?type=${type}&id=${encodeURIComponent(plan.id)}&format=pdf&token=${encodeURIComponent(jwt)}`;
}

async function renderPdf(client, plan, docType) {
  const url = await docUrl(client, plan, docType);
  const safeUrl = url.replace(/token=[^&]+/, "token=<jwt>");
  const retryDelaysMs = [500, 1500, 3000];
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const r = await fetch(url, { signal: controller.signal });
      const buf = Buffer.from(await r.arrayBuffer());
      if (!r.ok) throw new Error(`HTTP ${r.status} from ${safeUrl}`);
      if (buf.length < 200 || buf.subarray(0, 4).toString() !== "%PDF") {
        throw new Error(`${docType} renderer did not return a PDF`);
      }
      return buf;
    } catch (e) {
      if (attempt >= retryDelaysMs.length) throw e;
      const delay = retryDelaysMs[attempt];
      console.error(`renderPdf retry ${attempt + 1}/${retryDelaysMs.length} in ${delay}ms: ${e.message} ${safeUrl}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function upsertUpload(client, plan, rec) {
  const q = `
    UPDATE shipping_plans
       SET raw = jsonb_set(
         COALESCE(raw, '{}'::jsonb),
         '{collab_uploads}',
         (
           SELECT COALESCE(jsonb_agg(x), '[]'::jsonb)
             FROM jsonb_array_elements(COALESCE(raw->'collab_uploads', '[]'::jsonb)) x
            WHERE NOT (x->>'doc_type' = $2 AND x->>'source' = 'materialized')
         ) || $3::jsonb,
         true
       ),
       updated_at = NOW()
     WHERE id = $1`;
  await client.query(q, [plan.id, rec.doc_type, JSON.stringify([rec])]);
}

async function materialize(client, plan, docType, hash) {
  const buf = await renderPdf(client, plan, docType);
  const stored = storedName(plan, docType);
  const dir = path.join(UPLOAD_ROOT, String(plan.id));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, stored), buf);
  const now = new Date().toISOString();
  await upsertUpload(client, plan, {
    role: "admin",
    doc_type: docType,
    filename: displayName(plan, docType),
    stored,
    mime: "application/pdf",
    size: buf.length,
    uploaded_at: now,
    source: "materialized",
    source_hash: hash,
    materialized_at: now,
  });
  return { stored, size: buf.length };
}

function planLabel(plan) {
  return plan.shipment_no || plan.bl_no || plan._id || plan.id;
}

async function handlePlan(client, plan) {
  for (const docType of MATERIAL_DOCS) {
    const { gate, source } = await docGateAndSource(client, plan, docType);
    if (gate !== "GEN") {
      printRow([plan.id, planLabel(plan), docType, gate, "", "SKIP"]);
      continue;
    }
    const nextHash = sourceHash(source);
    const prev = latestMaterialized(plan, docType);
    const oldHash = prev?.source_hash || "";
    const action = oldHash === nextHash ? "SKIP:unchanged" : "GEN";
    if (!args.commit || action !== "GEN") {
      printRow([plan.id, planLabel(plan), docType, gate, `${oldHash || "-"} -> ${nextHash}`, args.commit ? action : `DRY:${action}`]);
      continue;
    }
    try {
      const out = await materialize(client, plan, docType, nextHash);
      printRow([plan.id, planLabel(plan), docType, gate, `${oldHash || "-"} -> ${nextHash}`, `WROTE ${out.stored} ${out.size}`]);
    } catch (e) {
      printRow([plan.id, planLabel(plan), docType, gate, `${oldHash || "-"} -> ${nextHash}`, `ERROR:${e.message}`]);
    }
  }
}

printRow(["plan_id", "plan", "doc_type", "gate", "hash_old -> hash_new", "action"]);
const client = await pool.connect();
try {
  const plans = await listPlans(client);
  if (!plans.length && args.only) {
    printRow([args.only, "", "", "SKIP:not-released", "", "SKIP"]);
  } else if (!plans.length) {
    console.log("SKIP no released customs_entries plans");
  }
  for (const plan of plans) await handlePlan(client, plan);
} finally {
  client.release();
  await pool.end();
}
