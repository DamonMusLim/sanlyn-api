-- 修：M071 契约规定 LOW_MONTHLY_SALES 是软排除、**仍然算可比**
-- （is_comparable = exclude_reason IS NULL OR = 'LOW_MONTHLY_SALES'），
-- 但这两个视图里的 WHERE COALESCE(q.is_soft_excluded,false)=false 又把它们滤掉了，
-- 导致库里 63 个可比商品、页面只显示 15 个，48 个真实竞店价看不见。
-- ⚠️ 本文件由脚本从线上 pg_get_viewdef 原样取出，只删那一个条件，
--    输出列名/列序/类型一个未动（CREATE OR REPLACE 对这三样都零容忍）。
-- ⛔ market_valid_cnt 那处的 LOW_MONTHLY_SALES 排除**故意保留不动** ——
--    它是一个具名的「严格可比计数」，语义与 is_comparable 不同，改它要单独评审。

CREATE OR REPLACE VIEW petstore_ops_row AS
SELECT o.product_code,
    o.barcode,
    o.product_name,
    o.category,
    o.spec_text,
    o.pic_url,
    o.supplier,
    o.own_brand,
    o.is_locked_price,
    o.lock_reason,
    o.store_price,
    o.mt_price,
    o.ele_price,
    o.cost_price,
    o.price_status,
    o.src_log_id,
    o.market_price,
    o.market_store,
    o.market_sold,
    o.market_spec,
    o.market_captured_at,
    o.market_quote_cnt,
    o.market_valid_cnt,
    o.market_excluded_cnt,
    o.sales_1d,
    o.sales_7d,
    o.sales_30d,
    o.sales_90d,
    o.daily_avg_90,
    o.cur_stock,
    o.days_of_supply,
    o.days_left,
    o.last_sale_at,
    o.problem_types,
    o.pending_card_cnt,
    o.restock_verdict,
    o.restock_qty,
    o.shelf_code,
    o.shelf_missing,
    o.expiry_flag,
    o.sales_src,
    o.stock_src,
    o.market_src_id,
    o.as_of,
    c.market_price_prev,
    c.market_price_delta,
    c.market_price_delta_pct,
    c.market_days_unchanged
   FROM ( WITH sku AS (
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
                          -- (已删除软排除过滤：M071 规定它仍算可比)
                          WHERE true) x
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
             LEFT JOIN lock_row l ON l.product_code = s.product_code) o
     LEFT JOIN petstore_market_quote_change_current c ON c.quote_id = o.market_src_id;

CREATE OR REPLACE VIEW petstore_ops_row_v2_base AS
SELECT o.product_id,
    o.product_code,
    o.barcode,
    o.product_name,
    o.category,
    o.spec_text,
    o.pic_url,
    o.supplier,
    o.own_brand,
    o.is_locked_price,
    o.lock_reason,
    o.store_price,
    o.mt_price,
    o.ele_price,
    o.cost_price,
    o.price_status,
    o.src_log_id,
    o.market_price,
    o.market_store,
    o.market_sold,
    o.market_spec,
    o.market_captured_at,
    o.market_quote_cnt,
    o.market_valid_cnt,
    o.market_excluded_cnt,
    o.sales_1d,
    o.sales_7d,
    o.sales_30d,
    o.sales_90d,
    o.daily_avg_90,
    o.cur_stock,
    o.days_of_supply,
    o.days_left,
    o.last_sale_at,
    o.restock_verdict,
    o.restock_qty,
    o.shelf_code,
    o.shelf_missing,
    o.expiry_flag,
    o.is_delisted,
    o.delisted_at,
    o.sales_src,
    o.stock_src,
    o.market_src_id,
    o.mt_price_src_id,
    o.ele_price_src_id,
    o.days_left_src_id,
    o.as_of,
    c.market_price_prev,
    c.market_price_delta,
    c.market_price_delta_pct,
    c.market_days_unchanged
   FROM ( WITH external_id_pick AS (
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
                  -- (已删除软排除过滤：M071 规定它仍算可比)
                          WHERE true
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
             LEFT JOIN lock_row lr ON lr.product_code = mb.product_code) o
     LEFT JOIN petstore_market_quote_change_current c ON c.quote_id = o.market_src_id;
