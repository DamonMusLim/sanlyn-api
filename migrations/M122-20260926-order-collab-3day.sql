-- 订单协同·客户版「3 天不回复视同确认」（Damon 0926）
-- ① 客户自己在客户页上填/改的通知邮箱（后续提醒、确认通知都发这里）；没填时用公司档案里的业务联系人→通用联系邮箱
-- ② 每张客户单：回复截止时间（发链接 + 3 天）、默认确认时间、每封自动邮件的发送记录
-- 只加列，不改数据；幂等可重跑。
ALTER TABLE companies ADD COLUMN IF NOT EXISTS order_notify_emails text[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN companies.order_notify_emails IS '客户在订单协同页自己填的通知邮箱（PI 链接/提醒/默认确认通知发这里）；空=用 biz_contact_email→contact_email';

ALTER TABLE collab.po_sheet ADD COLUMN IF NOT EXISTS reply_due_at timestamptz;     -- 客户版：发链接时间 + 3 天
ALTER TABLE collab.po_sheet ADD COLUMN IF NOT EXISTS deemed_at    timestamptz;     -- 客户版：到期未回复，按条款视同确认的时间
ALTER TABLE collab.po_sheet ADD COLUMN IF NOT EXISTS notify_log   jsonb NOT NULL DEFAULT '{}'::jsonb;  -- {link:{at,outbox_id}, r1:{…}, r2:{…}, deemed:{…}}
COMMENT ON COLUMN collab.po_sheet.reply_due_at IS '订单协同客户版：回复截止（sent_at + 3 天），过了没回复按 PI 条款视同确认';
