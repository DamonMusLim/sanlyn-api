// /api/db/field-registry  — 字段约束注册表 · 实时填充率
// GET /api/db/field-registry  (requires JWT)
//
// Returns: { success, generated_at, count, data: FieldStat[] }
// FieldStat: { table, field, label, source, required, total, filled, fill_rate }

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const REGISTRY = [
  // ── orders ── original 4
  {
    table: "orders", field: "seller_code", label: "出口主体", source: "seller_profiles.code", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE seller_code IS NOT NULL AND seller_code <> '') AS filled
          FROM orders`,
  },
  {
    table: "orders", field: "trade_terms", label: "贸易条款", source: "manual / enum", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE raw->>'tradeTerms' IS NOT NULL AND raw->>'tradeTerms' <> '') AS filled
          FROM orders`,
  },
  {
    table: "orders", field: "company_code", label: "客户编号", source: "customers.company_code", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE company_code IS NOT NULL AND company_code <> '') AS filled
          FROM orders`,
  },
  {
    table: "orders", field: "factory", label: "工厂", source: "orders.raw.factory / factory_city", required: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (
                   WHERE (raw->>'factory' IS NOT NULL AND raw->>'factory' <> '')
                      OR (raw->>'factory_city' IS NOT NULL AND raw->>'factory_city' <> '')
                 ) AS filled
          FROM orders`,
  },
  // ── orders ── profit fields (C5 2026-05-10)
  {
    table: "orders", field: "factory_amount", label: "工厂应付总额", source: "orders.factory_amount", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE factory_amount IS NOT NULL AND factory_amount > 0) AS filled
          FROM orders`,
  },
  {
    table: "orders", field: "customer_amount", label: "客户应收总额", source: "orders.customer_amount", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE customer_amount IS NOT NULL AND customer_amount > 0) AS filled
          FROM orders`,
  },
  {
    table: "orders", field: "margin_amount", label: "利润差额", source: "orders.margin_amount", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE margin_amount IS NOT NULL) AS filled
          FROM orders`,
  },
  {
    table: "orders", field: "margin_pct", label: "利润率", source: "orders.margin_pct", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE margin_pct IS NOT NULL) AS filled
          FROM orders`,
  },
  {
    table: "orders", field: "first_issued_at", label: "首次签发时间", source: "orders.raw.first_issued_at", required: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE raw->>'first_issued_at' IS NOT NULL AND raw->>'first_issued_at' <> '') AS filled
          FROM orders`,
  },
  // ── orders ── three-tier pricing fields (C6 2026-05-10)
  {
    table: "orders", field: "factory_price_total", label: "工厂出货价", source: "三层定价 C6", required: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE factory_price_total IS NOT NULL AND factory_price_total > 0) AS filled
          FROM orders`,
  },
  {
    table: "orders", field: "middleman_code", label: "中间人编码", source: "orders.middleman_code", required: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE middleman_code IS NOT NULL AND middleman_code <> '') AS filled
          FROM orders`,
  },
  {
    table: "orders", field: "customer_price_total", label: "客户成交价", source: "三层定价 C6", required: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE customer_price_total IS NOT NULL AND customer_price_total > 0) AS filled
          FROM orders`,
  },
  // ── products ── original 2
  {
    table: "products", field: "hs_code", label: "HS Code", source: "products.hs_code (customs)", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE hs_code IS NOT NULL AND hs_code <> '') AS filled
          FROM products`,
  },
  {
    table: "products", field: "declaration_name", label: "申报品名", source: "products.declaration_name", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE declaration_name IS NOT NULL AND declaration_name <> '') AS filled
          FROM products`,
  },
  // ── shipping_plans ── original 2
  {
    table: "shipping_plans", field: "forwarder_partner", label: "货代", source: "shipping_plans.forwarder_partner", required: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE forwarder_partner IS NOT NULL AND forwarder_partner <> '') AS filled
          FROM shipping_plans`,
  },
  {
    table: "shipping_plans", field: "bl_no", label: "提单号", source: "shipping_plans.bl_no", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE bl_no IS NOT NULL AND bl_no <> '') AS filled
          FROM shipping_plans
          WHERE flow_status NOT IN ('draft', 'confirmed', 'cancelled') OR flow_status IS NULL`,
  },
  // ── shipping_plans ── collab fields (C5 2026-05-10)
  {
    table: "shipping_plans", field: "cargo_ready_date", label: "货好日期", source: "factory cargo-ready confirm", required: true,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE cargo_ready_date IS NOT NULL) AS filled
          FROM shipping_plans`,
  },
  {
    table: "shipping_plans", field: "collab_sheet_status", label: "协同表状态", source: "state machine", required: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE collab_sheet_status IS NOT NULL AND collab_sheet_status <> 'draft') AS filled
          FROM shipping_plans`,
  },
  {
    table: "shipping_plans", field: "factory_confirmed_at", label: "工厂确认时间", source: "factory magic-link", required: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE factory_confirmed_at IS NOT NULL) AS filled
          FROM shipping_plans`,
  },
  {
    table: "shipping_plans", field: "customer_confirmed_at", label: "客户确认时间", source: "customer magic-link", required: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE customer_confirmed_at IS NOT NULL) AS filled
          FROM shipping_plans`,
  },
  {
    table: "shipping_plans", field: "booking_sent_at", label: "托书发送时间", source: "BookingSheet submit", required: false,
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE booking_sent_at IS NOT NULL) AS filled
          FROM shipping_plans`,
  },
];

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  if (!requireAuth(req, res)) return;
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

    const pool = getPool();
    try {
      const data = await Promise.all(REGISTRY.map(async f => {
        try {
          const r = await pool.query(f.sql);
          const row = r.rows[0] || {};
          const total     = parseInt(row.total  || 0, 10);
          const filled    = parseInt(row.filled || 0, 10);
          const fill_rate = total > 0 ? parseFloat(((filled / total) * 100).toFixed(1)) : null;
          return { table: f.table, field: f.field, label: f.label, source: f.source, required: f.required, total, filled, fill_rate };
        } catch (e) {
          // Column may not exist on this env yet
          return { table: f.table, field: f.field, label: f.label, source: f.source, required: f.required, total: null, filled: null, fill_rate: null, error: e.message };
        }
      }));

      res.json({ success: true, generated_at: new Date().toISOString(), count: data.length, data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
}
