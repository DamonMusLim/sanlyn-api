// po-collab-customer-notify.js — 订单协同·客户版「3 天不回复视同确认」+ 客户自填通知邮箱（Damon 0926）
//   ① 客户页上客户自己填/改通知邮箱（companies.order_notify_emails）；没填用档案 biz_contact_email → contact_email
//   ② 视同确认：发链接满 3 天、客户一个字没回（status 仍 sent/opened）→ confirmed + deemed_at，给艾莎建任务
//      客户提了修改申请但没回签（submitted）→ ⛔ 不自动确认，转艾莎先审修改
//   ③ PI 条款：写明「3 天不回复视同接受」，客户页和 PDF 都显示
// 自动发信本身在 jobs/order-collab-notify.js（只写 mail_outbox，由 email-agent 按白名单模板发出）。

import { resolveCustomerToken, customerGate } from "./po-collab-customer.js";

export const REPLY_DAYS = 3;
const EMAIL_RE = /^[^\s@<>(),;:"']+@[^\s@<>(),;:"']+\.[A-Za-z]{2,}$/;
const MAX_EMAILS = 5;

export function cleanEmails(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : String(list || "").split(/[,;\s]+/)) {
    const e = String(raw || "").trim().toLowerCase();
    if (!e) continue;
    if (!EMAIL_RE.test(e) || e.length > 120) return { error: `Invalid email: ${String(raw).slice(0, 60)}` };
    if (!out.includes(e)) out.push(e);
  }
  if (out.length > MAX_EMAILS) return { error: `At most ${MAX_EMAILS} emails.` };
  return { emails: out };
}

// 实际收件人：客户自填的优先；没填用档案（业务联系人 → 通用联系邮箱）；抄送 = 公司抄送栏
export async function notifyRecipients(pool, companyId) {
  const c = (await pool.query(
    `SELECT order_notify_emails, biz_contact_email, contact_email, cc_emails FROM companies WHERE id=$1`, [companyId])).rows[0];
  if (!c) return { to: [], cc: [], source: "none" };
  const custom = (c.order_notify_emails || []).filter(Boolean);
  const to = custom.length ? custom : [c.biz_contact_email || c.contact_email].filter(Boolean);
  const cc = (c.cc_emails || []).filter(e => e && !to.includes(String(e).toLowerCase()));
  return { to, cc, source: custom.length ? "customer" : (to.length ? "profile" : "none"), custom };
}

// PI 条款（客户页 + PDF 同一份）
export function piTerms(order, dueAt) {
  const due = dueAt ? new Date(new Date(dueAt).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ") + " (GMT+8)" : null;
  return [
    order.payment_terms ? { k: "payment", en: `Payment: ${order.payment_terms}` } : null,
    { k: "deemed", en: `Acceptance: please confirm or request changes within ${REPLY_DAYS} days of receiving this PI`
        + (due ? ` (by ${due})` : "") + `. If we receive no reply within ${REPLY_DAYS} days, this PI is deemed accepted.` },
    { k: "changes", en: "Requested changes take effect only after the seller's confirmation." },
  ].filter(Boolean);
}

// POST /notify-emails {token, sheet, emails:[…]} —— 客户改自己公司的通知邮箱
export async function handleCustomerNotifyEmails(req, res, pool) {
  const { sheet, err } = await resolveCustomerToken(pool, req.body?.token, req.body?.sheet);
  if (err) return res.status(403).json({ ok: false, error: err });
  if (!(await customerGate(req, res, pool, sheet))) return;
  const role = String(req.user?.role || "").toLowerCase();
  if (role !== "customer") return res.status(403).json({ ok: false, error: "Only the customer's account can change notification emails." });
  const r = cleanEmails(req.body?.emails);
  if (r.error) return res.status(400).json({ ok: false, error: r.error });
  const before = (await pool.query(`SELECT order_notify_emails FROM companies WHERE id=$1`, [sheet.party_company_id])).rows[0]?.order_notify_emails || [];
  await pool.query(`UPDATE companies SET order_notify_emails=$2::text[], updated_at=NOW() WHERE id=$1`, [sheet.party_company_id, r.emails]);
  await pool.query(
    `INSERT INTO collab.po_event (sheet_id, kind, actor_side, actor_name, detail) VALUES ($1,'notify_emails_changed','customer',$2,$3::jsonb)`,
    [sheet.id, String(req.user?.username || "").slice(0, 60), JSON.stringify({ before, after: r.emails })]);
  return res.json({ ok: true, emails: r.emails });
}

// 到期视同确认（job 调）。只对「一个字没回」的单；返回 true = 这次确认了
export async function deemAccepted(pool, sheetId) {
  const r = await pool.query(
    `UPDATE collab.po_sheet SET status='confirmed', deemed_at=NOW(), updated_at=NOW()
      WHERE id=$1 AND side='customer' AND status IN ('sent','opened') AND deemed_at IS NULL
        AND reply_due_at IS NOT NULL AND reply_due_at <= NOW()
      RETURNING id, order_no, factory_name AS customer`, [sheetId]);
  if (!r.rows.length) return false;
  const s = r.rows[0];
  await pool.query(`INSERT INTO collab.po_event (sheet_id, kind, actor_side, detail) VALUES ($1,'deemed_accepted','system',$2::jsonb)`,
    [s.id, JSON.stringify({ rule: `${REPLY_DAYS}-day no reply`, step: 4 })]);
  await upsertTask(pool, s, "deemed",
    `${s.customer} ${REPLY_DAYS} 天未回复，PI 已按条款视同确认 → 审核后给工厂发开工通知`,
    "①看一眼订单无误 ②采纳（记客户确认时间）③第4步：给工厂发开工通知");
  return true;
}

// 客户提了修改但没回签、已过 3 天 → 不自动确认，交艾莎先审修改
export async function escalateChangesPending(pool, sheetId) {
  const s = (await pool.query(`SELECT id, order_no, factory_name AS customer FROM collab.po_sheet WHERE id=$1`, [sheetId])).rows[0];
  if (!s) return;
  await upsertTask(pool, s, "changes",
    `${s.customer} 提了修改申请、${REPLY_DAYS} 天未回签 → 先审修改再定`,
    "①打开审核页看客户申请改了什么 ②能接受就在订单里改好、回复客户；不接受写原因退回 ③⛔ 不会自动视同确认");
}

async function upsertTask(pool, s, kind, title, next) {
  const base = process.env.PO_REVIEW_BASE || "https://ai.sanlyn.cn/po-review?sheet=";
  const raw = { task_class: "业务", subclass: "客户回签PI审核", canonical_domain: "order", owner: "WM-01 艾莎", reviewer: "D-00",
    deep_link: base + s.id, severity: "P2", dedupe_key: `order:pi_confirm:${s.order_no}`, sop_step: 4, sheet_id: s.id, trigger: kind };
  await pool.query(
    `INSERT INTO tasks (id, title, task_type, level, status, domain, priority, assigned_staff_no, related_order_no, source,
                        dedupe_key, due_at, reason, next_action, raw, created_at, updated_at)
     VALUES ($1,$2,'客户回签PI审核','L3','open','外贸','p1','WM-01',$3,'order-collab',$4,NOW()+interval '1 day',$5,$6,$7::jsonb,NOW(),NOW())
     ON CONFLICT (id) DO UPDATE SET status='open', title=EXCLUDED.title, reason=EXCLUDED.reason, next_action=EXCLUDED.next_action,
       raw=COALESCE(tasks.raw,'{}'::jsonb) || EXCLUDED.raw, updated_at=NOW()`,
    [`pi-confirm-${s.id}`, title.slice(0, 100), s.order_no, raw.dedupe_key, `客户协同单#${s.id} · ${kind === "deemed" ? "按条款视同确认" : "有修改申请待审"}`, next, JSON.stringify(raw)]);
}
