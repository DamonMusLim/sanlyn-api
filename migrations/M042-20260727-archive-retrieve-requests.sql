-- M042 归档图片提取申请(装箱照片转 NAS 后,顾客/内部申请提取→记录→邮件发送)
-- 幂等 additive。申请记录 = 人 + 事件(谁在哪票申请了哪些图,发给谁,状态)。
CREATE TABLE IF NOT EXISTS archive_retrieve_requests (
  id               SERIAL PRIMARY KEY,
  shipping_plan_id INTEGER NOT NULL,
  shipment_no      VARCHAR(40),
  requester_role   VARCHAR(40),          -- factory_booking/customer_booking/supplier_portal/internal
  requester_label  VARCHAR(120),         -- 谁(公司/工厂名/内部)
  recipient_email  VARCHAR(160),         -- 发到哪个邮箱
  recipient_person VARCHAR(80),          -- 或发给公司哪个人
  refs             JSONB,                -- 申请的图片引用清单
  note             TEXT,
  status           VARCHAR(20) NOT NULL DEFAULT 'requested',  -- requested/sent/failed
  sent_at          TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS arr_plan ON archive_retrieve_requests (shipping_plan_id, status);
