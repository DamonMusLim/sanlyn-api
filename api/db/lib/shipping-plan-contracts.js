function clean(v) {
  return String(v ?? "").trim();
}

function arr(v) {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  if (!v) return [];
  return String(v).split(/[,\s/，；;]+/).map(clean).filter(Boolean);
}

function uniq(xs) {
  var seen = new Set();
  return xs.filter(function (x) {
    x = clean(x);
    if (!x || seen.has(x)) return false;
    seen.add(x);
    return true;
  });
}

export function splitPlanLookupWhere(alias, param) {
  alias = alias || "sp";
  param = param || "$1";
  return `(
    ${alias}._id::text = ${param}
    OR ${alias}.shipment_no = ${param}
    OR ${alias}.contract_no = ${param}
    OR ${alias}.bl_no = ${param}
    OR ${alias}.id::text = ${param}
    OR ${alias}.order_contract_nos ILIKE '%' || ${param} || '%'
    OR ${param} = ANY(COALESCE(${alias}.contract_nos, ARRAY[]::text[]))
    OR ${param} = ANY(COALESCE(${alias}.order_nos, ARRAY[]::text[]))
    OR EXISTS (
      SELECT 1 FROM shipping_plan_contract_splits spcs
      WHERE spcs.shipping_plan_id = ${alias}.id
        AND spcs.status = 'active'
        AND spcs.contract_no = ${param}
    )
  )`;
}

export async function findPlanByRef(pool, ref) {
  var key = clean(ref);
  if (!key) return null;
  try {
    var r = await pool.query(
      `SELECT sp.* FROM shipping_plans sp
       WHERE ${splitPlanLookupWhere("sp", "$1")}
       ORDER BY sp.created_at DESC NULLS LAST, sp.id DESC
       LIMIT 1`,
      [key]
    );
    return r.rows[0] || null;
  } catch (_) {
    var r2 = await pool.query(
      `SELECT * FROM shipping_plans
       WHERE _id::text=$1 OR shipment_no=$1 OR contract_no=$1 OR bl_no=$1
          OR id::text=$1 OR order_contract_nos ILIKE '%'||$1||'%'
       LIMIT 1`,
      [key]
    );
    return r2.rows[0] || null;
  }
}

export async function findPlanForOrder(pool, order) {
  if (!order) return null;
  var keys = uniq([order.order_no, order.contract_no, order.customer_po]);
  for (var i = 0; i < keys.length; i++) {
    var p = await findPlanByRef(pool, keys[i]);
    if (p) return p;
  }
  return null;
}

export async function resolvePlanContracts(pool, plan) {
  var primary = clean(plan?.primary_contract_no) || clean(plan?.contract_no);
  var legacy = !(plan && plan.contract_split_enabled === true);
  if (legacy) {
    return {
      legacy: true,
      baseNo: clean(plan?.contract_base_no) || primary,
      primaryContractNo: primary,
      goodsCnyNo: null,
      freightUsdNo: null,
      allNos: uniq([primary].concat(arr(plan?.contract_nos))),
    };
  }

  var rows = [];
  try {
    var r = await pool.query(
      `SELECT role, currency, contract_no, is_customs_contract, is_freight_contract
         FROM shipping_plan_contract_splits
        WHERE shipping_plan_id=$1 AND status='active'`,
      [plan.id]
    );
    rows = r.rows || [];
  } catch (_) {
    rows = [];
  }

  var goods = rows.find(function (r) { return r.role === "goods_cny"; });
  var freight = rows.find(function (r) { return r.role === "freight_usd"; });
  var base = clean(plan.contract_base_no)
    || clean(primary).replace(/-(?:1|2)$/i, "")
    || clean(plan.shipment_no);
  var goodsNo = clean(goods?.contract_no) || (base ? base + "-2" : "");
  var freightNo = clean(freight?.contract_no) || (base ? base + "-1" : "");
  var primaryNo = clean(plan.primary_contract_no) || goodsNo || primary;

  return {
    legacy: false,
    baseNo: base,
    primaryContractNo: primaryNo,
    goodsCnyNo: goodsNo || null,
    freightUsdNo: freightNo || null,
    allNos: uniq([primaryNo, goodsNo, freightNo].concat(arr(plan.contract_nos))),
  };
}

export async function enableContractSplit(client, planId, baseNo) {
  var base = clean(baseNo);
  if (!base) throw new Error("contract_base_no_required");
  if (/(?:^|[-_])(?:1|2)$/i.test(base)) throw new Error("contract_base_no_must_not_include_split_suffix");

  var locked = await client.query(
    `SELECT id, primary_contract_no, contract_no, contract_split_enabled
       FROM shipping_plans WHERE id=$1 FOR UPDATE`,
    [planId]
  );
  var plan = locked.rows[0];
  if (!plan) throw new Error("shipping_plan_not_found");
  if (plan.contract_split_enabled === true) return plan;

  var goodsNo = base + "-2";
  var freightNo = base + "-1";
  var existingPrimary = clean(plan.primary_contract_no);
  if (existingPrimary && existingPrimary !== goodsNo) {
    throw new Error("primary_contract_no_conflict");
  }

  var updated = await client.query(
    `UPDATE shipping_plans
        SET contract_split_enabled = true,
            contract_split_version = 2,
            contract_base_no = $2,
            primary_contract_no = $2 || '-2',
            contract_nos = ARRAY[$2 || '-1', $2 || '-2']::text[],
            updated_at = now()
      WHERE id = $1 AND contract_split_enabled = false
      RETURNING *`,
    [planId, base]
  );

  await client.query(
    `INSERT INTO shipping_plan_contract_splits
       (shipping_plan_id, role, currency, contract_no, is_customs_contract, is_freight_contract)
     VALUES ($1, 'freight_usd', 'USD', $2 || '-1', false, true),
            ($1, 'goods_cny', 'CNY', $2 || '-2', true, false)
     ON CONFLICT (shipping_plan_id, role) DO NOTHING`,
    [planId, base]
  );

  return updated.rows[0] || plan;
}
