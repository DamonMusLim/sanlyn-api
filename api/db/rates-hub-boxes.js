export async function loadContainerTypeOptions(pool) {
  const r = await pool.query(`
SELECT code, name_cn, size_ft, family_cn, is_reefer, is_common
FROM container_types
WHERE is_active
ORDER BY is_common DESC, size_ft NULLS LAST, code`);
  return r.rows;
}

export async function attachFreightRateBoxes(pool, rows) {
  if (!rows.length) return rows;
  const ids = rows.map((row) => row.id).filter((id) => id !== null && id !== undefined);
  if (!ids.length) return rows.map((row) => ({ ...row, boxes: [] }));
  const r = await pool.query(
    `SELECT rate_id, id, container_type, cost, customer_price, remarks
       FROM freight_rate_boxes
      WHERE rate_id = ANY($1::bigint[])
      ORDER BY rate_id, container_type`,
    [ids]
  );
  const byRateId = new Map();
  for (const row of r.rows) {
    const rateId = String(row.rate_id);
    if (!byRateId.has(rateId)) byRateId.set(rateId, []);
    byRateId.get(rateId).push({
      id: row.id,
      container_type: row.container_type,
      cost: row.cost,
      customer_price: row.customer_price,
      remarks: row.remarks,
    });
  }
  return rows.map((row) => ({ ...row, boxes: byRateId.get(String(row.id)) || [] }));
}
