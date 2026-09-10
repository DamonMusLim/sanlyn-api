// 数据加工中心 · 第5层「效期风险」· 0910
//
// 🔴 这一层只回答一件事:哪些货再不动就烂在货架上,以及【哪些根本不知道会不会烂】。
//
// 铁律(记忆 project_petshop_operations_blueprint / petshop-pricing-framework):
//  ① 查不到真保质期的,一律不许自动打折 —— 07-02 事故病根就是"见货就打",
//     造成 343 乱打 + 141 亏本(¥27成本猫砂被打到¥8),自动打折 cron 至今停用。
//  ② 已过期 + 有库存 → 先下架再核对。下架可逆,卖出去不可逆。
//  ③ 日期真源优先级:店员实测 > 效期模块 > warn_status。
//     本层用的是【效期模块】(第②档) —— 每个品只存一条生产日期,进新货若没更新,
//     显示的仍是老批次 → 所以"系统说过期"必须让店员核实物,⛔不许直接报损。
//
// 成本红线:不返回 cost_price/gross_margin/进价/毛利。占款一律按【线下售价】估,
// 字段名 amount_by_price,⛔不许改成按成本算。
import { getPool } from "../db.js";
import { setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const MAX_ROWS = 300;
const PERISHABLE = ["猫咪零食", "狗狗零食", "热销猫粮", "热销狗粮", "宠物奶粉", "保健医疗", "驱虫专区", "驱虫/保健", "日常保健"];

function json(res, code, body) { return res.status(code).json(body); }

const BASE = `
  WITH f AS (
    SELECT r.product_code, r.product_name, r.barcode, r.spec_text, r.shelf_code,
           r.product_status, r.store_price, r.category, k.category_l1, k.month_sale,
           GREATEST(COALESCE(k.stock_num, 0), COALESCE(r.cur_stock, 0)) AS stk,
           x.produce_date, x.expiration_date, x.capture_date,
           r.category = ANY($2::text[]) AS is_perishable,
           -- $1 = 一次取好的 current_date,12 条查询共用。
           -- ⛔ 不许直接写 current_date:跨午夜时各档会落在不同的"今天",六档相加≠有货合计。
           (x.expiration_date - $1::date)::int AS d
      FROM public.petstore_ops_row r
      LEFT JOIN public.petstore_skus k ON k.product_code = r.product_code
      LEFT JOIN (
        SELECT DISTINCT ON (product_code) product_code, produce_date, expiration_date, capture_date
        FROM public.petstore_offline_expiry_snapshot
        WHERE expiration_date IS NOT NULL
        ORDER BY product_code, expiration_date ASC
      ) x ON x.product_code = r.product_code
  )`;

// 分档:临期分档归效期风险层,⛔不许在问题商品层再建一份。
const BUCKETS = [
  { key: "tier_5_expired", label: "5 已过期 · 下架报损", tier: "red",
    where: "stk > 0 AND is_perishable AND d < 0",
    why: "已过期品先下架(可逆),再让店员核实物日期；报损要 Damon 批。",
    highlight_onsale: true },
  { key: "tier_4_d30", label: "4 <=30天 · 1折", tier: "red",
    where: "stk > 0 AND is_perishable AND d >= 0 AND d <= 30",
    why: "按定价框架进入 1 折清货档；无真日期不进本档。" },
  { key: "tier_3_d60", label: "3 31-60天 · 3折", tier: "orange",
    where: "stk > 0 AND is_perishable AND d > 30 AND d <= 60",
    why: "按定价框架进入 3 折清货档；无真日期不进本档。" },
  { key: "tier_2_d90", label: "2 61-90天 · 观察", tier: "yellow",
    where: "stk > 0 AND is_perishable AND d > 60 AND d <= 90",
    why: "观察并准备清货动作；无真日期不进本档。" },
  { key: "tier_0_safe", label: "0 >90天 · 不打折", tier: "green",
    where: "stk > 0 AND is_perishable AND d > 90",
    why: "会坏的品但还没到临期打折线。" },
  { key: "no_real_date", label: "无真日期 · 一律不打折", tier: "yellow",
    where: "stk > 0 AND is_perishable AND d IS NULL",
    why: "🔴 会坏的品没有真日期,所以一个都不许自动打折(07-02 事故病根)。要么店员补录日期,要么留空。" },
  { key: "non_perishable", label: "用品 · 不看保质期", tier: "gray",
    where: "stk > 0 AND NOT is_perishable",
    why: "用品不参与临期分档,也不因没有日期进入自动打折。" },
];

async function build(pool) {
  // 一次定死"今天",后面所有查询共用(见 BASE 里的 $1)
  const today = (await pool.query("SELECT current_date::text AS t")).rows[0].t;
  const groups = [];
  for (const b of BUCKETS) {
    const agg = await pool.query(
      `${BASE} SELECT count(*)::int AS n,
              SUM(stk)::int AS stock_qty,
              round(SUM(stk * store_price)::numeric, 0)::text AS amount_by_price,
              count(*) FILTER (WHERE product_status = 'UP')::int AS up_count
         FROM f WHERE ${b.where}`, [today, PERISHABLE]);
    const a = agg.rows[0];
    const n = a.n;
    let rows = [];
    if (n > 0 && b.key !== "tier_0_safe" && b.key !== "non_perishable") {
      const r = await pool.query(
        `${BASE} SELECT product_code, product_name, barcode, spec_text, shelf_code,
                        product_status, category, category_l1, month_sale, stk,
                        produce_date, expiration_date, d AS days_to_expire,
                        round((stk * store_price)::numeric, 0)::text AS amount_by_price
           FROM f WHERE ${b.where}
          ORDER BY (d IS NULL), d, stk DESC
          LIMIT ${MAX_ROWS}`, [today, PERISHABLE]);
      rows = r.rows;
    }
    groups.push({ key: b.key, label: b.label, tier: b.tier, why: b.why,
                  count: n, stock_qty: a.stock_qty, amount_by_price: a.amount_by_price,
                  up_count: a.up_count, up_count_tier: b.highlight_onsale && a.up_count > 0 ? "red" : null,
                  shown: rows.length, truncated: n > rows.length && b.key !== "tier_0_safe" && b.key !== "non_perishable", rows });
  }
  const meta = await pool.query(
    `${BASE} SELECT count(*) FILTER (WHERE stk > 0)::int AS in_stock,
            count(*) FILTER (WHERE stk > 0 AND is_perishable)::int AS perishable,
            count(*) FILTER (WHERE stk > 0 AND is_perishable AND d IS NOT NULL)::int AS dated,
            MAX(capture_date)::text AS captured FROM f`, [today, PERISHABLE]);
  const m = meta.rows[0];
  const stale = m.captured
    ? Math.floor((Date.now() - new Date(m.captured + "T00:00:00+08:00").getTime()) / 86400000) : null;

  const expired = groups.find((g) => g.key === "tier_5_expired");
  const d30 = groups.find((g) => g.key === "tier_4_d30").count;
  const noDate = groups.find((g) => g.key === "no_real_date").count;
  const bucketTotal = groups.reduce((s, g) => s + g.count, 0);
  const selfCheckOk = bucketTotal === m.in_stock;
  const selfCheck = {
    ok: selfCheckOk,
    tier_count_sum: bucketTotal,
    in_stock: m.in_stock,
    verdict: selfCheckOk ? "✅ 七档计数相加 = 有货品数" : `🔴 七档计数相加 ${bucketTotal} != 有货品数 ${m.in_stock}`,
  };
  const verdict = expired.up_count > 0
    ? `🔴 ${expired.up_count} 个已过期的还挂在售 —— 顾客现在能买到`
    : ((d30 > 0 || noDate > 0)
      ? `⚠️ ${d30} 个 30 天内到期 · ${noDate} 个会坏的还没日期`
      : `✅ 没有过期在售的,${d30} 个 30 天内到期`);

  return {
    verdict: selfCheckOk ? verdict : `${selfCheck.verdict}；${verdict}`,
    summary: {
      in_stock: m.in_stock, perishable: m.perishable, dated: m.dated, undated: m.perishable - m.dated,
      dated_pct: m.perishable ? Math.round((m.dated * 1000) / m.perishable) / 10 : null,
      captured: m.captured, stale_days: stale, self_check: selfCheck,
    },
    groups,
    caveats: [
      "日期来自果冻橙效期模块,不是店员实地读的。每个品只存一条生产日期 —— 进了新货若没更新,显示的仍是老批次,所以「系统说过期」必须让店员核实物再动。",
      m.captured && stale !== null && stale > 2
        ? `日期快照拉取于 ${m.captured},已停 ${stale} 天 —— 这段时间到的货一条都不在里面。`
        : (m.captured ? `日期快照拉取于 ${m.captured}。` : "⚠️ 一条日期快照都没有 —— 效期采集没跑起来。"),
      `有货 ${m.in_stock} 个规格里 ${m.perishable - m.dated} 个会坏的品没有日期。⛔ 这些一律不许自动打折(07-02 事故:见货就打,343 个乱打、141 个亏本)。`,
      "占款按【线下售价】估,不是成本 —— 成本不出库。",
      "临期分档只对【会坏的品】生效 —— 判据是 category 正向白名单(猫咪零食/狗狗零食/热销猫粮/热销狗粮/宠物奶粉/保健医疗/驱虫专区/驱虫·保健/日常保健)。⛔别用品名正则猜,那样会把用品也算进来(0829 实测虚高 8 倍)。",
      "🔴 一个 SKU 有多批次时,取【最早到期】那批。⛔ 取最晚的等于把临期货洗白 —— 一批 2026-08 的临期货会被新货 2027-06 盖掉,风险凭空消失。",
      "⛔ 无真日期的一律不参与自动打折。血证:07-02「机器人不看保质期见货就打折」造成 343 个乱打 + 141 个亏本(¥27成本猫砂被打到¥8),自动打折 cron 至今停用。同类事故发生过三次(07-02/07-05/08-12)。",
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
    // ⛔ 不把 err.message 吐给客户端 —— 会泄漏表名/列名/SQL 细节(codex 0908 指出)
    console.error("[petstore-expiry-risk]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
