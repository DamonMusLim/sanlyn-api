// /api/db/field-registry  — 字段约束注册表 · 实时填充率
// GET /api/db/field-registry  (requires JWT)
//
// Returns: { success, generated_at, count, data: FieldStat[] }
// FieldStat: { table, field, label, source, required, total, filled, fill_rate }

import { getPool, setCors } from "../db.js";
import { requireAuth }      from "../auth.js";

const FIELDS = [
  {
    table:    "orders",
    field:    "seller_code",
    label:    "出口主体",
    source:   "seller_profiles.code",
    required: true,
    sql:      `SELECT COUNT(*) AS total,
                      COUNT(*) FILTER (WHERE seller_code IS NOT NULL AND seller_code <> '') AS filled
               FROM orders`,
  },
  {
    table:    "orders",
    field:    "trade_terms",
    label:    "贸易条款",
    source:   "manual / enum",
    required: true,
    sql:      `SELECT COUNT(*) AS total,
                      COUNT(*) FILTER (WHERE raw->>'tradeTerms' IS NOT NULL AND raw->>'tradeTerms' <> '') AS filled
               FROM orders`,
  },
  {
    table:    "orders",
    field:    "company_code",
    label:    "客户编号",
    source:   "customers.company_code",
    required: true,
    sql:      `SELECT COUNT(*) AS total,
                      COUNT(*) FILTER (WHERE company_code IS NOT NULL AND company_code <> '') AS filled
               FROM orders`,
  },
  {
    table:    "orders",
    field:    "factory",
    label:    "工厂",
    source:   "orders.raw.factory / factory_city",
    required: false,
    sql:      `SELECT COUNT(*) AS total,
                      COUNT(*) FILTER (
                        WHERE (raw->>'factory' IS NOT NULL AND raw->>'factory' <> '')
                           OR (raw->>'factory_city' IS NOT NULL AND raw->>'factory_city' <> '')
                      ) AS filled
               FROM orders`,
  },
  {
    table:    "products",
    field:    "hs_code",
    label:    "HS Code",
    source:   "products.hs_code (customs filing)",
    required: true,
    sql:      `SELECT COUNT(*) AS total,
                      COUNT(*) FILTER (WHERE hs_code IS NOT NULL AND hs_code <> '') AS filled
               FROM products`,
  },
  {
    table:    "products",
    field:    "declaration_name",
    label:    "申报品名",
    source:   "products.declaration_name",
    required: true,
    sql:      `SELECT COUNT(*) AS total,
                      COUNT(*) FILTER (WHERE declaration_name IS NOT NULL AND declaration_name <> '') AS filled
               FROM products`,
  },
  {
    table:    "shipping_plans",
    field:    "forwarder_partner",
    label:    "货代",
    source:   "shipping_plans.forwarder_partner",
    required: false,
    sql:      `SELECT COUNT(*) AS total,
                      COUNT(*) FILTER (WHERE forwarder_partner IS NOT NULL AND forwarder_partner <> '') AS filled
               FROM shipping_plans`,
  },
  {
    table:    "shipping_plans",
    field:    "bl_no",
    label:    "提单号",
    source:   "shipping_plans.bl_no",
    required: true,
    sql:      `SELECT COUNT(*) AS total,
                      COUNT(*) FILTER (WHERE bl_no IS NOT NULL AND bl_no <> '') AS filled
               FROM shipping_plans WHERE flow_status NOT IN ('draft', 'confirmed', 'cancelled') OR flow_status IS NULL`,
  },
];

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  requireAuth(req, res, async () => {
    if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

    const pool = getPool();
    try {
      const data = await Promise.all(FIELDS.map(async f => {
        try {
          const r = await pool.query(f.sql);
          const row = r.rows[0] || {};
          const total  = parseInt(row.total  || 0, 10);
          const filled = parseInt(row.filled || 0, 10);
          const fill_rate = total > 0 ? parseFloat(((filled / total) * 100).toFixed(1)) : null;
          return { table: f.table, field: f.field, label: f.label, source: f.source, required: f.required, total, filled, fill_rate };
        } catch (e) {
          return { table: f.table, field: f.field, label: f.label, source: f.source, required: f.required, total: null, filled: null, fill_rate: null, error: e.message };
        }
      }));

      res.json({ success: true, generated_at: new Date().toISOString(), count: data.length, data });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}
