-- M003: Initialize raw.cost_lines from existing fee columns
-- Idempotent: only runs where raw->'cost_lines' IS NULL.
-- After this migration, raw.cost_lines is the authoritative source for freight invoices.
-- Run: psql -h 127.0.0.1 -U sanlyn_admin -d sanlyn_db -f M003-cost-lines-init.sql

BEGIN;

UPDATE shipping_plans sp
SET raw = COALESCE(sp.raw, '{}'::jsonb) || jsonb_build_object('cost_lines', fee.lines)
FROM (
  SELECT
    sp2.id,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'name', t.name,
          'sale', t.amount,
          'currency', t.currency,
          'remark', ''
        )
        ORDER BY t.ord
      ),
      '[]'::jsonb
    ) AS lines
  FROM shipping_plans sp2
  CROSS JOIN LATERAL (
         SELECT 1  AS ord, 'Ocean Freight 海运费'::text   AS name, sp2.freight_sale_usd::numeric AS amount, 'USD'::text AS currency
    UNION ALL SELECT 2, 'THC Fee 码头操作费',          sp2.thc_fee::numeric,             'CNY'
    UNION ALL SELECT 3, 'EIR Fee 设备交接费',          sp2.eir_fee::numeric,             'CNY'
    UNION ALL SELECT 4, 'Seal Fee 铅封费',             sp2.seal_fee::numeric,            'CNY'
    UNION ALL SELECT 5, '订舱费 Booking Fee',          sp2.bkg_fee::numeric,             'CNY'
    UNION ALL SELECT 6, '单证费 Doc Fee',              sp2.doc_fee::numeric,             'CNY'
    UNION ALL SELECT 7, 'TLX Fee 电放费',              sp2.tlx_fee::numeric,             'CNY'
    UNION ALL SELECT 8, '港杂费合计 Port Surcharge',   sp2.port_surcharge_total::numeric, 'CNY'
    UNION ALL SELECT 9, '拖车费 Trucking',             sp2.trucking_cost_total::numeric,  'CNY'
    UNION ALL SELECT 10, '报关费 Customs',             sp2.customs_cost_total::numeric,   'CNY'
    UNION ALL SELECT 11, '保险费 Insurance',           sp2.insurance_cost::numeric,       'CNY'
  ) AS t(ord, name, amount, currency)
  WHERE sp2.raw->'cost_lines' IS NULL
    AND t.amount IS NOT NULL
    AND t.amount > 0
  GROUP BY sp2.id
) fee
WHERE sp.id = fee.id;

SELECT 'M003 done. cost_lines now set: ' ||
  COUNT(CASE WHEN raw->'cost_lines' IS NOT NULL THEN 1 END) ||
  ' / ' || COUNT(*) || ' total plans'
FROM shipping_plans;

COMMIT;
