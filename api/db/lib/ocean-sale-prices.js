function clean(v) {
  return String(v || "").trim().replace(/\s+/g, " ");
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  var n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v) {
  var n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
}

function actorFrom(user, fallback) {
  return clean(fallback) || clean(user?.username || user?.email || user?.id) || "unknown";
}

function previewItemMap(preview) {
  var map = new Map();
  (preview?.items || []).forEach((item) => {
    if (item?.fee_item) map.set(item.fee_item, item);
  });
  return map;
}

function validSubmittedItem(raw, previewItems) {
  var feeItem = clean(raw?.fee_item);
  var saleAmount = money(raw?.sale_amount);
  if (!feeItem) return { skip: true, reason: "fee_item missing" };
  if (raw?.sale_amount === null || raw?.sale_amount === undefined || raw?.sale_amount === "") {
    return { skip: true, fee_item: feeItem, reason: "sale_amount empty" };
  }
  if (saleAmount === null || saleAmount < 0) {
    return { reject: true, fee_item: feeItem, reason: "sale_amount must be >= 0" };
  }
  var pitem = previewItems.get(feeItem);
  if (!pitem) return { reject: true, fee_item: feeItem, reason: "fee_item not in current cost preview" };
  if (pitem.guard?.verdict === "alert" && raw?.guard_ack !== true) {
    return { reject: true, fee_item: feeItem, reason: "需人工核历史异常", guard: pitem.guard };
  }
  return {
    fee_item: feeItem,
    sale_amount: saleAmount,
    sale_currency: clean(raw?.sale_currency || pitem.currency || "CNY").toUpperCase(),
    source: clean(raw?.source || "manual") || "manual",
    guard_ack: raw?.guard_ack === true,
    cost_amount: money(pitem.unit_cost),
    cost_currency: clean(pitem.currency || "CNY").toUpperCase(),
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  var pos = (sorted.length - 1) * p;
  var lo = Math.floor(pos);
  var hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

async function upsertSalePrice(client, ctx, item, actor) {
  await client.query(
    `INSERT INTO ocean_sale_prices
      (bl_no, shipping_plan_id, customer_company_code, pol, pod, container_type,
       fee_item, cost_amount, cost_currency, sale_amount, sale_currency, source,
       effective_date, created_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,CURRENT_DATE,$13,now())
     ON CONFLICT (bl_no, fee_item) DO UPDATE SET
       shipping_plan_id = EXCLUDED.shipping_plan_id,
       customer_company_code = EXCLUDED.customer_company_code,
       pol = EXCLUDED.pol,
       pod = EXCLUDED.pod,
       container_type = EXCLUDED.container_type,
       cost_amount = EXCLUDED.cost_amount,
       cost_currency = EXCLUDED.cost_currency,
       sale_amount = EXCLUDED.sale_amount,
       sale_currency = EXCLUDED.sale_currency,
       source = EXCLUDED.source,
       effective_date = EXCLUDED.effective_date,
       created_by = EXCLUDED.created_by,
       updated_at = now()`,
    [
      ctx.bl_no, ctx.shipping_plan_id, ctx.customer_company_code, ctx.pol, ctx.pod,
      ctx.container_type, item.fee_item, item.cost_amount, item.cost_currency,
      item.sale_amount, item.sale_currency, item.source, actor,
    ]
  );
}

async function writeAudit(client, ctx, item, actor) {
  await client.query(
    `INSERT INTO audit_logs (action, operator, entity_type, entity_id, detail)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    ["confirm_sale_price", actor, "ocean_sale_price", ctx.bl_no, JSON.stringify({
      bl_no: ctx.bl_no,
      fee_item: item.fee_item,
      sale_amount: item.sale_amount,
      sale_currency: item.sale_currency,
      cost_amount: item.cost_amount,
      cost_currency: item.cost_currency,
      source: item.source,
      guard_ack: item.guard_ack,
    })]
  );
}

async function refreshDna(client, ctx, item) {
  var rows = await client.query(
    `SELECT sale_amount, sale_currency, cost_amount, updated_at
       FROM ocean_sale_prices
      WHERE customer_company_code = $1
        AND pol IS NOT DISTINCT FROM $2
        AND pod IS NOT DISTINCT FROM $3
        AND container_type IS NOT DISTINCT FROM $4
        AND fee_item = $5
        AND sale_amount IS NOT NULL
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 100`,
    [ctx.customer_company_code, ctx.pol, ctx.pod, ctx.container_type, item.fee_item]
  );
  var samples = rows.rows || [];
  var values = samples.map((r) => num(r.sale_amount)).filter((v) => v !== null).sort((a, b) => a - b);
  var ratios = samples.map((r) => {
    var sale = num(r.sale_amount);
    var cost = num(r.cost_amount);
    return sale !== null && cost && cost > 0 ? sale / cost : null;
  }).filter((v) => v !== null);
  var suggested = money(values.length ? percentile(values, 0.5) : item.sale_amount);
  var markup = ratios.length ? Math.round((ratios.reduce((a, b) => a + b, 0) / ratios.length) * 10000) / 10000 : null;
  var currency = clean(samples[0]?.sale_currency || item.sale_currency || "CNY").toUpperCase();
  await client.query(
    `INSERT INTO ocean_sale_price_dna
      (customer_company_code, pol, pod, container_type, fee_item, suggested_sale,
       suggested_currency, markup_ratio, sample_count, last_sale_amount,
       last_confirmed_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now(),now())
     ON CONFLICT (customer_company_code, pol, pod, container_type, fee_item) DO UPDATE SET
       suggested_sale = EXCLUDED.suggested_sale,
       suggested_currency = EXCLUDED.suggested_currency,
       markup_ratio = EXCLUDED.markup_ratio,
       sample_count = EXCLUDED.sample_count,
       last_sale_amount = EXCLUDED.last_sale_amount,
       last_confirmed_at = now(),
       updated_at = now()`,
    [
      ctx.customer_company_code, ctx.pol, ctx.pod, ctx.container_type, item.fee_item,
      suggested, currency, markup, values.length, item.sale_amount,
    ]
  );
}

export async function confirmSalePrices(pool, body, user, preview) {
  var blNo = clean(body?.bl_no);
  if (!blNo) return { status: 400, payload: { error: "bl_no required" } };
  var ctx0 = preview?.context || {};
  var ctx = {
    bl_no: blNo,
    shipping_plan_id: clean(body?.shipping_plan_id || ctx0.shipping_plan_id || ""),
    customer_company_code: clean(ctx0.customer_company_code || body?.customer_company_code),
    pol: clean(ctx0.pol?.raw || ctx0.pol?.norm || body?.pol),
    pod: clean(ctx0.pod?.raw || ctx0.pod?.norm || body?.pod),
    container_type: clean(ctx0.containerType || body?.container_type),
  };
  if (!ctx.customer_company_code || !ctx.pol || !ctx.pod || !ctx.container_type) {
    return { status: 400, payload: { error: "sale price context incomplete", context: ctx } };
  }
  var submitted = Array.isArray(body?.items) ? body.items : [];
  var previewItems = previewItemMap(preview);
  var checked = submitted.map((x) => validSubmittedItem(x, previewItems));
  var rejected = checked.filter((x) => x.reject);
  if (rejected.length) return { status: 409, payload: { ok: false, rejected: rejected } };
  var writable = checked.filter((x) => !x.skip);
  if (!writable.length) return { status: 400, payload: { error: "no sale price items to confirm" } };

  var actor = actorFrom(user, body?.confirmed_by);
  var client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (var item of writable) {
      await upsertSalePrice(client, ctx, item, actor);
      await writeAudit(client, ctx, item, actor);
      await refreshDna(client, ctx, item);
    }
    await client.query("COMMIT");
    return { status: 200, payload: { ok: true, bl_no: blNo, confirmed: writable.map((x) => x.fee_item) } };
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function auditDeprecatedSetPar(pool, req, blNo) {
  await pool.query(
    `INSERT INTO audit_logs (action, operator, entity_type, entity_id, detail)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [
      "set_par_deprecated",
      actorFrom(req?.user),
      "freight_bill",
      blNo,
      JSON.stringify({ bl_no: blNo, note: "deprecated set_par blocked; use confirm_sale_prices" }),
    ]
  ).catch((e) => console.error("[freight-cost-audit] deprecated set_par audit failed:", e.message));
}
