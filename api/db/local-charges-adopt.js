import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function toNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function dateOnly(v) {
  if (!v) return null;
  if (typeof v === "string") return v.slice(0, 10);
  return new Date(v).toISOString().slice(0, 10);
}

function hasRole(req) {
  const role = req.user?.role;
  return role === "admin" || role === "finance";
}

function sameText(a, b) {
  return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
}

function classifyChargeBasis(unit) {
  const s = String(unit || "").trim().toUpperCase();

  // 票/单/BL 是整票费用，只计 1 次。
  if (s.includes("票") || s.includes("单") || s.includes("BL")) return "per_bl";

  // 含柜型数字或“柜”的费用按柜量计费。
  if (/\d+\s*(GP|HQ|HC|RF)\b/.test(s) || s.includes("柜")) return "per_container";

  // 未知口径保守按整票，避免误乘柜量。
  return "per_bl";
}

function pickAdoptedBy(req) {
  return (
    req.user?.username ||
    req.user?.account ||
    req.user?.email ||
    req.user?.uid ||
    req.user?.id ||
    null
  );
}

async function rollbackQuietly(client) {
  try {
    await client.query("ROLLBACK");
  } catch (_) {
    // ignore rollback failures; original error is more useful
  }
}

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "Method not allowed" });
  }

  if (!requireAuth(req, res)) return;
  if (!hasRole(req)) {
    return res.status(403).json({ success: false, error: "admin or finance role required" });
  }

  const body = req.body || {};
  const localChargeId = body.local_charge_id;
  const shippingPlanId = body.shipping_plan_id;
  const force = body.force === true;

  if (!localChargeId || !shippingPlanId) {
    return res.status(400).json({
      success: false,
      error: "local_charge_id and shipping_plan_id required",
    });
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const lcResult = await client.query(
      `SELECT
         id, carrier, pol, pod, company_name, container_type, fees,
         cost_total, charge_code, valid_from, valid_until, currency
       FROM local_charges
       WHERE id = $1
       FOR SHARE`,
      [localChargeId]
    );
    const localCharge = lcResult.rows[0];
    if (!localCharge) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "local_charge_not_found" });
    }

    const planResult = await client.query(
      `SELECT
         id, carrier_code, shipping_line, pol, container_type, container_qty, factory_company_id,
         local_charges_code, raw, bl_no, container_no
       FROM shipping_plans
       WHERE id = $1
       FOR UPDATE`,
      [shippingPlanId]
    );
    const plan = planResult.rows[0];
    if (!plan) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "shipping_plan_not_found" });
    }

    const today = new Date().toISOString().slice(0, 10);
    const validFrom = dateOnly(localCharge.valid_from);
    const validUntil = dateOnly(localCharge.valid_until);

    if ((validFrom && validFrom > today) || (validUntil && validUntil < today)) {
      await client.query("ROLLBACK");
      return res.status(422).json({ success: false, error: "expired" });
    }

    if (toNumber(plan.container_qty) <= 0) {
      await client.query("ROLLBACK");
      return res.status(422).json({ success: false, error: "invalid_container_qty" });
    }

    const warnings = [];
    if (!sameText(localCharge.carrier, plan.carrier_code || plan.shipping_line)) {
      warnings.push({
        field: "carrier",
        local_charge: localCharge.carrier,
        shipping_plan: plan.carrier_code || plan.shipping_line,
      });
    }
    if (!sameText(localCharge.pol, plan.pol)) {
      warnings.push({
        field: "pol",
        local_charge: localCharge.pol,
        shipping_plan: plan.pol,
      });
    }

    // payer=出货人(工厂)：plan.factory_company_id → companies.code(FOB港杂找出货人)。
    let payerCode = null;
    if (plan.factory_company_id) {
      const f = await client.query("SELECT code FROM companies WHERE id = $1 LIMIT 1", [plan.factory_company_id]);
      payerCode = f.rows[0]?.code || null;
    }

    const fees = localCharge.fees;
    if (!Array.isArray(fees) || fees.length === 0) {
      await client.query("ROLLBACK");
      return res.status(422).json({ success: false, error: "no_fees" });
    }

    const containerQty = toNumber(plan.container_qty);
    const lines = [];

    for (const fee of fees) {
      if (!fee || fee.direction !== "应付") continue;

      const unitPrice = toNumber(fee.unitPrice);
      const originalAmount = toNumber(fee.amount);

      // amount<=0 或 unitPrice<=0 视为不可采用项，例如 qty=0 的电放费。
      if (originalAmount <= 0 || unitPrice <= 0) continue;

      const chargeBasis = classifyChargeBasis(fee.unit);
      const qty = chargeBasis === "per_container" ? containerQty : 1;
      const amount = round2(unitPrice * qty);

      if (amount <= 0) continue;

      lines.push({
        cost_category: fee.feeName || "港杂费",
        currency: fee.currency || localCharge.currency || "CNY",
        amount,
        qty,
        unit_price: unitPrice,
        charge_basis: chargeBasis,
        raw_fee: fee,
      });
    }

    if (lines.length === 0) {
      await client.query("ROLLBACK");
      return res.status(422).json({ success: false, error: "no_cost_lines" });
    }

    if (plan.bl_no) {
      const dupResult = await client.query(
        // Intentional raw-table read: adoption duplicate check must see existing source rows before writing.
        `SELECT id
         FROM freight_supplier_bills
         WHERE bl_no = $1
           AND COALESCE(rebill_status, '') <> 'voided'
           AND raw->>'kind' = 'local_charge_adopt'
         LIMIT 1`,
        [plan.bl_no]
      );

      if (dupResult.rows.length && !force) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          success: false,
          error: "duplicate_local_charge_adopt",
          message: "该提单已存在未作废的港杂费采用明细",
        });
      }

      if (dupResult.rows.length && force) {
        await client.query(
          `UPDATE freight_supplier_bills
           SET rebill_status = 'voided', updated_at = now()
           WHERE bl_no = $1
             AND COALESCE(rebill_status, '') <> 'voided'
             AND raw->>'kind' = 'local_charge_adopt'`,
          [plan.bl_no]
        );
      }
    }

    for (const line of lines) {
      await client.query(
        `INSERT INTO freight_supplier_bills (
           supplier,
           supplier_company_code,
           supplier_type,
           payer_company_code,
           bl_no,
           container_no,
           cost_category,
           currency,
           amount,
           qty,
           unit_price,
           charge_basis,
           rebill_status,
           raw,
           created_at,
           updated_at
         ) VALUES (
           $1, NULL, NULL, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           'to_rebill', $11::jsonb, now(), now()
         )`,
        [
          localCharge.company_name || localCharge.carrier,
          payerCode,
          plan.bl_no,
          plan.container_no,
          line.cost_category,
          line.currency,
          line.amount,
          line.qty,
          line.unit_price,
          line.charge_basis,
          JSON.stringify({
            kind: "local_charge_adopt",
            local_charge_id: localCharge.id,
            fee: line.raw_fee,
          }),
        ]
      );
    }

    const totalCost = round2(lines.reduce((sum, line) => sum + line.amount, 0));
    const adoptedAt = new Date().toISOString();
    const localChargesCode = localCharge.charge_code || null; // FK→local_charges.charge_code,写真实码

    const snapshot = {
      source: "local_charges",
      local_charge_id: localCharge.id,
      adopted_by: pickAdoptedBy(req),
      adopted_at: adoptedAt,
      carrier: localCharge.carrier,
      pol: localCharge.pol,
      container_type: plan.container_type,
      container_qty: containerQty,
      line_count: lines.length,
      total_cost: totalCost,
      raw_fees: fees,
    };

    // 快照写入 plan.raw，保留采用当时的明细，不依赖后续 local_charges 变更。
    await client.query(
      `UPDATE shipping_plans
       SET local_charges_code = $1,
           raw = COALESCE(raw, '{}'::jsonb) || $2::jsonb,
           updated_at = now()
       WHERE id = $3`,
      [
        localChargesCode,
        JSON.stringify({ local_charges_snapshot: snapshot }),
        plan.id,
      ]
    );

    await client.query("COMMIT");

    return res.status(200).json({
      success: true,
      local_charges_code: localChargesCode,
      plan_id: plan.id,
      lines: lines.map((line) => ({
        cost_category: line.cost_category,
        charge_basis: line.charge_basis,
        qty: line.qty,
        unit_price: line.unit_price,
        amount: line.amount,
      })),
      total_cost: totalCost,
      currency: lines[0]?.currency || localCharge.currency || "CNY",
      warnings,
    });
  } catch (err) {
    await rollbackQuietly(client);
    console.error("[local-charges-adopt] Error:", err);
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
}
