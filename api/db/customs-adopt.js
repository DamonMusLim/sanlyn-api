// api/db/customs-adopt.js
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 港口中英别名(治pol中英不一致,customs_rates只这几个港,够P0)
const POL_ALIASES = {
  xiamen:["厦门"], "厦门":["xiamen"],
  qingdao:["青岛"], "青岛":["qingdao"],
  tianjin:["天津"], "天津":["tianjin"],
  ningbo:["宁波","ningbo-zhoushan"], "宁波":["ningbo"],
  shanghai:["上海"], "上海":["shanghai"],
  shenzhen:["深圳"], "深圳":["shenzhen"],
  dalian:["大连"], "大连":["dalian"],
};
function polCandidates(pol){
  const k=String(pol||"").trim().toLowerCase().replace(/\s+/g,"");
  return Array.from(new Set([k, ...(POL_ALIASES[k]||[])])).filter(Boolean);
}

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

const json = (res, status, body) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
};

const getUserName = (user) =>
  user?.email || user?.name || user?.username || user?.id || "system";

export default async function handler(req, res) {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method !== "POST") {
    return json(res, 405, { success: false, error: "method_not_allowed" });
  }

  if (!requireAuth(req, res)) return;
  if (!["admin", "finance"].includes(req.user?.role)) {
    return json(res, 403, { success: false, error: "forbidden" });
  }
  const user = req.user;

  const pool = getPool();
  const client = await pool.connect();

  try {
    const {
      shipping_plan_id,
      num_descriptions,
      force = false,
    } = req.body || {};

    const planId = Number(shipping_plan_id);
    if (!Number.isInteger(planId) || planId <= 0) {
      return json(res, 400, {
        success: false,
        error: "invalid_shipping_plan_id",
      });
    }

    if (
      num_descriptions !== undefined &&
      (!Number.isInteger(Number(num_descriptions)) || Number(num_descriptions) < 0)
    ) {
      return json(res, 400, {
        success: false,
        error: "invalid_num_descriptions",
      });
    }

    await client.query("BEGIN");

    // 锁定 shipping_plan，避免并发重复采用。
    const planResult = await client.query(
      `
        SELECT
          id,
          pol,
          bl_no,
          container_no,
          factory_company_id,
          customs_broker_id,
          raw
        FROM shipping_plans
        WHERE id = $1
        FOR UPDATE
      `,
      [planId]
    );

    if (planResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return json(res, 404, {
        success: false,
        error: "shipping_plan_not_found",
      });
    }

    const plan = planResult.rows[0];
    const pol = String(plan.pol || "").trim();

    if (!pol) {
      await client.query("ROLLBACK");
      return json(res, 422, {
        success: false,
        error: "missing_plan_pol",
      });
    }

    // POL 做空白归一后双向 ILIKE，兼容“厦门/厦门港”等写法。
    const cands = polCandidates(pol);
    const rateResult = await client.query(
      `
        SELECT cr._id, cr.vendor_cn, cr.pol, cr.base_fee, cr.extra_per_desc,
               cr.max_free_descs, cr.currency, cr.valid_from, cr.valid_to
        FROM customs_rates cr
        WHERE EXISTS (
          SELECT 1 FROM unnest($1::text[]) cand
          WHERE regexp_replace(lower(coalesce(cr.pol,'')),'\\s+','','g') ILIKE '%'||cand||'%'
             OR cand ILIKE '%'||regexp_replace(lower(coalesce(cr.pol,'')),'\\s+','','g')||'%'
        )
        ORDER BY cr.valid_from DESC NULLS LAST, cr._id
        LIMIT 2
      `,
      [cands]
    );

    if (rateResult.rowCount === 0) {
      await client.query("ROLLBACK");
      return json(res, 422, {
        success: false,
        error: "no_customs_rate",
        pol,
      });
    }

    const warning =
      rateResult.rowCount > 1 ? "multiple_customs_rates_matched_first_used" : null;
    const rate = rateResult.rows[0];

    // 有效期为空则放行；当前日期不在区间内则拒绝采用。
    const validResult = await client.query(
      `
        SELECT
          ($1::date IS NULL OR CURRENT_DATE >= $1::date) AS from_ok,
          ($2::date IS NULL OR CURRENT_DATE <= $2::date) AS to_ok
      `,
      [rate.valid_from, rate.valid_to]
    );

    if (!validResult.rows[0].from_ok || !validResult.rows[0].to_ok) {
      await client.query("ROLLBACK");
      return json(res, 422, {
        success: false,
        error: "customs_rate_expired",
        rate_id: rate._id,
        valid_from: rate.valid_from,
        valid_to: rate.valid_to,
      });
    }

    const maxFreeDescs = Number(rate.max_free_descs ?? 0);
    const descs =
      num_descriptions === undefined ? maxFreeDescs : Number(num_descriptions);
    const extra = Math.max(0, descs - maxFreeDescs);
    const baseFee = Number(rate.base_fee || 0);
    const extraPerDesc = Number(rate.extra_per_desc || 0);
    const cost = round2(baseFee + extraPerDesc * extra);
    const currency = rate.currency || "CNY";

    // 报关行必须解析到 companies.id 才写 FK，否则置空。
    const brokerResult = await client.query(
      `
        SELECT id
        FROM companies
        WHERE type = 'customs_broker'
          AND name_cn ILIKE '%' || $1 || '%'
        ORDER BY id
        LIMIT 1
      `,
      [rate.vendor_cn || ""]
    );
    const brokerCompanyId = brokerResult.rows[0]?.id ?? null;

    // 出货人付款方 code：shipping_plans.factory_company_id -> companies.code。
    const payerResult = await client.query(
      `
        SELECT code
        FROM companies
        WHERE id = $1
        LIMIT 1
      `,
      [plan.factory_company_id]
    );
    const payerCompanyCode = payerResult.rows[0]?.code ?? null;

    const duplicateResult = await client.query(
      `
        SELECT id
        FROM freight_supplier_bills
        WHERE bl_no IS NOT DISTINCT FROM $1
          AND coalesce(rebill_status, '') <> 'voided'
          AND raw->>'kind' = 'customs_adopt'
        FOR UPDATE
      `,
      [plan.bl_no]
    );

    if (duplicateResult.rowCount > 0 && !force) {
      await client.query("ROLLBACK");
      return json(res, 409, {
        success: false,
        error: "customs_bill_exists",
        existing_ids: duplicateResult.rows.map((row) => row.id),
      });
    }

    if (duplicateResult.rowCount > 0) {
      await client.query(
        `
          UPDATE freight_supplier_bills
          SET
            rebill_status = 'voided',
            updated_at = now(),
            raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object(
              'voided_by_force_customs_adopt', true,
              'voided_at', now(),
              'voided_by', $2
            )
          WHERE id = ANY($1::int[])
        `,
        [duplicateResult.rows.map((row) => row.id), getUserName(user)]
      );
    }

    const billResult = await client.query(
      `
        INSERT INTO freight_supplier_bills (
          supplier,
          supplier_company_code,
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
        )
        VALUES (
          $1,
          NULL,
          $2,
          $3,
          $4,
          '报关费',
          $5,
          $6,
          1,
          $6,
          'per_bl',
          'to_rebill',
          jsonb_build_object(
            'kind', 'customs_adopt',
            'customs_rate_id', $7::uuid,
            'descs', $8::int,
            'extra', $9::int
          ),
          now(),
          now()
        )
        RETURNING *
      `,
      [
        rate.vendor_cn,
        payerCompanyCode,
        plan.bl_no,
        plan.container_no,
        currency,
        cost,
        rate._id,
        descs,
        extra,
      ]
    );

    await client.query(
      `
        UPDATE shipping_plans
        SET
          customs_cost_total = $2,
          customs_declare_fee = $2,
          customs_broker_id = $3,
          customs_cn = $4::text,
          raw = coalesce(raw, '{}'::jsonb) || jsonb_build_object(
            'customs_snapshot',
            jsonb_build_object(
              'source', 'customs_rates',
              'rate_id', $5::uuid,
              'vendor_cn', $4::text,
              'pol', $6::text,
              'base_fee', $7::numeric,
              'extra_per_desc', $8::numeric,
              'max_free_descs', $9::int,
              'descs', $10::int,
              'extra', $11::int,
              'cost', $2::numeric,
              'adopted_by', $12::text,
              'adopted_at', now()
            )
          ),
          updated_at = now()
        WHERE id = $1
      `,
      [
        plan.id,
        cost,
        brokerCompanyId,
        rate.vendor_cn,
        rate._id,
        rate.pol,
        baseFee,
        extraPerDesc,
        maxFreeDescs,
        descs,
        extra,
        getUserName(user),
      ]
    );

    await client.query("COMMIT");

    return json(res, 200, {
      success: true,
      customs_cost: cost,
      currency,
      broker: rate.vendor_cn,
      broker_company_id: brokerCompanyId,
      descs,
      extra,
      warning,
      lines: billResult.rows,
    });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // 忽略 rollback 失败，保留原始错误。
    }

    return json(res, 500, {
      success: false,
      error: "customs_adopt_failed",
      message: err?.message || String(err),
    });
  } finally {
    client.release();
  }
}
