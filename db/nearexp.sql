BEGIN;

CREATE TABLE IF NOT EXISTS public.petstore_nearexp_plan (
  id serial PRIMARY KEY,
  min_days int,
  max_days int,
  rate numeric NULL,
  rule_text text NOT NULL DEFAULT '',
  sort int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS public.petstore_nearexp_proposals (
  id bigserial PRIMARY KEY,
  product_code text NOT NULL,
  product_name text,
  spec text,
  orig_shelf text,
  nearexp_shelf text,
  days_left int,
  expiry_date date NOT NULL,
  produce_date date,
  date_verified boolean NOT NULL DEFAULT false,
  base_price numeric,
  suggest_price numeric,
  current_price numeric,
  stock numeric,
  tier_label text,
  status text NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed','approved','rejected','executed','failed')),
  approved_by text,
  approved_at timestamptz,
  executed_at timestamptz,
  readback_price numeric,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_seen_date date,
  UNIQUE(product_code, expiry_date, suggest_price)
);

ALTER TABLE public.petstore_nearexp_proposals
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE public.petstore_nearexp_proposals
  ADD COLUMN IF NOT EXISTS last_seen_date date;

CREATE TABLE IF NOT EXISTS public.petstore_offline_expiry_snapshot (
  capture_date date,
  captured_at timestamptz,
  store_code text,
  record_id text,
  product_code text,
  upc_code text,
  product_name text,
  spec text,
  produce_date date,
  expiration_date date,
  safe_day numeric,
  warn_day numeric,
  warn_status numeric,
  warn_status_str text,
  stock_num numeric,
  cost_price numeric,
  in_price numeric,
  out_price numeric,
  month_sale numeric,
  days_to_expire integer,
  raw_payload jsonb
);

CREATE INDEX IF NOT EXISTS idx_nearexp_proposals_today
  ON public.petstore_nearexp_proposals(updated_at, status, days_left);

CREATE INDEX IF NOT EXISTS idx_nearexp_proposals_code_expiry
  ON public.petstore_nearexp_proposals(product_code, expiry_date);

CREATE INDEX IF NOT EXISTS idx_offline_expiry_snapshot_day
  ON public.petstore_offline_expiry_snapshot(capture_date, store_code, product_code);

INSERT INTO public.petstore_nearexp_plan
  (min_days, max_days, rate, rule_text, sort, updated_by)
SELECT *
FROM (VALUES
  (151, NULL::int, NULL::numeric, '>150 天:不打折', 10, 'v2026.09.18-2'),
  (121, 150, 0.8, '121-150 天:8 折', 20, 'v2026.09.18-2'),
  (91, 120, 0.7, '91-120 天:7 折', 30, 'v2026.09.18-2'),
  (61, 90, 0.5, '61-90 天:5 折', 40, 'v2026.09.18-2'),
  (31, 60, 0.3, '31-60 天:3 折', 50, 'v2026.09.18-2'),
  (15, 30, 0.2, '15-30 天:2 折', 60, 'v2026.09.18-2'),
  (4, 14, 0.1, '4-14 天:1 折,最低 1 元', 70, 'v2026.09.18-2'),
  (0, 3, NULL::numeric, '≤3 天:1 元清 / 买1送2 / 会员满额送', 80, 'v2026.09.18-2'),
  (-99999, -1, NULL::numeric, '已过期:下架报损(报损要 Damon 批)', 90, 'v2026.09.18-2')
) AS seed(min_days, max_days, rate, rule_text, sort, updated_by)
WHERE NOT EXISTS (SELECT 1 FROM public.petstore_nearexp_plan);

COMMIT;
