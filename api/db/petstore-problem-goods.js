// 数据加工中心 · 第6层「问题商品」· 0908
//
// 🔴 回答:哪些商品【本身有毛病】,不是卖得好不好的问题,是数据/现场对不上。
//    这一层的每一条都该变成一张任务(店员去货架上核,或后台补录)。
//
// 判据全部写死在这里。⛔ 不许调用方传阈值 —— 规则只写进文档等于没有(0811 教训)。
//
// 🔴 会不会坏,只认【正向白名单】品类,⛔不许用反向正则排除。
//    0829 血证:我用反向正则(排除玩具/服饰/猫砂…)算出 368 个"该有保质期却没有",
//    虚高 8 倍,真实只有 46 个。反向排除永远漏掉你没想到的品类。
//
// 成本红线:不返回 cost_price/gross_margin/进价/毛利。占款按【线下售价】估。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const MAX_ROWS = 300;

// 正向白名单:确定会坏的品类。拿不准的一律【不进】这个名单(宁可漏报不许虚报)。
const PERISHABLE = ["猫咪零食", "狗狗零食", "热销猫粮", "热销狗粮",
                    "宠物奶粉", "保健医疗", "驱虫专区", "驱虫/保健", "日常保健"];

function json(res, code, body) { return res.status(code).json(body); }

const BASE = `
  WITH f AS (
    SELECT r.product_code, r.product_name, r.barcode, r.spec_text, r.shelf_code,
           r.product_status, r.store_price, r.cur_stock,
           k.stock_num, k.category_l1, k.category_l2, k.month_sale,
           GREATEST(COALESCE(k.stock_num, 0), COALESCE(r.cur_stock, 0)) AS stk,
           x.expiration_date
      FROM public.petstore_ops_row r
      LEFT JOIN public.petstore_skus k ON k.product_code = r.product_code
      LEFT JOIN public.petstore_offline_expiry_snapshot x ON x.product_code = r.product_code
  )`;

const CHECKS = [
  { key: "onsale_no_stock", label: "在售但没货", tier: "red",
    where: "product_status = 'UP' AND stk <= 0",
    why: "顾客在外卖上点进来是空的,下单不了还占着搜索位。要么补货,要么下架。",
    todo: "补货 或 下架" },
  { key: "instock_no_shelf", label: "有货但没货位", tier: "red",
    where: "stk > 0 AND (shelf_code IS NULL OR shelf_code = '')",
    why: "店员不知道货在哪一排,拣货只能靠找。有货位才谈得上盘点和补货。",
    todo: "店员到现场补货位" },
  { key: "perishable_no_date", label: "会坏的品 · 有货但没保质期", tier: "red",
    where: `stk > 0 AND expiration_date IS NULL AND category_l1 = ANY($1::text[])`,
    why: "食品/保健/驱虫类不知道会不会坏。⛔ 这些一个都不许自动打折(07-02 事故),也没法判临期。",
    todo: "店员读实物日期回填", param: true },
  { key: "price_zero", label: "售价≈0 但有货", tier: "red",
    where: "stk > 0 AND COALESCE(store_price, 0) <= 0.05",
    why: "顾客下单等于白送。多半是「想下架却用改价代替」,价改了货还挂着。",
    todo: "定价 或 下架" },
  { key: "negative_stock", label: "负库存", tier: "red",
    where: "COALESCE(stock_num, 0) < 0 OR COALESCE(cur_stock, 0) < 0",
    why: "账实不符:系统认为卖出去的比进货多。⛔ 不许直接抹平,要盘点找出差在哪。",
    todo: "盘点" },
  { key: "stock_mismatch", label: "两个库存源对不上", tier: "yellow",
    where: "stk > 0 AND COALESCE(stock_num, 0) IS DISTINCT FROM COALESCE(cur_stock, 0)",
    why: "果冻橙快照 和 门店在册 数字不一样。⛔ 不许挑一个信,要查哪边没同步。",
    todo: "查同步" },
  { key: "status_unknown", label: "连上下架状态都没有", tier: "yellow",
    where: "product_status IS NULL",
    why: "不知道它到底在不在卖 —— 界面上的「在售/下架」都判不了。",
    todo: "查状态" },
];

// 这三类当前是 0 —— 也要显示出来。⛔ 不显示会让人以为没查(「没问题」和「没查」必须分得开)
const CLEAN_CHECKS = [
  { key: "no_barcode", label: "无条码", where: "barcode IS NULL OR barcode = ''" },
  { key: "no_category", label: "无品类", where: "category_l1 IS NULL OR category_l1 = ''" },
  { key: "name_too_short", label: "品名过短(疑似占位)", where: "length(product_name) < 6" },
];

async function build(pool) {
  const groups = [];
  for (const c of CHECKS) {
    const params = c.param ? [PERISHABLE] : [];
    const agg = await pool.query(
      `${BASE} SELECT count(*)::int AS n,
              COALESCE(round(SUM(GREATEST(stk, 0) * store_price)::numeric, 0), 0)::text AS amount_by_price
         FROM f WHERE ${c.where}`, params);
    const n = agg.rows[0].n;
    let rows = [];
    if (n > 0) {
      const r = await pool.query(
        `${BASE} SELECT product_code, product_name, spec_text, barcode, shelf_code, product_status,
                        category_l1, category_l2, month_sale, stk, stock_num, cur_stock,
                        store_price, expiration_date,
                        round((GREATEST(stk, 0) * store_price)::numeric, 0)::text AS amount_by_price
           FROM f WHERE ${c.where} ORDER BY stk DESC, product_code LIMIT ${MAX_ROWS}`, params);
      rows = r.rows;
    }
    groups.push({ key: c.key, label: c.label, tier: c.tier, why: c.why, todo: c.todo,
                  count: n, amount_by_price: agg.rows[0].amount_by_price,
                  shown: rows.length, truncated: n > rows.length, rows });
  }
  const clean = [];
  for (const c of CLEAN_CHECKS) {
    const r = await pool.query(`${BASE} SELECT count(*)::int AS n FROM f WHERE ${c.where}`);
    clean.push({ key: c.key, label: c.label, count: r.rows[0].n });
  }
  const tot = await pool.query(`${BASE} SELECT count(*)::int AS total,
      count(*) FILTER (WHERE stk > 0)::int AS in_stock FROM f`);

  const red = groups.filter((g) => g.tier === "red" && g.count > 0);
  const verdict = red.length
    ? `🔴 ${red.length} 类问题共 ${red.reduce((a, g) => a + g.count, 0)} 条要处理`
    : "✅ 没有红档问题";

  return {
    verdict, total: tot.rows[0].total, in_stock: tot.rows[0].in_stock,
    groups, clean,
    perishable_whitelist: PERISHABLE,
    caveats: [
      "「会坏的品」只认正向白名单品类:" + PERISHABLE.join("、") +
        "。⛔ 不用反向正则排除 —— 0829 实证反向排除算出 368 个,虚高 8 倍,真实只有 46 个。拿不准的品类一律不进名单,宁可漏报不虚报。",
      "「两个库存源对不上」不是显示错,是真实存在的差:一边是果冻橙每日快照,一边是工作台门店在册。",
      "占款按【线下售价】估,不是成本 —— 成本不出库。",
      "每档最多列 " + MAX_ROWS + " 条;超过的说明该批量处理,不是一条条看。",
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
    console.error("[petstore-problem-goods]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
