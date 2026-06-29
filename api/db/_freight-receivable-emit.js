export async function emitFreightReceivable(client, args) {
  const { freightRateId, shippingPlanId, totalCost, unitCost, totalSale, qty } = args;
  const planResult = await client.query(
    `SELECT id, bl_no, container_qty, customer_company_id, forwarder_company_id, forwarder_cn, shipping_line
       FROM shipping_plans
      WHERE id = $1
      LIMIT 1`,
    [shippingPlanId]
  );
  const plan = planResult.rows[0];
  if (!plan || !plan.bl_no || !plan.customer_company_id) return null;

  const companyResult = await client.query(
    `SELECT id, code, name_cn, name_en, province
       FROM companies
      WHERE id = ANY($1::int[])`,
    [[plan.customer_company_id, plan.forwarder_company_id].filter((v) => Number.isInteger(v))]
  );
  const companies = new Map(companyResult.rows.map((r) => [r.id, r]));
  const payer = companies.get(plan.customer_company_id);
  const supplier = companies.get(plan.forwarder_company_id);
  if (!payer) return null;

  const warn = [];
  if (!supplier) warn.push("forwarder_company_code_unresolved");
  const raw = {
    kind: "freight_rate_sale",
    freight_rate_id: freightRateId,
    shipping_plan_id: shippingPlanId,
  };
  if (warn.length) raw.warn = warn;

  const result = await client.query(
    `WITH existing AS (
       SELECT id FROM freight_supplier_bills
        WHERE bl_no = $1 AND raw->>'kind' = 'freight_rate_sale'
        LIMIT 1
     ), updated AS (
       UPDATE freight_supplier_bills b
          SET supplier = $2,
              supplier_type = 'forwarder',
              cost_category = '海运费',
              amount = $3,
              currency = 'USD',
              qty = $4,
              unit_price = $5,
              link_plan_id = $6,
              raw = COALESCE(b.raw, '{}'::jsonb) || $7::jsonb,
              updated_at = NOW(),
              supplier_company_code = $8,
              charge_basis = 'per_container',
              payer_company_code = $9,
              sale_amount = $10,
              canonical_category = '海运费',
              currency_norm = 'USD'
         FROM existing e
        WHERE b.id = e.id
        RETURNING b.*
     )
     INSERT INTO freight_supplier_bills (
       supplier, supplier_type, bl_no, cost_category, amount, currency, qty, unit_price,
       rebill_status, link_plan_id, raw, created_at, updated_at, supplier_company_code,
       charge_basis, payer_company_code, sale_amount, canonical_category, currency_norm
     )
     SELECT $2, 'forwarder', $1, '海运费', $3, 'USD', $4, $5,
            'pending', $6, $7::jsonb, NOW(), NOW(), $8,
            'per_container', $9, $10, '海运费', 'USD'
     WHERE NOT EXISTS (SELECT 1 FROM updated)
     RETURNING *`,
    [
      plan.bl_no,
      supplier?.name_cn || supplier?.name_en || plan.forwarder_cn || "待补",
      totalCost,
      qty || plan.container_qty,
      unitCost,
      shippingPlanId,
      JSON.stringify(raw),
      supplier?.code || null,
      payer.code,
      totalSale,
    ]
  );
  return result.rows[0] || null;
}
