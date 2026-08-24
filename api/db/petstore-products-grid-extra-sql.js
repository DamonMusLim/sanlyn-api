export const productGridExtraBaseSelectSql = `
        market_fold.market_min_price, market_fold.market_max_price,
        market_fold.market_low_store, market_fold.market_low_sold,
        market_fold.market_low_spec, market_fold.market_low_captured_at,
        market_fold.market_low_src_id,
        sales_dna.qty_30 AS dna_qty_30, sales_dna.qty_90 AS dna_qty_90,
        sales_dna.qty_180 AS dna_qty_180, sales_dna.sale_days_30 AS dna_sale_days_30,
        sales_dna.daily_avg_30 AS dna_daily_avg_30, sales_dna.last_sale_at AS dna_last_sale_at,
        sales_dna.days_since_last_sale AS dna_days_since_last_sale,
        sales_dna.oos_days_30 AS dna_oos_days_30, sales_dna.velocity_tier AS dna_velocity_tier,
        recent_stock.recent_stock_change_cnt,`;

export const productGridExtraBaseJoinSql = `
      LEFT JOIN LATERAL (
        WITH normalized AS (
          SELECT
            q.id, q.product_code, q.store_name, q.price, q.monthly_sales,
            q.spec_text, q.captured_at,
            true AS is_valid_quote
          FROM petstore_market_quotes q
          WHERE q.product_code = o.product_code
            AND q.is_comparable = true
            AND q.exclude_reason IS NULL
          UNION ALL
          SELECT
            q.id, q.product_code, q.store_name, q.price, q.monthly_sales,
            q.spec_text, q.captured_at,
            true AS is_valid_quote
          FROM petstore_valid_quotes q
          WHERE q.product_code = o.product_code
            AND q.is_comparable = true
            AND q.exclude_reason IS NULL
            AND COALESCE(q.is_soft_excluded, false) = false
        ),
        picked AS (
          SELECT *
          FROM normalized
          WHERE is_valid_quote
          ORDER BY price ASC NULLS LAST, captured_at DESC NULLS LAST, id DESC NULLS LAST
          LIMIT 1
        )
        SELECT
          min(n.price) FILTER (WHERE n.is_valid_quote) AS market_min_price,
          max(n.price) FILTER (WHERE n.is_valid_quote) AS market_max_price,
          max(p.store_name) AS market_low_store,
          max(p.monthly_sales) AS market_low_sold,
          max(p.spec_text) AS market_low_spec,
          max(p.captured_at) AS market_low_captured_at,
          max(p.id) AS market_low_src_id
        FROM normalized n
        LEFT JOIN picked p ON true
      ) market_fold ON true
      LEFT JOIN LATERAL (
        SELECT
          d.qty_30, d.qty_90, d.qty_180, d.sale_days_30, d.daily_avg_30,
          d.last_sale_at, d.days_since_last_sale, d.oos_days_30, d.velocity_tier
        FROM petstore_sku_sales_dna d
        WHERE d.product_code = o.product_code
        ORDER BY d.as_of DESC NULLS LAST
        LIMIT 1
      ) sales_dna ON true
      LEFT JOIN LATERAL (
        SELECT count(*)::int AS recent_stock_change_cnt
        FROM petstore_stock_ledger l
        WHERE l.product_code = o.product_code
          AND l.change_time >= now() - interval '30 days'
      ) recent_stock ON true`;

export const productGridExtraFinalJoinSql = `
    LEFT JOIN LATERAL (
      WITH prices AS (
        SELECT *
        FROM (VALUES
          ('线下'::text, store_price::numeric),
          ('线上'::text, COALESCE(online_activity_price, online_original_price)::numeric),
          ('美团'::text, NULLIF(gdc_profile->'channel_activities'->'meituan'->>'activityPrice', '')::numeric),
          ('饿了么'::text, NULLIF(gdc_profile->'channel_activities'->'eleme'->>'activityPrice', '')::numeric)
        ) AS p(channel, price)
      ),
      calc AS (
        SELECT
          channel, price,
          CASE WHEN price IS NULL OR price = 0 OR cost_price IS NULL THEN NULL
               ELSE round(((price - cost_price) / price * 100)::numeric, 2)
          END AS margin_pct
        FROM prices
      ),
      picked AS (
        SELECT *
        FROM calc
        WHERE margin_pct IS NOT NULL
        ORDER BY margin_pct ASC, channel
        LIMIT 1
      )
      SELECT
        (SELECT jsonb_agg(jsonb_build_object(
          'channel', channel, 'price', round(price::numeric, 2),
          'margin_pct', margin_pct, 'source', '计算'
        ) ORDER BY margin_pct ASC NULLS LAST, channel) FROM calc) AS channel_margin_list,
        picked.channel AS worst_margin_channel,
        picked.margin_pct AS worst_margin_pct
      FROM picked
    ) gross ON true`;

export const productGridExtraFinalSelectSql = `
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN round(COALESCE(market_min_price, market_price)::numeric, 2) END AS market_min_price,
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN round(COALESCE(market_max_price, market_price)::numeric, 2) END AS market_max_price,
      channel_margin_list, worst_margin_channel, worst_margin_pct,
      dna_qty_30 AS qty_30, dna_qty_90 AS qty_90, dna_qty_180 AS qty_180,
      dna_sale_days_30 AS sale_days_30, dna_daily_avg_30 AS daily_avg_30,
      COALESCE(dna_last_sale_at, last_sale_at) AS sales_last_sale_at,
      dna_days_since_last_sale AS days_since_last_sale,
      dna_oos_days_30 AS oos_days_30, dna_velocity_tier AS velocity_tier,
      COALESCE(recent_stock_change_cnt, 0) AS recent_stock_change_cnt,`;
