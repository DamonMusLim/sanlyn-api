import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 对账主表行内编辑: plan字段按BL改shipping_plans, order字段按PO改orders
const PLAN_FIELDS = { freight_sale_usd: "freight_sale_usd", freight_sale_cny: "freight_sale_cny" };
const ORDER_FIELDS = { goods_cost: "factory_total_amount", goods_sale: "customer_amount" };

export default async function handler(req, res) {
  setCors(req, res, "PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "PATCH") return res.status(405).json({ success: false, error: "PATCH required" });
  if (!requireAuth(req, res)) return;
  const { kind, key, field, value } = req.body || {};
  const num = Number(value);
  if (!key || !Number.isFinite(num) || num < 0) return res.status(400).json({ success: false, error: "key/value invalid" });
  const pool = getPool();
  try {
    let r;
    if (kind === "plan" && PLAN_FIELDS[field]) {
      r = await pool.query(
        `UPDATE shipping_plans SET ${PLAN_FIELDS[field]}=$1, updated_at=now()
          WHERE BTRIM(bl_no)=BTRIM($2) AND deleted_at IS NULL RETURNING bl_no`, [num, key]);
    } else if (kind === "order" && ORDER_FIELDS[field]) {
      r = await pool.query(
        `UPDATE orders SET ${ORDER_FIELDS[field]}=$1, updated_at=now()
          WHERE order_no=$2 AND deleted_at IS NULL RETURNING order_no`, [num, key]);
    } else {
      return res.status(400).json({ success: false, error: "bad kind/field" });
    }
    if (!r.rowCount) return res.status(404).json({ success: false, error: "not found" });
    res.status(200).json({ success: true, updated: r.rowCount });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
}
