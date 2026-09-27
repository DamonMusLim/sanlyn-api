-- M127 订单申请：确认建单原子抢占加 'confirming' 状态（防两个内部同时确认建两张正式单）—— GPT 审出
BEGIN;
ALTER TABLE order_request DROP CONSTRAINT IF EXISTS order_request_status_check;
ALTER TABLE order_request ADD CONSTRAINT order_request_status_check
  CHECK (status IN ('submitted','reviewing','confirming','returned','confirmed','cancelled'));
COMMIT;
