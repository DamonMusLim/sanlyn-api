// /api/db/customer-portal.js — customer-scoped order progress and stock lens
import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";

function json(res, status, payload) {
  return res.status(status).json(payload);
}

function userCodes(req) {
  const u = req.user || {};
  const raw = Array.isArray(u.companyCodes) && u.companyCodes.length
    ? u.companyCodes
    : (u.companyCode || u.company_code ? [u.companyCode || u.company_code] : []);
  return raw.map(String).map(s => s.trim()).filter(Boolean);
}

function actorName(req) {
  const u = req.user || {};
  return String(u.username || u.email || u.account || u.sub || u.uid || "customer").slice(0, 120);
}

function cleanDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

async function getOrders(pool, codes) {
  const r = await pool.query(
    `SELECT
        o.order_no,
        COALESCE(
          NULLIF(string_agg(DISTINCT NULLIF(COALESCE(p.product_name, li.product_name), ''), ', '), ''),
          NULLIF(o.products->0->>'product_name', ''),
          NULLIF(o.products->0->>'productName', '')
        ) AS product_name,
        COALESCE(
          NULLIF(string_agg(DISTINCT NULLIF(p.product_name_cn, ''), ', '), ''),
          NULLIF(o.products->0->>'product_name_cn', ''),
          NULLIF(o.products->0->>'nameCN', '')
        ) AS product_name_cn,
        o.total_qty,
        COALESCE(NULLIF(o.raw->>'containerType', ''), NULLIF(o.raw->>'container_type', '')) AS container_type,
        o.status,
        o.etd,
        o.delivery_date,
        o.confirmed_delivery
       FROM orders o
       LEFT JOIN order_line_items li ON li.order_id = o.id
       LEFT JOIN products p ON p.sku = li.sku
      WHERE o.company_code = ANY($1::text[])
      GROUP BY o.id
      ORDER BY COALESCE(o.delivery_date, o.etd) DESC NULLS LAST, o.order_no DESC`,
    [codes]
  );
  return r.rows.map(row => ({
    order_no: row.order_no,
    product_name: row.product_name,
    product_name_cn: row.product_name_cn,
    total_qty: row.total_qty,
    container_type: row.container_type,
    status: row.status,
    etd: row.etd,
    delivery_date: row.delivery_date,
    confirmed_delivery: row.confirmed_delivery,
  }));
}

async function getStock(pool, codes) {
  const r = await pool.query(
    `WITH scoped_skus AS (
       SELECT DISTINCT li.sku
         FROM order_line_items li
         JOIN orders o ON o.id = li.order_id
        WHERE o.company_code = ANY($1::text[])
          AND li.sku IS NOT NULL
          AND li.sku <> ''
     )
     SELECT
       p.product_name,
       p.product_name_cn,
       COALESCE(NULLIF(p.size, ''), NULLIF(p.spec, '')) AS size,
       p.flavor AS variant,
       SUM(COALESCE(f.current_stock, 0)) AS current_stock,
       CASE
         WHEN SUM(COALESCE(f.current_stock, 0)) <= 0 THEN 'out_of_stock'
         WHEN SUM(COALESCE(f.current_stock, 0)) <= 10 THEN 'low_stock'
         ELSE 'in_stock'
       END AS status
      FROM scoped_skus s
      JOIN products p ON p.sku = s.sku
      LEFT JOIN finished_goods_inventory f ON f.product_id = p.id
     GROUP BY p.sku, p.product_name, p.product_name_cn, p.size, p.spec, p.flavor
     ORDER BY p.product_name_cn NULLS LAST, p.product_name NULLS LAST`,
    [codes]
  );
  return r.rows.map(row => ({
    product_name: row.product_name,
    product_name_cn: row.product_name_cn,
    size: row.size,
    variant: row.variant,
    current_stock: row.current_stock,
    status: row.status,
  }));
}

async function requestDeliveryDate(req, res, pool, codes) {
  const b = req.body || {};
  const orderNo = String(b.order_no || "").trim();
  const requestedDate = cleanDate(b.requested_date || b.delivery_date);
  const note = String(b.note || "").trim().slice(0, 500);
  if (!orderNo) return json(res, 400, { success: false, error: "order_no required" });
  if (!requestedDate) return json(res, 400, { success: false, error: "valid requested_date required" });

  const ord = await pool.query(
    `SELECT id, order_no
       FROM orders
      WHERE order_no = $1
        AND company_code = ANY($2::text[])
      LIMIT 1`,
    [orderNo, codes]
  );
  if (!ord.rows.length) {
    return json(res, 404, { success: false, error: "order not found in your scope" });
  }

  const who = actorName(req);
  const meta = {
    order_no: orderNo,
    requested_date: requestedDate,
    note,
    who,
  };
  await pool.query(
    `INSERT INTO order_events
       (order_id, stage_key, event_group, sequence_no, is_current,
        occurred_at, actor_role, actor_company_id, actor_user_id,
        source, visibility_scope, status, meta)
     VALUES ($1, 'delivery_date_request', 'negotiation', 1, true,
        NOW(), $2, $3, $4, 'manual', $5::jsonb, 'active', $6::jsonb)`,
    [
      ord.rows[0].id,
      req.user?.role || "customer",
      codes[0],
      who,
      JSON.stringify({ customer: codes }),
      JSON.stringify(meta),
    ]
  );
  return json(res, 200, {
    success: true,
    data: { order_no: orderNo, requested_date: requestedDate },
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) extractUser(req);
  if (!req.user) return json(res, 401, { success: false, error: "Unauthorized" });
  if (!["customer", "admin"].includes(req.user?.role)) {
    return json(res, 403, { success: false, error: "Forbidden: customer role required" });
  }

  const codes = userCodes(req);
  if (!codes.length) {
    return json(res, 403, { success: false, error: "Account company scope missing" });
  }

  const pool = getPool();
  try {
    if (req.method === "GET") {
      const view = String(req.query.view || "orders");
      if (view === "orders") return json(res, 200, { success: true, data: await getOrders(pool, codes) });
      if (view === "stock") return json(res, 200, { success: true, data: await getStock(pool, codes) });
      return json(res, 400, { success: false, error: "unknown view" });
    }

    if (req.method === "POST") {
      const action = String(req.query.action || req.body?.action || "");
      if (action === "request-delivery-date") {
        return await requestDeliveryDate(req, res, pool, codes);
      }
      return json(res, 400, { success: false, error: "unknown action" });
    }

    return json(res, 405, { success: false, error: "Method not allowed" });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message });
  }
}
