import crypto from "crypto";
import { generateToken } from "../../auth.js";

const APP_PORT = process.env.PORT || 9000;
const CUSTOMER_DOC_TYPES = new Set(["pack", "pl", "sc", "iv"]);

function clean(v, max = 500) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

function jsonObj(v) {
  if (!v) return {};
  if (typeof v === "string") {
    try { return JSON.parse(v) || {}; } catch (_e) { return {}; }
  }
  return v && typeof v === "object" ? v : {};
}

function shortOrderKey(orderNos) {
  return (orderNos || []).map(x => clean(x, 80)).filter(Boolean).join(",");
}

function docPrefix(type) {
  return type === "pack" ? "PACK" : String(type || "doc").toUpperCase();
}

function ymd() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, "");
}

function sha256(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex");
}

function htmlTitle(type) {
  if (type === "pl") return "Packing List";
  if (type === "sc") return "Sales Contract";
  if (type === "iv") return "Invoice";
  return "Packing List / Sales Contract / Invoice";
}

async function loadPlanOrders(pool, planId) {
  const p = await pool.query(
    `SELECT id, bl_no, shipment_no FROM shipping_plans WHERE id=$1 LIMIT 1`,
    [planId]
  );
  if (!p.rows.length) return null;
  const o = await pool.query(
    `SELECT id, order_no, contract_no, customer_po, total_amount, currency
       FROM orders
      WHERE shipping_plan_id=$1 AND COALESCE(order_no, contract_no, customer_po) IS NOT NULL
      ORDER BY order_no NULLS LAST, contract_no NULLS LAST, id`,
    [planId]
  );
  const orders = o.rows || [];
  const orderNos = orders.map(r => r.order_no || r.contract_no || r.customer_po).filter(Boolean);
  return { plan: p.rows[0], orders, orderNos, orderKey: shortOrderKey(orderNos) };
}

async function renderCustomerDoc(planId, orderNos, type) {
  const docId = orderNos[0];
  const ids = orderNos.join(",");
  const jwt = generateToken({ uid: 90, username: "svc-agent", role: "admin", tv: 1 });
  const url = `http://127.0.0.1:${APP_PORT}/api/db/documents?type=${encodeURIComponent(type)}`
    + `&id=${encodeURIComponent(docId)}&ids=${encodeURIComponent(ids)}`
    + `&style=v2&audience=customer&token=${encodeURIComponent(jwt)}`;
  const up = await fetch(url);
  const body = Buffer.from(await up.arrayBuffer());
  if (!up.ok) throw new Error(`render ${type} plan ${planId} http ${up.status}: ${body.toString("utf8").slice(0, 160)}`);
  return {
    html: body.toString("utf8"),
    contentType: up.headers.get("content-type") || "text/html; charset=utf-8",
    sourceUrl: url.replace(/([?&]token=)[^&]+/, "$1***"),
  };
}

async function previousSnapshot(pool, type, orderKey) {
  const r = await pool.query(
    `SELECT id, snapshot
       FROM doc_issue_log
      WHERE doc_type=$1 AND order_no=$2
      ORDER BY id DESC LIMIT 1`,
    [type, orderKey]
  );
  return r.rows[0] || null;
}

async function insertSnapshot(pool, ctx, type, rendered, generatedBy, trigger) {
  const { plan, orders, orderNos, orderKey } = ctx;
  const htmlHash = sha256(rendered.html);
  const prev = await previousSnapshot(pool, type, orderKey);
  const prevSnap = jsonObj(prev && prev.snapshot);
  if (prevSnap.fingerprint === htmlHash || sha256(prevSnap.html || "") === htmlHash) {
    return { type, skipped: true, reason: "unchanged", issue_log_id: prev.id };
  }

  const n = await pool.query(
    `SELECT count(*)::int AS c FROM doc_issue_log WHERE doc_type=$1 AND order_no=$2`,
    [type, orderKey]
  );
  const seq = Number(n.rows[0]?.c || 0) + 1;
  const seed = (plan.bl_no || plan.shipment_no || orderNos[0] || String(plan.id)).replace(/[^A-Za-z0-9-]/g, "").slice(0, 40) || `PLAN${plan.id}`;
  const docNo = `${docPrefix(type)}-${seed}-${ymd()}-${seq}`;
  const totalUsd = orders.reduce((sum, r) => sum + (String(r.currency || "").toUpperCase() === "USD" ? Number(r.total_amount || 0) : 0), 0);
  const totalCny = orders.reduce((sum, r) => sum + (String(r.currency || "").toUpperCase() === "CNY" ? Number(r.total_amount || 0) : 0), 0);
  const snap = {
    frozen: true,
    format: "html",
    doc_type: type,
    title: htmlTitle(type),
    plan_id: plan.id,
    bl_no: plan.bl_no || null,
    shipment_no: plan.shipment_no || null,
    order_no: orderKey,
    order_nos: orderNos,
    content_type: rendered.contentType,
    html: rendered.html,
    fingerprint: htmlHash,
    rendered_from: rendered.sourceUrl,
    trigger: trigger || null,
  };
  const ins = await pool.query(
    `INSERT INTO doc_issue_log
       (doc_no, bl_no, order_no, doc_type, total_usd, total_cny, generated_at, generated_by, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,NOW(),$7,$8::jsonb)
     RETURNING id`,
    [docNo, plan.bl_no || null, orderKey, type, totalUsd, totalCny, generatedBy || "system", JSON.stringify(snap)]
  );
  return { type, inserted: true, issue_log_id: ins.rows[0].id, doc_no: docNo };
}

export async function freezePlanCustomerDocs(pool, planId, opts = {}) {
  const ctx = await loadPlanOrders(pool, planId);
  if (!ctx || !ctx.orderNos.length) throw new Error(`plan ${planId} has no orders`);
  const types = (Array.isArray(opts.types) && opts.types.length ? opts.types : ["pack", "pl", "sc", "iv"])
    .filter(t => CUSTOMER_DOC_TYPES.has(t));
  const out = [];
  for (const type of types) {
    const rendered = await renderCustomerDoc(planId, ctx.orderNos, type);
    out.push(await insertSnapshot(pool, ctx, type, rendered, opts.generatedBy, opts.trigger));
  }
  return { ok: true, plan_id: planId, order_nos: ctx.orderNos, docs: out };
}

export async function loadFrozenCustomerDoc(pool, planId, type) {
  if (!CUSTOMER_DOC_TYPES.has(type)) return null;
  const ctx = await loadPlanOrders(pool, planId);
  if (!ctx || !ctx.orderNos.length) return null;
  const r = await pool.query(
    `SELECT id, doc_no, generated_at, snapshot
       FROM doc_issue_log
      WHERE doc_type=$1 AND order_no=$2
      ORDER BY id DESC LIMIT 1`,
    [type, ctx.orderKey]
  );
  if (!r.rows.length) return null;
  return { ...r.rows[0], snapshot: jsonObj(r.rows[0].snapshot) };
}

export async function sendFrozenCustomerDoc(pool, planId, type, res) {
  const rec = await loadFrozenCustomerDoc(pool, planId, type);
  const snap = rec && rec.snapshot;
  if (!snap || !snap.html) {
    return res.status(404).send("<!doctype html><meta charset=\"utf-8\"><h1>待正式发出</h1><p>该单据尚未冻结归档，客户端暂不可下载。</p>");
  }
  res.setHeader("Content-Type", snap.content_type || "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Doc-Frozen", "1");
  res.setHeader("X-Doc-Issue-Log-Id", String(rec.id));
  const name = `${snap.doc_type || type}-${snap.order_no || planId}.html`.replace(/[\\/\r\n"]/g, "_");
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(name)}`);
  return res.status(200).send(snap.html);
}
