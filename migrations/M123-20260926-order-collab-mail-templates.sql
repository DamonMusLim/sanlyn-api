-- M123 订单协同·客户版自动邮件：登记 4 个邮件模板键（mail_outbox.tpl_key 外键指向 email_templates）
-- 正文由 jobs/order-collab-notify.js composeMail() 按单生成；这里只登记键，让发件台能入库、邮件中心能按类展示。
-- 漏登记的后果：定时任务一开 LIVE，每封信都会撞 mail_outbox_tpl_key_fkey 入不了库（0926 链路测试抓到）。
INSERT INTO email_templates (tpl_key, name, category, sender, subject, html, variables, is_active, is_system, updated_by)
VALUES
 ('order_collab_link',   '订单协同·PI 确认链接 Proforma Invoice – please review and confirm', 'customer', 'petbaby',
  'Proforma Invoice {pi_no} – please review and confirm', '<p>由系统按单生成（jobs/order-collab-notify.js）</p>', '[]'::jsonb, true, true, 'M123'),
 ('order_collab_r1',     '订单协同·第 1 次提醒 Reminder (24h)', 'customer', 'petbaby',
  'Reminder: Proforma Invoice {pi_no} – please confirm by {due}', '<p>由系统按单生成（jobs/order-collab-notify.js）</p>', '[]'::jsonb, true, true, 'M123'),
 ('order_collab_r2',     '订单协同·第 2 次提醒 Reminder (48h)', 'customer', 'petbaby',
  'Reminder: Proforma Invoice {pi_no} – please confirm by {due}', '<p>由系统按单生成（jobs/order-collab-notify.js）</p>', '[]'::jsonb, true, true, 'M123'),
 ('order_collab_deemed', '订单协同·视同确认通知 PI deemed accepted', 'customer', 'petbaby',
  'Proforma Invoice {pi_no} – deemed accepted', '<p>由系统按单生成（jobs/order-collab-notify.js）</p>', '[]'::jsonb, true, true, 'M123')
ON CONFLICT (tpl_key) DO NOTHING;
