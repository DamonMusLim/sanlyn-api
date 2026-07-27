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

  const pr = await pool.query(
    `SELECT shipment_no, issuing_company, customer, customer_en,
            raw->>'cargo_payment_note' AS note,
            raw->'cargo_payment_confirms' AS confirms,
            (raw->>'customs_confirmed')::boolean AS customs_confirmed,
            raw->'broker_ack' AS broker_ack
       FROM shipping_plans WHERE id = $1`, [planId]);
  if (!pr.rows.length) return res.status(404).json({ ok: false, error: "计划不存在" });
  const OUR = "上海洋宝宝国际物流有限公司";  // 我方主体

  // ── 门控:报关资料确认后才显示开票资料(最稳,报关没定不急着开票)──
  const ack = pr.rows[0].broker_ack || {};
  const customsConfirmed = pr.rows[0].customs_confirmed === true || ack.confirmed === true;
  if (!customsConfirmed) {
    return res.json({
      ok: true, view: "cargo_payment", side, gated: true,
      gate_reason: "报关资料确认后才开放开票资料",
      shipment_no: pr.rows[0].shipment_no,
    });
  }

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

  const taxRate = 0.13;
  const cleanLines = lines.map(l => ({
    name: l.name, sku: l.sku, qty: Number(l.qty) || 0,
    unit_price: money(l.unit_price), amount: money(l.subtotal),           // 金额(不含税)
    tax_rate: taxRate, tax: money(Number(l.subtotal) * taxRate),          // 税额=金额×13%(图1口径)
  }));
  const total = money(cleanLines.reduce((s, l) => s + l.amount, 0));      // 金额合计(不含税)
  const taxTotal = money(cleanLines.reduce((s, l) => s + l.tax, 0));
  const grandTotal = money(total + taxTotal);                            // 价税合计
  // 开票双方(采购:工厂开给我方 / 销售:我方开给客户)
  const facLabel2 = meta.factory_scope && meta.factory_scope.label;
  const cust = pr.rows[0].customer || pr.rows[0].customer_en || "客户";
  const seller = side === "purchase" ? (facLabel2 || "工厂") : OUR;
  const buyer = side === "purchase" ? (pr.rows[0].issuing_company || OUR) : cust;
  // 价格确认:比对该侧已确认快照,有改动=待重新确认
  const confirmed = (pr.rows[0].confirms || {})[side] || null;
  const changed = confirmed ? Math.abs(Number(confirmed.grand_total || 0) - grandTotal) > 0.01 : null;

  // 付款状态:水单 + finance_payments 合算(best-effort,查不到不阻断)
  let paid = 0, slips = 0;
  try {
    const bl = await pool.query(`SELECT COUNT(*) c FROM bank_slip_links bsl WHERE bsl.shipping_plan_id = $1`, [planId]);
    slips = Number(bl.rows[0].c) || 0;
  } catch (e) { /* 表/列不匹配则跳过 */ }

  return res.json({
    ok: true, view: "cargo_payment", side, title, currency,
    shipment_no: pr.rows[0].shipment_no,
    buyer, seller, direction: side === "purchase" ? "对方开给我方" : "我方开给对方",
    lines: cleanLines, amount_total: total, tax_total: taxTotal, grand_total: grandTotal,
    note: pr.rows[0].note || "",
    price_confirm: { confirmed_at: confirmed && confirmed.at || null, changed, confirmed_total: confirmed && confirmed.grand_total || null },
    payment: { total: grandTotal, paid: money(paid), unpaid: money(grandTotal - paid), slip_count: slips },
  });
}

// POST /api/db/booking-collab/cargo-payment-confirm  {token, side?, grand_total}
// 价格确认:该方确认当前看到的价税合计,存快照(按侧)。之后价格有改动 → cargo-payment 返回 changed=true 待重新确认。
export async function handleCargoPaymentConfirm(req, res, pool) {
  const b = req.body || {};
  if (!b.token) return res.status(400).json({ ok: false, error: "token 必填" });
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
       WHERE token_hash = $1 AND recipient_role IN ('factory_booking','customer_booking','supplier_portal')
         AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(b.token)]);
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const role = rows[0].recipient_role;
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "链接数据异常" });
  const internal = INTERNAL.has(String(meta.field_profile || ""));
  const side = role === "factory_booking" ? "purchase" : role === "customer_booking" ? "sale" : (internal ? (b.side === "sale" ? "sale" : "purchase") : null);
  if (!side) return res.status(403).json({ ok: false, error: "此角色无货款确认" });
  const gt = money(b.grand_total);
  if (!(gt >= 0)) return res.status(400).json({ ok: false, error: "金额无效" });
  await pool.query(
    `UPDATE shipping_plans
        SET raw = COALESCE(raw, '{}'::jsonb) || jsonb_build_object(
              'cargo_payment_confirms',
              COALESCE(raw->'cargo_payment_confirms', '{}'::jsonb) ||
              jsonb_build_object($1::text, jsonb_build_object('grand_total', $2::numeric, 'at', $3::text, 'by', $4::text))),
            updated_at = now()
      WHERE id = $5`,
    [side, gt, new Date().toISOString(), role, planId]);
  return res.json({ ok: true, side, confirmed_total: gt });
}
