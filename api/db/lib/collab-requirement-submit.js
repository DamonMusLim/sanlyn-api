// POST /api/db/booking-collab/collab-requirement-submit
// 承运人要求任务(保函/申报等)提交。
//  - 外部货代(无 field_profile):上传已签署件 → status='submitted' + 签署人/时间/证据(免登录点一下法律太薄,必须落签署人+证据+时间)
//  - 内部 godview:核准/驳回 → status='accepted'/'rejected' + verified_by/at
// 铁律:文件走现有 /upload 存,这里只记签署证据链+状态流,不碰钱。
import crypto from "node:crypto";
import { notifyDamonCard } from "./notify-damon.js";

function rawToHash(raw) {
  return crypto.createHash("sha256").update(String(raw || "")).digest("hex");
}
const INTERNAL = new Set(["upstream_downstream", "shipping_booking"]);

export async function handleCollabRequirementSubmit(req, res, pool) {
  const b = req.body || {};
  if (!b.token) return res.status(400).json({ ok: false, error: "token 必填" });
  const taskId = parseInt(b.task_id, 10);
  if (!taskId) return res.status(400).json({ ok: false, error: "task_id 必填" });

  const { rows } = await pool.query(
    `SELECT meta FROM magic_links
       WHERE token_hash = $1 AND recipient_role = 'supplier_portal'
         AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(b.token)]);
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "链接数据异常" });
  const internal = INTERNAL.has(String(meta.field_profile || ""));

  // 任务必须属本票(防越权改别票任务)
  const { rows: tr } = await pool.query(
    `SELECT id, shipping_plan_id, task_type FROM shipment_requirement_tasks WHERE id = $1`, [taskId]);
  if (!tr.length || tr[0].shipping_plan_id !== planId)
    return res.status(403).json({ ok: false, error: "任务不属于本票" });

  if (internal) {
    // 核准/驳回
    const st = b.status === "rejected" ? "rejected" : "accepted";
    await pool.query(
      `UPDATE shipment_requirement_tasks
          SET status = $1, verified_by = $2, verified_at = now(),
              reject_reason = $3, updated_at = now()
        WHERE id = $4 AND shipping_plan_id = $5`,
      [st, String(meta.company_label || "internal").slice(0, 80),
       st === "rejected" ? String(b.reject_reason || "").slice(0, 500) : null, taskId, planId]);
    return res.json({ ok: true, status: st });
  }

  // 外部货代:提交签署件(文件已走 /upload 存,这里记证据链)
  const evidenceRef = b.evidence_ref ? String(b.evidence_ref).slice(0, 120) : null;
  await pool.query(
    `UPDATE shipment_requirement_tasks
        SET status = 'submitted',
            signed_by = $1, signed_title = $2, signed_at = now(),
            company_chop_present = $3,
            loi_template_version = COALESCE($4, loi_template_version),
            evidence_ref = COALESCE($5, evidence_ref),
            updated_at = now()
      WHERE id = $6 AND shipping_plan_id = $7`,
    [String(b.signed_by || "").slice(0, 80), String(b.signed_title || "").slice(0, 80),
     b.company_chop_present === true, b.loi_template_version ? String(b.loi_template_version).slice(0, 30) : null,
     evidenceRef, taskId, planId]);

  try {
    const { rows: pn } = await pool.query(`SELECT shipment_no FROM shipping_plans WHERE id = $1`, [planId]);
    notifyDamonCard({
      title: "货代提交承运人要求件",
      applicant: String((pn[0] || {}).shipment_no || planId), urgency: "普通", count: 1,
      url: `https://ai.sanlyn.cn/data`,
    }).catch(() => {});
  } catch (e) { /* 通知失败不阻断 */ }

  return res.json({ ok: true, status: "submitted", evidence_ref: evidenceRef });
}
