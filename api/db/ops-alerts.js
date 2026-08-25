// GET /api/db/ops-alerts — 操作预警面板只读数据源
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const MIN_FILL_RATE = 0.8;
const NODES = [
  ["booking", "待订舱", "booking_sent_at", "订舱发送时间有人写入后，此处自动生效。"],
  ["allocation", "待配舱", "booking_no", "订舱号稳定写入后，此处自动生效。"],
  ["signing", "待签单", "bl_no", "BL 号缺失即待签单。"],
  ["customs", "待报关", "so_no", "SO 号稳定写入后，此处自动生效。"],
  ["transport", "待运输", "factory_dispatch_confirmed_at", "工厂发运确认时间有人写入后，此处自动生效。"],
  ["release", "待换单", "telex_released_at", "电放/换单释放时间有人写入后，此处自动生效。"],
];

function pct(filled, total) {
  if (!total) return null;
  return Math.round((Number(filled || 0) * 1000) / Number(total)) / 10;
}

function basis(field, filled, total, note) {
  return { field, filled: Number(filled || 0), total: Number(total || 0), fill_rate: pct(filled, total), note };
}

function makeNode(meta, stats, rows) {
  const [key, title, field, note] = meta;
  const filled = stats[field] || 0;
  const b = basis(field, filled, stats.total, note);
  const ready = key === "signing" || (b.fill_rate !== null && b.fill_rate >= MIN_FILL_RATE);
  if (!ready) return { key, title, state: "no_data", count: null, rows: [], basis: b };
  const list = key === "signing" ? rows : [];
  return { key, title, state: "ready", count: list.length, rows: list, basis: b };
}

export async function loadOpsAlerts(pool) {
  const sql = `
WITH active AS (
  SELECT s.id, s._id, s.shipment_no, s.order_nos, s.contract_nos,
    s.customer, s.customer_en, s.customer_cn, s.company_code, s.etd,
    s.booking_sent_at, s.booking_no, s.bl_no, s.so_no,
    s.factory_dispatch_confirmed_at, s.telex_released_at,
    COALESCE(c.name_cn, c.name_en, cu.name_cn, cu.name_en, s.customer_cn, s.customer_en, s.customer, s.company_code) AS customer_name
  FROM shipping_plans s
  LEFT JOIN companies c ON c.code = s.company_code
  LEFT JOIN customers cu ON cu.company_code = s.company_code
  WHERE s.deleted_at IS NULL
    AND COALESCE(s.bl_no, '') NOT ILIKE '%#merged%'
    AND COALESCE(s.bl_no, '') NOT ILIKE '%#void%'
    AND COALESCE(s.bl_no, '') NOT ILIKE '%#retired%'
    AND COALESCE(s.flow_status, '') NOT LIKE 'merged_to%'
    AND lower(COALESCE(s.status, '')) NOT IN ('cancelled', 'canceled', 'void', 'voided', 'retired')
    AND lower(COALESCE(s.flow_status, '')) NOT IN ('cancelled', 'canceled', 'void', 'voided', 'retired')
),
stats AS (
  SELECT COUNT(*)::int AS total,
    COUNT(*) FILTER (WHERE booking_sent_at IS NOT NULL)::int AS booking_sent_at,
    COUNT(*) FILTER (WHERE NULLIF(BTRIM(booking_no), '') IS NOT NULL)::int AS booking_no,
    COUNT(*) FILTER (WHERE NULLIF(BTRIM(bl_no), '') IS NOT NULL)::int AS bl_no,
    COUNT(*) FILTER (WHERE NULLIF(BTRIM(so_no), '') IS NOT NULL)::int AS so_no,
    COUNT(*) FILTER (WHERE factory_dispatch_confirmed_at IS NOT NULL)::int AS factory_dispatch_confirmed_at,
    COUNT(*) FILTER (WHERE telex_released_at IS NOT NULL)::int AS telex_released_at
  FROM active
),
sign_rows AS (
  SELECT COALESCE(json_agg(json_build_object(
    'id', id,
    'plan_id', _id,
    'order_no', COALESCE(NULLIF(array_to_string(order_nos, ', '), ''), NULLIF(array_to_string(contract_nos, ', '), ''), shipment_no, _id),
    'customer', customer_name,
    'shipment_no', shipment_no,
    'etd', to_char(etd, 'YYYY-MM-DD')
  ) ORDER BY etd NULLS LAST, id), '[]'::json) AS rows
  FROM active
  WHERE NULLIF(BTRIM(bl_no), '') IS NULL
)
SELECT stats.*, sign_rows.rows AS signing_rows FROM stats, sign_rows`;
  const r = await pool.query(sql);
  const row = r.rows[0] || {};
  const stats = {
    total: row.total || 0,
    booking_sent_at: row.booking_sent_at || 0,
    booking_no: row.booking_no || 0,
    bl_no: row.bl_no || 0,
    so_no: row.so_no || 0,
    factory_dispatch_confirmed_at: row.factory_dispatch_confirmed_at || 0,
    telex_released_at: row.telex_released_at || 0,
  };
  const signingRows = Array.isArray(row.signing_rows) ? row.signing_rows : [];
  return NODES.map((node) => makeNode(node, stats, signingRows));
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const nodes = await loadOpsAlerts(getPool());
    res.status(200).json({ success: true, generated_at: new Date().toISOString(), data: nodes });
  } catch (err) {
    console.error("[ops-alerts]", err);
    res.status(500).json({ success: false, error: err.message });
  }
}
