CREATE SCHEMA IF NOT EXISTS demo;

COMMENT ON SCHEMA demo IS
  '演示数据,与 public.shipping_plans 物理隔离,235 个业务消费方读不到;撤销 = DROP SCHEMA demo CASCADE';

CREATE TABLE IF NOT EXISTS demo.forwarder_shipping_plans (
  id bigserial PRIMARY KEY,
  demo_set_id text NOT NULL,
  demo_plan_id text NOT NULL,
  lane_seq integer NOT NULL,
  plan_seq integer NOT NULL,
  bl_no text,
  pol text,
  pod text,
  carrier_code text,
  vessel text,
  voyage text,
  etd date,
  eta date,
  container_qty integer,
  container_type text,
  gross_weight_kg numeric,
  cargo_description text,
  booking_no text,
  forwarder_booking_no text,
  booking_stage text,
  shipping_status text,
  current_status_cn text,
  pod_terminal_unconfirmed boolean NOT NULL DEFAULT false,
  freight_cost numeric,
  port_surcharge_total numeric,
  thc_fee numeric NOT NULL DEFAULT 0,
  seal_fee numeric NOT NULL DEFAULT 0,
  vgm_fee numeric NOT NULL DEFAULT 0,
  doc_fee numeric NOT NULL DEFAULT 0,
  eir_fee numeric NOT NULL DEFAULT 0,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (demo_set_id, demo_plan_id)
);

COMMENT ON TABLE demo.forwarder_shipping_plans IS
  '演示数据,与 public.shipping_plans 物理隔离,235 个业务消费方读不到;撤销 = DROP SCHEMA demo CASCADE';
COMMENT ON COLUMN demo.forwarder_shipping_plans.demo_set_id IS
  '演示数据集 ID;演示数据,与 public.shipping_plans 物理隔离,235 个业务消费方读不到;撤销 = DROP SCHEMA demo CASCADE';
COMMENT ON COLUMN demo.forwarder_shipping_plans.demo_plan_id IS
  '演示计划 ID,仅在 demo schema 内唯一;不引用 public.shipping_plans';
COMMENT ON COLUMN demo.forwarder_shipping_plans.raw IS
  '演示数据原始快照;不存真实 shipping plan 业务事实';

CREATE TABLE IF NOT EXISTS demo.forwarder_delivery_change_events (
  id bigserial PRIMARY KEY,
  demo_plan_id bigint NOT NULL REFERENCES demo.forwarder_shipping_plans(id) ON DELETE CASCADE,
  seq integer NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  field_name text NOT NULL,
  old_value text,
  new_value text,
  reason text,
  actor text,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (demo_plan_id, seq)
);

COMMENT ON TABLE demo.forwarder_delivery_change_events IS
  '演示交期变更流水,与 public.shipping_plans 物理隔离,235 个业务消费方读不到;撤销 = DROP SCHEMA demo CASCADE';
COMMENT ON COLUMN demo.forwarder_delivery_change_events.demo_plan_id IS
  '引用 demo.forwarder_shipping_plans.id,ON DELETE CASCADE;不引用 public.shipping_plans';
COMMENT ON COLUMN demo.forwarder_delivery_change_events.seq IS
  '同一演示计划内的交期变更流水序号,UNIQUE (demo_plan_id, seq)';

ALTER TABLE forwarder_portal_tokens
  ADD COLUMN IF NOT EXISTS portal_mode text NOT NULL DEFAULT 'real';

ALTER TABLE forwarder_portal_tokens
  ADD COLUMN IF NOT EXISTS demo_set_id text;

UPDATE forwarder_portal_tokens
   SET portal_mode = 'real'
 WHERE portal_mode IS NULL;

ALTER TABLE forwarder_portal_tokens
  ALTER COLUMN portal_mode SET DEFAULT 'real';

ALTER TABLE forwarder_portal_tokens
  ALTER COLUMN portal_mode SET NOT NULL;

-- 验证口径:portal_mode 是 NOT NULL DEFAULT 'real',现有 3 个真实 token 加列后自动为 'real',不会因 NULL 被误判为 demo。

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'forwarder_portal_tokens_portal_mode_chk'
       AND conrelid = 'forwarder_portal_tokens'::regclass
  ) THEN
    ALTER TABLE forwarder_portal_tokens
      ADD CONSTRAINT forwarder_portal_tokens_portal_mode_chk
      CHECK (portal_mode IN ('real', 'demo'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'forwarder_portal_tokens_demo_set_chk'
       AND conrelid = 'forwarder_portal_tokens'::regclass
  ) THEN
    ALTER TABLE forwarder_portal_tokens
      ADD CONSTRAINT forwarder_portal_tokens_demo_set_chk
      CHECK (
        (portal_mode = 'real' AND demo_set_id IS NULL)
        OR (portal_mode = 'demo' AND NULLIF(BTRIM(demo_set_id), '') IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN forwarder_portal_tokens.portal_mode IS
  'real=真实门户,demo=演示门户;demo 数据与 public.shipping_plans 物理隔离,235 个业务消费方读不到;撤销 = DROP SCHEMA demo CASCADE';
COMMENT ON COLUMN forwarder_portal_tokens.demo_set_id IS
  'portal_mode=demo 时指向 demo.forwarder_shipping_plans.demo_set_id;真实 token 必须为空';

-- 回滚 SQL(人工确认后执行):
-- ALTER TABLE forwarder_portal_tokens DROP CONSTRAINT IF EXISTS forwarder_portal_tokens_demo_set_chk;
-- ALTER TABLE forwarder_portal_tokens DROP CONSTRAINT IF EXISTS forwarder_portal_tokens_portal_mode_chk;
-- ALTER TABLE forwarder_portal_tokens DROP COLUMN IF EXISTS demo_set_id;
-- ALTER TABLE forwarder_portal_tokens DROP COLUMN IF EXISTS portal_mode;
-- DROP SCHEMA IF EXISTS demo CASCADE;
