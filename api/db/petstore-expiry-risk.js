// 数据加工中心 · 第5层「效期风险」· 0908
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

function json(res, code, body) { return res.status(code).json(body); }

const BASE = `
  WITH f AS (
    SELECT r.product_code, r.product_name, r.barcode, r.spec_text, r.shelf_code,
           r.product_status, r.store_price, k.category_l1, k.month_sale,
           GREATEST(COALESCE(k.stock_num, 0), COALESCE(r.cur_stock, 0)) AS stk,
           x.produce_date, x.expiration_date, x.capture_date,
           -- $1 = 一次取好的 current_date,12 条查询共用。
           -- ⛔ 不许直接写 current_date:跨午夜时各档会落在不同的"今天",六档相加≠有货合计。
           (x.expiration_date - $1::date)::int AS d
      FROM public.petstore_ops_row r
      LEFT JOIN public.petstore_skus k ON k.product_code = r.product_code
      LEFT JOIN public.petstore_offline_expiry_snapshot x ON x.product_code = r.product_code
  )`;

// 分档:判据写死在这里,⛔不许调用方传阈值(规则只能在代码里,写进文档等于没有 —— 0811 教训)
const BUCKETS = [
  { key: "expired_onsale", label: "已过期 · 还在售", tier: "red",
    where: "stk > 0 AND d < 0 AND product_status = 'UP'",
    why: "顾客现在就能下单买到过期货。先下架(可逆),再让店员核实物日期。" },
  { key: "expired", label: "已过期 · 已下架", tier: "red",
    where: "stk > 0 AND d < 0 AND product_status = 'LOWER'",
    why: "货还在货架上占位占款。等店员核实物:真过期→报损(要 Damon 批),日期错→改日期。" },
  // 实测 product_status 有 22 行是 NULL(9 行有货)。原来写 IS DISTINCT FROM 'UP',
  // PG 里对 NULL 返回 true → 把「状态未知」误标成「已下架」。单独一档,⛔不许糊。
  { key: "expired_unknown", label: "已过期 · 状态未知", tier: "red",
    where: "stk > 0 AND d < 0 AND product_status IS NULL",
    why: "这些商品连上下架状态都没有 —— 先查它到底在不在售,再决定下架还是报损。" },
  { key: "d30", label: "30 天内到期", tier: "red",
    where: "stk > 0 AND d BETWEEN 0 AND 30",
    why: "按打折梯度该到 1 折清货档。食品地板=成本×0.5,用品⛔不许破成本。" },
  { key: "d90", label: "31–90 天到期", tier: "yellow",
    where: "stk > 0 AND d BETWEEN 31 AND 90",
    why: "该转买 5 送 2 清货,或进特价区。控价品(鲜朗)只有临期才可合法打折。" },
  { key: "no_date", label: "有货 · 但没有日期", tier: "yellow",
    where: "stk > 0 AND d IS NULL",
    why: "🔴 不知道会不会坏,所以一个都不许自动打折(07-02 事故病根)。要么店员补录日期,要么当无保质期品管。" },
  { key: "safe", label: "90 天以上", tier: "green",
    where: "stk > 0 AND d > 90", why: "不用动。" },
];

async function build(pool) {
  // 一次定死"今天",后面所有查询共用(见 BASE 里的 $1)
  const today = (await pool.query("SELECT current_date::text AS t")).rows[0].t;
  const groups = [];
  for (const b of BUCKETS) {
    const agg = await pool.query(
      `${BASE} SELECT count(*)::int AS n,
              COALESCE(round(SUM(stk * store_price)::numeric, 0), 0)::text AS amount_by_price
         FROM f WHERE ${b.where}`, [today]);
    const n = agg.rows[0].n;
    let rows = [];
    if (n > 0 && b.key !== "safe") {
      const r = await pool.query(
        `${BASE} SELECT product_code, product_name, barcode, spec_text, shelf_code,
                        product_status, category_l1, month_sale, stk,
                        produce_date, expiration_date, d AS days_to_expire,
                        round((stk * store_price)::numeric, 0)::text AS amount_by_price
           FROM f WHERE ${b.where}
          ORDER BY (d IS NULL), d, stk DESC
          LIMIT ${MAX_ROWS}`, [today]);
      rows = r.rows;
    }
    groups.push({ key: b.key, label: b.label, tier: b.tier, why: b.why,
                  count: n, amount_by_price: agg.rows[0].amount_by_price,
                  shown: rows.length, truncated: n > rows.length && b.key !== "safe", rows });
  }
  const meta = await pool.query(
    `${BASE} SELECT count(*) FILTER (WHERE stk > 0)::int AS in_stock,
            count(*) FILTER (WHERE stk > 0 AND d IS NOT NULL)::int AS dated,
            MAX(capture_date)::text AS captured FROM f`, [today]);
  const m = meta.rows[0];
  const stale = m.captured
    ? Math.floor((Date.now() - new Date(m.captured + "T00:00:00+08:00").getTime()) / 86400000) : null;

  const onsale = groups.find((g) => g.key === "expired_onsale").count;
  const d30 = groups.find((g) => g.key === "d30").count;
  const verdict = onsale > 0
    ? `🔴 ${onsale} 个已过期的还挂在售 —— 顾客现在能买到`
    : (d30 > 0 ? `🟡 ${d30} 个 30 天内到期,该清了` : "✅ 没有已过期在售的");

  return {
    verdict,
    summary: {
      in_stock: m.in_stock, dated: m.dated, undated: m.in_stock - m.dated,
      dated_pct: m.in_stock ? Math.round((m.dated * 1000) / m.in_stock) / 10 : 0,
      captured: m.captured, stale_days: stale,
    },
    groups,
    caveats: [
      "日期来自果冻橙效期模块,不是店员实地读的。每个品只存一条生产日期 —— 进了新货若没更新,显示的仍是老批次,所以「系统说过期」必须让店员核实物再动。",
      m.captured && stale !== null && stale > 2
        ? `日期快照拉取于 ${m.captured},已停 ${stale} 天 —— 这段时间到的货一条都不在里面。`
        : (m.captured ? `日期快照拉取于 ${m.captured}。` : "⚠️ 一条日期快照都没有 —— 效期采集没跑起来。"),
      `有货 ${m.in_stock} 个规格里 ${m.in_stock - m.dated} 个没有日期。⛔ 这些一律不许自动打折(07-02 事故:见货就打,343 个乱打、141 个亏本)。`,
      "占款按【线下售价】估,不是成本 —— 成本不出库。",
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
