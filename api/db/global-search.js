// GET /api/db/global-search?q=xxx
// Read-only top-bar global search. Sources are fixed allowlist tables/columns.
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { searchModules } from "./global-search-modules.js";

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
        COALESCE(bl_no,'') ILIKE $1 ESCAPE '\\' OR COALESCE(mbl_no,'') ILIKE $1 ESCAPE '\\' OR
        COALESCE(hbl_no,'') ILIKE $1 ESCAPE '\\' OR COALESCE(vessel,'') ILIKE $1 ESCAPE '\\' OR
        COALESCE(so_no,'') ILIKE $1 ESCAPE '\\' OR COALESCE(booking_no,'') ILIKE $1 ESCAPE '\\'
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
      WHERE COALESCE(order_no,'') ILIKE $1 ESCAPE '\\' OR COALESCE(contract_no,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(customer_po,'') ILIKE $1 ESCAPE '\\' OR COALESCE(company_name_en,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(customer,'') ILIKE $1 ESCAPE '\\'
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
      WHERE COALESCE(code,'') ILIKE $1 ESCAPE '\\' OR COALESCE(name_cn,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(name_en,'') ILIKE $1 ESCAPE '\\' OR COALESCE(tax_id,'') ILIKE $1 ESCAPE '\\'
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
      WHERE COALESCE(company_code,'') ILIKE $1 ESCAPE '\\' OR COALESCE(name,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(name_en,'') ILIKE $1 ESCAPE '\\' OR COALESCE(name_cn,'') ILIKE $1 ESCAPE '\\'
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
      WHERE id::text ILIKE $1 ESCAPE '\\' OR COALESCE(bl_no,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(container_no,'') ILIKE $1 ESCAPE '\\' OR COALESCE(cost_category,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(supplier,'') ILIKE $1 ESCAPE '\\'
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
      WHERE COALESCE(container_no,'') ILIKE $1 ESCAPE '\\' OR COALESCE(seal_no,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(bl_no,'') ILIKE $1 ESCAPE '\\' OR COALESCE(contract_no,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(booking_no,'') ILIKE $1 ESCAPE '\\'
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
      WHERE COALESCE(code,'') ILIKE $1 ESCAPE '\\' OR COALESCE(name_en,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(name_cn,'') ILIKE $1 ESCAPE '\\' OR COALESCE(unlocode,'') ILIKE $1 ESCAPE '\\'
      ORDER BY code ASC
      LIMIT $2`,
  },
  {
    type: "服务报价",
    sql: `
      SELECT COALESCE(NULLIF(service,''), 'service') || '-' || id::text AS label,
        CONCAT_WS(' · ', NULLIF(factory_name,''), NULLIF(pickup_place,''), NULLIF(pol,''), NULLIF(pod,''), NULLIF(customs_port,''), NULLIF(customs_type,''), NULLIF(container_type,''), rate::text, NULLIF(currency,'')) AS sub,
        id::text AS url_key
      FROM service_rates
      WHERE id::text ILIKE $1 ESCAPE '\\' OR COALESCE(service,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(factory_name,'') ILIKE $1 ESCAPE '\\' OR COALESCE(pickup_place,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(pol,'') ILIKE $1 ESCAPE '\\' OR COALESCE(pod,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(customs_port,'') ILIKE $1 ESCAPE '\\' OR COALESCE(customs_type,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(container_type,'') ILIKE $1 ESCAPE '\\' OR COALESCE(issuing_company,'') ILIKE $1 ESCAPE '\\'
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "拖车线路",
    sql: `
      SELECT COALESCE(NULLIF(factory_name,''), NULLIF(pickup_city,''), _id::text) AS label,
        CONCAT_WS(' · ', NULLIF(pickup_city,''), NULLIF(pol,''), NULLIF(pol_terminal,''), distance_km::text, NULLIF(notes,'')) AS sub,
        _id::text AS url_key
      FROM trucking_routes
      WHERE _id::text ILIKE $1 ESCAPE '\\' OR COALESCE(factory_name,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(pickup_city,'') ILIKE $1 ESCAPE '\\' OR COALESCE(pol,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(pol_terminal,'') ILIKE $1 ESCAPE '\\' OR COALESCE(notes,'') ILIKE $1 ESCAPE '\\'
      ORDER BY updated_at DESC NULLS LAST, _id DESC
      LIMIT $2`,
  },
  {
    type: "港杂",
    sql: `
      SELECT COALESCE(NULLIF(charge_code,''), id::text) AS label,
        CONCAT_WS(' · ', NULLIF(carrier,''), NULLIF(pol,''), NULLIF(pod,''), NULLIF(company_name,''), NULLIF(container_type,''), charge_name, sell_total::text) AS sub,
        COALESCE(NULLIF(charge_code,''), id::text) AS url_key
      FROM local_charges
      WHERE id::text ILIKE $1 ESCAPE '\\' OR COALESCE(charge_code,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(carrier,'') ILIKE $1 ESCAPE '\\' OR COALESCE(pol,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(pod,'') ILIKE $1 ESCAPE '\\' OR COALESCE(company_name,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(container_type,'') ILIKE $1 ESCAPE '\\' OR COALESCE(charge_name,'') ILIKE $1 ESCAPE '\\'
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "海运价",
    sql: `
      SELECT COALESCE(NULLIF(carrier,''), 'freight') || '-' || id::text AS label,
        CONCAT_WS(' · ', NULLIF(pol,''), NULLIF(pod,''), NULLIF(forwarder,''), NULLIF(route_code,''), gp20::text, hq40::text, NULLIF(status,'')) AS sub,
        id::text AS url_key
      FROM freight_rates
      WHERE id::text ILIKE $1 ESCAPE '\\' OR COALESCE(carrier,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(forwarder,'') ILIKE $1 ESCAPE '\\' OR COALESCE(pol,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(pod,'') ILIKE $1 ESCAPE '\\' OR COALESCE(route_code,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(status,'') ILIKE $1 ESCAPE '\\' OR COALESCE(remarks,'') ILIKE $1 ESCAPE '\\'
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "操作待办",
    sql: `
      SELECT 'TODO-' || id::text AS label,
        CONCAT_WS(' · ', NULLIF(severity,''), NULLIF(status,''), NULLIF(target_table,''), NULLIF(target_id,''), NULLIF(owner_no,''), NULLIF(reviewer_no,''), NULLIF(description,'')) AS sub,
        id::text AS url_key
      FROM operation_todos
      WHERE id::text ILIKE $1 ESCAPE '\\' OR COALESCE(check_code,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(severity,'') ILIKE $1 ESCAPE '\\' OR COALESCE(target_table,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(target_id,'') ILIKE $1 ESCAPE '\\' OR COALESCE(description,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(status,'') ILIKE $1 ESCAPE '\\' OR COALESCE(owner_no,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(reviewer_no,'') ILIKE $1 ESCAPE '\\'
      ORDER BY created_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "知识库",
    sql: `
      SELECT COALESCE(NULLIF(title,''), id::text) AS label,
        CONCAT_WS(' · ', NULLIF(topic,''), NULLIF(category,''), NULLIF(source,''), NULLIF(url,'')) AS sub,
        id::text AS url_key
      FROM knowledge_articles
      WHERE id::text ILIKE $1 ESCAPE '\\' OR COALESCE(title,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(topic,'') ILIKE $1 ESCAPE '\\' OR COALESCE(category,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(source,'') ILIKE $1 ESCAPE '\\' OR COALESCE(url,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(body,'') ILIKE $1 ESCAPE '\\'
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "订单人员槽",
    sql: `
      SELECT COALESCE(NULLIF(role_key,''), 'slot') || '-' || id::text AS label,
        CONCAT_WS(' · ', order_id::text, NULLIF(staff_no,''), NULLIF(note,''), NULLIF(updated_by,'')) AS sub,
        order_id::text AS url_key
      FROM order_staff_slots
      WHERE id::text ILIKE $1 ESCAPE '\\' OR order_id::text ILIKE $1 ESCAPE '\\'
        OR COALESCE(role_key,'') ILIKE $1 ESCAPE '\\' OR COALESCE(staff_no,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(note,'') ILIKE $1 ESCAPE '\\' OR COALESCE(updated_by,'') ILIKE $1 ESCAPE '\\'
      ORDER BY updated_at DESC NULLS LAST, id DESC
      LIMIT $2`,
  },
  {
    type: "忽略记录",
    sql: `
      SELECT COALESCE(NULLIF(scope,''), 'ignore') || '-' || id::text AS label,
        CONCAT_WS(' · ', NULLIF(target_key,''), NULLIF(actor,''), NULLIF(note,'')) AS sub,
        id::text AS url_key
      FROM alert_ignores
      WHERE id::text ILIKE $1 ESCAPE '\\' OR COALESCE(scope,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(target_key,'') ILIKE $1 ESCAPE '\\' OR COALESCE(actor,'') ILIKE $1 ESCAPE '\\'
        OR COALESCE(note,'') ILIKE $1 ESCAPE '\\'
      ORDER BY created_at DESC NULLS LAST, id DESC
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
  "服务报价": (r) => "/rates?service_rate=" + encodeURIComponent(r.url_key || ""),
  "拖车线路": (r) => "/rates?trucking_route=" + encodeURIComponent(r.url_key || ""),
  "港杂": (r) => "/rates?local_charge=" + encodeURIComponent(r.url_key || ""),
  "海运价": (r) => "/rates?freight_rate=" + encodeURIComponent(r.url_key || ""),
  "操作待办": (r) => "/ops-todos?q=" + encodeURIComponent(r.url_key || r.label || ""),
  "知识库": (r) => "/kb?id=" + encodeURIComponent(r.url_key || ""),
  "订单人员槽": (r) => "/order-staff-slots?order_id=" + encodeURIComponent(r.url_key || ""),
  "忽略记录": (r) => "/biz-alerts?ignore_id=" + encodeURIComponent(r.url_key || ""),
};

function cleanQuery(v) {
  return String(v ?? "").trim().slice(0, 80);
}

function escapeLike(v) {
  return v.replace(/[\\%_]/g, "\\$&");
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
  const like = "%" + escapeLike(needle) + "%";
  const moduleGroup = searchModules(needle);
  const results = await Promise.all(
    SEARCHES.map((cfg) => pool.query(cfg.sql, [like, LIMIT]).then((r) => groupResult(cfg.type, r.rows)))
  );
  return [moduleGroup].concat(results).filter((g) => g && g.items.length);
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
