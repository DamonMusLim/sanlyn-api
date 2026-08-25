// GET /api/db/global-search?q=xxx
// Read-only top-bar global search. Sources are fixed allowlist tables/columns.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const LIMIT = 5;

const SEARCHES = [
  {
    type: "提单",
    sql: `
      SELECT COALESCE(NULLIF(bl_no,''), NULLIF(mbl_no,''), NULLIF(hbl_no,''), shipment_no, _id) AS label,
        CONCAT_WS(' · ', NULLIF(vessel,''), NULLIF(so_no,''), NULLIF(booking_no,''), NULLIF(customer,'')) AS sub,
        COALESCE(NULLIF(bl_no,''), NULLIF(mbl_no,''), NULLIF(hbl_no,''), shipment_no, _id) AS url_key
      FROM shipping_plans
      WHERE deleted_at IS NULL AND (
        COALESCE(bl_no,'') ILIKE $1 OR COALESCE(mbl_no,'') ILIKE $1 OR
        COALESCE(hbl_no,'') ILIKE $1 OR COALESCE(vessel,'') ILIKE $1 OR
        COALESCE(so_no,'') ILIKE $1 OR COALESCE(booking_no,'') ILIKE $1
      )
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "订单",
    sql: `
      SELECT COALESCE(NULLIF(order_no,''), NULLIF(contract_no,''), id::text) AS label,
        CONCAT_WS(' · ', NULLIF(contract_no,''), NULLIF(customer_po,''), NULLIF(company_name_en,''), NULLIF(customer,'')) AS sub,
        COALESCE(NULLIF(order_no,''), NULLIF(contract_no,''), id::text) AS url_key
      FROM orders
      WHERE COALESCE(order_no,'') ILIKE $1 OR COALESCE(contract_no,'') ILIKE $1
        OR COALESCE(customer_po,'') ILIKE $1 OR COALESCE(company_name_en,'') ILIKE $1
        OR COALESCE(customer,'') ILIKE $1
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "公司",
    sql: `
      SELECT COALESCE(NULLIF(code,''), id::text) AS label,
        CONCAT_WS(' · ', NULLIF(name_cn,''), NULLIF(name_en,''), NULLIF(tax_id,'')) AS sub,
        COALESCE(NULLIF(code,''), NULLIF(name_cn,''), NULLIF(name_en,''), id::text) AS url_key
      FROM companies
      WHERE COALESCE(code,'') ILIKE $1 OR COALESCE(name_cn,'') ILIKE $1
        OR COALESCE(name_en,'') ILIKE $1 OR COALESCE(tax_id,'') ILIKE $1
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "客户",
    sql: `
      SELECT COALESCE(NULLIF(company_code,''), NULLIF(name,''), NULLIF(name_cn,''), NULLIF(name_en,''), id::text) AS label,
        CONCAT_WS(' · ', NULLIF(name_cn,''), NULLIF(name_en,''), NULLIF(name,''), NULLIF(country,'')) AS sub,
        COALESCE(NULLIF(company_code,''), NULLIF(name,''), NULLIF(name_cn,''), NULLIF(name_en,''), id::text) AS url_key
      FROM customers
      WHERE COALESCE(company_code,'') ILIKE $1 OR COALESCE(name,'') ILIKE $1
        OR COALESCE(name_en,'') ILIKE $1 OR COALESCE(name_cn,'') ILIKE $1
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "账单",
    sql: `
      SELECT 'FSB-' || id::text AS label,
        CONCAT_WS(' · ', NULLIF(bl_no,''), NULLIF(container_no,''), NULLIF(cost_category,''), NULLIF(supplier,'')) AS sub,
        id::text AS url_key
      FROM freight_supplier_bills
      WHERE id::text ILIKE $1 OR COALESCE(bl_no,'') ILIKE $1
        OR COALESCE(container_no,'') ILIKE $1 OR COALESCE(cost_category,'') ILIKE $1
        OR COALESCE(supplier,'') ILIKE $1
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "集装箱",
    sql: `
      SELECT COALESCE(NULLIF(container_no,''), id::text) AS label,
        CONCAT_WS(' · ', NULLIF(seal_no,''), NULLIF(bl_no,''), NULLIF(contract_no,''), NULLIF(booking_no,'')) AS sub,
        COALESCE(NULLIF(container_no,''), NULLIF(bl_no,''), id::text) AS url_key
      FROM container_bookings
      WHERE COALESCE(container_no,'') ILIKE $1 OR COALESCE(seal_no,'') ILIKE $1
        OR COALESCE(bl_no,'') ILIKE $1 OR COALESCE(contract_no,'') ILIKE $1
        OR COALESCE(booking_no,'') ILIKE $1
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "港口",
    sql: `
      SELECT COALESCE(NULLIF(code,''), NULLIF(unlocode,''), id::text) AS label,
        CONCAT_WS(' · ', NULLIF(name_en,''), NULLIF(name_cn,''), NULLIF(unlocode,'')) AS sub,
        COALESCE(NULLIF(code,''), NULLIF(unlocode,''), NULLIF(name_en,''), NULLIF(name_cn,''), id::text) AS url_key
      FROM ports
      WHERE COALESCE(code,'') ILIKE $1 OR COALESCE(name_en,'') ILIKE $1
        OR COALESCE(name_cn,'') ILIKE $1 OR COALESCE(unlocode,'') ILIKE $1
      ORDER BY code ASC
      LIMIT $2`,
  },
];

const TYPE_URL = {
  "提单": (r) => "/ocean?q=" + encodeURIComponent(r.url_key || r.label || ""),
  "订单": (r) => "/ship-grid?q=" + encodeURIComponent(r.url_key || r.label || ""),
  "公司": (r) => "/kb?q=" + encodeURIComponent(r.url_key || r.label || ""),
  "客户": (r) => "/kb?q=" + encodeURIComponent(r.url_key || r.label || ""),
  "账单": (r) => "/rates?bill_id=" + encodeURIComponent(r.url_key || ""),
  "集装箱": (r) => "/ocean?q=" + encodeURIComponent(r.url_key || r.label || ""),
  "港口": (r) => "/kb?q=" + encodeURIComponent(r.url_key || r.label || ""),
};

function cleanQuery(v) {
  return String(v ?? "").trim().slice(0, 80);
}

function groupResult(type, rows) {
  return {
    type,
    items: rows.map((r) => ({
      type,
      label: r.label || "未设置",
      sub: r.sub || "未设置",
      url: TYPE_URL[type](r),
    })),
  };
}

export async function loadGlobalSearch(pool, q) {
  const needle = cleanQuery(q);
  if (needle.length < 2) return [];
  const like = "%" + needle + "%";
  const results = await Promise.all(
    SEARCHES.map((cfg) => pool.query(cfg.sql, [like, LIMIT]).then((r) => groupResult(cfg.type, r.rows)))
  );
  return results.filter((g) => g.items.length);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "GET required" });
  if (!requireAuth(req, res)) return;
  try {
    const q = cleanQuery(req.query?.q);
    if (q.length < 2) return res.status(200).json({ success: true, data: [], flat: [], count: 0 });
    const data = await loadGlobalSearch(getPool(), q);
    const flat = data.flatMap((g) => g.items);
    return res.status(200).json({ success: true, data, flat, count: flat.length });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
}
