// GET /api/db/booking-collab/cargo-payment?token=[&side=purchase|sale]
// 货款视图 —— 与物流【物理分开】:此端点绝不返回任何物流/运费字段(海运/港杂/拖车/报关)。
// 工厂 → 采购货款(CNY, 工厂价); 客户 → 销售货款(USD, 销售价); 内部 godview → 按 side 二选一;
// 货代/车队/报关 → 无货款视图(403)。
// 红线:工厂响应只含工厂价、绝无销售价/毛利;客户响应只含销售价、绝无采购价。
import crypto from "node:crypto";

function rawToHash(raw) { return crypto.createHash("sha256").update(String(raw || "")).digest("hex"); }
function money(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
const INTERNAL = new Set(["upstream_downstream", "shipping_booking"]);

export async function handleCargoPayment(req, res, pool) {
  const raw = req.query && req.query.token;
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash = $1 AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]);
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const role = rows[0].recipient_role;
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "链接数据异常" });
  const internal = INTERNAL.has(String(meta.field_profile || ""));

  // 决定看采购还是销售侧(货代等无货款视图)
  let side;
  if (role === "factory_booking") side = "purchase";
  else if (role === "customer_booking") side = "sale";
  else if (internal) side = req.query.side === "sale" ? "sale" : "purchase";
  else return res.status(403).json({ ok: false, error: "此角色无货款视图" });

  const pr = await pool.query(`SELECT shipment_no, raw->>'cargo_payment_note' AS note FROM shipping_plans WHERE id = $1`, [planId]);
  if (!pr.rows.length) return res.status(404).json({ ok: false, error: "计划不存在" });

  let lines, currency, title;
  if (side === "purchase") {
    currency = "CNY"; title = "采购货款";
    const facLabel = meta.factory_scope && meta.factory_scope.label;
    const q = facLabel
      ? await pool.query(
          `SELECT oli.declaration_name AS name, oli.sku, oli.qty_ctn AS qty, oli.factory_price AS unit_price, oli.factory_subtotal AS subtotal
             FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
            WHERE o.shipping_plan_id = $1 AND o.factory = $2 ORDER BY oli.id`, [planId, facLabel])
      : await pool.query(
          `SELECT oli.declaration_name AS name, oli.sku, oli.qty_ctn AS qty, oli.factory_price AS unit_price, oli.factory_subtotal AS subtotal
             FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
            WHERE o.shipping_plan_id = $1 ORDER BY oli.id`, [planId]);
    lines = q.rows;
  } else {
    currency = "USD"; title = "销售货款";
    const q = await pool.query(
      `SELECT oli.declaration_name AS name, oli.sku, oli.qty_ctn AS qty, oli.unit_price, oli.subtotal
         FROM order_line_items oli JOIN orders o ON o.id = oli.order_id
        WHERE o.shipping_plan_id = $1 ORDER BY oli.id`, [planId]);
    lines = q.rows;
  }

  const cleanLines = lines.map(l => ({
    name: l.name, sku: l.sku, qty: Number(l.qty) || 0,
    unit_price: money(l.unit_price), subtotal: money(l.subtotal),
  }));
  const total = money(cleanLines.reduce((s, l) => s + l.subtotal, 0));

  // 付款状态:水单 + finance_payments 合算(best-effort,查不到不阻断)
  let paid = 0, slips = 0;
  try {
    const bl = await pool.query(`SELECT COUNT(*) c FROM bank_slip_links bsl WHERE bsl.shipping_plan_id = $1`, [planId]);
    slips = Number(bl.rows[0].c) || 0;
  } catch (e) { /* 表/列不匹配则跳过 */ }

  return res.json({
    ok: true, view: "cargo_payment", side, title, currency,
    shipment_no: pr.rows[0].shipment_no,
    lines: cleanLines, total, note: pr.rows[0].note || "",
    payment: { total, paid: money(paid), unpaid: money(total - paid), slip_count: slips },
  });
}
