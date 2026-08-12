// Read-only draft reuse for port charges; never writes freight facts.
function clean(v, max = 120) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

async function recentPortChargeDraft(pool, plan, auth) {
  const carrier = clean(plan && (plan.carrier_code || plan.shipping_line), 80);
  const companyCode = clean(auth && auth.meta && (auth.meta.company_code || auth.meta.supplier_company_code), 80);
  const companyLabel = clean(auth && auth.meta && auth.meta.company_label, 160);
  if (!carrier || (!companyCode && !companyLabel)) return null;
  const { rows } = await pool.query(
    `SELECT cost_category, amount, currency, qty, unit_price, charge_basis, bl_no, updated_at
       FROM freight_supplier_bills
      WHERE COALESCE(rebill_status,'') <> 'voided'
        AND (cost_category ILIKE '%港杂%' OR canonical_category='港杂费' OR COALESCE(fob_scope,'')='port_charge')
        AND (($1<>'' AND supplier_company_code=$1) OR ($2<>'' AND supplier=$2))
        AND bl_no <> COALESCE($3,'')
        AND EXISTS (
          SELECT 1 FROM shipping_plans sp
           WHERE (sp.bl_no=freight_supplier_bills.bl_no OR sp.hbl_no=freight_supplier_bills.bl_no)
             AND (sp.carrier_code=$4 OR sp.shipping_line=$4)
        )
      ORDER BY updated_at DESC NULLS LAST, id DESC LIMIT 12`,
    [companyCode, companyLabel, plan.bl_no || plan.hbl_no || "", carrier]
  );
  if (!rows.length) return null;
  return {
    source_bl_no: rows[0].bl_no || null,
    source_updated_at: rows[0].updated_at || null,
    lines: rows.map(r => ({
      cost_category: r.cost_category || "港杂费",
      amount: r.amount == null ? null : Number(r.amount),
      currency: r.currency || "CNY",
      qty: r.qty == null ? null : Number(r.qty),
      unit_price: r.unit_price == null ? null : Number(r.unit_price),
      charge_basis: r.charge_basis || "per_bl",
    })),
  };
}

async function handlePortChargeDraft(req, res, pool) {
  const { rawToHash } = await import("./collab-shared.js");
  const token = req.query && req.query.token;
  if (!token) return res.status(400).json({ ok: false, error: "token 必填" });
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
      WHERE token_hash=$1 AND recipient_role='supplier_portal'
        AND expires_at>NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(token)]
  );
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const meta = typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta || {};
  const planId = parseInt(meta.shipment_id, 10);
  const plan = (await pool.query(
    `SELECT id, bl_no, hbl_no, carrier_code, shipping_line FROM shipping_plans WHERE id=$1 LIMIT 1`,
    [planId]
  )).rows[0];
  if (!plan) return res.status(404).json({ ok: false, error: "找不到出货计划" });
  const existing = await pool.query(
    `SELECT 1 FROM freight_supplier_bills
      WHERE bl_no=COALESCE($1,$2,'') AND COALESCE(rebill_status,'')<>'voided'
        AND (cost_category ILIKE '%港杂%' OR canonical_category='港杂费' OR COALESCE(fob_scope,'')='port_charge')
      LIMIT 1`,
    [plan.bl_no, plan.hbl_no]
  );
  if (existing.rows.length) return res.json({ ok: true, draft: null });
  const draft = await recentPortChargeDraft(pool, plan, { role: rows[0].recipient_role, meta });
  return res.json({ ok: true, draft });
}

export { recentPortChargeDraft, handlePortChargeDraft };
