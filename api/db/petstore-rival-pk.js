// 数据加工中心 · 竞争商品档 · PK
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const PK_LIMIT = 300;
const OP_LIMIT = 60;

function json(res, code, body) { return res.status(code).json(body); }

const CAVEATS = [
  "数据源=美团商家后台导出的竞店商品档(老板提供的 Excel,四家店 12,916 行) + 美团活动邀请表。⛔不是爬虫抓的列表页 —— 所以有条码和实际购买价。",
  "🔴 竞店数据导出于 2026-06-17,活动表采于 2026-08-27,我方是实时的。三个时间不齐,⛔当线索不当今天的行情。",
  "「附近最低实付」已剔除占位/钩子价(≤¥0.5、低于划线价3折)。⛔ 剔除前最低是 ¥0.01,那是多恩把2袋装标成 ¥0.01 的固有打法,不是真实成交价。",
  "「附近月销」按(店,条码)去重后相加 —— 同一条码挂多个店内分类会重复,⛔不去重就直接 sum 会虚高数倍。",
  "「我们有没有」按【条码】判,⛔不是品名匹配(品名匹配准确率只有 10.6%)。",
  "「活动价上限」是平台允许的最高活动价,不是建议价。能报≠值得报 —— 要先过毛利这关,⛔ 本页不返回成本和毛利。",
  "同一个品可能出现多行(平台把「单袋」和「4袋装」拆成两个活动),条码相同、活动名不同。看的时候注意 sub_act_name 里的【N袋】。",
  "只列出附近月销>0 的;附近没销量的不进这张表,不代表它不存在。",
  "💰 那一档按【平台补贴】切,⛔不看附近有没有人卖 —— 平台愿意贴钱推的品,附近没人做反而可能是机会。它和下面三档会重复出现同一个品,那是两个视角不是重复数据。",
  "⛔「能报」不等于「值得报」:活动价上限是平台允许的最高活动价,不是建议价。报之前必须先过毛利这关,而本接口⛔不返回成本和毛利。另外要看清最少下单量/每日库存下限/本店最多报几个SKU —— 报了执行不了等于没报。"
];

const SUBSIDY_BUCKET = {
  key: "subsidized",
  label: "💰 平台给补贴 · 不管附近有没有人卖 —— 这是平台在贴钱推的",
  tier: "green",
  note: "⚠️ 这一档和下面三档会重复出现同一个品 —— 它是按「平台补贴」切的另一个视角",
  test: (r) => (num(r.plat_charge_amount) || 0) > 0
};

const BUCKETS = [
  {
    key: "can_apply",
    label: "✅ 平台在推 · 附近在卖 · 我们有货 —— 可以立刻报活动",
    tier: "green",
    test: (r) => hasMineCode(r) && Number(r.我方库存) > 0
  },
  {
    key: "need_restock",
    label: "⚠️ 平台在推 · 附近在卖 · 我们有品但没货 —— 该补货",
    tier: "yellow",
    test: (r) => hasMineCode(r) && !(Number(r.我方库存) > 0)
  },
  {
    key: "need_buy",
    label: "🔴 平台在推 · 附近在卖 · 我们连品都没有 —— 该进货",
    tier: "red",
    test: (r) => !hasMineCode(r)
  }
];

const PK_BASE = `
  SELECT
    "条码", "品牌", "类目", "竞店品名", "几家在卖", "附近月销",
    "附近最低实付", "附近最高实付", "采于",
    "我方编码", "我方品名", "我方售价", "我方库存", "我方月销",
    "我方货位", "我方状态", "我们有", "价差百分比", "各家明细"
  FROM public.v_petstore_rival_pk
`;

const ACTIVITY_BASE = `
  WITH latest_activity AS (
    SELECT DISTINCT ON (sub_act_id)
      sub_act_id,
      sub_act_name,
      max_act_price,
      can_apply,
      plat_charge_amount,
      min_order_count,
      day_stock_limit_min,
      max_sku_per_poi,
      capture_date,
      captured_at,
      (regexp_match(sku_filter_detail::text, 'UPC:([0-9]{8,14})'))[1] AS "条码"
    FROM public.petstore_mt_activity_subact
    ORDER BY sub_act_id, captured_at DESC
  )
  SELECT
    a.sub_act_id,
    a.sub_act_name,
    a.max_act_price,
    a.can_apply,
    a.plat_charge_amount,
    a.min_order_count,
    a.day_stock_limit_min,
    a.max_sku_per_poi,
    a.capture_date,
    a."条码",
    p."品牌", p."类目", p."竞店品名", p."几家在卖", p."附近月销",
    p."附近最低实付", p."附近最高实付", p."采于",
    p."我方编码", p."我方品名", p."我方售价", p."我方库存", p."我方月销",
    p."我方货位", p."我方状态", p."我们有", p."价差百分比", p."各家明细"
  FROM latest_activity a
  LEFT JOIN public.v_petstore_rival_pk p ON p."条码" = a."条码"
`;

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function bool(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return v;
  if (String(v).toLowerCase() === "true") return true;
  if (String(v).toLowerCase() === "false") return false;
  return null;
}

function hasMineCode(r) {
  return str(r.我方编码) !== null;
}

function dateDaysAgo(s) {
  if (!s) return null;
  return Math.floor((Date.now() - new Date(`${s}T00:00:00+08:00`).getTime()) / 86400000);
}

function sortBySales(a, b) {
  return (num(b.附近月销) || 0) - (num(a.附近月销) || 0)
    || String(a.条码 || "").localeCompare(String(b.条码 || ""), "zh-CN");
}

function sortBySubsidy(a, b) {
  return (num(b.plat_charge_amount) || 0) - (num(a.plat_charge_amount) || 0)
    || (num(b.附近月销) ?? -1) - (num(a.附近月销) ?? -1)
    || String(a.条码 || "").localeCompare(String(b.条码 || ""), "zh-CN");
}

function shops(detail) {
  const xs = Array.isArray(detail) ? detail : [];
  return xs.map((x) => ({
    shop: str(x?.shop),
    price: num(x?.price),
    ms: num(x?.ms)
  }));
}

function packSubsidized(r) {
  return {
    条码: str(r.条码),
    平台在推: str(r.sub_act_name),
    平台补贴: num(r.plat_charge_amount),
    活动价上限: num(r.max_act_price),
    能不能报: bool(r.can_apply),
    最少下单量: num(r.min_order_count),
    每日库存下限: num(r.day_stock_limit_min),
    本店最多报几个SKU: num(r.max_sku_per_poi),
    附近月销: num(r.附近月销),
    几家在卖: num(r.几家在卖),
    附近最低实付: num(r.附近最低实付),
    我方品名: str(r.我方品名),
    我方售价: num(r.我方售价),
    我方库存: num(r.我方库存),
    我方月销: num(r.我方月销),
    我方货位: str(r.我方货位),
    价差百分比: num(r.价差百分比),
    各家在卖: shops(r.各家明细)
  };
}

function packOpportunity(r) {
  return {
    条码: str(r.条码),
    平台在推: str(r.sub_act_name),
    活动价上限: num(r.max_act_price),
    平台补贴: num(r.plat_charge_amount),
    能不能报: bool(r.can_apply),
    附近月销: num(r.附近月销),
    几家在卖: num(r.几家在卖),
    附近最低实付: num(r.附近最低实付),
    附近最高实付: num(r.附近最高实付),
    我方品名: str(r.我方品名),
    我方售价: num(r.我方售价),
    我方库存: num(r.我方库存),
    我方月销: num(r.我方月销),
    我方货位: str(r.我方货位),
    价差百分比: num(r.价差百分比),
    各家在卖: shops(r.各家明细)
  };
}

function packPk(r) {
  return {
    条码: str(r.条码),
    品牌: str(r.品牌),
    类目: str(r.类目),
    竞店品名: str(r.竞店品名),
    几家在卖: num(r.几家在卖),
    附近月销: num(r.附近月销),
    附近最低实付: num(r.附近最低实付),
    附近最高实付: num(r.附近最高实付),
    采于: str(r.采于),
    我方编码: str(r.我方编码),
    我方品名: str(r.我方品名),
    我方售价: num(r.我方售价),
    我方库存: num(r.我方库存),
    我方月销: num(r.我方月销),
    我方货位: str(r.我方货位),
    我方状态: str(r.我方状态),
    我们有: bool(r.我们有),
    价差百分比: num(r.价差百分比),
    各家明细: Array.isArray(r.各家明细) ? r.各家明细 : null
  };
}

function overviewFrom(rows, pkStats) {
  const matched = rows.filter((r) => str(r.条码) && r.竞店品名 !== null);
  const matchedSelling = matched.filter((r) => (num(r.附近月销) || 0) > 0);
  const subsidized = rows.filter(SUBSIDY_BUCKET.test);
  const counts = Object.fromEntries(BUCKETS.map((b) => [b.key, matchedSelling.filter(b.test).length]));
  const actDates = rows.map((r) => str(r.capture_date)).filter(Boolean).sort();
  const selfCheck = counts.can_apply + counts.need_restock + counts.need_buy;
  const subsidyShown = Math.min(subsidized.length, OP_LIMIT);

  return {
    pk_total: pkStats.pk_total,
    我们有: pkStats.我们有,
    我们没有: pkStats.我们没有,
    活动总数: rows.length,
    能对上条码的: matched.length,
    有补贴的活动数: subsidized.length,
    有补贴且我们有货的: subsidized.filter((r) => hasMineCode(r) && Number(r.我方库存) > 0).length,
    有补贴但我们连品都没有的: subsidized.filter((r) => !hasMineCode(r)).length,
    can_apply: counts.can_apply,
    need_restock: counts.need_restock,
    need_buy: counts.need_buy,
    采于_竞店: pkStats.采于_竞店,
    采于_活动: actDates[actDates.length - 1] || null,
    stale_days: dateDaysAgo(pkStats.采于_竞店),
    excluded_no_sales: matched.length - matchedSelling.length,
    self_check: {
      三档计数相加: selfCheck,
      能对上条码且附近月销大于0的活动数: matchedSelling.length,
      ok: selfCheck === matchedSelling.length
    },
    subsidy_check: {
      有补贴的活动数: subsidized.length,
      本档列出数: subsidyShown,
      ok: subsidyShown === Math.min(subsidized.length, OP_LIMIT)
    }
  };
}

async function pkStats(pool) {
  const { rows } = await pool.query(`
    SELECT
      count(*)::int AS pk_total,
      count(*) FILTER (WHERE "我们有" IS TRUE)::int AS "我们有",
      count(*) FILTER (WHERE "我们有" IS NOT TRUE)::int AS "我们没有",
      max("采于")::text AS "采于_竞店"
    FROM public.v_petstore_rival_pk
  `);
  return rows[0];
}

function buildBuckets(rows) {
  const subsidyRows = rows.filter(SUBSIDY_BUCKET.test).sort(sortBySubsidy);
  const selling = rows.filter((r) => str(r.条码) && r.竞店品名 !== null && (num(r.附近月销) || 0) > 0);
  const subsidized = {
    key: SUBSIDY_BUCKET.key,
    label: SUBSIDY_BUCKET.label,
    note: SUBSIDY_BUCKET.note,
    tier: SUBSIDY_BUCKET.tier,
    count: subsidyRows.length,
    shown: Math.min(subsidyRows.length, OP_LIMIT),
    truncated: subsidyRows.length > OP_LIMIT,
    rows: subsidyRows.slice(0, OP_LIMIT).map(packSubsidized)
  };

  return [
    subsidized,
    ...BUCKETS.map((b) => {
      const bucketRows = selling.filter(b.test).sort(sortBySales);
      return {
        key: b.key,
        label: b.label,
        tier: b.tier,
        count: bucketRows.length,
        shown: Math.min(bucketRows.length, OP_LIMIT),
        truncated: bucketRows.length > OP_LIMIT,
        rows: bucketRows.slice(0, OP_LIMIT).map(packOpportunity)
      };
    })
  ];
}

async function buildOpportunities(pool) {
  const [stats, activity] = await Promise.all([
    pkStats(pool),
    pool.query(`${ACTIVITY_BASE} ORDER BY a.plat_charge_amount DESC NULLS LAST, p."附近月销" DESC NULLS LAST, a.sub_act_id`)
  ]);
  const overview = overviewFrom(activity.rows, stats);
  const total = overview.can_apply + overview.need_restock + overview.need_buy;
  return {
    overview,
    verdict: total === 0
      ? "未发现「平台在推且附近在卖」的品 —— 可能是活动表或竞店数据过期了"
      : `平台在推 ${overview.能对上条码的} 个品 · 附近在卖的 ${total} 个 —— 可立刻报 ${overview.can_apply} · 该补货 ${overview.need_restock} · 该进货 ${overview.need_buy}`,
    groups: buildBuckets(activity.rows),
    caveats: CAVEATS
  };
}

async function buildPk(pool, req) {
  const msRaw = typeof req.query.ms === "string" && req.query.ms.trim() ? Number(req.query.ms) : null;
  const ms = Number.isFinite(msRaw) ? msRaw : null;
  const have = req.query.have === "0" || req.query.have === "1" ? req.query.have : null;
  const where = [];
  const args = [];

  if (ms !== null) {
    args.push(ms);
    where.push(`"附近月销" >= $${args.length}`);
  }
  if (have === "1") where.push(`"我们有" IS TRUE`);
  if (have === "0") where.push(`"我们有" IS NOT TRUE`);

  const sqlWhere = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const sql = `${PK_BASE}${sqlWhere} ORDER BY "附近月销" DESC NULLS LAST LIMIT ${PK_LIMIT + 1}`;
  const [stats, result] = await Promise.all([pkStats(pool), pool.query(sql, args)]);
  const rows = result.rows.slice(0, PK_LIMIT);

  return {
    view: "pk",
    ms,
    have,
    total_shown_query_rows: result.rows.length > PK_LIMIT ? null : rows.length,
    shown: rows.length,
    truncated: result.rows.length > PK_LIMIT,
    rows: rows.map(packPk),
    overview: {
      pk_total: stats.pk_total,
      我们有: stats.我们有,
      我们没有: stats.我们没有,
      采于_竞店: stats.采于_竞店,
      stale_days: dateDaysAgo(stats.采于_竞店)
    },
    caveats: CAVEATS
  };
}

async function build(pool, req) {
  if (req.query.view === "pk") return buildPk(pool, req);
  return buildOpportunities(pool);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") { if (!requireAuth(req, res)) return; }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await build(getPool(), req));
  } catch (err) {
    console.error("[petstore-rival-pk]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
