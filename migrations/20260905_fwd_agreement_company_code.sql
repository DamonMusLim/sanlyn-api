-- migrations/20260905_fwd_agreement_company_code.sql
ALTER TABLE public.forwarder_carrier_agreements
  ADD COLUMN IF NOT EXISTS company_code text;

CREATE INDEX IF NOT EXISTS idx_forwarder_carrier_agreements_company_code_active
  ON public.forwarder_carrier_agreements (company_code, active);

UPDATE public.forwarder_carrier_agreements
   SET company_code = 'CN-00028'
 WHERE forwarder_co = '万汇国际'
   AND company_code IS NULL;

WITH normalized_rates AS (
  SELECT DISTINCT
         'HH'::text AS company_code,
         forwarder AS forwarder_co,
         UPPER(TRIM(pol)) AS pol,
         UPPER(TRIM(pod)) AS pod,
         CASE UPPER(TRIM(carrier))
           WHEN 'EVERGREEN' THEN 'EMC'
           WHEN 'MAERSK' THEN 'MSK'
           ELSE UPPER(TRIM(carrier))
         END AS carrier_code
    FROM public.freight_rates
   WHERE forwarder = '天津惠禾国际货运代理有限责任公司'
     AND status = 'active'
     AND pol IS NOT NULL
     AND pod IS NOT NULL
     AND carrier IS NOT NULL
), ranked_rates AS (
  SELECT company_code,
         forwarder_co,
         pol,
         pod,
         carrier_code,
         row_number() OVER (ORDER BY pol, pod, carrier_code) AS priority
    FROM normalized_rates
)
INSERT INTO public.forwarder_carrier_agreements
  (company_code, forwarder_co, pol, pod, carrier_code, priority, active, source)
SELECT r.company_code,
       r.forwarder_co,
       r.pol,
       r.pod,
       r.carrier_code,
       r.priority,
       true,
       'derived_from_freight_rates_20260905'
  FROM ranked_rates r
 WHERE NOT EXISTS (
       SELECT 1
         FROM public.forwarder_carrier_agreements a
        WHERE a.company_code = r.company_code
          AND UPPER(TRIM(COALESCE(a.pol, ''))) = r.pol
          AND UPPER(TRIM(COALESCE(a.pod, ''))) = r.pod
          AND UPPER(TRIM(COALESCE(a.carrier_code, ''))) = r.carrier_code
 );
