// 数据加工中心 · 竞品今日行情 · 0915
// 源: public 已建只读视图。分类、机制、同款匹配口径均由视图提供,JS 不重算。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const SHOPS = ["爪壮壮", "邻小虎"];

const CAVEATS = [
  "数据来源=public.v_rival_sku_today / v_rival_category_strategy / v_rival_mechanism_pattern / v_rival_sku_vs_own。",
  "category、is_med、机制识别、同款匹配均来自只读视图,本页不在 JS 里重算分类。",
  "captured_at 是采集时刻;captured_from/captured_to 为本页返回数据覆盖时段。",
  "到手价按视图 hand_price 口径展示;起送价/打包费等不在本页二次计算。",
  "月销是平台显示值,带+号的按下限计,实际只会更高。",
  "兽药类单独标 is_med=true,只记录不建议。",
  "同款汇总 match_suspect=true 的行疑似匹配错,勿用于决策。"
];

const STRATEGY_SQL = `
SELECT shop, category, sku_count, sku_share, sales_sum, sales_share,
       sales_per_sku, median_hand_price
  FROM public.v_rival_category_strategy
 WHERE shop IN ('爪壮壮','邻小虎')
 ORDER BY shop, sales_sum DESC NULLS LAST`;

const MECHANISM_SQL = `
SELECT shop, mechanism_type,
       sum(sku_count) AS sku_count,
       sum(sales_sum) AS sales_sum
  FROM public.v_rival_mechanism_pattern
 WHERE shop IN ('爪壮壮','邻小虎')
 GROUP BY 1,2
 ORDER BY shop, sales_sum DESC NULLS LAST`;

const TOP_SQL = `
SELECT shop, shop_name_raw, product_name, month_sale, hand_price, list_price,
       price_gap, tier_type, tier_qty, tier_text, coupon, category, captured_at, is_med
  FROM public.v_rival_sku_today
 WHERE month_sale >= 20
 ORDER BY month_sale DESC NULLS LAST
 LIMIT 120`;

const HOT_SAME_SQL = `
WITH quote_price AS (
  SELECT product_code,
         min(price) FILTER (WHERE price > 1) AS normal_price_min,
         (array_agg(competitor_name ORDER BY price ASC NULLS LAST) FILTER (WHERE price > 1))[1] AS normal_price_min_shop,
         bool_or(price <= 1) AS has_hook_price
    FROM public.petstore_market_quotes_raw
   WHERE source = 'meituan_h5'
     AND match_status = 'MATCHED'
   GROUP BY product_code
)
SELECT v.product_code,
       v.our_name AS product_name,
       v.rival_shop_count,
       v.rival_sales_total,
       v.rival_sales_max,
       v.rival_sales_max_shop,
       v.rival_price_min,
       v.rival_price_min_shop,
       v.rival_price_median,
       v.rival_captured_from,
       v.rival_captured_to,
       v.match_suspect,
       q.normal_price_min,
       q.normal_price_min_shop,
       q.has_hook_price
  FROM public.v_rival_sku_vs_own v
  LEFT JOIN quote_price q ON q.product_code = v.product_code
 WHERE v.rival_shop_count > 0
 ORDER BY v.rival_sales_total DESC NULLS LAST`;

function json(res, code, body) {
  return res.status(code).json(body);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function minTime(values) {
  const xs = values.filter(Boolean).sort();
  return xs[0] || null;
}

function maxTime(values) {
  const xs = values.filter(Boolean).sort();
  return xs[xs.length - 1] || null;
}

function build(strategyRows, mechanismRows, topRows, hotRows) {
  const shops = SHOPS.map((shop) => {
    const cats = strategyRows
      .filter((r) => r.shop === shop)
      .map((r) => ({
        shop: r.shop,
        category: r.category,
        sku_count: num(r.sku_count),
        sku_share: num(r.sku_share),
        sales_sum: num(r.sales_sum),
        sales_share: num(r.sales_share),
        sales_per_sku: num(r.sales_per_sku),
        median_hand_price: num(r.median_hand_price)
      }));
    const skuTotal = cats.reduce((a, r) => a + (num(r.sku_count) ?? 0), 0);
    const saleTotal = cats.reduce((a, r) => a + (num(r.sales_sum) ?? 0), 0);
    return { shop, items: skuTotal, month_sale: saleTotal, cats };
  }).filter((s) => s.cats.length);

  const totalSku = strategyRows.reduce((a, r) => a + (num(r.sku_count) ?? 0), 0);
  const verdict = strategyRows.length
    ? `两家共 ${totalSku} 个不重复商品;${SHOPS.map((shop) => {
        const cat = strategyRows.find((r) => r.shop === shop && r.category === "猫砂");
        return `${shop} 猫砂占月销 ${cat && cat.sales_share !== null && cat.sales_share !== undefined ? Number(cat.sales_share).toFixed(1) : "-"}%`;
      }).join(" · ")}`
    : "没有数据";

  const times = [];
  for (const r of topRows) times.push(r.captured_at);
  for (const r of hotRows) {
    times.push(r.rival_captured_from);
    times.push(r.rival_captured_to);
  }

  return {
    verdict,
    captured_from: minTime(times),
    captured_to: maxTime(times),
    shops,
    mechanism: mechanismRows.map((r) => ({
      shop: r.shop,
      mechanism_type: r.mechanism_type,
      sku_count: num(r.sku_count),
      sales_sum: num(r.sales_sum)
    })),
    top: topRows.map((r) => ({
      shop: r.shop,
      shop_name_raw: r.shop_name_raw,
      product_name: r.product_name,
      month_sale: num(r.month_sale),
      hand_price: num(r.hand_price),
      list_price: num(r.list_price),
      price_gap: num(r.price_gap),
      tier_type: r.tier_type,
      tier_qty: num(r.tier_qty),
      tier_text: r.tier_text,
      coupon: r.coupon,
      category: r.category,
      captured_at: r.captured_at,
      is_med: r.is_med
    })),
    hot_same: hotRows.map((r) => ({
      product_code: r.product_code,
      product_name: r.product_name,
      rival_shop_count: num(r.rival_shop_count),
      rival_sales_total: num(r.rival_sales_total),
      rival_sales_max: num(r.rival_sales_max),
      rival_sales_max_shop: r.rival_sales_max_shop,
      rival_price_min: num(r.rival_price_min),
      rival_price_min_shop: r.rival_price_min_shop,
      rival_price_median: num(r.rival_price_median),
      rival_captured_from: r.rival_captured_from,
      rival_captured_to: r.rival_captured_to,
      match_suspect: r.match_suspect,
      normal_price_min: num(r.normal_price_min),
      normal_price_min_shop: r.normal_price_min_shop,
      has_hook_price: r.has_hook_price
    })),
    caveats: CAVEATS
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") {
      if (!requireAuth(req, res)) return;
    }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const pool = getPool();
    const [strategy, mechanism, top, hotSame] = await Promise.all([
      pool.query(STRATEGY_SQL),
      pool.query(MECHANISM_SQL),
      pool.query(TOP_SQL),
      pool.query(HOT_SAME_SQL)
    ]);

    return json(res, 200, build(strategy.rows, mechanism.rows, top.rows, hotSame.rows));
  } catch (err) {
    console.error("[petstore-rival-live]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
