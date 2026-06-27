// GET /api/db/purchase-invoice?id=ORDER_ID
// 采购开票申请数据接口
// 返回: 订单头 + OLI明细(含发票价/报关价/数量/NW) + 付款记录 + AI审核结果
// AI规则: factory_price <= declare_amount_per_box → 通过；否则红标

import { requireAuth } from "../auth.js";
import { getPool } from "../db.js";

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const pool = getPool();
  const orderId = req.query.id;
  if (!orderId) return res.status(400).json({ error: "id required" });

  try {
    // 订单头
    const orderRes = await pool.query(`
      SELECT id, order_no, contract_no, customer_po, company_code, customer,
             currency, status, etd, total_amount
      FROM orders WHERE id = $1 LIMIT 1
    `, [orderId]);
    if (!orderRes.rows.length) return res.status(404).json({ error: "order not found" });
    const order = orderRes.rows[0];

    // OLI明细
    const oliRes = await pool.query(`
      SELECT oli.id, oli.declaration_name, oli.hs_code, oli.product_name,
             oli.qty_ctn, oli.nw_ctn,
             ROUND(oli.qty_ctn * oli.nw_ctn, 2) AS total_nw,
             oli.factory_price, oli.factory_subtotal,
             oli.declare_amount_per_box,
             ROUND(oli.declare_amount_per_box * oli.qty_ctn, 2) AS decl_total,
             oli.unit_price, oli.subtotal,
             oli.vat_rate, oli.sort_order
      FROM order_line_items oli
      WHERE oli.order_id = $1
      ORDER BY oli.sort_order, oli.id
    `, [orderId]);

    // AI审核: factory_price <= declare_amount_per_box
    const lines = oliRes.rows.map(r => ({
      ...r,
      audit_pass: parseFloat(r.factory_price) <= parseFloat(r.declare_amount_per_box),
      margin: parseFloat(r.declare_amount_per_box) - parseFloat(r.factory_price),
    }));
    const allPass = lines.every(l => l.audit_pass);

    // 发票汇总
    const invoiceExcl = lines.reduce((s, l) => s + parseFloat(l.factory_subtotal || 0), 0);
    const vatRate = parseFloat(lines[0]?.vat_rate || 0.13);
    const vatAmt = Math.round(invoiceExcl * vatRate * 100) / 100;
    const invoiceIncl = Math.round((invoiceExcl + vatAmt) * 100) / 100;

    // 付款记录
    const payRes = await pool.query(`
      SELECT id, amount, currency, payment_date, status, pay_type, direction, bank_ref
      FROM finance_payments
      WHERE (contract_no = $1 OR order_no = $2)
        AND direction = 'out'
      ORDER BY payment_date
    `, [order.contract_no, order.order_no]);

    const paidTotal = payRes.rows.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
    const pendingAmt = Math.round((invoiceIncl - paidTotal) * 100) / 100;

    res.json({
      order,
      lines,
      audit: { all_pass: allPass, pass_count: lines.filter(l => l.audit_pass).length, total: lines.length },
      invoice: {
        excl_tax: Math.round(invoiceExcl * 100) / 100,
        vat_rate: vatRate,
        vat_amt: vatAmt,
        incl_tax: invoiceIncl,
      },
      payments: payRes.rows,
      payment_summary: {
        invoice_total: invoiceIncl,
        paid: Math.round(paidTotal * 100) / 100,
        pending: pendingAmt,
      },
    });
  } catch (e) {
    console.error("[purchase-invoice]", e);
    res.status(500).json({ error: e.message });
  }
}
