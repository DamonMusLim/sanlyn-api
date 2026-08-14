-- M070: 货代账单 payer 条款DNA归属
-- 幂等: 只改 payer 为空或 BABI、且 raw 未人工 split 的有效账单行。

WITH bill_scope AS (
  SELECT
    b.id,
    b.bl_no,
    b.cost_category,
    UPPER(BTRIM(COALESCE(b.currency, ''))) AS currency_norm,
    BTRIM(COALESCE(b.payer_company_code, '')) AS current_payer,
    COALESCE(b.raw, '{}'::jsonb) AS bill_raw,
    COALESCE(sp.raw, '{}'::jsonb) AS plan_raw,
    sp.id AS plan_id,
    NULLIF(BTRIM(COALESCE(sp.company_code, sp.raw->>'company_code')), '') AS plan_company_code,
    COALESCE(
      NULLIF(BTRIM(b.raw->>'transport_mode'), ''),
      NULLIF(BTRIM(sp.raw->>'transport_mode'), '')
    ) AS transport_mode,
    COALESCE(b.raw, '{}'::jsonb) ? 'split' AS has_split
  FROM freight_supplier_bills b
  LEFT JOIN LATERAL (
    SELECT sp.*
    FROM shipping_plans sp
    WHERE (b.link_plan_id IS NOT NULL AND sp._id::text = b.link_plan_id::text)
       OR (NULLIF(BTRIM(b.bl_no), '') IS NOT NULL AND BTRIM(sp.bl_no) = BTRIM(b.bl_no))
    ORDER BY CASE WHEN b.link_plan_id IS NOT NULL AND sp._id::text = b.link_plan_id::text THEN 0 ELSE 1 END
    LIMIT 1
  ) sp ON TRUE
  WHERE COALESCE(b.rebill_status, '') NOT IN ('voided', 'absorbed')
    AND NULLIF(BTRIM(b.bl_no), '') IS NOT NULL
), order_rows AS (
  SELECT
    s.id AS bill_id,
    NULLIF(BTRIM(o.trade_terms), '') AS trade_terms,
    NULLIF(BTRIM(o.factory_code), '') AS factory_code,
    NULLIF(BTRIM(o.company_code), '') AS company_code
  FROM bill_scope s
  JOIN orders o
    ON o.deleted_at IS NULL
   AND (
     BTRIM(o.bl_no) = BTRIM(s.bl_no)
     OR (s.plan_id IS NOT NULL AND o.shipping_plan_id::text = s.plan_id::text)
   )
), order_stats AS (
  SELECT
    bill_id,
    COUNT(DISTINCT UPPER(trade_terms)) FILTER (WHERE UPPER(trade_terms) IN ('EXW', 'FOB')) AS term_count,
    COUNT(*) FILTER (WHERE UPPER(trade_terms) = 'EXW') > 0 AS has_exw,
    COUNT(*) FILTER (WHERE UPPER(trade_terms) = 'FOB') > 0 AS has_fob,
    CASE WHEN COUNT(DISTINCT factory_code) FILTER (WHERE factory_code IS NOT NULL) = 1
         THEN MIN(factory_code) FILTER (WHERE factory_code IS NOT NULL)
    END AS factory_code,
    CASE WHEN COUNT(DISTINCT company_code) FILTER (WHERE company_code IS NOT NULL) = 1
         THEN MIN(company_code) FILTER (WHERE company_code IS NOT NULL)
    END AS order_company_code
  FROM order_rows
  GROUP BY bill_id
), classified AS (
  SELECT
    s.id,
    s.bl_no,
    s.current_payer,
    CASE
      WHEN s.has_split THEN 'split'
      WHEN s.current_payer <> '' AND s.current_payer <> 'BABI' THEN 'manual_payer'
      WHEN s.cost_category ~* '海运|ocean' AND s.currency_norm = 'USD' THEN 'r1'
      WHEN s.currency_norm IN ('CNY', 'RMB') AND s.transport_mode = '内转外' THEN 'r2a'
      WHEN s.currency_norm IN ('CNY', 'RMB') AND COALESCE(os.has_exw, FALSE) AND COALESCE(os.has_fob, FALSE) THEN 'mixterm'
      WHEN s.currency_norm IN ('CNY', 'RMB') AND os.term_count = 1 AND os.has_exw THEN 'r2b'
      WHEN s.currency_norm IN ('CNY', 'RMB') AND os.term_count = 1 AND os.has_fob THEN 'r2c'
      WHEN s.currency_norm IN ('CNY', 'RMB') THEN 'unknown'
      ELSE 'skipped'
    END AS rule_code,
    CASE
      WHEN s.has_split THEN NULL
      WHEN s.current_payer <> '' AND s.current_payer <> 'BABI' THEN NULL
      WHEN s.cost_category ~* '海运|ocean' AND s.currency_norm = 'USD'
        THEN COALESCE(os.order_company_code, s.plan_company_code)
      WHEN s.currency_norm IN ('CNY', 'RMB') AND s.transport_mode = '内转外'
        THEN 'BABI'
      WHEN s.currency_norm IN ('CNY', 'RMB') AND os.term_count = 1 AND os.has_exw
        THEN COALESCE(os.order_company_code, s.plan_company_code)
      WHEN s.currency_norm IN ('CNY', 'RMB') AND os.term_count = 1 AND os.has_fob
        THEN COALESCE(os.factory_code, NULLIF(BTRIM(s.plan_raw->>'shipper_company_code'), ''))
      ELSE NULL
    END AS desired_payer
  FROM bill_scope s
  LEFT JOIN order_stats os ON os.bill_id = s.id
), updated AS (
  UPDATE freight_supplier_bills b
  SET payer_company_code = c.desired_payer,
      updated_at = now()
  FROM classified c
  WHERE b.id = c.id
    AND c.desired_payer IS NOT NULL
    AND c.current_payer IN ('', 'BABI')
    AND c.current_payer IS DISTINCT FROM c.desired_payer
  RETURNING b.id, b.bl_no, c.rule_code
), mixterm_inserted AS (
  INSERT INTO tasks (id, title, reason, status, source, owner_object_type, owner_object_id, created_at, updated_at)
  SELECT DISTINCT
         'payer-mixterm-' || BTRIM(bl_no),
         '货代账单混条款待分摊',
         '货代账单 payer 待人工按柜分摊: 同票订单既有 EXW 又有 FOB',
         'open',
         'payer-terms-dna',
         'logistics',
         BTRIM(bl_no),
         now(),
         now()
  FROM classified
  WHERE rule_code = 'mixterm'
    AND current_payer IN ('', 'BABI')
  ON CONFLICT (id) DO NOTHING
  RETURNING id
), unknown_inserted AS (
  INSERT INTO tasks (id, title, reason, status, source, owner_object_type, owner_object_id, created_at, updated_at)
  SELECT DISTINCT
         'payer-' || BTRIM(bl_no),
         '货代账单待归属',
         '货代账单 payer 判不出条款或工厂, 待人工确认',
         'open',
         'payer-terms-dna',
         'logistics',
         BTRIM(bl_no),
         now(),
         now()
  FROM classified
  WHERE rule_code IN ('unknown', 'r2b', 'r2c')
    AND desired_payer IS NULL
    AND current_payer IN ('', 'BABI')
  ON CONFLICT (id) DO NOTHING
  RETURNING id
)
SELECT
  COUNT(*) FILTER (WHERE rule_code = 'r1') AS r1_filled,
  COUNT(*) FILTER (WHERE rule_code = 'r2a') AS r2a_babi,
  COUNT(*) FILTER (WHERE rule_code = 'r2b') AS r2b_exw,
  COUNT(*) FILTER (WHERE rule_code = 'r2c') AS r2c_fob,
  (SELECT COUNT(*) FROM mixterm_inserted) AS mixterm_tasks,
  (SELECT COUNT(*) FROM classified c
    WHERE NOT EXISTS (SELECT 1 FROM updated u WHERE u.id = c.id)
      AND NOT (
        c.rule_code = 'mixterm'
        AND c.current_payer IN ('', 'BABI')
        AND EXISTS (SELECT 1 FROM mixterm_inserted)
      )
      AND NOT (
        c.rule_code IN ('unknown', 'r2b', 'r2c')
        AND c.desired_payer IS NULL
        AND c.current_payer IN ('', 'BABI')
        AND EXISTS (SELECT 1 FROM unknown_inserted)
      )) AS skipped
FROM updated;

/*
Dry-run: 上线前先跑, 看一次性引爆面。

WITH bill_scope AS (
  SELECT b.id, b.bl_no, b.cost_category, UPPER(BTRIM(COALESCE(b.currency, ''))) AS currency_norm,
         BTRIM(COALESCE(b.payer_company_code, '')) AS current_payer,
         COALESCE(b.raw, '{}'::jsonb) AS bill_raw, COALESCE(sp.raw, '{}'::jsonb) AS plan_raw,
         sp.id AS plan_id, NULLIF(BTRIM(COALESCE(sp.company_code, sp.raw->>'company_code')), '') AS plan_company_code,
         COALESCE(NULLIF(BTRIM(b.raw->>'transport_mode'), ''), NULLIF(BTRIM(sp.raw->>'transport_mode'), '')) AS transport_mode,
         COALESCE(b.raw, '{}'::jsonb) ? 'split' AS has_split
  FROM freight_supplier_bills b
  LEFT JOIN LATERAL (
    SELECT sp.* FROM shipping_plans sp
    WHERE (b.link_plan_id IS NOT NULL AND sp._id::text = b.link_plan_id::text)
       OR (NULLIF(BTRIM(b.bl_no), '') IS NOT NULL AND BTRIM(sp.bl_no) = BTRIM(b.bl_no))
    ORDER BY CASE WHEN b.link_plan_id IS NOT NULL AND sp._id::text = b.link_plan_id::text THEN 0 ELSE 1 END
    LIMIT 1
  ) sp ON TRUE
  WHERE COALESCE(b.rebill_status, '') NOT IN ('voided', 'absorbed')
    AND NULLIF(BTRIM(b.bl_no), '') IS NOT NULL
), order_rows AS (
  SELECT s.id AS bill_id, NULLIF(BTRIM(o.trade_terms), '') AS trade_terms,
         NULLIF(BTRIM(o.factory_code), '') AS factory_code, NULLIF(BTRIM(o.company_code), '') AS company_code
  FROM bill_scope s
  JOIN orders o ON o.deleted_at IS NULL
   AND (BTRIM(o.bl_no) = BTRIM(s.bl_no) OR (s.plan_id IS NOT NULL AND o.shipping_plan_id::text = s.plan_id::text))
), order_stats AS (
  SELECT bill_id,
         COUNT(DISTINCT UPPER(trade_terms)) FILTER (WHERE UPPER(trade_terms) IN ('EXW', 'FOB')) AS term_count,
         COUNT(*) FILTER (WHERE UPPER(trade_terms) = 'EXW') > 0 AS has_exw,
         COUNT(*) FILTER (WHERE UPPER(trade_terms) = 'FOB') > 0 AS has_fob,
         CASE WHEN COUNT(DISTINCT factory_code) FILTER (WHERE factory_code IS NOT NULL) = 1 THEN MIN(factory_code) FILTER (WHERE factory_code IS NOT NULL) END AS factory_code,
         CASE WHEN COUNT(DISTINCT company_code) FILTER (WHERE company_code IS NOT NULL) = 1 THEN MIN(company_code) FILTER (WHERE company_code IS NOT NULL) END AS order_company_code
  FROM order_rows GROUP BY bill_id
), classified AS (
  SELECT s.id, s.bl_no, s.current_payer,
         CASE WHEN s.has_split THEN 'split'
              WHEN s.current_payer <> '' AND s.current_payer <> 'BABI' THEN 'manual_payer'
              WHEN s.cost_category ~* '海运|ocean' AND s.currency_norm = 'USD' THEN 'r1'
              WHEN s.currency_norm IN ('CNY', 'RMB') AND s.transport_mode = '内转外' THEN 'r2a'
              WHEN s.currency_norm IN ('CNY', 'RMB') AND COALESCE(os.has_exw, FALSE) AND COALESCE(os.has_fob, FALSE) THEN 'mixterm'
              WHEN s.currency_norm IN ('CNY', 'RMB') AND os.term_count = 1 AND os.has_exw THEN 'r2b'
              WHEN s.currency_norm IN ('CNY', 'RMB') AND os.term_count = 1 AND os.has_fob THEN 'r2c'
              WHEN s.currency_norm IN ('CNY', 'RMB') THEN 'unknown' ELSE 'skipped' END AS rule_code,
         CASE WHEN s.has_split THEN NULL
              WHEN s.current_payer <> '' AND s.current_payer <> 'BABI' THEN NULL
              WHEN s.cost_category ~* '海运|ocean' AND s.currency_norm = 'USD' THEN COALESCE(os.order_company_code, s.plan_company_code)
              WHEN s.currency_norm IN ('CNY', 'RMB') AND s.transport_mode = '内转外' THEN 'BABI'
              WHEN s.currency_norm IN ('CNY', 'RMB') AND os.term_count = 1 AND os.has_exw THEN COALESCE(os.order_company_code, s.plan_company_code)
              WHEN s.currency_norm IN ('CNY', 'RMB') AND os.term_count = 1 AND os.has_fob THEN COALESCE(os.factory_code, NULLIF(BTRIM(s.plan_raw->>'shipper_company_code'), ''))
              ELSE NULL END AS desired_payer
  FROM bill_scope s LEFT JOIN order_stats os ON os.bill_id = s.id
)
SELECT rule_code, current_payer, desired_payer, COUNT(*) AS rows
FROM classified
GROUP BY rule_code, current_payer, desired_payer
ORDER BY rule_code, current_payer, desired_payer;
*/
