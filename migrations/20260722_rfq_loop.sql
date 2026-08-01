BEGIN;

-- 状态机扩容：原 CHECK 只认 open/quoted/awarded/cancelled，先扩再清场
ALTER TABLE freight_rfqs DROP CONSTRAINT IF EXISTS freight_rfqs_status_check;
ALTER TABLE freight_rfqs ADD CONSTRAINT freight_rfqs_status_check
  CHECK (status::text = ANY (ARRAY['open','quoted','awarded','cancelled','void','needs_review','priced','accepted']::text[]));

UPDATE freight_rfqs
   SET status = 'void', updated_at = NOW()
 WHERE status = 'open'
   AND created_by IN ('claude_qa','Claude-mini')
   AND COALESCE(service_type,'ocean') = 'ocean'  -- 只清海运测试单，拖车/报关/投保竞价场不动
   AND id NOT IN (
     SELECT DISTINCT rfq_id
       FROM freight_rfq_items
      WHERE submitted_at IS NOT NULL
   );

ALTER TABLE freight_rfqs
  ADD COLUMN IF NOT EXISTS customer_company_id int,
  ADD COLUMN IF NOT EXISTS pol_port_id int,
  ADD COLUMN IF NOT EXISTS pod_port_id int,
  ADD COLUMN IF NOT EXISTS client_rates_json jsonb,
  ADD COLUMN IF NOT EXISTS quote_published_at timestamptz,
  ADD COLUMN IF NOT EXISTS needs_review_reason text;

ALTER TABLE freight_rfq_items
  ADD COLUMN IF NOT EXISTS status text DEFAULT 'invited';

UPDATE freight_rfq_items
   SET status = 'quoted'
 WHERE submitted_at IS NOT NULL
   AND COALESCE(status, 'invited') <> 'quoted';

CREATE UNIQUE INDEX IF NOT EXISTS ux_rfq_invited_forwarder
  ON freight_rfq_items (rfq_id, forwarder_company_id)
  WHERE status = 'invited' AND forwarder_company_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS freight_quote_shortlinks (
  code text PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES freight_rfq_items(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_freight_quote_shortlinks_item
  ON freight_quote_shortlinks(item_id);

COMMIT;

-- 补丁2026-07-22b：邀请行无价未交卷，两列松绑（default now() 保留给老写入方）
ALTER TABLE freight_rfq_items ALTER COLUMN usd_rate DROP NOT NULL;
ALTER TABLE freight_rfq_items ALTER COLUMN submitted_at DROP NOT NULL;

-- 补丁2026-07-22c：客户需求报价——心里价位(只进内部)+请求元数据
ALTER TABLE freight_rfqs ADD COLUMN IF NOT EXISTS client_target_usd numeric;
ALTER TABLE freight_rfqs ADD COLUMN IF NOT EXISTS request_meta jsonb;
