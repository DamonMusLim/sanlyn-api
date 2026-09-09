// 数据加工中心 · 比价罗盘 · 0908
//
// 它回答的不是「别人卖多少」,是【我在市场上站在哪、今天该动哪几个】。
//
// 🔴 口径全部沿用 petstore-market-row.js(deepseek 按实测数据定的),改口径要一起改:
//   · 每家竞店只取该品【最新一条】—— ⛔不 sum 全部行(原表被重导7遍,0908 已清理 28,408→4,102)
//   · 价格给【区间】不给点 —— 同编码混过不同规格(实测 12.90~539)
//   · 【验证低价】= 月销≥50 的店里的最低价。⛔不用「最高月销那家的价」:
//     monthly_sales 最大值恰好 200,疑似平台「200+」封顶,分不清「卖200」和「卖爆」
//   · 没有店月销≥50 → 明说「谁的价都不算被市场验证过」,⛔不编一个
//
// 🔴 0908 实测修正(deepseek 当时不知道这个数):去重后 80 条报价里【43 条(54%)根本没有月销】,
//    月销≥50 的只有 2 条。所以「验证低价」在这份数据上覆盖不到 —— 门槛50→2品、门槛5→12品。
//    ⛔ 不能拿它当主轴,否则罗盘 63/65 都落进「没有验证价」,等于空的。
//    → 主轴改成【我方售价 vs 附近最低价】(65 个品全都有价),
//      「验证低价」降级为加分标注:有月销时才标「这个价被 N 月销验证过」。
//
// 🔴 覆盖率必须印在脸上:全店 2936 个规格,只有 65 个有对标(2.2%)。
//    ⛔ 不许拿「已对标的那 65 个」的分布去代表全店。
//
// 🔴 淘宝/拼多多【通道未开,零数据】。⛔ 不许留一个空栏假装在采,要明说没开。
//
// 成本红线:不返回任何成本/进价/毛利。差额只按售价算。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const VERIFIED_SALES = 50;
const STALE_WARN_DAYS = 3;

function json(res, code, body) { return res.status(code).json(body); }

const BASE = `
  WITH latest AS (
    SELECT DISTINCT ON (q.product_code, q.competitor_name)
           q.product_code, q.competitor_name, q.price, q.monthly_sales, q.qty_g, q.captured_at,
           q.title, q.match_rule,
           (q.competitor_name ~ '宠物|宠|猫粮|狗粮|猫砂|猫罐|猫条|喵|汪|犬|萌宠|萌鸟|爱宠|羊奶粉') AS is_peer
      FROM public.petstore_market_quotes_raw q
     WHERE q.match_status = 'MATCHED' AND q.price IS NOT NULL
     ORDER BY q.product_code, q.competitor_name, q.captured_at DESC
  ), agg AS (
    SELECT product_code,
           count(*) FILTER (WHERE is_peer)::int AS peer_shops,
           round(min(price)::numeric,2) AS price_min,
           round(min(price) FILTER (WHERE is_peer)::numeric,2) AS lo,          -- 主轴:附近最低价(不看销量,65个品全都有)
           round(min(price) FILTER (WHERE NOT is_peer)::numeric,2) AS super_lo,
           count(*) FILTER (WHERE NOT is_peer)::int AS super_shops,
           count(*) FILTER (WHERE monthly_sales IS NOT NULL)::int AS shops_with_sales,
           round(max(price)::numeric,2) AS price_max,
           sum(COALESCE(monthly_sales,0))::int AS rival_sales,
           max(monthly_sales)::int AS rival_sales_max,
           bool_or(monthly_sales >= 200) AS sales_capped,
           round(min(price) FILTER (WHERE monthly_sales >= ${VERIFIED_SALES})::numeric,2) AS verified_low,
           count(*) FILTER (WHERE monthly_sales >= ${VERIFIED_SALES})::int AS verified_shops,
           max(captured_at)::date::text AS captured,
           -- 🔴 竞店原始标题必须带出去:判「是不是匹配错」只能靠它,
           --    光看价格和百分比人没法判(0908 Damon:「不然看不到更多消息」)
           jsonb_agg(jsonb_build_object(
             'shop', competitor_name, 'peer', is_peer, 'title', title, 'rule', match_rule,
             'price', round(price::numeric,2), 'sales', monthly_sales, 'qty_g', qty_g,
             'unit_100g', CASE WHEN qty_g > 0 THEN round((price/qty_g*100)::numeric,2) END,
             'captured', captured_at::date::text
           ) ORDER BY price) AS shops_detail
      FROM latest GROUP BY product_code
  ), j AS (
    SELECT a.*, r.product_name, r.spec_text, r.shelf_code, r.product_status, r.store_price,
           k.month_sale AS my_sales, k.category_l1,
           GREATEST(COALESCE(k.stock_num,0), COALESCE(r.cur_stock,0)) AS stk,
           CASE WHEN a.lo IS NOT NULL AND r.store_price > 0
                THEN round((r.store_price - a.lo)::numeric, 2) END AS gap,
           CASE WHEN a.lo > 0 AND r.store_price > 0
                THEN round(((r.store_price - a.lo) / a.lo * 100)::numeric, 1) END AS gap_pct
      FROM agg a
      JOIN public.petstore_ops_row r ON r.product_code = a.product_code
      LEFT JOIN public.petstore_skus k ON k.product_code = a.product_code
  )`;

// 分档互斥,相加必须等于总数(自校验)
const BUCKETS = [
  { key: "super_only", label: "⚠️ 附近只有超市在卖,没有同行报价 · 仅供参考不可定价", tier: "gray",
    where: "lo IS NULL AND super_lo IS NOT NULL AND store_price > 0" },
  // 🔴 这一档必须排在最前面 —— 它是【数据可信度闸】,不是定价档。
  //    0908 实测 —— 展开看竞店原始标题后【修正了我最初的判断】:
  //    冠能那行商品其实【匹配对了】,竞店标题是「冠能 鸡肉配方成年期全价猫粮 2.5kg/袋*2」,同品牌同配方。
  //    离谱的是【价】:5 公斤冠能不可能卖 ¥14.80,那是首件神价;
  //    而且 qty_g 被抓成 2500(标题写着 *2,应是 5000),规格也没折算。
  //    所以这一档不叫「匹配错」,叫「价差 3 倍 = 不可比」,上面三种原因都可能。
  //    ⛔ 这些绝不能进定价建议 —— 照它改价会把正常价砍到 1/10。
  //    判据:价差超过 3 倍(任一方向)。真实同款商品在附近门店之间不会差 3 倍。
  { key: "suspect_match", label: "⚠️ 价差超 3 倍 · 不可比,不可用于定价", tier: "gray",
    where: "lo IS NOT NULL AND store_price > 0 AND (store_price > lo * 3 OR store_price * 3 < lo)",
    why: "价差 3 倍以上,三种原因之一:①匹配到别的商品 ②对方那个价是【首件神价】不是常规成交价 ③规格没折算(实测冠能 2.5kg*2 被抓成 qty_g=2500)。👉 点开看竞店原始标题就能分辨是哪一种。⛔ 无论哪种都不能按这个价差改价。" },
  { key: "over20", label: "比附近最低价贵 20% 以上", tier: "red",
    where: "lo IS NOT NULL AND NOT (store_price > lo * 3 OR store_price * 3 < lo) AND store_price > lo * 1.2",
    why: "顾客一比就走。除非是控价品或有真服务溢价,否则这是在把单子送给对面。" },
  { key: "over5", label: "贵 5~20%", tier: "yellow",
    where: "lo IS NOT NULL AND NOT (store_price > lo * 3 OR store_price * 3 < lo) AND store_price > lo * 1.05 AND store_price <= lo * 1.2",
    why: "还在可解释范围,但要知道自己贵在哪。" },
  { key: "aligned", label: "基本持平(±5%)", tier: "green",
    where: "lo IS NOT NULL AND NOT (store_price > lo * 3 OR store_price * 3 < lo) AND store_price BETWEEN lo * 0.95 AND lo * 1.05",
    why: "位置合理,不用动。" },
  { key: "cheap_dead", label: "🔴 比附近都便宜,却卖不动", tier: "red",
    where: `lo IS NOT NULL AND NOT (store_price > lo * 3 OR store_price * 3 < lo) AND store_price < lo * 0.95
            AND COALESCE(rival_sales_max,0) > 0
            AND COALESCE(my_sales,0) * 3 < COALESCE(rival_sales_max,0)`,
    why: "价格不是问题 —— 我们更便宜,对手却卖得更多。去查曝光/货位/图片/评价,⛔别再降价了。" },
  { key: "cheap", label: "比附近都便宜(在抢量 或 白让利)", tier: "yellow",
    where: `lo IS NOT NULL AND NOT (store_price > lo * 3 OR store_price * 3 < lo) AND store_price < lo * 0.95
            AND NOT (COALESCE(rival_sales_max,0) > 0
                     AND COALESCE(my_sales,0) * 3 < COALESCE(rival_sales_max,0))`,
    why: "比附近最低价还低。是有意抢量还是白送毛利,自己确认 —— 对手月销拿不到时无法替你判断。" },
];

async function build(pool) {
  const groups = [];
  for (const b of BUCKETS) {
    const agg = await pool.query(`${BASE}
      SELECT count(*)::int AS n,
             COALESCE(round(SUM(GREATEST(stk,0) * store_price)::numeric,0),0)::text AS amount_by_price
        FROM j WHERE ${b.where}`);
    let rows = [];
    if (agg.rows[0].n > 0) {
      const r = await pool.query(`${BASE}
        SELECT product_code, product_name, spec_text, shelf_code, product_status, category_l1,
               store_price, my_sales, stk, peer_shops, price_min, price_max,
               lo, super_lo, super_shops, verified_low, verified_shops, shops_with_sales,
               rival_sales, rival_sales_max, sales_capped, gap, gap_pct, captured, shops_detail
          FROM j WHERE ${b.where}
         ORDER BY (gap_pct IS NULL), abs(COALESCE(gap_pct,0)) DESC, product_code
         LIMIT 200`);
      rows = r.rows;
    }
    groups.push({ ...b, count: agg.rows[0].n, amount_by_price: agg.rows[0].amount_by_price,
                  shown: rows.length, truncated: agg.rows[0].n > rows.length, rows });
  }

  const cov = await pool.query(`${BASE}
    SELECT (SELECT count(*)::int FROM public.petstore_ops_row) AS all_sku,
           count(*)::int AS matched_sku,
           count(*) FILTER (WHERE stk > 0)::int AS matched_instock,
           max(captured) AS captured,
           count(DISTINCT category_l1)::int AS cats FROM j`);
  const c = cov.rows[0];
  const shops = await pool.query(`
    SELECT competitor_name, count(DISTINCT product_code)::int AS 品,
           max(captured_at)::date::text AS 最新
      FROM public.petstore_market_quotes_raw
     WHERE match_status='MATCHED' GROUP BY 1 ORDER BY 2 DESC`);
  const stale = c.captured
    ? Math.floor((Date.now() - new Date(c.captured + "T00:00:00+08:00").getTime()) / 86400000) : null;

  const tot = groups.reduce((a, g) => a + g.count, 0);
  const red = groups.filter((g) => g.tier === "red").reduce((a, g) => a + g.count, 0);
  const verdict = red > 0
    ? `🔴 ${red} 个品要处理(贵过附近 20% 以上,或 便宜却卖不动)`
    : (tot ? "✅ 已对标的品里没有红档" : "⚠️ 没有任何品有竞品对标");

  return {
    verdict,
    coverage: {
      all_sku: c.all_sku, matched_sku: c.matched_sku, matched_instock: c.matched_instock,
      pct: c.all_sku ? Math.round(c.matched_sku * 1000 / c.all_sku) / 10 : 0,
      captured: c.captured, stale_days: stale,
    },
    shops: shops.rows,
    // ⛔ 空栏不许假装在采
    channels: [
      { name: "附近门店(美团)", status: "有数据", detail: `${shops.rows.length} 家 · 覆盖 ${c.matched_sku} 个品`
        + (stale > STALE_WARN_DAYS ? ` · 已停采 ${stale} 天` : "") },
      { name: "淘宝", status: "通道未开", detail: "一条数据都没有 —— 不是没匹配上,是根本没采过" },
      { name: "拼多多", status: "通道未开", detail: "同上" },
    ],
    groups, total_matched: tot,
    caveats: [
      `覆盖率只有 ${c.matched_sku}/${c.all_sku} 个规格。⛔ 不许拿这 ${c.matched_sku} 个的分布去代表全店 —— 剩下的不是「没问题」,是「没看过」。`,
      "每家竞店只取该品最新一条报价。原表曾被重导 7 遍(28,408→4,102 已于 0908 清理),⛔任何直接 sum 都会虚高。",
      `🔴 去重后 80 条竞店报价里【43 条(54%)根本没采到月销】,月销≥${VERIFIED_SALES} 的只有 2 条。所以主轴用【我方 vs 附近最低价】(65 个品全有价);「验证低价」只在有月销时作为加分标注出现,⛔ 它覆盖不了大盘。`,
      `「验证低价」= 月销≥${VERIFIED_SALES} 的店里的最低价。⛔ 不用「最高月销那家的价」:竞店月销最大值恰好 200,疑似平台「200+」封顶,分不清卖 200 和卖爆。`,
      "「便宜却卖不动」的判据需要对手月销;54% 的报价没有月销,这些品只会落进「在抢量 或 白让利」,⛔ 别把它当成「已确认在抢量」。",
      "价格给区间不给点 —— 同一个编码历史上混进过不同规格(实测 12.90~539)。差额一律按【线下售价】算,成本不出库。",
      "🔴 竞店的 price 抓的是美团页面价,里面混着【第1件神价】。实证:冠能 2.5kg*2(5公斤)标 ¥14.80、网易严选冻干双拼 1.8kg*2 也标 ¥14.80 —— 这个价位不可能是常规成交价。拿我们的常规价比人家的首件神价,本来就不是一回事,⛔ 别据此降价。",
      "🔴 多件装没折算:竞店标题写「2.5kg/袋*2」但 qty_g 只抓到 2500(应是 5000)。所以「每100g」在多件装上会偏高一倍,⛔ 单位价也不能直接信,先看标题里有没有 *2。",
      "即时零售 ≠ 电商:30 分钟送达值溢价,合理是电商价的 1.1~1.3 倍。⛔ 拿淘宝价直接对标必亏(而且现在也没有淘宝数据)。",
    ],
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") { if (!requireAuth(req, res)) return; }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await build(getPool()));
  } catch (err) {
    console.error("[petstore-price-compass]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
