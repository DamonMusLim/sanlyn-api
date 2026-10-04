const FIELD = 'actual_gross_weight_kg';

export function validateActualGrossWeight(body, user = {}) {
  if (!Object.prototype.hasOwnProperty.call(body, FIELD)) return { ok: true };
  if (!['admin', 'superadmin', 'logistics'].includes(user?.role)) {
    return { ok: false, status: 403, error: 'actual_gross_weight_kg requires admin/superadmin/logistics' };
  }
  const value = body[FIELD];
  if (!['number', 'string'].includes(typeof value) || !Number.isFinite(Number(value)) || Number(value) <= 0) {
    return { ok: false, status: 400, error: 'actual_gross_weight_kg must be a positive number' };
  }
  body[FIELD] = Number(value);
  return { ok: true };
}

export async function auditActualGrossWeight(pool, row, old, user = {}) {
  try {
    const actor = user.name || user.username || user.email || user.role || 'admin';
    await pool.query(
      "INSERT INTO shipping_plan_audit (plan_id, plan_uid, action, actor, detail) VALUES ($1,$2,'actual_gross_weight',$3,$4::jsonb)",
      [row.id, row._id || null, actor, JSON.stringify({ old: old ?? null, new: row[FIELD], bl_no: row.bl_no, shipment_no: row.shipment_no })]
    );
  } catch (err) { console.warn('[shipping actual_gross_weight audit]', err.message); }
}
