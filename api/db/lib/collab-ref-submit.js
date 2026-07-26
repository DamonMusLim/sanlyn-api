// POST /api/db/booking-collab/collab-ref-submit
// 货代在确认单上改「SO/BL 引用单号」。默认=shipment_no(我方内部号)。
// 铁律：
//  - 外部(货代, 无 field_profile) → 只写 staging(raw.so_bl_ref_pending)待我方核对；
//  - 内部(field_profile=upstream_downstream/shipping_booking godview) → 直接落 raw.so_bl_reference(apply)并清 pending；
//  - 绝不改 shipment_no 本身(内部编号体系不被外部污染)。
import crypto from "node:crypto";
import { notifyDamonCard } from "./notify-damon.js";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}

export async function handleCollabRefSubmit(req, res, pool) {
  const { token: raw, so_bl_reference } = req.body || {};
  if (!raw) return res.status(400).json({ ok: false, error: "token 必填" });
  const ref = String(so_bl_reference || "").trim().slice(0, 40);
  if (!ref) return res.status(400).json({ ok: false, error: "引用单号必填" });

  const { rows } = await pool.query(
    `SELECT meta FROM magic_links
       WHERE token_hash = $1 AND recipient_role = 'supplier_portal'
         AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(raw)]);
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "链接数据异常" });

  const fp = String(meta.field_profile || "");
  const internal = fp === "upstream_downstream" || fp === "shipping_booking";
  const by = meta.company_label || fp || "forwarder";
  const at = new Date().toISOString();

  if (internal) {
    // apply：落确认值 + 清 pending（内部 godview 核对确认）
    await pool.query(
      `UPDATE shipping_plans
          SET raw = (COALESCE(raw, '{}'::jsonb)
                     || jsonb_build_object('so_bl_reference', $1::text)) - 'so_bl_ref_pending',
              updated_at = now()
        WHERE id = $2`,
      [ref, planId]);
    return res.json({ ok: true, applied: true, so_bl_reference: ref });
  }

  // staging：外部提议进 pending（单值，最新覆盖），待我方核对
  await pool.query(
    `UPDATE shipping_plans
        SET raw = COALESCE(raw, '{}'::jsonb)
                  || jsonb_build_object('so_bl_ref_pending',
                       jsonb_build_object('value', $1::text, 'by', $2::text, 'at', $3::text, 'status', 'pending')),
            updated_at = now()
      WHERE id = $4`,
    [ref, by, at, planId]);

  try {
    const { rows: pn } = await pool.query(`SELECT shipment_no FROM shipping_plans WHERE id = $1`, [planId]);
    const sm = (pn[0] || {}).shipment_no || planId;
    notifyDamonCard({
      title: "货代改SO/BL引用单号",
      applicant: String(sm), urgency: "普通", count: 1,
      url: `https://ai.sanlyn.cn/data`,
    }).catch(() => {});
  } catch (e) { /* 通知失败不阻断 */ }

  return res.json({ ok: true, pending: ref });
}
