-- 人工确认后执行：订单8个人员角色槽真源表。
-- 不放 migrations/，避免部署脚本自动执行。
CREATE TABLE IF NOT EXISTS order_staff_slots (
  id BIGSERIAL PRIMARY KEY,
  order_id TEXT NOT NULL,
  role_key TEXT NOT NULL CHECK (role_key IN (
    'sales_owner','merchandiser','booking_owner','customs_owner',
    'document_owner','trucking_owner','finance_owner','qc_owner'
  )),
  staff_no TEXT NOT NULL REFERENCES ai_staff(staff_no),
  is_active BOOLEAN NOT NULL DEFAULT true,
  note TEXT,
  updated_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(order_id, role_key)
);

CREATE INDEX IF NOT EXISTS idx_order_staff_slots_staff_no
  ON order_staff_slots(staff_no) WHERE is_active IS TRUE;

CREATE INDEX IF NOT EXISTS idx_order_staff_slots_role_key
  ON order_staff_slots(role_key) WHERE is_active IS TRUE;

COMMENT ON TABLE order_staff_slots IS '订单8个人员角色槽；order_id 存 orders.id 文本值；人员只认 ai_staff.staff_no，不从姓名反推。';
