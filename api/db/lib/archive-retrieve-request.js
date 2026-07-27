// POST /api/db/booking-collab/archive-retrieve-request
// 归档图片(转NAS后)提取申请:记录 谁/哪票/要哪些图/发到哪(邮箱或公司人员)+ 事件。
// 真·从NAS取图+邮件发送 等邮件渠道接通;此处先落申请队列(status=requested)+服务号提醒。
import crypto from "node:crypto";
import { notifyDamonCard } from "./notify-damon.js";

function rawToHash(raw) { return crypto.createHash("sha256").update(String(raw || "")).digest("hex"); }
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handleArchiveRetrieveRequest(req, res, pool) {
  const b = req.body || {};
  if (!b.token) return res.status(400).json({ ok: false, error: "token 必填" });
  const { rows } = await pool.query(
    `SELECT recipient_role, meta FROM magic_links
       WHERE token_hash = $1
         AND recipient_role IN ('factory_booking','customer_booking','supplier_portal','trucking_booking','broker_booking')
         AND expires_at > NOW() AND revoked_at IS NULL LIMIT 1`,
    [rawToHash(b.token)]);
  if (!rows.length) return res.status(403).json({ ok: false, error: "链接无效或已过期" });
  const role = rows[0].recipient_role;
  const meta = (typeof rows[0].meta === "string" ? JSON.parse(rows[0].meta) : rows[0].meta) || {};
  const planId = parseInt(meta.shipment_id, 10);
  if (!planId) return res.status(400).json({ ok: false, error: "链接数据异常" });

  const email = String(b.recipient_email || "").trim().slice(0, 160);
  const person = String(b.recipient_person || "").trim().slice(0, 80);
  if (!email && !person) return res.status(400).json({ ok: false, error: "请填邮箱或选择公司接收人" });
  if (email && !EMAIL_RE.test(email)) return res.status(400).json({ ok: false, error: "邮箱格式不对" });

  const pr = await pool.query(`SELECT shipment_no FROM shipping_plans WHERE id = $1`, [planId]);
  if (!pr.rows.length) return res.status(404).json({ ok: false, error: "计划不存在" });
  const label = String(meta.company_label || (meta.factory_scope && meta.factory_scope.label) || role || "").slice(0, 120);

  const ins = await pool.query(
    `INSERT INTO archive_retrieve_requests
       (shipping_plan_id, shipment_no, requester_role, requester_label, recipient_email, recipient_person, refs, note, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'requested') RETURNING id`,
    [planId, pr.rows[0].shipment_no, role, label, email || null, person || null,
     JSON.stringify(Array.isArray(b.refs) ? b.refs.slice(0, 200) : []), String(b.note || "").slice(0, 500)]);

  try {
    notifyDamonCard({
      title: "归档图片提取申请",
      applicant: String(pr.rows[0].shipment_no || planId), urgency: "普通", count: 1,
      url: "https://ai.sanlyn.cn/data",
    }).catch(() => {});
  } catch (e) { /* 通知失败不阻断 */ }

  return res.json({ ok: true, request_id: ins.rows[0].id, status: "requested", to: email || person });
}
