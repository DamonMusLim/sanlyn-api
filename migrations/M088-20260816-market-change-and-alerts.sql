CREATE TABLE IF NOT EXISTS petstore_market_change_events (
  id bigserial PRIMARY KEY,
  product_code text NOT NULL,
  store_name text,
  change_type text NOT NULL,
  old_value numeric,
  new_value numeric,
  delta numeric,
  delta_pct numeric,
  from_quote_id bigint,
  to_quote_id bigint,
  from_captured_at timestamptz,
  to_captured_at timestamptz,
  rule_version text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  CHECK (change_type IN ('PRICE_UP','PRICE_DOWN','NEW_LISTING','DELISTED','SPEC_CHANGED','SALES_JUMP'))
);

CREATE INDEX IF NOT EXISTS idx_pmce_product_code ON petstore_market_change_events (product_code);
CREATE INDEX IF NOT EXISTS idx_pmce_detected_at ON petstore_market_change_events (detected_at);
CREATE INDEX IF NOT EXISTS idx_pmce_change_type ON petstore_market_change_events (change_type);

COMMENT ON TABLE petstore_market_change_events IS
'竞店报价变动事件流。PRICE_UP/PRICE_DOWN=同 rule_version 内上次报价到本次报价的涨跌; NEW_LISTING=同 rule_version 内没有历史基线; DELISTED=下架; SPEC_CHANGED=规格文本变化; SALES_JUMP=销量跳变。变动只在同 rule_version 内计算,跨 rule_version 一律不算变动。';

CREATE TABLE IF NOT EXISTS petstore_alert_rules (
  id serial PRIMARY KEY,
  rule_key text NOT NULL UNIQUE,
  rule_name text NOT NULL,
  metric text NOT NULL,
  threshold numeric NOT NULL,
  comparison text NOT NULL CHECK (comparison IN ('>','>=','<','<=','=')),
  action text NOT NULL,
  scope text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO petstore_alert_rules
  (rule_key, rule_name, metric, threshold, comparison, action, scope)
VALUES
  ('MARKET_DATA_STALE_DAYS','竞店报价数据超过2天未更新','market_data_age_days',2,'>','notify','store:63350001'),
  ('PRICE_DROP_PCT','竞店降价超过10%','competitor_price_drop_pct',10,'>=','notify','store:63350001'),
  ('COMPARABLE_COUNT_MIN','可比商品数跌破50','comparable_product_count',50,'<','notify','store:63350001')
ON CONFLICT (rule_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS petstore_alert_events (
  id bigserial PRIMARY KEY,
  rule_key text NOT NULL,
  metric text NOT NULL,
  observed numeric NOT NULL,
  threshold numeric NOT NULL,
  comparison text NOT NULL,
  severity text NOT NULL DEFAULT 'warn' CHECK (severity IN ('info','warn','critical')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  fired_at timestamptz NOT NULL DEFAULT now(),
  notified_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_pae_rule_key ON petstore_alert_events (rule_key);
CREATE INDEX IF NOT EXISTS idx_pae_fired_at ON petstore_alert_events (fired_at);

-- Claude 改：我在 brief 里给的唯一键 (product_code, day_key, store_name) 是错的，
-- 实测现有 206 行里就有 26 组 63 行重复 —— 同一我方商品在同店同天本来就可能匹配到
-- 多条竞店报价（如 6335102920 在邻小虎命中 4 条：14.80/258.00/68.00/99.00）。
-- 改成内容键：同一天同样的数据重跑必然撞上，才是真幂等。
-- ⛔ 不能用 quote_id：reingest 每轮先删后插，quote_id 每次都是新的，去不了重。
-- price/spec_text 可空，唯一索引里 NULL 互不相等，所以必须 COALESCE。
CREATE UNIQUE INDEX IF NOT EXISTS ux_pmqh_content
  ON petstore_market_quote_history
     (product_code, day_key, store_name, COALESCE(price, -1), COALESCE(spec_text, ''));

CREATE OR REPLACE VIEW petstore_market_quote_change_current AS
SELECT
  q.id AS quote_id,
  prev.quote_id AS prev_quote_id,
  prev.price AS market_price_prev,
  CASE WHEN prev.price IS NULL THEN NULL ELSE round((q.price - prev.price)::numeric, 2) END AS market_price_delta,
  CASE
    WHEN prev.price IS NULL OR prev.price = 0 THEN NULL
    ELSE round(((q.price - prev.price) / prev.price * 100.0)::numeric, 2)
  END AS market_price_delta_pct,
  CASE
    WHEN prev.price IS NULL THEN NULL
    WHEN q.price = prev.price THEN (q.captured_at::date - prev.captured_at::date)::integer
    ELSE 0
  END AS market_days_unchanged
FROM petstore_market_quotes q
LEFT JOIN LATERAL (
  SELECT h.quote_id, h.price, h.captured_at
  FROM petstore_market_quote_history h
  WHERE h.product_code = q.product_code
    AND h.rule_version = q.rule_version
    AND h.captured_at::date < q.captured_at::date
  ORDER BY h.captured_at DESC, h.id DESC
  LIMIT 1
) prev ON true;

COMMENT ON VIEW petstore_market_quote_change_current IS
'当前竞店报价的同 rule_version 上次报价 helper。没有同版本历史时四个变动列均为 NULL; market_price_delta_pct 在上次价格为 0 或 NULL 时为 NULL。';

-- ⚠️ 由脚本从线上 pg_get_viewdef 原样取出后包一层，未重打任何一行原定义。
-- o.* 保证 44 列的名字与顺序完全不变，新 4 列只追加在尾部。
-- 按 market_src_id join：这是本行实际选中的那条报价，避免一商品多报价时放大行数。
CREATE OR REPLACE VIEW petstore_ops_row AS
SELECT o.*,
  c.market_price_prev,
  c.market_price_delta,
  c.market_price_delta_pct,
  c.market_days_unchanged
FROM (
WITH sku AS (
         SELECT DISTINCT ON (petstore_skus.product_code) petstore_skus.product_code,
            petstore_skus.product_name,
            petstore_skus.category,
            petstore_skus.spec AS spec_text,
            petstore_skus.cost_price,
            petstore_skus.out_price,
            NULLIF(regexp_replace(COALESCE(petstore_skus.shelf_list, ''::text), '[\[\]"]'::text, ''::text, 'g'::text), ''::text) AS shelf_code,
            COALESCE(NULLIF(regexp_replace(COALESCE(petstore_skus.shelf_list, ''::text), '[\[\]"\s]'::text, ''::text, 'g'::text), ''::text), ''::text) = ''::text AS shelf_missing,
            petstore_skus.supplier,
            petstore_skus.own_brand,
            petstore_skus.snapshot_date
           FROM petstore_skus
          WHERE petstore_skus.product_code IS NOT NULL
          ORDER BY petstore_skus.product_code, petstore_skus.snapshot_date DESC NULLS LAST
        ), bc AS (
         SELECT DISTINCT ON (petstore_pricing_log.product_code) petstore_pricing_log.product_code,
            petstore_pricing_log.barcode
           FROM petstore_pricing_log
          WHERE petstore_pricing_log.product_code IS NOT NULL AND petstore_pricing_log.barcode IS NOT NULL
          ORDER BY petstore_pricing_log.product_code, petstore_pricing_log.id DESC
        ), price_today AS (
         SELECT DISTINCT ON (petstore_pricing_daily.product_code) petstore_pricing_daily.product_code,
            petstore_pricing_daily.log_date,
            petstore_pricing_daily.ts,
            petstore_pricing_daily.product_name,
            petstore_pricing_daily.store_name,
            petstore_pricing_daily.old_price,
            petstore_pricing_daily.new_price,
            petstore_pricing_daily.rate,
            petstore_pricing_daily.reason,
            petstore_pricing_daily.days_left,
            petstore_pricing_daily.channel_results,
            petstore_pricing_daily.ok_cnt,
            petstore_pricing_daily.fail_cnt,
            petstore_pricing_daily.skip_cnt,
            petstore_pricing_daily.chan_cnt,
            petstore_pricing_daily.price_status,
            petstore_pricing_daily.effective_channels,
            petstore_pricing_daily.preview_only_channels,
            petstore_pricing_daily.src_log_id,
            petstore_pricing_daily.preview_new_price
           FROM petstore_pricing_daily
          WHERE petstore_pricing_daily.log_date = CURRENT_DATE AND petstore_pricing_daily.product_code IS NOT NULL
          ORDER BY petstore_pricing_daily.product_code, petstore_pricing_daily.src_log_id DESC NULLS LAST
        ), price_src AS (
         SELECT l_1.id,
            l_1.ts,
            l_1.log_date,
            l_1.store_code,
            l_1.store_name,
            l_1.channel,
            l_1.product_code,
            l_1.product_name,
            l_1.old_price,
            l_1.new_price,
            l_1.rate,
            l_1.reason,
            l_1.result,
            l_1.days_left,
            l_1.tier,
            l_1.source_hash,
            l_1.synced_at,
            l_1.mkt_price,
            l_1.mkt_store,
            l_1.mkt_sold,
            l_1.mkt_total_sold,
            l_1.mkt_n_stores,
            l_1.mkt_matched_title,
            l_1.mkt_conf,
            l_1.mkt_captured_at,
            l_1.cost_price,
            l_1.stock_qty,
            l_1.qty_90,
            l_1.expiry_flag,
            l_1.problem_type,
            l_1.damon_verdict,
            l_1.damon_price,
            l_1.damon_reason,
            l_1.confirmed_at,
            l_1.exec_status,
            l_1.executed_at,
            l_1.readback_ok,
            l_1.idem_key,
            l_1.sales_7d_after,
            l_1.sales_30d_after,
            l_1.barcode,
            l_1.mt_price,
            l_1.ele_price,
            l_1.pic_url,
            l_1.damon_online_price,
            l_1.damon_context
           FROM petstore_pricing_log l_1
             JOIN price_today d_1 ON d_1.src_log_id = l_1.id
        ), pic AS (
         SELECT DISTINCT ON (petstore_pricing_log.product_code) petstore_pricing_log.product_code,
            petstore_pricing_log.pic_url
           FROM petstore_pricing_log
          WHERE petstore_pricing_log.product_code IS NOT NULL AND petstore_pricing_log.pic_url IS NOT NULL
          ORDER BY petstore_pricing_log.product_code, petstore_pricing_log.id DESC
        ), market_pick AS (
         SELECT x.id,
            x.product_code,
            x.source,
            x.source_tier,
            x.store_name,
            x.matched_title,
            x.spec_text,
            x.price,
            x.orig_price,
            x.monthly_sales,
            x.promo,
            x.match_conf,
            x.captured_at,
            x.evidence,
            x.qty_g,
            x.unit_price,
            x.is_comparable,
            x.exclude_reason,
            x.rule_version,
            x.is_soft_excluded,
            x.rn
           FROM ( SELECT q.id,
                    q.product_code,
                    q.source,
                    q.source_tier,
                    q.store_name,
                    q.matched_title,
                    q.spec_text,
                    q.price,
                    q.orig_price,
                    q.monthly_sales,
                    q.promo,
                    q.match_conf,
                    q.captured_at,
                    q.evidence,
                    q.qty_g,
                    q.unit_price,
                    q.is_comparable,
                    q.exclude_reason,
                    q.rule_version,
                    q.is_soft_excluded,
                    row_number() OVER (PARTITION BY q.product_code ORDER BY (COALESCE(q.monthly_sales, 0)) DESC, q.captured_at DESC, q.id DESC) AS rn
                   FROM petstore_valid_quotes q
                  WHERE COALESCE(q.is_soft_excluded, false) = false) x
          WHERE x.rn = 1
        ), market_cnt AS (
         SELECT q.product_code,
            count(*)::integer AS market_quote_cnt,
            count(*) FILTER (WHERE q.is_comparable = true AND COALESCE(q.exclude_reason, ''::text) <> 'LOW_MONTHLY_SALES'::text)::integer AS market_valid_cnt,
            count(*) FILTER (WHERE q.exclude_reason IS NOT NULL)::integer AS market_excluded_cnt
           FROM petstore_market_quotes q
          GROUP BY q.product_code
        ), pending AS (
         SELECT petstore_pricing_log.product_code,
            array_agg(DISTINCT petstore_pricing_log.problem_type) FILTER (WHERE petstore_pricing_log.problem_type IS NOT NULL) AS problem_types,
            count(*)::integer AS pending_card_cnt,
            min(petstore_pricing_log.days_left) AS days_left,
            (array_agg(petstore_pricing_log.expiry_flag ORDER BY petstore_pricing_log.ts DESC, petstore_pricing_log.id DESC) FILTER (WHERE petstore_pricing_log.expiry_flag IS NOT NULL))[1] AS expiry_flag,
            (array_agg(petstore_pricing_log.pic_url ORDER BY petstore_pricing_log.ts DESC, petstore_pricing_log.id DESC) FILTER (WHERE petstore_pricing_log.pic_url IS NOT NULL))[1] AS pic_url
           FROM petstore_pricing_log
          WHERE petstore_pricing_log.exec_status = 'pending'::text
          GROUP BY petstore_pricing_log.product_code
        ), dna AS (
         SELECT DISTINCT ON (petstore_sku_sales_dna.product_code) petstore_sku_sales_dna.product_code,
            petstore_sku_sales_dna.restock_verdict,
            petstore_sku_sales_dna.restock_qty,
            petstore_sku_sales_dna.as_of
           FROM petstore_sku_sales_dna
          ORDER BY petstore_sku_sales_dna.product_code, petstore_sku_sales_dna.as_of DESC
        ), lock_row AS (
         SELECT DISTINCT ON (petstore_price_lock.product_code) petstore_price_lock.product_code,
            petstore_price_lock.locked,
            petstore_price_lock.reason
           FROM petstore_price_lock
          ORDER BY petstore_price_lock.product_code
        )
 SELECT s.product_code,
    bc.barcode,
    s.product_name,
    s.category,
    s.spec_text,
    COALESCE(p.pic_url, ps.pic_url, pic.pic_url) AS pic_url,
    s.supplier,
    s.own_brand,
    COALESCE(l.locked, false) AS is_locked_price,
    l.reason AS lock_reason,
    round(s.out_price, 2) AS store_price,
    round(ps.mt_price, 2) AS mt_price,
    round(ps.ele_price, 2) AS ele_price,
    round(s.cost_price, 2) AS cost_price,
    d.price_status,
    d.src_log_id,
    round(m.price, 2) AS market_price,
    m.store_name AS market_store,
    m.monthly_sales AS market_sold,
    m.spec_text AS market_spec,
    m.captured_at AS market_captured_at,
    COALESCE(mc.market_quote_cnt, 0) AS market_quote_cnt,
    COALESCE(mc.market_valid_cnt, 0) AS market_valid_cnt,
    COALESCE(mc.market_excluded_cnt, 0) AS market_excluded_cnt,
    COALESCE(r.sales_1d, 0::numeric) AS sales_1d,
    COALESCE(r.sales_7d, 0::numeric) AS sales_7d,
    COALESCE(r.sales_30d, 0::numeric) AS sales_30d,
    COALESCE(r.sales_90d, 0::numeric) AS sales_90d,
    COALESCE(r.daily_avg_90, 0::numeric) AS daily_avg_90,
    r.cur_stock,
    r.days_of_supply,
    COALESCE(ps.days_left, p.days_left) AS days_left,
    r.last_sale_at,
    COALESCE(p.problem_types, ARRAY[]::text[]) AS problem_types,
    COALESCE(p.pending_card_cnt, 0) AS pending_card_cnt,
    dna.restock_verdict,
    dna.restock_qty,
    s.shelf_code,
    s.shelf_missing,
    COALESCE(ps.expiry_flag, p.expiry_flag) AS expiry_flag,
    'petstore_stock_ledger'::text AS sales_src,
    'petstore_stock_ledger'::text AS stock_src,
    m.id AS market_src_id,
    now() AS as_of
   FROM sku s
     LEFT JOIN bc ON bc.product_code = s.product_code
     LEFT JOIN price_today d ON d.product_code = s.product_code
     LEFT JOIN price_src ps ON ps.id = d.src_log_id
     LEFT JOIN pic ON pic.product_code = s.product_code
     LEFT JOIN market_pick m ON m.product_code = s.product_code
     LEFT JOIN market_cnt mc ON mc.product_code = s.product_code
     LEFT JOIN petstore_sales_rollup r ON r.product_code = s.product_code
     LEFT JOIN pending p ON p.product_code = s.product_code
     LEFT JOIN dna ON dna.product_code = s.product_code
     LEFT JOIN lock_row l ON l.product_code = s.product_code
) o
LEFT JOIN petstore_market_quote_change_current c ON c.quote_id = o.market_src_id;

-- ⚠️ 由脚本从线上 pg_get_viewdef 原样取出后包一层，未重打任何一行原定义。
-- o.* 保证 44 列的名字与顺序完全不变，新 4 列只追加在尾部。
-- 按 market_src_id join：这是本行实际选中的那条报价，避免一商品多报价时放大行数。
CREATE OR REPLACE VIEW petstore_ops_row_v2_base AS
SELECT o.*,
  c.market_price_prev,
  c.market_price_delta,
  c.market_price_delta_pct,
  c.market_days_unchanged
FROM (
WITH external_id_pick AS (
         SELECT DISTINCT ON (pei.product_id) pei.product_id,
            pei.external_product_code,
            pei.barcode,
            pei.is_current,
            pei.valid_to
           FROM product_external_ids pei
          WHERE pei.source_system = 'jelly_orange'::text
          ORDER BY pei.product_id, pei.is_current DESC, pei.valid_from DESC NULLS LAST, pei.id DESC
        ), master_base AS (
         SELECT pm.product_id,
            pei.external_product_code AS product_code,
            COALESCE(pei.barcode, pm.barcode, pm.pos_barcode) AS barcode,
            COALESCE(pm.standard_product_name, pm.pos_product_name) AS product_name,
            COALESCE(pm.display_category, pm.pos_category) AS category,
            COALESCE(pm.standard_spec, pm.pos_spec) AS spec_text,
            pm.supplier,
            pm.out_price,
            pm.cost_price,
            pm.stock_num,
            pm.shelf_list,
            pm.updated_at,
            pei.is_current = false AS is_delisted,
            pei.valid_to AS delisted_at
           FROM product_master pm
             JOIN external_id_pick pei ON pei.product_id = pm.product_id
        ), latest_sku AS (
         SELECT DISTINCT ON (ps.product_code) ps.product_code,
            ps.own_brand
           FROM petstore_skus ps
          WHERE ps.product_code IS NOT NULL
          ORDER BY ps.product_code, ps.snapshot_date DESC NULLS LAST
        ), barcode_pick AS (
         SELECT DISTINCT ON (pl.product_code) pl.product_code,
            pl.barcode
           FROM petstore_pricing_log pl
          WHERE pl.product_code IS NOT NULL AND pl.barcode IS NOT NULL AND pl.barcode <> ''::text
          ORDER BY pl.product_code, pl.synced_at DESC NULLS LAST, pl.id DESC
        ), days_left_pick AS (
         SELECT DISTINCT ON (pl.product_code) pl.product_code,
            pl.days_left,
            pl.id AS days_left_src_id
           FROM petstore_pricing_log pl
          WHERE pl.product_code IS NOT NULL AND pl.days_left IS NOT NULL
          ORDER BY pl.product_code, pl.synced_at DESC NULLS LAST, pl.id DESC
        ), mt_price_pick AS (
         SELECT DISTINCT ON (pl.product_code) pl.product_code,
            round(pl.mt_price, 2) AS mt_price,
            pl.id AS mt_price_src_id
           FROM petstore_pricing_log pl
          WHERE pl.product_code IS NOT NULL AND pl.mt_price IS NOT NULL
          ORDER BY pl.product_code, pl.synced_at DESC NULLS LAST, pl.id DESC
        ), ele_price_pick AS (
         SELECT DISTINCT ON (pl.product_code) pl.product_code,
            round(pl.ele_price, 2) AS ele_price,
            pl.id AS ele_price_src_id
           FROM petstore_pricing_log pl
          WHERE pl.product_code IS NOT NULL AND pl.ele_price IS NOT NULL
          ORDER BY pl.product_code, pl.synced_at DESC NULLS LAST, pl.id DESC
        ), expiry_flag_pick AS (
         SELECT DISTINCT ON (pl.product_code) pl.product_code,
            pl.expiry_flag
           FROM petstore_pricing_log pl
          WHERE pl.product_code IS NOT NULL AND pl.expiry_flag IS NOT NULL
          ORDER BY pl.product_code, pl.synced_at DESC NULLS LAST, pl.id DESC
        ), pic_pick AS (
         SELECT DISTINCT ON (pl.product_code) pl.product_code,
            pl.pic_url
           FROM petstore_pricing_log pl
          WHERE pl.product_code IS NOT NULL AND pl.pic_url IS NOT NULL AND pl.pic_url <> ''::text
          ORDER BY pl.product_code, pl.synced_at DESC NULLS LAST, pl.id DESC
        ), price_today AS (
         SELECT DISTINCT ON (pd.product_code) pd.product_code,
            pd.price_status,
            pd.src_log_id
           FROM petstore_pricing_daily pd
          WHERE pd.log_date = CURRENT_DATE AND pd.product_code IS NOT NULL
          ORDER BY pd.product_code, pd.src_log_id DESC NULLS LAST
        ), market_ranked AS (
         SELECT q.id,
            q.product_code,
            round(q.price, 2) AS price,
            q.store_name,
            q.monthly_sales,
            q.spec_text,
            q.captured_at,
            row_number() OVER (PARTITION BY q.product_code ORDER BY (COALESCE(q.monthly_sales, 0)) DESC, q.captured_at DESC, q.id DESC) AS rn
           FROM petstore_valid_quotes q
          WHERE COALESCE(q.is_soft_excluded, false) = false
        ), market_pick AS (
         SELECT mr.id,
            mr.product_code,
            mr.price,
            mr.store_name,
            mr.monthly_sales,
            mr.spec_text,
            mr.captured_at
           FROM market_ranked mr
          WHERE mr.rn = 1
        ), market_cnt AS (
         SELECT q.product_code,
            count(*)::integer AS market_quote_cnt,
            count(*) FILTER (WHERE q.is_comparable = true AND COALESCE(q.exclude_reason, ''::text) <> 'LOW_MONTHLY_SALES'::text)::integer AS market_valid_cnt,
            count(*) FILTER (WHERE q.exclude_reason IS NOT NULL)::integer AS market_excluded_cnt
           FROM petstore_market_quotes q
          GROUP BY q.product_code
        ), sales AS (
         SELECT psl.product_code,
            sum(
                CASE
                    WHEN psl.change_time >= (now() - '1 day'::interval) THEN
                    CASE
                        WHEN psl.delta < 0::numeric THEN - psl.delta
                        ELSE psl.delta
                    END
                    ELSE 0::numeric
                END) AS sales_1d,
            sum(
                CASE
                    WHEN psl.change_time >= (now() - '7 days'::interval) THEN
                    CASE
                        WHEN psl.delta < 0::numeric THEN - psl.delta
                        ELSE psl.delta
                    END
                    ELSE 0::numeric
                END) AS sales_7d,
            sum(
                CASE
                    WHEN psl.change_time >= (now() - '30 days'::interval) THEN
                    CASE
                        WHEN psl.delta < 0::numeric THEN - psl.delta
                        ELSE psl.delta
                    END
                    ELSE 0::numeric
                END) AS sales_30d,
            sum(
                CASE
                    WHEN psl.change_time >= (now() - '90 days'::interval) THEN
                    CASE
                        WHEN psl.delta < 0::numeric THEN - psl.delta
                        ELSE psl.delta
                    END
                    ELSE 0::numeric
                END) AS sales_90d,
            max(psl.change_time) AS last_sale_at
           FROM petstore_stock_ledger psl
          WHERE psl.order_type = 'XS'::text
          GROUP BY psl.product_code
        ), stock_latest AS (
         SELECT DISTINCT ON (psl.product_code) psl.product_code,
            psl.stock_after AS cur_stock,
            psl.change_time AS stock_captured_at
           FROM petstore_stock_ledger psl
          WHERE psl.product_code IS NOT NULL
          ORDER BY psl.product_code, psl.change_time DESC NULLS LAST, psl.src_id DESC
        ), sales_rollup AS (
         SELECT COALESCE(s.product_code, st.product_code) AS product_code,
            COALESCE(s.sales_1d, 0::numeric) AS sales_1d,
            COALESCE(s.sales_7d, 0::numeric) AS sales_7d,
            COALESCE(s.sales_30d, 0::numeric) AS sales_30d,
            COALESCE(s.sales_90d, 0::numeric) AS sales_90d,
            round(COALESCE(s.sales_90d, 0::numeric) / 90.0, 2) AS daily_avg_90,
            st.cur_stock,
                CASE
                    WHEN COALESCE(s.sales_90d, 0::numeric) > 0::numeric AND st.cur_stock IS NOT NULL THEN round(st.cur_stock / (s.sales_90d / 90.0), 2)
                    ELSE NULL::numeric
                END AS days_of_supply,
            s.last_sale_at,
            st.stock_captured_at
           FROM sales s
             FULL JOIN stock_latest st ON st.product_code = s.product_code
        ), dna AS (
         SELECT DISTINCT ON (psd.product_code) psd.product_code,
            psd.restock_verdict,
            psd.restock_qty
           FROM petstore_sku_sales_dna psd
          WHERE psd.product_code IS NOT NULL
          ORDER BY psd.product_code, psd.as_of DESC NULLS LAST
        ), lock_row AS (
         SELECT DISTINCT ON (ppl.product_code) ppl.product_code,
            ppl.locked,
            ppl.reason
           FROM petstore_price_lock ppl
          WHERE ppl.product_code IS NOT NULL
          ORDER BY ppl.product_code
        )
 SELECT mb.product_id,
    mb.product_code,
    COALESCE(mb.barcode, bp.barcode) AS barcode,
    mb.product_name,
    mb.category,
    mb.spec_text,
    pp.pic_url,
    mb.supplier,
    ls.own_brand,
    COALESCE(lr.locked, false) AS is_locked_price,
    lr.reason AS lock_reason,
    round(mb.out_price::numeric, 2) AS store_price,
    mt.mt_price,
    ele.ele_price,
    round(mb.cost_price::numeric, 2) AS cost_price,
    pt.price_status,
    pt.src_log_id,
    mp.price AS market_price,
    mp.store_name AS market_store,
    mp.monthly_sales AS market_sold,
    mp.spec_text AS market_spec,
    mp.captured_at AS market_captured_at,
    COALESCE(mc.market_quote_cnt, 0) AS market_quote_cnt,
    COALESCE(mc.market_valid_cnt, 0) AS market_valid_cnt,
    COALESCE(mc.market_excluded_cnt, 0) AS market_excluded_cnt,
    COALESCE(sr.sales_1d, 0::numeric) AS sales_1d,
    COALESCE(sr.sales_7d, 0::numeric) AS sales_7d,
    COALESCE(sr.sales_30d, 0::numeric) AS sales_30d,
    COALESCE(sr.sales_90d, 0::numeric) AS sales_90d,
    COALESCE(sr.daily_avg_90, 0::numeric) AS daily_avg_90,
    COALESCE(sr.cur_stock, mb.stock_num) AS cur_stock,
    sr.days_of_supply,
    dlp.days_left,
    sr.last_sale_at,
    dna.restock_verdict,
    dna.restock_qty,
    NULLIF(regexp_replace(COALESCE(mb.shelf_list, ''::text), '[\[\]"]'::text, ''::text, 'g'::text), ''::text) AS shelf_code,
    COALESCE(NULLIF(regexp_replace(COALESCE(mb.shelf_list, ''::text), '[\[\]"\s]'::text, ''::text, 'g'::text), ''::text), ''::text) = ''::text AS shelf_missing,
    efp.expiry_flag,
    mb.is_delisted,
    mb.delisted_at,
    'petstore_stock_ledger'::text AS sales_src,
    'petstore_stock_ledger'::text AS stock_src,
    mp.id AS market_src_id,
    mt.mt_price_src_id,
    ele.ele_price_src_id,
    dlp.days_left_src_id,
    now() AS as_of
   FROM master_base mb
     LEFT JOIN latest_sku ls ON ls.product_code = mb.product_code
     LEFT JOIN barcode_pick bp ON bp.product_code = mb.product_code
     LEFT JOIN days_left_pick dlp ON dlp.product_code = mb.product_code
     LEFT JOIN mt_price_pick mt ON mt.product_code = mb.product_code
     LEFT JOIN ele_price_pick ele ON ele.product_code = mb.product_code
     LEFT JOIN expiry_flag_pick efp ON efp.product_code = mb.product_code
     LEFT JOIN pic_pick pp ON pp.product_code = mb.product_code
     LEFT JOIN price_today pt ON pt.product_code = mb.product_code
     LEFT JOIN market_pick mp ON mp.product_code = mb.product_code
     LEFT JOIN market_cnt mc ON mc.product_code = mb.product_code
     LEFT JOIN sales_rollup sr ON sr.product_code = mb.product_code
     LEFT JOIN dna ON dna.product_code = mb.product_code
     LEFT JOIN lock_row lr ON lr.product_code = mb.product_code
) o
LEFT JOIN petstore_market_quote_change_current c ON c.quote_id = o.market_src_id;

-- ⚠️ 由脚本从线上 pg_get_viewdef 原样取出后包一层，未重打任何一行原定义。
-- o.* 保证 44 列的名字与顺序完全不变，新 4 列只追加在尾部。
-- 按 market_src_id join：这是本行实际选中的那条报价，避免一商品多报价时放大行数。
CREATE OR REPLACE VIEW petstore_ops_row_v2_shadow AS
SELECT o.*,
  c.market_price_prev,
  c.market_price_delta,
  c.market_price_delta_pct,
  c.market_days_unchanged
FROM (
WITH rule AS (
         SELECT max(ebr.rule_value) FILTER (WHERE ebr.rule_key = 'expired_days'::text) AS expired_days,
            max(ebr.rule_value) FILTER (WHERE ebr.rule_key = 'clearance_days'::text) AS clearance_days,
            max(ebr.rule_value) FILTER (WHERE ebr.rule_key = 'near_expiry_days'::text) AS near_expiry_days,
            max(ebr.rule_value) FILTER (WHERE ebr.rule_key = 'below_cost_pct'::text) AS below_cost_pct,
            max(ebr.rule_value) FILTER (WHERE ebr.rule_key = 'margin_pct_zero'::text) AS margin_pct_zero,
            max(ebr.rule_value) FILTER (WHERE ebr.rule_key = 'thin_margin_pct'::text) AS thin_margin_pct,
            max(ebr.rule_value) FILTER (WHERE ebr.rule_key = 'slow_moving_days'::text) AS slow_moving_days,
            max(ebr.rule_value) FILTER (WHERE ebr.rule_key = 'dead_stock_days'::text) AS dead_stock_days,
            max(ebr.rule_value) FILTER (WHERE ebr.rule_key = 'restock_days_of_supply'::text) AS restock_days_of_supply,
            max(ebr.rule_value) FILTER (WHERE ebr.rule_key = 'market_deviation_pct'::text) AS market_deviation_pct
           FROM effective_business_rules ebr
          WHERE ebr.store_code = '63350001'::text
        ), base_with_problem AS (
         SELECT rb.product_id,
            rb.product_code,
            rb.barcode,
            rb.product_name,
            rb.category,
            rb.spec_text,
            rb.pic_url,
            rb.supplier,
            rb.own_brand,
            rb.is_locked_price,
            rb.lock_reason,
            rb.store_price,
            rb.mt_price,
            rb.ele_price,
            rb.cost_price,
                CASE
                    WHEN rb.store_price IS NOT NULL AND rb.cost_price IS NOT NULL AND rb.store_price > 0::numeric THEN round((rb.store_price - rb.cost_price) / rb.store_price * 100.0, 2)
                    ELSE NULL::numeric
                END AS margin_pct,
            rb.price_status,
            rb.src_log_id,
            rb.market_price,
            rb.market_store,
            rb.market_sold,
            rb.market_spec,
            rb.market_captured_at,
            rb.market_quote_cnt,
            rb.market_valid_cnt,
            rb.market_excluded_cnt,
            rb.sales_1d,
            rb.sales_7d,
            rb.sales_30d,
            rb.sales_90d,
            rb.daily_avg_90,
            rb.cur_stock,
            rb.days_of_supply,
            rb.days_left,
            rb.last_sale_at,
            rb.restock_verdict,
            rb.restock_qty,
            rb.shelf_code,
            rb.shelf_missing,
            rb.expiry_flag,
            rb.is_delisted,
            rb.delisted_at,
            rb.sales_src,
            rb.stock_src,
            rb.market_src_id,
            rb.mt_price_src_id,
            rb.ele_price_src_id,
            rb.days_left_src_id,
            rb.as_of,
            p.problem_type,
            p.rule_key
           FROM petstore_ops_row_v2_base rb
             CROSS JOIN rule r
             LEFT JOIN LATERAL ( VALUES ('below_cost'::text,'below_cost_pct'::text,rb.store_price IS NOT NULL AND rb.cost_price IS NOT NULL AND rb.store_price < (rb.cost_price * (1::numeric - r.below_cost_pct / 100.0))), ('zero_margin'::text,'margin_pct_zero'::text,rb.store_price IS NOT NULL AND rb.cost_price IS NOT NULL AND rb.store_price > 0::numeric AND rb.store_price >= (rb.cost_price * (1::numeric - r.below_cost_pct / 100.0)) AND ((rb.store_price - rb.cost_price) / rb.store_price * 100.0) <= r.margin_pct_zero), ('thin_margin'::text,'thin_margin_pct'::text,rb.store_price IS NOT NULL AND rb.cost_price IS NOT NULL AND rb.store_price > 0::numeric AND ((rb.store_price - rb.cost_price) / rb.store_price * 100.0) > r.margin_pct_zero AND ((rb.store_price - rb.cost_price) / rb.store_price * 100.0) < r.thin_margin_pct), ('expired'::text,'expired_days'::text,rb.days_left IS NOT NULL AND rb.days_left::numeric <= r.expired_days), ('clearance'::text,'clearance_days'::text,rb.days_left IS NOT NULL AND rb.days_left::numeric > r.expired_days AND rb.days_left::numeric <= r.clearance_days), ('near_expiry'::text,'near_expiry_days'::text,rb.days_left IS NOT NULL AND rb.days_left::numeric > r.clearance_days AND rb.days_left::numeric <= r.near_expiry_days), ('dead_stock'::text,'dead_stock_days'::text,rb.last_sale_at IS NOT NULL AND rb.last_sale_at::date <= (CURRENT_DATE - r.dead_stock_days::integer::double precision * '1 day'::interval)), ('slow_moving'::text,'slow_moving_days'::text,rb.last_sale_at IS NOT NULL AND rb.last_sale_at::date <= (CURRENT_DATE - r.slow_moving_days::integer::double precision * '1 day'::interval) AND rb.last_sale_at::date > (CURRENT_DATE - r.dead_stock_days::integer::double precision * '1 day'::interval)), ('restock'::text,'restock_days_of_supply'::text,rb.days_of_supply IS NOT NULL AND rb.days_of_supply < r.restock_days_of_supply), ('market_deviation'::text,'market_deviation_pct'::text,rb.store_price IS NOT NULL AND rb.market_price IS NOT NULL AND rb.store_price > 0::numeric AND (abs(rb.store_price - rb.market_price) / rb.store_price * 100.0) >= r.market_deviation_pct)) p(problem_type, rule_key, hit) ON p.hit
        )
 SELECT bwp.product_code,
    bwp.barcode,
    bwp.product_name,
    bwp.category,
    bwp.spec_text,
    bwp.pic_url,
    bwp.supplier,
    bwp.own_brand,
    bwp.is_locked_price,
    bwp.lock_reason,
    bwp.store_price,
    bwp.mt_price,
    bwp.ele_price,
    bwp.cost_price,
    bwp.margin_pct,
    bwp.price_status,
    bwp.src_log_id,
    bwp.market_price,
    bwp.market_store,
    bwp.market_sold,
    bwp.market_spec,
    bwp.market_captured_at,
    bwp.market_quote_cnt,
    bwp.market_valid_cnt,
    bwp.market_excluded_cnt,
    bwp.sales_1d,
    bwp.sales_7d,
    bwp.sales_30d,
    bwp.sales_90d,
    bwp.daily_avg_90,
    bwp.cur_stock,
    bwp.days_of_supply,
    bwp.days_left,
    bwp.last_sale_at,
    COALESCE(array_agg(DISTINCT bwp.problem_type ORDER BY bwp.problem_type) FILTER (WHERE bwp.problem_type IS NOT NULL), ARRAY[]::text[]) AS problem_types,
    COALESCE(array_agg(DISTINCT bwp.rule_key ORDER BY bwp.rule_key) FILTER (WHERE bwp.rule_key IS NOT NULL), ARRAY[]::text[]) AS problem_rule_keys,
    bwp.restock_verdict,
    bwp.restock_qty,
    bwp.shelf_code,
    bwp.shelf_missing,
    bwp.expiry_flag,
    bwp.is_delisted,
    bwp.delisted_at,
    bwp.sales_src,
    bwp.stock_src,
    bwp.market_src_id,
    bwp.mt_price_src_id,
    bwp.ele_price_src_id,
    bwp.days_left_src_id,
    bwp.as_of
   FROM base_with_problem bwp
  GROUP BY bwp.product_code, bwp.barcode, bwp.product_name, bwp.category, bwp.spec_text, bwp.pic_url, bwp.supplier, bwp.own_brand, bwp.is_locked_price, bwp.lock_reason, bwp.store_price, bwp.mt_price, bwp.ele_price, bwp.cost_price, bwp.margin_pct, bwp.price_status, bwp.src_log_id, bwp.market_price, bwp.market_store, bwp.market_sold, bwp.market_spec, bwp.market_captured_at, bwp.market_quote_cnt, bwp.market_valid_cnt, bwp.market_excluded_cnt, bwp.sales_1d, bwp.sales_7d, bwp.sales_30d, bwp.sales_90d, bwp.daily_avg_90, bwp.cur_stock, bwp.days_of_supply, bwp.days_left, bwp.last_sale_at, bwp.restock_verdict, bwp.restock_qty, bwp.shelf_code, bwp.shelf_missing, bwp.expiry_flag, bwp.is_delisted, bwp.delisted_at, bwp.sales_src, bwp.stock_src, bwp.market_src_id, bwp.mt_price_src_id, bwp.ele_price_src_id, bwp.days_left_src_id, bwp.as_of
) o
LEFT JOIN petstore_market_quote_change_current c ON c.quote_id = o.market_src_id;
