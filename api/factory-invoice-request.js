// api/factory-invoice-request.js
// GET /api/factory-invoice-request?token=<hex>
// 公开只读：凭 token 返回开票所需字段
import { getPool, setCors } from "./db.js";

const BUYER = {
  name: "厦门巴匕进出口有限公司",
  taxId: "91350206MA34RW3852",
};

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const token = (req.query.token || "").trim();
  if (!token) return res.status(400).json({ error: "token required" });

  try {
    const pool = getPool();

    // 1. 验证 token
    const tr = await pool.query(
      `SELECT token, company_code, purpose, expires_at
       FROM _idx_tokens
       WHERE token = $1 AND purpose = 'invoice_request' AND expires_at > NOW()`,
      [token]
    );
    if (!tr.rows.length) return res.status(404).json({ error: "Token invalid or expired" });

    const { company_code } = tr.rows[0];

    // 2. 从 customers.raw.activeTokens 找 orderNo + companyId
    const cr = await pool.query(
      `SELECT raw FROM customers WHERE company_code = $1`, [company_code]
    );
    const activeTokens = cr.rows[0]?.raw?.activeTokens || [];
    const rec = activeTokens.find(t => t.token === token && t.purpose === "invoice_request");
    if (!rec) return res.status(404).json({ error: "Token record not found" });

    const { orderNo, companyId } = rec;

    // 3. 拉订单
    const or = await pool.query(
      `SELECT order_no, contract_no, customer_po, products,
              total_amount, currency, etd
       FROM orders WHERE order_no = $1`, [orderNo]
    );
    if (!or.rows.length) return res.status(404).json({ error: "Order not found" });

    // 4. 拉工厂公司信息
    const fr = companyId ? await pool.query(
      `SELECT name_cn, name_en, tax_id FROM companies WHERE id = $1`, [companyId]
    ) : { rows: [] };

    // 记录访问
    // _idx_tokens has no last_used_at column; access logged via expires_at only

    const order = or.rows[0];
    const factory = fr.rows[0] || {};

    // 5. 优先从 OLI 取明细（有 nw_ctn）；OLI 空则降级到 products JSONB
    const oliR = await pool.query(
      `SELECT hs_code, declaration_name,
              SUM(qty_ctn)::int AS qty,
              MAX(COALESCE(factory_price, unit_price, 0)) AS unit_price,
              SUM(COALESCE(nw_ctn,0) * COALESCE(qty_ctn,0)) AS nw_kg,
              SUM(COALESCE(factory_subtotal, subtotal, 0)) AS subtotal
       FROM order_line_items
       WHERE order_id = (SELECT id FROM orders WHERE order_no = $1)
       GROUP BY hs_code, declaration_name
       ORDER BY MIN(sort_order), MIN(id)`,
      [orderNo]
    );

    let items;
    if (oliR.rows.length > 0) {
      items = oliR.rows.map(p => ({
        name: p.declaration_name || "",
        hsCode: p.hs_code || "",
        qty: Number(p.qty) || 0,
        unit: "CTN",
        unitPrice: Number(p.unit_price) || 0,
        nwKg: Math.round(Number(p.nw_kg) || 0),
        subtotal: Number(p.subtotal) || 0,
        currency: order.currency || "CNY",
      }));
    } else {
      const products = Array.isArray(order.products) ? order.products : [];
      items = products.map(p => ({
        name: p.declaration_name || p.name || p.product_name || "",
        hsCode: p.hs_code || p.hsCode || "",
        qty: p.qty || p.quantity || 0,
        unit: p.unit || "件",
        unitPrice: p.unit_price || p.unitPrice || 0,
        nwKg: null,
        subtotal: p.subtotal || p.totalPrice || 0,
        currency: p.currency || order.currency || "CNY",
      }));
    }

    return res.status(200).json({
      ok: true,
      invoiceType: "增值税专用发票",
      buyer: BUYER,
      seller: {
        name: factory.name_cn || factory.name_en || company_code,
        taxId: factory.tax_id || "",
      },
      order: {
        contractNo: order.contract_no,
        customerPo: order.customer_po,
        orderNo: order.order_no,
        etd: order.etd,
        currency: order.currency || "CNY",
        totalAmount: order.total_amount,
      },
      items,
      expiresAt: tr.rows[0].expires_at,
    });
  } catch (err) {
    console.error("[factory-invoice-request]", err);
    return res.status(500).json({ error: err.message });
  }
}
