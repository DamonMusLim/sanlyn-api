// api/db/insurance-adopt.js
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const toPositiveNumber = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "method_not_allowed" });
  }

  if (!requireAuth(req, res)) return;
  if (!["admin", "finance"].includes(req.user?.role)) {
    return res.status(403).json({ success: false, error: "forbidden" });
  }
  const user = req.user;

  const {
    shipping_plan_id,
    cargo_value,
    insurance_rate,
    coverage_ratio = 1.1,
    currency = "USD",
    insurer_name = null,
    create_bill = false,
    force = false,
  } = req.body || {};

  const planId = Number.parseInt(shipping_plan_id, 10);
  const cargoValue = toPositiveNumber(cargo_value);
  const rate = toPositiveNumber(insurance_rate);
  const coverageRatio = toPositiveNumber(coverage_ratio);

  if (!Number.isInteger(planId) || planId <= 0) {
    return res.status(422).json({ success: false, error: "invalid_shipping_plan_id" });
  }

  if (!cargoValue || !rate || !coverageRatio) {
    return res.status(422).json({
      success: false,
      error: "invalid_insurance_formula_input",
      message: "cargo_value、insurance_rate、coverage_ratio 必须大于 0",
    });
  }

  const premium = round2(cargoValue * coverageRatio * rate);
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // 锁定计划，避免并发采用时重复写保险费或账单。
    const planResult = await client.query(
      `
        SELECT id, bl_no, container_no, insurance_cn
        FROM shipping_plans
        WHERE id = $1
        FOR UPDATE
      `,
      [planId],
    );

    if (planResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, error: "shipping_plan_not_found" });
    }

    const plan = planResult.rows[0];
    const adoptedBy = user.id || user.user_id || user.email || user.username || "system";
    const snapshot = {
      cargo_value: cargoValue,
      cargo_value_source: "manual",
      coverage_ratio: coverageRatio,
      insurance_rate: rate,
      currency,
      premium,
      formula: "cargo_value*coverage_ratio*rate",
      adopted_by: adoptedBy,
      adopted_at: new Date().toISOString(),
    };

    await client.query(
      `
        UPDATE shipping_plans
        SET
          insurance_required = true,
          insurance_rate = $2,
          insurance_premium = $3,
          insurance_cost = $3,
          insurance_cn = COALESCE($4, insurance_cn),
          raw = COALESCE(raw, '{}'::jsonb)
            || jsonb_build_object('insurance_snapshot', $5::jsonb),
          updated_at = now()
        WHERE id = $1
      `,
      [planId, rate, premium, insurer_name, JSON.stringify(snapshot)],
    );

    if (create_bill) {
      // 保险账单按计划的提单号/箱号和 raw.kind 防重复；force=true 时先作废旧记录。
      const dupWhere = `
        cost_category = '保险费'
        AND COALESCE(bl_no, '') = COALESCE($1, '')
        AND COALESCE(container_no, '') = COALESCE($2, '')
        AND raw->>'kind' = 'insurance_adopt'
        AND COALESCE(rebill_status, '') <> 'voided'
      `;

      const dupParams = [plan.bl_no, plan.container_no];

      if (force) {
        await client.query(
          `
            UPDATE freight_supplier_bills
            SET
              rebill_status = 'voided',
              raw = COALESCE(raw, '{}'::jsonb)
                || jsonb_build_object(
                  'voided_by', $3,
                  'voided_at', now(),
                  'void_reason', 'insurance_adopt_force'
                )
            WHERE ${dupWhere}
          `,
          [...dupParams, adoptedBy],
        );
      } else {
        const dupResult = await client.query(
          `SELECT id FROM freight_supplier_bills WHERE ${dupWhere} LIMIT 1`,
          dupParams,
        );

        if (dupResult.rowCount > 0) {
          await client.query("ROLLBACK");
          return res.status(409).json({
            success: false,
            error: "insurance_bill_exists",
            message: "保险费账单已存在；如需重建请传 force=true",
          });
        }
      }

      await client.query(
        `
          INSERT INTO freight_supplier_bills (
            cost_category,
            currency,
            amount,
            qty,
            unit_price,
            charge_basis,
            supplier,
            payer_company_code,
            bl_no,
            container_no,
            rebill_status,
            raw
          )
          VALUES (
            '保险费',
            $1,
            $2,
            1,
            $2,
            'per_bl',
            $3,
            NULL,
            $4,
            $5,
            'to_rebill',
            $6::jsonb
          )
        `,
        [
          currency,
          premium,
          insurer_name ? `${insurer_name}保险` : "保险",
          plan.bl_no,
          plan.container_no,
          JSON.stringify({ kind: "insurance_adopt", shipping_plan_id: planId }),
        ],
      );
    }

    await client.query("COMMIT");

    return res.json({
      success: true,
      premium,
      cargo_value: cargoValue,
      coverage_ratio: coverageRatio,
      insurance_rate: rate,
      currency,
    });
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return res.status(500).json({
      success: false,
      error: "insurance_adopt_failed",
      message: err.message,
    });
  } finally {
    client.release();
  }
}
