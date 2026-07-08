import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const POLICYHOLDER_NAME = "上海洋宝宝国际物流有限公司";
const POLICYHOLDER_TAX_ID = "91310106MAE9L4AQ28";
const INSURERS = ["平安", "太保", "人保", "史带"];
const DEFAULT_RATE = 0.0003;
const DEFAULT_EXCHANGE_RATE = 6.81; // TODO: 接实时汇率
const MIN_PREMIUM_RMB = 35;

function pathname(req) {
  if (req.path) return req.path;
  return new URL(req.url || "/", "http://localhost").pathname;
}

function routeParam(req, key, re) {
  if (req.params && req.params[key] != null) return String(req.params[key]);
  const m = pathname(req).match(re);
  return m ? m[1] : null;
}

function splitValues(v) {
  if (Array.isArray(v)) return v.map((x) => String(x || "").trim()).filter(Boolean);
  if (v == null) return [];
  return String(v)
    .replace(/[{}\[\]"]/g, " ")
    .split(/[,|]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function toNumberOrNull(v) {
  if (v == null || (typeof v === "string" && v.trim() === "")) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function buildPremiumEstimates(insuredAmount, exchangeRate) {
  if (insuredAmount == null) {
    return Object.fromEntries(INSURERS.map((name) => [name, null]));
  }
  const premium = Math.max(round2(Number(insuredAmount) * DEFAULT_RATE * Number(exchangeRate)), MIN_PREMIUM_RMB);
  return Object.fromEntries(INSURERS.map((name) => [name, premium]));
}

function goodsCategory(cargoDescription) {
  const desc = String(cargoDescription || "");
  if (/猫砂|膨润土/i.test(desc)) return "矿产品";
  return desc || null;
}

async function invoiceAmountForPlan(pool, plan) {
  const orderNos = [...new Set(splitValues(plan.order_nos))];
  const contractNos = [...new Set([...splitValues(plan.order_contract_nos), ...splitValues(plan.contract_no)])];
  if (!orderNos.length && !contractNos.length) {
    return { invoice_amount: null, linked_orders: 0 };
  }

  try {
    const r = await pool.query(
      `
        WITH matched_orders AS (
          SELECT DISTINCT id
          FROM orders
          WHERE order_no = ANY($1::text[])
             OR contract_no = ANY($2::text[])
        )
        SELECT COUNT(DISTINCT m.id)::int AS linked_orders,
               ROUND(SUM(COALESCE(oli.qty_ctn, 0) * COALESCE(oli.declare_amount_per_box, 0))::numeric, 2) AS invoice_amount
        FROM matched_orders m
        LEFT JOIN order_line_items oli ON oli.order_id = m.id
      `,
      [orderNos, contractNos],
    );
    const row = r.rows[0] || {};
    const linked = Number(row.linked_orders || 0);
    return {
      invoice_amount: linked > 0 && row.invoice_amount != null ? Number(row.invoice_amount) : null,
      linked_orders: linked,
    };
  } catch (e) {
    console.warn("[insurance prepare] invoice amount lookup failed:", e.message);
    return { invoice_amount: null, linked_orders: 0 };
  }
}

async function handlePrepare(req, res, pool) {
  const idRaw = routeParam(req, "id", /^\/api\/shipping\/([^/]+)\/insurance\/prepare\/?$/);
  const planId = Number.parseInt(idRaw, 10);
  if (!Number.isInteger(planId) || planId <= 0) {
    return res.status(400).json({ ok: false, error: "invalid_shipping_plan_id" });
  }

  const pr = await pool.query(
    `
      SELECT id, customer_en, bl_no, contract_no, vessel, voyage, pol, pod, etd,
             cargo_description, total_cartons, order_nos, order_contract_nos
      FROM shipping_plans
      WHERE id = $1
      LIMIT 1
    `,
    [planId],
  );
  if (!pr.rows.length) return res.status(404).json({ ok: false, error: "shipping_plan_not_found" });

  const body = req.body || {};
  const plan = pr.rows[0];
  const inv = await invoiceAmountForPlan(pool, plan);
  const markupPct = toNumberOrNull(body.markup) ?? 110;
  const exchangeRate = toNumberOrNull(body.exchange_rate) ?? DEFAULT_EXCHANGE_RATE;
  const invoiceAmount = inv.invoice_amount;
  const insuredAmount = invoiceAmount == null ? null : round2(invoiceAmount * markupPct / 100);
  const estimates = buildPremiumEstimates(insuredAmount, exchangeRate);
  const vesselVoyage = [plan.vessel, plan.voyage].map((x) => String(x || "").trim()).filter(Boolean).join(" ") || null;
  const packingQty = plan.total_cartons == null ? null : `${plan.total_cartons} CARTONS`;

  const ir = await pool.query(
    `
      INSERT INTO insurance_policies (
        shipping_plan_id, order_ref, status, insured_name,
        policyholder_name, policyholder_tax_id,
        bl_no, contract_no, vessel_voyage, pol, pod, etd,
        cargo_description, packing_qty, invoice_amount, currency,
        markup_pct, insured_amount, goods_category, transport_mode,
        insurer, rate, exchange_rate, premium_estimates, created_by,
        created_at, updated_at
      )
      VALUES (
        $1, $2, 'draft', $3,
        $4, $5,
        $6, $7, $8, $9, $10, $11,
        $12, $13, $14, $15,
        $16, $17, $18, $19,
        '平安', $20, $21, $22::jsonb, $23,
        now(), now()
      )
      RETURNING *
    `,
    [
      plan.id,
      Array.isArray(plan.order_nos) ? plan.order_nos.join(",") : (plan.order_nos || plan.order_contract_nos || plan.contract_no || null),
      plan.customer_en || null,
      POLICYHOLDER_NAME,
      POLICYHOLDER_TAX_ID,
      plan.bl_no || null,
      plan.contract_no || null,
      vesselVoyage,
      plan.pol || null,
      plan.pod || null,
      plan.etd || null,
      plan.cargo_description || null,
      packingQty,
      invoiceAmount,
      body.currency || "USD",
      markupPct,
      insuredAmount,
      goodsCategory(plan.cargo_description),
      "密闭式集装箱水运",
      DEFAULT_RATE,
      exchangeRate,
      JSON.stringify(estimates),
      body.user || "admin",
    ],
  );

  return res.json({ ok: true, policy: ir.rows[0], estimates });
}

async function handleMarkFilled(req, res, pool) {
  const policyId = routeParam(req, "policyId", /^\/api\/insurance\/([^/]+)\/mark-filled\/?$/);
  if (!policyId) return res.status(400).json({ ok: false, error: "policy_id_required" });

  const r = await pool.query(
    `
      UPDATE insurance_policies
      SET status = 'filled',
          filled_at = now(),
          updated_at = now()
      WHERE id = $1
      RETURNING *
    `,
    [policyId],
  );
  if (!r.rows.length) return res.status(404).json({ ok: false, error: "policy_not_found" });
  return res.json({ ok: true, policy: r.rows[0] });
}

async function handleMarkSubmitted(req, res, pool) {
  const policyId = routeParam(req, "policyId", /^\/api\/insurance\/([^/]+)\/mark-submitted\/?$/);
  if (!policyId) return res.status(400).json({ ok: false, error: "policy_id_required" });

  const body = req.body || {};
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const r = await client.query(
      `
        UPDATE insurance_policies
        SET status = 'submitted',
            policy_no = $2,
            policy_pdf_url = $3,
            premium_rmb = $4,
            insurer = COALESCE($5, insurer),
            submitted_at = now(),
            updated_at = now()
        WHERE id = $1
        RETURNING *
      `,
      [policyId, body.policy_no || null, body.policy_pdf_url || null, body.premium_rmb ?? null, body.insurer ?? null],
    );
    if (!r.rows.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "policy_not_found" });
    }

    const policy = r.rows[0];
    await client.query(
      `
        UPDATE shipping_plans
        SET insurance_policy_no = $2,
            insurance_premium = $3,
            insurance_required = true,
            updated_at = now()
        WHERE id = $1
      `,
      [policy.shipping_plan_id, policy.policy_no, policy.premium_rmb],
    );
    await client.query("COMMIT");
    return res.json({ ok: true, policy });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "method_not_allowed" });

  const pool = getPool();
  const path = pathname(req);
  try {
    if (/^\/api\/shipping\/[^/]+\/insurance\/prepare\/?$/.test(path)) {
      return await handlePrepare(req, res, pool);
    }
    if (/^\/api\/insurance\/[^/]+\/mark-filled\/?$/.test(path)) {
      return await handleMarkFilled(req, res, pool);
    }
    if (/^\/api\/insurance\/[^/]+\/mark-submitted\/?$/.test(path)) {
      return await handleMarkSubmitted(req, res, pool);
    }
    return res.status(404).json({ ok: false, error: "not_found" });
  } catch (err) {
    console.error("[insurance]", err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
