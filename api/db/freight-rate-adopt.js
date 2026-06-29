// api/db/freight-rate-adopt.js
// POST /api/db/freight-rate-adopt
// 将 freight_rates 运价采用到 shipping_plans，并固化整票价格快照。

import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { emitFreightReceivable } from "./_freight-receivable-emit.js";

const ALLOWED_ROLES = new Set(["admin", "finance"]);

function bad(res, status, error, message) {
  return res.status(status).json({ success: false, error, message });
}

function parseId(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toNum(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

function dateKey(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

async function rollbackReturn(client, res, status, error, message) {
  try {
    await client.query("ROLLBACK");
  } catch (_) {}
  return bad(res, status, error, message);
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "method_not_allowed" });
  }

  if (!requireAuth(req, res)) return;
  if (!ALLOWED_ROLES.has(req.user?.role)) {
    return bad(res, 403, "forbidden", "admin/finance only");
  }

  const body = req.body || {};
  const freightRateId = parseId(body.freight_rate_id);
  const shippingPlanId = parseId(body.shipping_plan_id);
  const force = body.force === true;

  if (!freightRateId || !shippingPlanId) {
    return bad(res, 400, "missing_required", "freight_rate_id and shipping_plan_id required");
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const todayResult = await client.query("SELECT CURRENT_DATE AS today");
    const today = dateKey(todayResult.rows[0]?.today);

    const rateResult = await client.query(
      `
        SELECT
          id, pol, pod, carrier, forwarder, route_code,
          gp20, hq40, customer_gp20, customer_hq40,
          currency, status, valid_from, valid_to
        FROM freight_rates
        WHERE id = $1
        FOR SHARE
      `,
      [freightRateId]
    );
    if (!rateResult.rows.length) {
      return rollbackReturn(client, res, 404, "rate_not_found", "freight rate not found");
    }
    const rate = rateResult.rows[0];

    const planResult = await client.query(
      `
        SELECT
          id, container_type, container_qty, freight_rate_id,
          freight_cost, freight_sale_usd, quote_ref,
          order_nos, contract_nos, raw, forwarder_cn, shipping_line,
          bl_no, customer_company_id, forwarder_company_id
        FROM shipping_plans
        WHERE id = $1
        FOR UPDATE
      `,
      [shippingPlanId]
    );
    if (!planResult.rows.length) {
      return rollbackReturn(client, res, 404, "plan_not_found", "shipping plan not found");
    }
    const plan = planResult.rows[0];

    if (rate.status !== "active") {
      return rollbackReturn(client, res, 422, "rate_not_active", "freight rate is not active");
    }

    // 有效期空值放行；按数据库 CURRENT_DATE 判断，避免应用服务器时区漂移。
    const validFrom = dateKey(rate.valid_from);
    const validTo = dateKey(rate.valid_to);
    if ((validFrom && validFrom > today) || (validTo && validTo < today)) {
      return rollbackReturn(client, res, 422, "rate_expired", "freight rate is outside valid date range");
    }

    if (rate.currency !== "USD") {
      return rollbackReturn(client, res, 422, "currency_not_usd", "only USD freight rates can be adopted");
    }

    if (!plan.container_type || !String(plan.container_type).trim()) {
      return rollbackReturn(client, res, 422, "plan_missing_container_type", "shipping plan missing container_type");
    }

    const qty = Number(plan.container_qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      return rollbackReturn(client, res, 422, "invalid_container_qty", "shipping plan container_qty must be greater than 0");
    }

    // 柜型从 plan 判断：含 20 走 gp20/customer_gp20，否则走 hq40/customer_hq40。
    const containerType = String(plan.container_type).trim();
    const is20 = containerType.includes("20");
    const unitCost = toNum(is20 ? rate.gp20 : rate.hq40);
    const unitSale = toNum(is20 ? rate.customer_gp20 : rate.customer_hq40);

    if (unitCost === null) {
      return rollbackReturn(client, res, 422, "missing_unit_cost", "missing cost price for this container type");
    }
    if (unitSale === null) {
      return rollbackReturn(client, res, 422, "missing_unit_sale", "missing customer price for this container type");
    }

    if (plan.freight_rate_id && Number(plan.freight_rate_id) !== rate.id && !force) {
      return rollbackReturn(client, res, 409, "plan_already_has_freight_rate", "use force=true to replace existing adopted freight rate");
    }

    // 铁律：成本/售价均落整票总额，单价只进快照；计费口径固定 per_container。
    const totalCost = round2(unitCost * qty);
    const totalSale = round2(unitSale * qty);
    const stamp = new Date().toISOString().replace(/\D/g, "");
    const quoteRef = `FR-${rate.id}-SP-${plan.id}-${stamp}`;

    const snapshot = {
      source: "freight_rates",
      quote_ref: quoteRef,
      freight_rate_id: rate.id,
      adopted_by: req.user?.username || null,
      adopted_at: new Date().toISOString(),
      pol: rate.pol,
      pod: rate.pod,
      carrier: rate.carrier,
      forwarder: rate.forwarder,
      route_code: rate.route_code,
      container_type: containerType,
      container_qty: qty,
      charge_basis: "per_container",
      currency: "USD",
      unit_cost: unitCost,
      unit_sale: unitSale,
      total_cost: totalCost,
      total_sale: totalSale,
      rate_valid_from: validFrom,
      rate_valid_to: validTo,
      raw_rate: rate,
    };

    const updatedPlan = await client.query(
      `
        UPDATE shipping_plans
        SET
          freight_rate_id = $1,
          quote_ref = $2,
          freight_cost = $3,
          freight_sale_usd = $4,
          forwarder_cn = COALESCE($5, forwarder_cn),
          shipping_line = COALESCE($6, shipping_line),
          raw = COALESCE(raw, '{}'::jsonb) || $7::jsonb,
          updated_at = NOW()
        WHERE id = $8
        RETURNING
          id, freight_rate_id, quote_ref, freight_cost, freight_sale_usd,
          container_type, container_qty, forwarder_cn, shipping_line,
          order_nos, contract_nos, raw, updated_at
      `,
      [
        rate.id,
        quoteRef,
        totalCost,
        totalSale,
        rate.forwarder,
        rate.carrier,
        JSON.stringify({ freight_rate_snapshot: snapshot }),
        plan.id,
      ]
    );

    const emittedBill = await emitFreightReceivable(client, {
      freightRateId: rate.id,
      shippingPlanId: plan.id,
      totalCost,
      unitCost,
      totalSale,
      qty,
    });

    // 回链订单是尽力操作：0 条匹配也成功，但 SQL/字段异常不影响采用运价主事务。
    let linkedOrders = [];
    try {
      const linked = await client.query(
        `
          UPDATE orders
          SET freight_rate_id = $1, updated_at = NOW()
          WHERE shipping_plan_id = $2
          RETURNING id, order_no, contract_no
        `,
        [rate.id, plan.id]
      );
      linkedOrders = linked.rows;
    } catch (e) {
      linkedOrders = [];
    }

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      quote_ref: quoteRef,
      shipping_plan: updatedPlan.rows[0],
      price: {
        container_type: containerType,
        qty,
        unit_cost: unitCost,
        unit_sale: unitSale,
        total_cost: totalCost,
        total_sale: totalSale,
        currency: "USD",
      },
      linked_orders: linkedOrders,
      freight_receivable_bill: emittedBill,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    console.error("[freight-rate-adopt]", err);
    return res.status(500).json({ success: false, error: "internal_error", message: err.message });
  } finally {
    client.release();
  }
}
