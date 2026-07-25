// POST /api/db/booking-collab/collab-quote-submit
// 货代/承运方在确认单里填「自己的收费报价」(拖车/报关/港杂)。
// 铁律：这是对方报的「他收我们的价」= 我方成本，一律进 staging(shipping_plans.raw.collab_quotes)
// 待 Sanlyn 人工核价后才落 freight_supplier_bills。绝不在此写 sale_amount / 任何财务真值。
import crypto from "node:crypto";

const SEG_OK = new Set(["truck", "customs", "local", "ocean", "port_charge"]);

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

export async function handleCollabQuoteSubmit(req, res, pool) {
  const body = req.body || {};
  const raw = body.token;
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });

  // 兼容单条 {segment,amount} 与数组 {quotes:[...]}
  let quotes = Array.isArray(body.quotes) ? body.quotes : null;
  if (!quotes && body.segment) quotes = [{ segment: body.segment, amount: body.amount, currency: body.currency }];
  if (!Array.isArray(quotes) || !quotes.length)
    return res.status(400).json({ ok: false, error: "quotes 必填" });

  const { rows } = await pool.query(
    `SELECT meta FROM magic_links
       WHERE token_hash = $1 AND recipient_role = 'supplier_portal'
         AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]);
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "链接数据异常" });
  const allowedSegs = Array.isArray(meta.segments) ? meta.segments : ["ocean", "truck", "customs"];

  const nowIso = new Date().toISOString();
  const by = meta.company_label || meta.field_profile || "forwarder";
  const staged = [];
  const rejected = [];
  for (const q of quotes) {
    const seg = String((q && q.segment) || "").toLowerCase().trim();
    const amt = Number(q && q.amount);
    if (!SEG_OK.has(seg)) { rejected.push({ q, why: "费段不识别" }); continue; }
    if (!Number.isFinite(amt) || amt < 0) { rejected.push({ q, why: "金额非法" }); continue; }
    // 权限：只能报自己承包的费段(local/港杂视同 truck/customs 之外的落地费，放行)
    if (seg !== "local" && seg !== "port_charge" && !allowedSegs.includes(seg)) {
      rejected.push({ q, why: `贵司端口未承包 ${seg} 段` }); continue;
    }
    staged.push({
      segment: seg,
      name: String((q && q.name) || "").slice(0, 60) || null,
      amount: Math.round(amt * 100) / 100,
      currency: String((q && q.currency) || "CNY").slice(0, 8).toUpperCase(),
      by, status: "pending", at: nowIso,
    });
  }
  if (!staged.length)
    return res.status(400).json({ ok: false, error: "无有效报价", rejected });

  // append 进 raw.collab_quotes（pending 队列，非财务真值），带 WHERE id 定位本票
  await pool.query(
    `UPDATE shipping_plans
        SET raw = COALESCE(raw, '{}'::jsonb) ||
                  jsonb_build_object('collab_quotes',
                    COALESCE(raw->'collab_quotes', '[]'::jsonb) || $1::jsonb),
            updated_at = now()
      WHERE id = $2`,
    [JSON.stringify(staged), planId]);

  try {
    const { rows: pn } = await pool.query(`SELECT shipment_no FROM shipping_plans WHERE id = $1`, [planId]);
    const sm = (pn[0] || {}).shipment_no || planId;
    const txt = staged.map(s => `${s.segment} ${s.currency}${s.amount}`).join(" · ");
    fetch("https://ntfy.sh/sanlyn-damon-alert", {
      method: "POST",
      headers: { Title: encodeURIComponent(`货代报价 ${sm}`), Priority: "default" },
      body: `货代在确认单填了报价（待核价）：\n${txt}`,
    }).catch(() => {});
  } catch (e) { /* 通知失败不阻断 */ }

  return res.json({ ok: true, staged: staged.length, rejected });
}
