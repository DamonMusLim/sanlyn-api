-- petstore_pricing_daily — 每商品每天压缩成一条 + 清洗打折原因 + 各渠道结果汇总
CREATE OR REPLACE VIEW petstore_pricing_daily AS
WITH latest_per_channel AS (
  SELECT DISTINCT ON (product_code, log_date, channel)
    product_code, log_date, channel, ts, product_name, store_name,
    old_price, new_price, rate, reason, result, days_left
  FROM petstore_pricing_log
  ORDER BY product_code, log_date, channel, ts DESC
),
cat AS (
  SELECT *,
    CASE
      WHEN reason ILIKE '%涨价%'                             THEN '涨价止血'
      WHEN reason ILIKE '%清仓%' OR reason ILIKE '%滞销%'    THEN '清仓滞销'
      WHEN reason ILIKE '%外卖对齐%'                         THEN '外卖对齐'
      WHEN reason ILIKE '%活动%'                             THEN '外卖上活动'
      WHEN reason ILIKE '%事故%' OR reason ILIKE '%恢复%'    THEN '事故恢复'
      WHEN reason ILIKE '%无成本价%'                         THEN '缺成本价·跳过'
      WHEN reason ILIKE '%不低于%'                           THEN '价已到位·跳过'
      WHEN reason ILIKE 'dry-run%' OR reason ILIKE '%预览%'  THEN '预览·未执行'
      WHEN reason ILIKE '%store_tasks%' OR reason ILIKE '%门店任务%' THEN '门店任务'
      ELSE COALESCE(NULLIF(split_part(reason, ':', 1), ''), '—')
    END AS reason_cat,
    -- 优先级：真正的定价意图排前，跳过/状态排后
    CASE
      WHEN reason ILIKE '%涨价%' THEN 1
      WHEN reason ILIKE '%清仓%' OR reason ILIKE '%滞销%' THEN 2
      WHEN reason ILIKE '%外卖对齐%' THEN 3
      WHEN reason ILIKE '%活动%' THEN 4
      WHEN reason ILIKE '%事故%' OR reason ILIKE '%恢复%' THEN 5
      WHEN reason ILIKE 'dry-run%' OR reason ILIKE '%预览%' THEN 8
      ELSE 6
    END AS reason_prio
  FROM latest_per_channel
)
SELECT
  product_code,
  log_date,
  MAX(ts)                                   AS ts,
  MAX(product_name)                         AS product_name,
  MAX(store_name)                           AS store_name,
  MAX(old_price)                            AS old_price,
  MIN(new_price)                            AS new_price,
  MIN(rate)                                 AS rate,
  (array_agg(reason_cat ORDER BY reason_prio, ts DESC))[1] AS reason,
  (array_agg(days_left ORDER BY days_left NULLS LAST))[1]  AS days_left,
  jsonb_object_agg(channel, result)         AS channel_results,
  count(*) FILTER (WHERE result LIKE '生效%')  AS ok_cnt,
  count(*) FILTER (WHERE result LIKE '失败%')  AS fail_cnt,
  count(*) FILTER (WHERE result LIKE '跳过%')  AS skip_cnt,
  count(*)                                   AS chan_cnt
FROM cat
GROUP BY product_code, log_date;
