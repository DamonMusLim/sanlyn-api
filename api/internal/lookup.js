/**
 * api/internal/lookup.js — 任务中心执行器专用·内部只读 lookup
 * POST /api/internal/lookup  Body: { type, ...params }
 * 白名单查询(绝不接原始SQL),只读(只SELECT),供执行器"先查后问"。
 * 认证:服务 token(verifyToken,role∈service/admin/logistics/finance)。
 * 列名均经核实(customers/orders/order_line_items 真实列)。2026-06-06
 */
import { getPool, setCors } from "../db.js";
import { verifyToken } from "../auth.js";

const ALLOWED = ["customer_by_name", "customer_by_code", "orders_by_customer", "order_by_contract", "product_by_sku", "factory_code_resolve", "product_resolve_scoped", "line_item_history_by_sku"];

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
    if (type === "product_by_sku") {
      const r = await pool.query(
        `SELECT id, sku, product_name, product_name_cn, flavor, size, hs_code
         FROM products WHERE sku = $1 LIMIT 1`,
        [String(body.sku || "").trim()]
      );
      return res.status(200).json({ ok: true, type, data: r.rows[0] || null });
    }
    if (type === "factory_code_resolve") {
      // 工厂唯一锁定码:先查 factories 主表(company_code是权威码),再回退 orders 历史,最后生成 FC-NNNNN
      const fname = String(body.factory || "").trim();
      let existingCode = null;
      if (fname) {
        // 1. 查 factories 主表:双向模糊(全称↔输入,简称包含在输入里)
        //    例:输入"辽宁宠爱" → name ILIKE '%辽宁宠爱%' 命中
        //    例:输入"辽宁宠爱宠爱宠用品"(MiniMax花名) → '$1 ILIKE %宠爱%' 命中 name_short
        const fromTable = await pool.query(
          `SELECT company_code FROM factories
           WHERE is_active = true AND (
             name = $1
             OR name_short = $1
             OR company_code = $1
             OR name ILIKE '%' || $1 || '%'
             OR $1 ILIKE '%' || name || '%'
             OR (name_short <> '' AND $1 ILIKE '%' || name_short || '%')
           )
           ORDER BY
             CASE WHEN name = $1 OR name_short = $1 THEN 0
                  WHEN name ILIKE '%' || $1 || '%' THEN 1
                  WHEN $1 ILIKE '%' || name || '%' THEN 2
                  ELSE 3 END
           LIMIT 1`,
          [fname]
        );
        if (fromTable.rows.length) {
          existingCode = fromTable.rows[0].company_code;
        } else {
          // 2. 回退:orders 历史中找已锁定的 factory_code
          const fromOrders = await pool.query(
            `SELECT factory_code FROM orders
             WHERE (factory ILIKE $1 OR factory ILIKE $2)
               AND factory_code IS NOT NULL AND factory_code <> ''
             ORDER BY length(factory) LIMIT 1`,
            ['%' + fname + '%', fname + '%']
          );
          if (fromOrders.rows.length) existingCode = fromOrders.rows[0].factory_code;
        }
      }
      // 3. 新工厂:取下一个 FC-NNNNN 流水
      const maxr = await pool.query(
        `SELECT factory_code FROM orders WHERE factory_code ~ '^FC-[0-9]+$' ORDER BY (substring(factory_code from 4))::int DESC LIMIT 1`
      );
      const maxNum = maxr.rows.length ? parseInt(String(maxr.rows[0].factory_code).slice(3), 10) : 0;
      const next = "FC-" + String(maxNum + 1).padStart(5, "0");
      return res.status(200).json({ ok: true, type, data: { existing: existingCode, next } });
    }
    if (type === "product_resolve_scoped") {
      // 授权隔离:只能在客户授权品牌范围内搜产品(防跳单+授权);带价格/重量/HS
      const code = String(body.company_code || "").trim();
      const sku = String(body.sku || "").trim();
      const hint = String(body.hint || "").trim();  // 香型/品名关键词
      const r = await pool.query(
        `SELECT p.id, p.sku, p.product_name, p.flavor, p.brand,
                p.factory_price, p.sale_price_cny, p.price_usd,
                p.net_weight, p.gross_weight, p.cbm, p.bg_bx, p.hs_code, p.vat_rate
           FROM products p
          WHERE p.brand IN (SELECT jsonb_array_elements_text(c.brands) FROM customers c WHERE c.company_code = $1)
            AND ( ($2 <> '' AND p.sku = $2)
               OR ($3 <> '' AND (p.product_name ILIKE '%'||$3||'%' OR p.flavor ILIKE '%'||$3||'%')) )
          ORDER BY (p.sku = $2) DESC NULLS LAST, p.id
          LIMIT 1`,
        [code, sku, hint]
      );
      return res.status(200).json({ ok: true, type, data: r.rows[0] || null });
    }
    if (type === "line_item_history_by_sku") {
      // 历史回退:产品表查不到的字段,从该SKU最近一次有值的订单明细取(不外推不造数)
      const sku = String(body.sku || "").trim();
      if (!sku) return res.status(200).json({ ok: true, type, data: null });
      const r = await pool.query(
        `SELECT unit_price, factory_price, nw_ctn, gw_ctn, cbm_ctn, hs_code, bg_bx
           FROM order_line_items
          WHERE sku = $1 AND (unit_price IS NOT NULL OR factory_price IS NOT NULL OR nw_ctn IS NOT NULL)
          ORDER BY id DESC LIMIT 1`,
        [sku]
      );
      return res.status(200).json({ ok: true, type, data: r.rows[0] || null });
    }
  } catch (e) {
    console.error("[internal/lookup]", type, e.message);
    return res.status(500).json({ ok: false, error: "query error" });
  }
}
