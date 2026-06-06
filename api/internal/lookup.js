/**
 * api/internal/lookup.js — 任务中心执行器专用·内部只读 lookup
 * POST /api/internal/lookup  Body: { type, ...params }
 * 白名单查询(绝不接原始SQL),只读(只SELECT),供执行器"先查后问"。
 * 认证:服务 token(verifyToken,role∈service/admin/logistics/finance)。
 * 列名均经核实(customers/orders/order_line_items 真实列)。2026-06-06
 */
import { getPool, setCors } from "../db.js";
import { verifyToken } from "../auth.js";

const ALLOWED = ["customer_by_name", "customer_by_code", "orders_by_customer", "order_by_contract"];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  // 只允许 POST(敏感查询参数不进 URL/日志/代理记录)— Codex审核要求
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "POST only" });

  const auth = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const p = verifyToken(auth);
  // 只信任 service(执行器)/ admin —— 收窄,不给 logistics/finance(Codex审核要求)
  if (!p || !["service", "admin"].includes(p.role)) {
    return res.status(401).json({ ok: false, error: "internal lookup: unauthorized" });
  }

  const body = req.body || {};
  const type = body.type;
  if (!ALLOWED.includes(type)) {
    return res.status(400).json({ ok: false, error: "type 必须是白名单之一: " + ALLOWED.join(", ") });
  }
  const lim = Math.min(parseInt(body.limit || 10, 10) || 10, 50);
  const pool = getPool();

  try {
    if (type === "customer_by_name") {
      const kw = "%" + String(body.name || "").trim() + "%";
      const r = await pool.query(
        `SELECT company_code, name_en, name_cn, contact_name, contact_phone, country
         FROM customers WHERE name_en ILIKE $1 OR name_cn ILIKE $1 OR company_code = $2 LIMIT 5`,
        [kw, String(body.name || "").trim()]
      );
      return res.status(200).json({ ok: true, type, data: r.rows });
    }
    if (type === "customer_by_code") {
      const r = await pool.query(
        `SELECT company_code, name_en, name_cn, contact_name, contact_phone, country
         FROM customers WHERE company_code = $1 LIMIT 1`,
        [String(body.company_code || "")]
      );
      return res.status(200).json({ ok: true, type, data: r.rows[0] || null });
    }
    if (type === "orders_by_customer") {
      const r = await pool.query(
        `SELECT contract_no, order_no, status, country, factory FROM orders
         WHERE company_code = $1 ORDER BY _id DESC LIMIT $2`,
        [String(body.company_code || ""), lim]
      );
      return res.status(200).json({ ok: true, type, data: r.rows });
    }
    if (type === "order_by_contract") {
      const o = await pool.query(
        `SELECT _id, contract_no, order_no, status, customer, company_code, country FROM orders
         WHERE contract_no = $1 LIMIT 1`,
        [String(body.contract_no || "")]
      );
      if (!o.rows.length) return res.status(200).json({ ok: true, type, data: null });
      const li = await pool.query(
        `SELECT product_name, sku, qty, ctn, net_weight, gross_weight, cbm, hs_code
         FROM order_line_items WHERE order_id = $1 ORDER BY sort_order, id LIMIT 50`,
        [o.rows[0]._id]
      );
      return res.status(200).json({ ok: true, type, data: { ...o.rows[0], line_items: li.rows } });
    }
  } catch (e) {
    console.error("[internal/lookup]", type, e.message);
    return res.status(500).json({ ok: false, error: "query error" });
  }
}
