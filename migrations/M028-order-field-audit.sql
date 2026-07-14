-- M028-order-field-audit.sql — orders 关键字段变更审计
-- 目的: orders 关键 keying 字段被静默 clobber 时,能查到 order / 字段 / old→new / 时间 / 来源(source) / 谁(actor)。
--       事故背景: contract_no 被某代码路径静默从组合串改回 PI 短号,无审计追不到源头。
-- 机制: orders 上 AFTER UPDATE 行级触发器 → 写 order_field_changes(append-only)。监控列见 WHEN 与函数体。
-- 设计要点(已过 deep-reasoner 审):
--   * 锚定用不可变 orders.id(order_id);order_no 仅冗余记录(可变,不可当定位键)。
--   * actor/source 取 set_config('sanlyn.actor'/'sanlyn.source', ..., true)(事务级 GUC,不串连接池);
--     未注入时回退 session_user / application_name。注入见 api/lib/audit-actor.js(热点交互路径用)。
--   * SQL_ASCII 库: old/new 存无界 text,逐字节保真、不转码、不截断(无需 fitBytes)。
--     监控列本身即 text/varchar,结构上不可能含 NUL(否则当初就存不进 orders),故直接引用,
--     不做 NUL 剥离 —— 注: PG 里 chr(0) 本身会报 "null character not permitted",replace(...,chr(0),...)
--     反而会在每次监控列变化时抛错阻断主 UPDATE,绝不可用(forge 回审 catch)。
--   * WHEN 裁剪: 只有监控列真变化才 fire,大批量 backfill 若不动监控列则零开销。
--   * AFTER + RETURN NULL: 不干扰主写入,只 INSERT 审计表,绝不 UPDATE orders(防触发器递归)。
--   * 扩展监控列: 函数体加一个 IF 块 + WHEN 条件加一个 OR 分支即可。
-- 注意: runner(scripts/apply-migrations.js)已把本文件包在 BEGIN/COMMIT 事务里跑,勿在此写 BEGIN/COMMIT。

CREATE TABLE IF NOT EXISTS order_field_changes (
  id         bigserial   PRIMARY KEY,
  order_id   bigint      NOT NULL,   -- 不可变锚 = orders.id
  order_no   text,                   -- 冗余业务键(记 NEW.order_no,可变)
  field      text        NOT NULL,
  old_val    text,
  new_val    text,
  actor      text,
  source     text,
  txid       bigint,
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ofc_order_id ON order_field_changes (order_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ofc_order_no ON order_field_changes (order_no, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_ofc_field    ON order_field_changes (field, changed_at DESC);

CREATE OR REPLACE FUNCTION audit_orders_changes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_actor  text := COALESCE(NULLIF(current_setting('sanlyn.actor', true), ''), session_user);
  v_source text := COALESCE(NULLIF(current_setting('sanlyn.source', true), ''),
                            NULLIF(current_setting('application_name', true), ''), '');
BEGIN
  IF OLD.contract_no IS DISTINCT FROM NEW.contract_no THEN
    INSERT INTO order_field_changes(order_id, order_no, field, old_val, new_val, actor, source, txid)
    VALUES (NEW.id, NEW.order_no, 'contract_no', OLD.contract_no, NEW.contract_no,
      v_actor, v_source, txid_current());
  END IF;

  IF OLD.bl_no IS DISTINCT FROM NEW.bl_no THEN
    INSERT INTO order_field_changes(order_id, order_no, field, old_val, new_val, actor, source, txid)
    VALUES (NEW.id, NEW.order_no, 'bl_no', OLD.bl_no, NEW.bl_no,
      v_actor, v_source, txid_current());
  END IF;

  IF OLD.factory_code IS DISTINCT FROM NEW.factory_code THEN
    INSERT INTO order_field_changes(order_id, order_no, field, old_val, new_val, actor, source, txid)
    VALUES (NEW.id, NEW.order_no, 'factory_code', OLD.factory_code, NEW.factory_code,
      v_actor, v_source, txid_current());
  END IF;

  IF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO order_field_changes(order_id, order_no, field, old_val, new_val, actor, source, txid)
    VALUES (NEW.id, NEW.order_no, 'status', OLD.status, NEW.status,
      v_actor, v_source, txid_current());
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_field_audit ON orders;
CREATE TRIGGER trg_orders_field_audit
AFTER UPDATE ON orders
FOR EACH ROW
WHEN (
  OLD.contract_no  IS DISTINCT FROM NEW.contract_no  OR
  OLD.bl_no        IS DISTINCT FROM NEW.bl_no        OR
  OLD.factory_code IS DISTINCT FROM NEW.factory_code OR
  OLD.status       IS DISTINCT FROM NEW.status
)
EXECUTE FUNCTION audit_orders_changes();
