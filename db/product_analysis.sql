CREATE OR REPLACE FUNCTION public.pet_category_of(name text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  n text := COALESCE(name, '');
BEGIN
  IF n LIKE '%新宠之康%' AND (n LIKE '%罐%' OR n LIKE '%零食%') THEN
    RETURN '湿粮零食';
  ELSIF n LIKE '%宠医到%' OR n LIKE '%新宠之康%' OR n LIKE '%驱虫%' OR n LIKE '%除虫%'
     OR n LIKE '%海乐妙%' OR n LIKE '%拜达尔%' OR n LIKE '%普安特%' OR n LIKE '%阿莫西林%'
     OR n LIKE '%多西环素%' OR n LIKE '%恩诺沙星%' OR n LIKE '%滴眼液%' OR n LIKE '%消炎%' THEN
    RETURN '兽药';
  ELSIF n LIKE '%猫砂盆%' OR n LIKE '%猫砂铲%' OR n LIKE '%猫砂垫%' THEN
    RETURN '用品';
  ELSIF (n LIKE '砂 %' OR n LIKE '砂%') AND (n LIKE '%kg%' OR n LIKE '%KG%' OR n LIKE '%斤%') THEN
    RETURN '猫砂';
  ELSIF n LIKE '%猫砂%' OR n LIKE '%猫沙%' OR n LIKE '%豆腐砂%' OR n LIKE '%膨润土%'
     OR n LIKE '%木薯%' OR n LIKE '%矿砂%' THEN
    RETURN '猫砂';
  ELSIF n LIKE '%鲜封包%' OR n LIKE '%餐盒%' OR n LIKE '%餐包%' OR n LIKE '%主食罐%' THEN
    RETURN '湿粮零食';
  ELSIF n LIKE '%猫粮%' OR n LIKE '%狗粮%' OR n LIKE '%犬粮%' OR n LIKE '%全价%'
     OR n LIKE '%奶糕%' THEN
    RETURN '主粮';
  ELSIF n LIKE '%猫条%' OR n LIKE '%罐头%' OR n LIKE '%冻干%' OR n LIKE '%零食%'
     OR n LIKE '%慕斯%' OR n LIKE '%肉泥%' OR n LIKE '%鸡胸肉%' OR n LIKE '%火腿肠%'
     OR n LIKE '%罐%' OR n LIKE '%磨牙棒%' OR n LIKE '%羊奶棒%' OR n LIKE '%肉干%'
     OR n LIKE '%饼干%' OR n LIKE '%猫草%' THEN
    RETURN '湿粮零食';
  ELSIF n LIKE '%益生菌%' OR n LIKE '%羊奶粉%' OR n LIKE '%营养%' OR n LIKE '%化毛%'
     OR n LIKE '%葡萄糖%' OR n LIKE '%软骨%' OR n LIKE '%补充剂%' OR n LIKE '%肠胃宝%'
     OR n LIKE '%乳铁%' THEN
    RETURN '营养保健';
  ELSIF n LIKE '%猫砂盆%' OR n LIKE '%尿垫%' OR n LIKE '%玩具%' OR n LIKE '%逗猫%'
     OR n LIKE '%湿巾%' OR n LIKE '%除臭%' OR n LIKE '%喂水%' OR n LIKE '%绝育服%'
     OR n LIKE '%项圈%' OR n LIKE '%航空箱%' OR n LIKE '%头套%' OR n LIKE '%伊丽莎%'
     OR n LIKE '%喂食器%' OR n LIKE '%喂药%' OR n LIKE '%猫包%' OR n LIKE '%牵引%'
     OR n LIKE '%猫窝%' OR n LIKE '%狗窝%' OR n LIKE '%爬架%' OR n LIKE '%梳%'
     OR n LIKE '%指甲剪%' OR n LIKE '%碗%' OR n LIKE '%沐浴露%' OR n LIKE '%浴液%'
     OR n LIKE '%猫抓板%' OR n LIKE '%窝%' OR n LIKE '%笼%' OR n LIKE '%奶瓶%'
     OR n LIKE '%手术服%' THEN
    RETURN '用品';
  END IF;
  RETURN '其他';
END;
$$;

CREATE OR REPLACE VIEW public.v_rival_sku_today AS
WITH ranked AS (
  SELECT
    CASE
      WHEN q.shop_name LIKE '%爪壮壮%' THEN '爪壮壮'
      WHEN q.shop_name LIKE '%邻小虎%' THEN '邻小虎'
      ELSE q.shop_name
    END AS shop,
    q.shop_name AS shop_name_raw,
    q.product_name,
    q.month_sale,
    q.tier_price AS hand_price,
    q.list_price,
    q.list_price - q.tier_price AS price_gap,
    q.tier_type,
    q.tier_qty,
    q.raw_block ->> 'tier' AS tier_text,
    q.raw_block ->> 'coupon' AS coupon,
    public.pet_category_of(q.product_name) AS category,
    q.captured_at,
    q.id,
    row_number() OVER (
      PARTITION BY
        CASE
          WHEN q.shop_name LIKE '%爪壮壮%' THEN '爪壮壮'
          WHEN q.shop_name LIKE '%邻小虎%' THEN '邻小虎'
          ELSE q.shop_name
        END,
        q.product_name
      ORDER BY q.captured_at DESC NULLS LAST, q.id DESC
    ) AS rn
  FROM public.petstore_rival_quotes_app q
)
SELECT
  shop,
  shop_name_raw,
  product_name,
  month_sale,
  hand_price,
  list_price,
  price_gap,
  tier_type,
  tier_qty,
  tier_text,
  coupon,
  category,
  captured_at,
  category = '兽药' AS is_med
FROM ranked
WHERE rn = 1;

CREATE OR REPLACE VIEW public.v_own_category_mix AS
WITH latest AS (
  SELECT max(as_of) AS as_of
  FROM public.petstore_sku_sales_dna
  WHERE store_code = '63350001'
),
own_base AS (
  SELECT
    public.pet_category_of(d.product_name) AS category,
    d.product_name,
    d.product_code,
    COALESCE(d.cur_stock, -1) AS cur_stock,
    COALESCE(d.qty_90, 0) AS qty_90,
    COALESCE(d.qty_180, 0) AS qty_180
  FROM public.petstore_sku_sales_dna d
  JOIN latest l ON l.as_of = d.as_of
  WHERE d.store_code = '63350001'
),
own_cat AS (
  SELECT
    category,
    count(DISTINCT product_name) AS names,
    count(DISTINCT product_code) AS codes,
    count(*) FILTER (WHERE cur_stock > 0) AS in_stock,
    count(*) FILTER (WHERE cur_stock > 0 AND qty_90 > 0) AS moving,
    sum(qty_180)::numeric AS qty_180
  FROM own_base
  GROUP BY category
),
own_mix AS (
  SELECT
    o.*,
    CASE WHEN sum(o.qty_180) OVER () > 0
      THEN round(o.qty_180 * 100.0 / sum(o.qty_180) OVER (), 2)
      ELSE 0
    END AS qty_share
  FROM own_cat o
),
rival AS (
  SELECT
    category,
    max(sales_share) FILTER (WHERE shop = '爪壮壮') AS zzz_sales_share,
    max(sales_share) FILTER (WHERE shop = '邻小虎') AS lxh_sales_share
  FROM public.v_rival_category_strategy
  GROUP BY category
),
nearby_one AS (
  SELECT
    competitor_name,
    title,
    public.pet_category_of(title) AS category,
    max(COALESCE(monthly_sales, 0)) AS monthly_sales
  FROM public.petstore_market_quotes_raw
  WHERE source = 'meituan_h5'
  GROUP BY competitor_name, title, public.pet_category_of(title)
),
nearby_cat AS (
  SELECT
    category,
    sum(monthly_sales)::numeric AS sales_sum
  FROM nearby_one
  GROUP BY category
),
nearby_mix AS (
  SELECT
    category,
    CASE WHEN sum(sales_sum) OVER () > 0
      THEN round(sales_sum * 100.0 / sum(sales_sum) OVER (), 2)
      ELSE 0
    END AS nearby_sales_share
  FROM nearby_cat
)
SELECT
  o.category,
  o.names,
  o.codes,
  o.in_stock,
  o.moving,
  o.qty_180,
  o.qty_share,
  COALESCE(r.zzz_sales_share, 0) AS zzz_sales_share,
  COALESCE(r.lxh_sales_share, 0) AS lxh_sales_share,
  COALESCE(n.nearby_sales_share, 0) AS nearby_sales_share
FROM own_mix o
LEFT JOIN rival r ON r.category = o.category
LEFT JOIN nearby_mix n ON n.category = o.category;

CREATE TABLE IF NOT EXISTS public.petstore_med_classify (
  product_code text PRIMARY KEY,
  product_name text,
  rx_type text CHECK (rx_type IN ('处方药','非处方药','驱虫药','保健品','器械耗材','不确定')),
  reason text,
  confidence numeric CHECK (confidence BETWEEN 0 AND 1),
  forbid_marketing boolean NOT NULL,
  model text NOT NULL,
  evidence jsonb,
  classified_at timestamptz NOT NULL DEFAULT now(),
  reviewed_by text,
  reviewed_at timestamptz
);
