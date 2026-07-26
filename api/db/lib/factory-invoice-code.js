// GET /api/db/booking-collab/factory-invoice-code?token=
// 工厂协同(factory_booking magic_link)→ 解析工厂编码 → 复用/生成 invoice_links 开票门户 code
// → 返回图1 开票模板 URL(factory-invoice.html?c=)。让工厂在协同里点开一整份完整开票模板去确认。
// 复用现有 invoice_links(purpose=portal,scope_type=factory)+ factory-portal,不改鉴权、不另造 token。
import crypto from "node:crypto";

function rawToHash(raw) { return crypto.createHash("sha256").update(String(raw || "")).digest("hex"); }

export async function handleFactoryInvoiceCode(req, res, pool) {
  const raw = req.query && req.query.token;
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });
  const { rows } = await pool.query(
    `SELECT meta FROM magic_links
       WHERE token_hash = $1 AND recipient_role = 'factory_booking'
         AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]);
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  const facLabel = meta.factory_scope && meta.factory_scope.label;
  if (!planId || !facLabel) return res.status(400).json({ ok: false, error: "链接缺工厂 scope" });

  // 解析工厂编码 + 一个订单号(scope_value=factory code)
  const fc = await pool.query(
    `SELECT o.raw->>'factoryCompanyCode' AS code, o.order_no
       FROM orders o
      WHERE o.shipping_plan_id = $1 AND o.factory = $2
        AND COALESCE(o.raw->>'factoryCompanyCode','') <> ''
      ORDER BY o.id LIMIT 1`, [planId, facLabel]);
  const factoryCode = fc.rows[0] && fc.rows[0].code;
  const orderNo = (fc.rows[0] && fc.rows[0].order_no) || "";
  if (!factoryCode) return res.status(404).json({ ok: false, error: "未找到该工厂编码" });

  // 复用未过期的门户 code,没有才生成(照抄 factory-invoice-reconcile 写法)
  const found = await pool.query(
    `SELECT code FROM invoice_links
      WHERE purpose = 'portal' AND scope_type = 'factory' AND scope_value = $1 AND expires_at > NOW()
      ORDER BY expires_at DESC LIMIT 1`, [factoryCode]);
  let code = found.rows[0] && found.rows[0].code;
  if (!code) {
    const prefix = (String(factoryCode).match(/[a-z]/ig) || []).join("").toLowerCase().slice(0, 2) || "fx";
    code = `${prefix}${crypto.randomBytes(6).toString("hex")}`;
    await pool.query(
      `INSERT INTO invoice_links (code, purpose, scope_type, scope_value, order_no, expires_at, created_by, created_at)
       VALUES ($1, 'portal', 'factory', $2, $3, NOW() + interval '1 year', 'collab-factory', NOW())`,
      [code, factoryCode, orderNo]);
  }

  return res.json({
    ok: true,
    url: `/public/factory-invoice.html?c=${encodeURIComponent(code)}` + (orderNo ? `&order_no=${encodeURIComponent(orderNo)}` : ""),
    factory_code: factoryCode,
  });
}
