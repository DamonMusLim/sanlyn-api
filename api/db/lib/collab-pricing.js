// collab-pricing.js — extracted from booking-collab.js (structural split 2026-07-31, zero behavior change)
import { requireAuth } from "../../auth.js";
import { APP_BASE, genRaw, rawToHash } from "./collab-shared.js";

// ── GET /collab-pricing — 洋宝宝费用成本/销售视图（只读）──
async function handleCollabPricing(req, res, pool) {
  const { token: raw } = req.query || {};
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });
  const { rows: ml } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'supplier_portal'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]);
  if (!ml.length) return res.status(403).json({ ok: false, error: "链接无效" });
  const meta = typeof ml[0].meta === "string" ? JSON.parse(ml[0].meta) : ml[0].meta;
  // 仅内部 field_profile 可看运费成本/销售+下游客户；纯 ocean 供应商不得看销售价/加价
  const seesPricing = meta.field_profile === "shipping_booking" || meta.field_profile === "upstream_downstream";
  if (!seesPricing) return res.status(403).json({ ok: false, error: "无权访问运费价格" });
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "plan 无效" });

  // 从 shipping_plans 取 bl_no + 客户信息
  const { rows: plan } = await pool.query(
    `SELECT bl_no, hbl_no, trucking_arrange, customs_arrange, customer_en, customer,
            pol, pod, freight_term
     FROM shipping_plans WHERE id = $1 LIMIT 1`, [planId]);
  if (!plan.length) return res.status(404).json({ ok: false, error: "计划不存在" });
  const blNo = plan[0].bl_no || plan[0].hbl_no;
  if (!blNo) return res.json({ ok: true, items: [], note: "BL 尚未录入" });
  const customerName = plan[0].customer_en || plan[0].customer || "";

  // 自理段判断
  const selfHandled = {
    trucking: plan[0].trucking_arrange === "factory" || plan[0].trucking_arrange === "self" || plan[0].trucking_arrange === "babi",
    customs:  plan[0].customs_arrange  === "factory" || plan[0].customs_arrange  === "self" || plan[0].customs_arrange  === "babi",
  };

  const { rows: bills } = await pool.query(
    `SELECT id, cost_category, charge_basis, unit_price, qty, amount, sale_amount,
            currency, supplier, incoterm, rebill_to_name
       FROM freight_supplier_bills
      WHERE bl_no = $1
      ORDER BY created_at`, [blNo]);

  const items = bills.map(b => {
    const amt  = b.amount      != null ? Number(b.amount)      : null;
    const sale = b.sale_amount != null ? Number(b.sale_amount) : null;
    return {
      id:            b.id,
      cost_category: b.cost_category,
      charge_basis:  b.charge_basis || "per_bl",
      unit_price:    b.unit_price != null ? Number(b.unit_price) : null,
      qty:           b.qty        != null ? Number(b.qty)        : null,
      amount:        amt,
      sale_amount:   sale,
      currency:      b.currency || "CNY",
      supplier:      b.supplier,
      incoterm:      b.incoterm,
      rebill_to:     b.rebill_to_name || customerName,
      self_handled:  (b.cost_category === "trucking" && selfHandled.trucking) ||
                     (b.cost_category === "customs_declaration" && selfHandled.customs),
    };
  });

  // 分币种汇总
  const makeTotals = (cur) => items.filter(i => i.currency === cur).reduce(
    (acc, i) => ({ cost: acc.cost + (i.amount||0), sales: acc.sales + (i.sale_amount||0) }),
    { cost: 0, sales: 0 }
  );
  const totals = { USD: makeTotals("USD"), CNY: makeTotals("CNY") };

  return res.json({ ok: true, bl_no: blNo, customer: customerName,
                    pol: plan[0].pol, pod: plan[0].pod, freight_term: plan[0].freight_term,
                    items, totals, self_handled: selfHandled });
}

// ── GET /collab-order-pricing — 巴匕采购/销售价视图（只读）──
async function handleCollabOrderPricing(req, res, pool) {
  const { token: raw } = req.query || {};
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });
  const { rows: ml } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'supplier_portal'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]);
  if (!ml.length) return res.status(403).json({ ok: false, error: "链接无效" });
  const meta = typeof ml[0].meta === "string" ? JSON.parse(ml[0].meta) : ml[0].meta;
  if (meta.field_profile !== "upstream_downstream")
    return res.status(403).json({ ok: false, error: "无权访问价格" });
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "plan 无效" });

  // 拉本票关联订单的行项目（采购价=settle_after_tax_per_unit，销售价=unit_price）
  const { rows } = await pool.query(
    `SELECT o.order_no, o.customer AS customer,
            oli.product_name, oli.sku AS product_sku,
            oli.qty_ctn AS quantity, oli.unit,
            oli.factory_price    AS purchase_unit_price,
            oli.unit_price       AS sales_unit_price,
            oli.subtotal         AS sales_total,
            oli.factory_subtotal AS purchase_total,
            (oli.subtotal - oli.factory_subtotal) AS gross_profit,
            o.currency
       FROM orders o
       JOIN order_line_items oli ON oli.order_id = o.id
      WHERE o.shipping_plan_id = $1
      ORDER BY o.order_no, oli.id`, [planId]);

  const totals = rows.reduce((acc, r) => ({
    purchase: acc.purchase + (Number(r.purchase_total) || 0),
    sales:    acc.sales    + (Number(r.sales_total)    || 0),
    profit:   acc.profit   + (Number(r.gross_profit)   || 0),
  }), { purchase: 0, sales: 0, profit: 0 });

  return res.json({ ok: true, items: rows, totals });
}

// ── POST /collab-pricing-submit — 洋宝宝补录运费销售价（写 freight_supplier_bills.sale_amount）──
async function handleCollabPricingSubmit(req, res, pool) {
  const { token: raw, updates } = req.body || {};
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });
  if (!Array.isArray(updates) || !updates.length)
    return res.status(400).json({ ok: false, error: "updates 必填" });

  // 校验 token（与 handleCollabPricing 完全一致）
  const { rows: ml } = await pool.query(
    `SELECT meta FROM magic_links
      WHERE token_hash = $1
        AND recipient_role = 'supplier_portal'
        AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]);
  if (!ml.length) return res.status(403).json({ ok: false, error: "链接无效" });
  const meta = typeof ml[0].meta === "string" ? JSON.parse(ml[0].meta) : ml[0].meta;
  // 仅 upstream_downstream godview 可补录运费销售价；shipping_booking 只读。
  if (meta.field_profile !== "upstream_downstream")
    return res.status(403).json({ ok: false, error: "无权补录运费价格" });
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "plan 无效" });

  // 取本票 bl_no（只能改本票的账单行，防越权）
  const { rows: plan } = await pool.query(
    `SELECT bl_no, hbl_no FROM shipping_plans WHERE id = $1 LIMIT 1`, [planId]);
  if (!plan.length) return res.status(404).json({ ok: false, error: "计划不存在" });
  const blNo = plan[0].bl_no || plan[0].hbl_no;
  if (!blNo) return res.status(400).json({ ok: false, error: "BL 尚未录入" });

  // 逐条更新：bill id 必须属于本票 bl_no，sale_amount 必须是非负数字
  let updated = 0;
  for (const u of updates) {
    if (!u || !u.bill_id) continue;
    const sale = Number(u.sale_amount);
    if (!isFinite(sale) || sale < 0) continue;
    const r = await pool.query(
      `UPDATE freight_supplier_bills
          SET sale_amount = $1, updated_at = NOW()
        WHERE id = $2 AND bl_no = $3`,
      [sale, u.bill_id, blNo]);
    updated += r.rowCount || 0;
  }

  return res.json({ ok: true, updated });
// ── POST /factory-self-token  (工厂 JWT 自助生成协同表链接) ──────────────────
async function handleFactoryToken(req, res, pool) {
  if (!requireAuth(req, res)) return;
  const companyCodes = ((req.user.companyCodes && req.user.companyCodes.length)
    ? req.user.companyCodes
    : req.user.companyCode ? [req.user.companyCode] : []
  ).map(c => String(c).toLowerCase());
  if (!companyCodes.length) return res.status(403).json({ ok: false, error: "no_scope" });

  const body = req.body || {};
  const shipping_plan_id = parseInt(body.shipping_plan_id);
  if (!shipping_plan_id || isNaN(shipping_plan_id))
    return res.status(400).json({ ok: false, error: "shipping_plan_id required" });

  const ownerRow = await pool.query(
    `SELECT COUNT(*) AS cnt FROM orders
     WHERE shipping_plan_id = $1
       AND LOWER(raw->>'factoryCompanyCode') = ANY($2::text[])`,
    [shipping_plan_id, companyCodes]
  );
  if (parseInt(ownerRow.rows[0]?.cnt || 0) === 0)
    return res.status(403).json({ ok: false, error: "scope_mismatch" });

  const rawTok = genRaw();
  const hash = rawToHash(rawTok);
  const factoryLabel = companyCodes[0].toUpperCase();
  await pool.query(
    `INSERT INTO magic_links (token_hash, recipient_role, meta, expires_at, access_log, created_at)
     VALUES ($1, 'factory_booking', $2, NOW() + INTERVAL '7 days', '[]'::jsonb, NOW())`,
    [hash, JSON.stringify({ shipment_id: shipping_plan_id, factory_scope: { label: factoryLabel } })]
  );

  return res.json({ ok: true, link: `${APP_BASE}/kp?c=${rawTok}`, expires_in: "7 days" });
}

}

export { handleCollabPricing, handleCollabOrderPricing, handleCollabPricingSubmit };
