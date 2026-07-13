// booking-collab-view-lib.js — booking-collab-view 共享工具（拆自 booking-collab-view.js 2026-07-13）

export const NON_EMPTY = v => v !== null && v !== undefined && String(v).trim() !== "";
export const arr = v => Array.isArray(v) ? v : [];

export function parseRaw(raw) {
  if (!raw) return {};
  if (typeof raw === "string") {
    try { return JSON.parse(raw) || {}; } catch { return {}; }
  }
  return raw || {};
}

export async function tableExists(pool, table) {
  const { rows } = await pool.query(
    `SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
  return !!(rows[0] && rows[0].ok);
}

export async function columnExists(pool, table, column) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2
     ) AS ok`,
    [table, column]);
  return !!(rows[0] && rows[0].ok);
}

export async function resolvePlan(pool, planRef) {
  const { rows } = await pool.query(
    `SELECT sp.* FROM shipping_plans sp WHERE sp._id = $1 OR sp.id::text = $1 LIMIT 1`,
    [String(planRef || "")]);
  return rows[0] || null;
}

export async function derivePlanFactories(pool, planId) {
  const { rows } = await pool.query(
    `SELECT NULLIF(TRIM(factory), '') AS label,
            COUNT(*)::int AS order_count,
            COALESCE(SUM(total_qty), 0)::int AS total_qty
       FROM orders
      WHERE shipping_plan_id = $1
        AND NULLIF(TRIM(factory), '') IS NOT NULL
        AND (status IS NULL OR status NOT IN ('cancelled'))
      GROUP BY NULLIF(TRIM(factory), '')
      ORDER BY label`,
    [planId]);
  return rows.map(r => ({
    label: r.label,
    seqs: [],
    qty: r.order_count || null,
    note: null,
    submitted: false,
    source: "derived",
    order_count: r.order_count || 0,
    total_qty: r.total_qty || 0,
  }));
}

export async function companyName(pool, id) {
  if (!NON_EMPTY(id)) return null;
  try {
    const { rows } = await pool.query(
      `SELECT COALESCE(name_cn, name_en) AS n FROM companies WHERE id = $1 LIMIT 1`, [id]);
    return rows[0] ? rows[0].n : null;
  } catch { return null; }
}
