-- petstore_health — 数据体检：一行=一个有问题的商品，标出亏本/快过期/无日期/渠道差价/无售价
CREATE OR REPLACE VIEW petstore_health AS
WITH ext AS (   -- 每商品最新外卖渠道价(美团/饿了么/京东到家里最近一次，排除占位/负价)
  SELECT DISTINCT ON (product_code) product_code, new_price AS ext_price, channel AS ext_channel
  FROM petstore_pricing_log
  WHERE channel IN ('美团','饿了么','京东到家') AND new_price > 0.1
  ORDER BY product_code, ts DESC
),
base AS (
  SELECT s.product_code, s.product_name, s.category, s.cost_price, s.out_price,
         s.stock_num, s.month_sale, s.shelf_list, s.supplier,
         sp.shelf_life_days, sp.expire_date_batch,
         e.ext_price, e.ext_channel,
         CASE WHEN sp.expire_date_batch ~ '^\d{4}-\d{2}-\d{2}$'
              THEN (sp.expire_date_batch::date - CURRENT_DATE) END AS days_to_expire
  FROM petstore_skus s
  LEFT JOIN petstore_sku_supp sp ON sp.product_code = s.product_code
  LEFT JOIN ext e ON e.product_code = s.product_code
),
flagged AS (
  SELECT *,
    (cost_price > 0.1 AND cost_price < 9999 AND out_price > 0.1 AND out_price < cost_price) AS is_loss,
    (out_price IS NULL OR out_price <= 0.1) AS no_price,
    (days_to_expire IS NOT NULL AND days_to_expire <= 60) AS is_expiring,
    (expire_date_batch IS NULL OR expire_date_batch = '') AS no_date,
    (ext_price IS NOT NULL AND out_price > 0.1 AND abs(out_price - ext_price) / out_price > 0.25) AS price_gap,
    ROUND(CASE WHEN cost_price>0.1 AND cost_price<9999 AND out_price>0.1 AND out_price<cost_price
               THEN (cost_price - out_price) * COALESCE(NULLIF(stock_num,0),1) END, 2) AS loss_amount
  FROM base
)
SELECT
  product_code, product_name, category, shelf_list,
  cost_price, out_price, ext_price, ext_channel,
  stock_num, month_sale, expire_date_batch, days_to_expire, loss_amount,
  is_loss, no_price, is_expiring, no_date, price_gap,
  CASE WHEN is_loss THEN '亏本卖'
       WHEN is_expiring AND days_to_expire < 0 THEN '已过期'
       WHEN is_expiring THEN '快过期'
       WHEN no_price THEN '无有效售价'
       WHEN price_gap THEN '渠道差价大'
       WHEN no_date THEN '无生产日期'
       ELSE '' END AS main_problem,
  trim(BOTH ' ,·' FROM concat_ws(' · ',
     CASE WHEN is_loss THEN '亏本卖(进'||cost_price||'>售'||out_price||')' END,
     CASE WHEN is_expiring AND days_to_expire<0 THEN '已过期'||(-days_to_expire)||'天'
          WHEN is_expiring THEN '剩'||days_to_expire||'天到期' END,
     CASE WHEN no_price THEN '门店无有效售价('||COALESCE(out_price::text,'空')||')' END,
     CASE WHEN price_gap THEN '门店'||out_price||' vs 外卖'||ext_price||'('||ext_channel||')' END,
     CASE WHEN no_date THEN '无生产日期' END
  )) AS problems,
  CASE WHEN is_loss OR (is_expiring AND days_to_expire<0) THEN 3
       WHEN is_expiring OR price_gap OR no_price THEN 2
       ELSE 1 END AS severity
FROM flagged
WHERE is_loss OR no_price OR is_expiring OR price_gap OR no_date;
