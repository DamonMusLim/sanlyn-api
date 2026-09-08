// 数据加工中心 · 商品行下面那一排「附近怎么卖」· 0908
//
// Damon:「产品下面新增一排:附近价格、总月销、最高月销价格」。
// deepseek 评审后按实测数据把口径改了 —— 他要的三个数有两个当前算出来是错的:
//
//  ✅ 附近价格 → 只给【区间】不给点。同一个编码混进过不同规格(实测最低12.90/最高539),给单点必错。
//  ❌ 总月销   → 原始表被 reingest 重导过 7 遍(已于 0908 清理,28,408→4,102)。
//               即便清理后也按「每家竞店只取该品最新一条」去重,⛔不许直接 sum。
//  ❌ 最高月销价格 → 不能用。monthly_sales 最大值恰好 200,疑似平台「200+」封顶,
//               分不清「卖200的店」和「卖爆的店」。改成【月销≥50 的店里的最低价】
//               = 被市场验证过的最低可成交价。
//
// 🔴 96.7% 的商品没有竞品数据(只有 65 个品匹配上)。这种一律返回 has_data=false,
//    前端显示「未采集」—— ⛔不许隐藏(会让人以为没竞品而瞎定价),
//    ⛔更不许拿同品类中位价顶替(规格跨度 12.90~539,比没有更糟)。
//
// 成本红线:不返回任何成本/进价/毛利。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const MAX_CODES = 400;
const VERIFIED_SALES = 50;   // 月销≥这个数才算「市场验证过」

function json(res, code, body) { return res.status(code).json(body); }

// 每家竞店只取该品【最新一条】—— deepseek 选的口径。
// ⛔ 不选「取月销最大的一条」:会取到 200 封顶值,虚增。
const SQL = `
  WITH latest AS (
    SELECT DISTINCT ON (q.product_code, q.competitor_name)
           q.product_code, q.competitor_name, q.price, q.monthly_sales, q.qty_g, q.captured_at
      FROM public.petstore_market_quotes_raw q
     WHERE q.match_status = 'MATCHED'
       AND q.product_code = ANY($1::text[])
       AND q.price IS NOT NULL
     ORDER BY q.product_code, q.competitor_name, q.captured_at DESC
  )
  SELECT product_code,
         count(*)::int                                   AS shops,
         round(min(price)::numeric, 2)                   AS price_min,
         round(max(price)::numeric, 2)                   AS price_max,
         sum(COALESCE(monthly_sales, 0))::int            AS sales_total,
         max(monthly_sales)::int                         AS sales_max,
         bool_or(monthly_sales >= 200)                   AS sales_capped,
         round(min(price) FILTER (WHERE monthly_sales >= ${VERIFIED_SALES})::numeric, 2)
                                                         AS verified_low,
         count(*) FILTER (WHERE monthly_sales >= ${VERIFIED_SALES})::int AS verified_shops,
         max(captured_at)::date::text                    AS captured,
         jsonb_agg(jsonb_build_object(
           'shop', competitor_name, 'price', round(price::numeric, 2),
           'sales', monthly_sales, 'qty_g', qty_g,
           'unit_100g', CASE WHEN qty_g > 0 THEN round((price / qty_g * 100)::numeric, 2) END
         ) ORDER BY COALESCE(monthly_sales, 0) DESC)     AS shops_detail
    FROM latest GROUP BY product_code`;

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") { if (!requireAuth(req, res)) return; }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

    const raw = String(req.query?.codes || "").trim();
    if (!raw) return json(res, 400, { ok: false, error: "codes_required" });
    const codes = raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, MAX_CODES);
    if (!codes.length) return json(res, 400, { ok: false, error: "codes_required" });

    const r = await getPool().query(SQL, [codes]);
    const byCode = {};
    for (const x of r.rows) {
      byCode[x.product_code] = {
        has_data: true,
        shops: x.shops,
        price_min: x.price_min, price_max: x.price_max,
        sales_total: x.sales_total, sales_max: x.sales_max,
        // 月销被平台封顶时,总月销只能当下限看
        sales_capped: x.sales_capped,
        verified_low: x.verified_low, verified_shops: x.verified_shops,
        captured: x.captured,
        detail: x.shops_detail,
      };
    }
    // ⛔ 没数据的必须显式返回 has_data:false,不许静默省略 —— 前端要能区分「没竞品」和「没查」
    for (const c of codes) if (!byCode[c]) byCode[c] = { has_data: false };

    const covered = r.rows.length;
    return json(res, 200, {
      ok: true, asked: codes.length, covered,
      verified_threshold: VERIFIED_SALES,
      rows: byCode,
      note: "每家竞店只取该品最新一条(⛔不 sum 全部行:原表曾被重导 7 遍,0908 已清理)。"
          + "价格给区间不给点(同编码混过不同规格)。"
          + "「验证低价」= 月销≥" + VERIFIED_SALES + " 的店里的最低价,"
          + "⛔ 不用「最高月销那家的价」(月销 200 疑似平台封顶值)。",
    });
  } catch (err) {
    console.error("[petstore-market-row]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
