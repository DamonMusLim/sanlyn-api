-- 2026-09-05 portal lane quote intake.
-- Run manually. Idempotent: no production data is mutated except schema metadata.

ALTER TABLE public.freight_rfq_items
  ADD COLUMN IF NOT EXISTS forwarder_company_id integer,
  ADD COLUMN IF NOT EXISTS carrier text,
  ADD COLUMN IF NOT EXISTS container_type text,
  ADD COLUMN IF NOT EXISTS quote_detail_json jsonb;

ALTER TABLE public.freight_rfqs
  ADD COLUMN IF NOT EXISTS service_type text,
  ADD COLUMN IF NOT EXISTS request_meta jsonb;

ALTER TABLE public.freight_rates
  ADD COLUMN IF NOT EXISTS forwarder_company_id integer,
  ADD COLUMN IF NOT EXISTS source character varying(60),
  ADD COLUMN IF NOT EXISTS raw jsonb,
  ADD COLUMN IF NOT EXISTS valid_from date,
  ADD COLUMN IF NOT EXISTS valid_to date;

CREATE INDEX IF NOT EXISTS idx_freight_rfqs_portal_lane_open
  ON public.freight_rfqs (lower(btrim(pol)), lower(btrim(pod)), ctnr_type)
  WHERE status = 'open' AND COALESCE(service_type, 'ocean') = 'ocean';

CREATE INDEX IF NOT EXISTS idx_freight_rfq_items_forwarder_lane
  ON public.freight_rfq_items (rfq_id, forwarder_company_id, carrier, container_type);

CREATE INDEX IF NOT EXISTS idx_freight_rates_portal_quote_forwarder_lane
  ON public.freight_rates (forwarder_company_id, carrier, lower(btrim(pol)), lower(btrim(pod)))
  WHERE source = 'portal_quote' AND status = 'active';
