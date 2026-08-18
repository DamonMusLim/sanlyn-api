-- M100: Backfill shipping_plans.freight_term only when linked order terms are unique.
-- Review-only migration. Run inside BEGIN ... ROLLBACK for dry-run validation.

WITH plan_scope AS (
  SELECT
    sp.id,
    sp._id,
    sp.bl_no,
    sp.order_nos,
    sp.freight_term,
    COALESCE(sp.raw, '{}'::jsonb) AS raw
  FROM shipping_plans sp
  WHERE NULLIF(BTRIM(sp.freight_term), '') IS NULL
    AND sp.deleted_at IS NULL
), matched_orders AS (
  SELECT DISTINCT
    sp.id AS shipping_plan_id,
    o.order_no,
    UPPER(BTRIM(o.trade_terms)) AS trade_term
  FROM plan_scope sp
  JOIN orders o
    ON COALESCE(o.deleted_at::text, '') = ''
   AND NULLIF(BTRIM(o.trade_terms), '') IS NOT NULL
   AND (
     (
       NULLIF(BTRIM(o.order_no), '') IS NOT NULL
       AND o.order_no = ANY(COALESCE(sp.order_nos, ARRAY[]::text[]))
     ) OR (
       NULLIF(BTRIM(sp.bl_no), '') IS NOT NULL
       AND NULLIF(BTRIM(o.bl_no), '') IS NOT NULL
       AND BTRIM(sp.bl_no) = BTRIM(o.bl_no)
     ) OR (
       o.shipping_plan_id IS NOT NULL
       AND o.shipping_plan_id = sp.id
     )
   )
), term_stats AS (
  SELECT
    ps.id AS shipping_plan_id,
    ps._id,
    ps.bl_no,
    ARRAY_AGG(DISTINCT mo.order_no ORDER BY mo.order_no) FILTER (WHERE mo.order_no IS NOT NULL) AS source_order_nos,
    ARRAY_AGG(DISTINCT mo.trade_term ORDER BY mo.trade_term) FILTER (WHERE mo.trade_term IS NOT NULL) AS trade_terms,
    COUNT(DISTINCT mo.order_no) FILTER (WHERE mo.order_no IS NOT NULL) AS linked_order_count,
    COUNT(DISTINCT mo.trade_term) FILTER (WHERE mo.trade_term IN ('EXW', 'FOB')) AS supported_term_count,
    COUNT(DISTINCT mo.trade_term) FILTER (WHERE mo.trade_term IS NOT NULL) AS all_term_count,
    MIN(mo.trade_term) FILTER (WHERE mo.trade_term IN ('EXW', 'FOB')) AS derived_term
  FROM plan_scope ps
  LEFT JOIN matched_orders mo ON mo.shipping_plan_id = ps.id
  GROUP BY ps.id, ps._id, ps.bl_no
), unique_candidates AS (
  SELECT *
  FROM term_stats
  WHERE linked_order_count > 0
    AND supported_term_count = 1
    AND all_term_count = 1
), updated AS (
  UPDATE shipping_plans sp
  SET freight_term = uc.derived_term,
      raw = COALESCE(sp.raw, '{}'::jsonb) || jsonb_build_object(
        'freight_term_derivation',
        jsonb_build_object(
          'derived_by', 'M100-terms-backfill',
          'derived_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
          'source_order_nos', COALESCE(uc.source_order_nos, ARRAY[]::text[]),
          'source_trade_terms', COALESCE(uc.trade_terms, ARRAY[]::text[])
        )
      ),
      updated_at = now()
  FROM unique_candidates uc
  WHERE sp.id = uc.shipping_plan_id
    AND NULLIF(BTRIM(sp.freight_term), '') IS NULL
  RETURNING sp.id, sp._id, sp.bl_no, sp.freight_term, uc.source_order_nos
)
SELECT
  'updated_unique_terms' AS section,
  COUNT(*)::int AS row_count,
  JSONB_AGG(
    JSONB_BUILD_OBJECT(
      'shipping_plan_id', id,
      '_id', _id,
      'bl_no', bl_no,
      'freight_term', freight_term,
      'source_order_nos', source_order_nos
    )
    ORDER BY id
  ) AS rows
FROM updated;

WITH plan_scope AS (
  SELECT sp.id, sp._id, sp.bl_no, sp.order_nos, sp.freight_term
  FROM shipping_plans sp
  WHERE NULLIF(BTRIM(sp.freight_term), '') IS NULL
    AND sp.deleted_at IS NULL
), matched_orders AS (
  SELECT DISTINCT
    sp.id AS shipping_plan_id,
    o.order_no,
    UPPER(BTRIM(o.trade_terms)) AS trade_term
  FROM plan_scope sp
  JOIN orders o
    ON COALESCE(o.deleted_at::text, '') = ''
   AND NULLIF(BTRIM(o.trade_terms), '') IS NOT NULL
   AND (
     (
       NULLIF(BTRIM(o.order_no), '') IS NOT NULL
       AND o.order_no = ANY(COALESCE(sp.order_nos, ARRAY[]::text[]))
     ) OR (
       NULLIF(BTRIM(sp.bl_no), '') IS NOT NULL
       AND NULLIF(BTRIM(o.bl_no), '') IS NOT NULL
       AND BTRIM(sp.bl_no) = BTRIM(o.bl_no)
     ) OR (
       o.shipping_plan_id IS NOT NULL
       AND o.shipping_plan_id = sp.id
     )
   )
), term_stats AS (
  SELECT
    ps.id AS shipping_plan_id,
    ps._id,
    ps.bl_no,
    ARRAY_AGG(DISTINCT mo.order_no ORDER BY mo.order_no) FILTER (WHERE mo.order_no IS NOT NULL) AS source_order_nos,
    ARRAY_AGG(DISTINCT mo.trade_term ORDER BY mo.trade_term) FILTER (WHERE mo.trade_term IS NOT NULL) AS trade_terms,
    COUNT(DISTINCT mo.order_no) FILTER (WHERE mo.order_no IS NOT NULL) AS linked_order_count,
    COUNT(DISTINCT mo.trade_term) FILTER (WHERE mo.trade_term IS NOT NULL) AS all_term_count
  FROM plan_scope ps
  LEFT JOIN matched_orders mo ON mo.shipping_plan_id = ps.id
  GROUP BY ps.id, ps._id, ps.bl_no
)
SELECT
  'mixed_terms_not_updated' AS section,
  shipping_plan_id,
  _id,
  bl_no,
  source_order_nos,
  trade_terms
FROM term_stats
WHERE linked_order_count > 0
  AND all_term_count > 1
ORDER BY shipping_plan_id;

WITH plan_scope AS (
  SELECT sp.id, sp._id, sp.bl_no, sp.order_nos, sp.freight_term
  FROM shipping_plans sp
  WHERE NULLIF(BTRIM(sp.freight_term), '') IS NULL
    AND sp.deleted_at IS NULL
), matched_orders AS (
  SELECT DISTINCT sp.id AS shipping_plan_id, o.order_no
  FROM plan_scope sp
  JOIN orders o
    ON COALESCE(o.deleted_at::text, '') = ''
   AND (
     (
       NULLIF(BTRIM(o.order_no), '') IS NOT NULL
       AND o.order_no = ANY(COALESCE(sp.order_nos, ARRAY[]::text[]))
     ) OR (
       NULLIF(BTRIM(sp.bl_no), '') IS NOT NULL
       AND NULLIF(BTRIM(o.bl_no), '') IS NOT NULL
       AND BTRIM(sp.bl_no) = BTRIM(o.bl_no)
     ) OR (
       o.shipping_plan_id IS NOT NULL
       AND o.shipping_plan_id = sp.id
     )
   )
), no_order_plans AS (
  SELECT ps.id, ps._id, ps.bl_no
  FROM plan_scope ps
  WHERE NOT EXISTS (
    SELECT 1 FROM matched_orders mo WHERE mo.shipping_plan_id = ps.id
  )
)
SELECT
  'no_order_not_updated' AS section,
  COUNT(*)::int AS row_count,
  JSONB_AGG(
    JSONB_BUILD_OBJECT('shipping_plan_id', id, '_id', _id, 'bl_no', bl_no)
    ORDER BY id
  ) AS rows
FROM no_order_plans;
