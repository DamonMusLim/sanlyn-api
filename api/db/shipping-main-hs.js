function clean(v) {
  return String(v ?? "").trim();
}

function uniqueOrderIds(orders) {
  const out = [];
  const seen = new Set();
  (orders || []).forEach(o => {
    const id = Number(o && o.id);
    if (Number.isFinite(id) && id > 0 && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  });
  return out;
}

export async function loadMainHsByNetWeight(pool, orders) {
  const orderIds = uniqueOrderIds(orders);
  if (!orderIds.length) return "";
  const r = await pool.query(
    `WITH product_one AS (
       SELECT DISTINCT ON (sku) sku, hs_code
       FROM products
       WHERE NULLIF(btrim(sku), '') IS NOT NULL
       ORDER BY sku, active DESC NULLS LAST, updated_at DESC NULLS LAST, id DESC
     ),
     hs_weight AS (
       SELECT
         NULLIF(btrim(COALESCE(oli.hs_code, p_id.hs_code, p_sku.hs_code, '')), '') AS hs_code,
         SUM(COALESCE(oli.qty_ctn, 0) * COALESCE(oli.nw_ctn, 0)) AS net_weight_kg
       FROM order_line_items oli
       LEFT JOIN products p_id ON p_id.id = oli.product_id
       LEFT JOIN product_one p_sku ON oli.product_id IS NULL AND p_sku.sku = oli.sku
       WHERE oli.order_id = ANY($1::int[])
       GROUP BY 1
     )
     SELECT hs_code
     FROM hs_weight
     WHERE hs_code IS NOT NULL
     ORDER BY net_weight_kg DESC NULLS LAST, hs_code
     LIMIT 1`,
    [orderIds]
  );
  return clean(r.rows && r.rows[0] && r.rows[0].hs_code);
}
