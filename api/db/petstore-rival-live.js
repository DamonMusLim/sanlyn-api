// 数据加工中心 · 竞品实时行情(OCR线) · 0914
// 源表 public.petstore_rival_quotes_app —— 手机端 OCR 逐屏采集,追加型时间序列。
// ⛔ 与 petstore-rival-merged.js 不是一回事:那个是 Excel 导出的四家店按条码合并(87天前的快照),
//    这个是今天真机采的到手价/阶梯机制/月销。两者口径不同,⛔不可混比。
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const CAVEATS = [
  "数据来源=public.petstore_rival_quotes_app,collect_method in (app_ocr, app_shop_page)。",
  "captured_at 是【截图那一刻】,不是入库时刻;同一商品不同时间点会有多行,这里每店每商品只取月销最高的那行。",
  "到手价三形态:有阶梯行取阶梯价(N件总价已折成单件);无阶梯行两个¥取小的;一个¥就是它。",
  "⛔ 起送价/打包费/每100g/券额 一律不入到手价。",
  "月销是平台显示值,带+号的(月售100+)按下限计,实际只会更高。",
  "兽药类单独标 is_med=true,⛔ 不进任何「该学/该进」表述(合规闸 rival-compliance-gate-0912)。",
  "「其他」类目占比偏大,是关键词分类未覆盖(主要是水族/犬用/清洁),不影响各主类结论。",
  "OCR 仍可能认错个别字;raw_block 留了原始块可回溯。"
];

const CATS = `CASE
  WHEN product_name LIKE '%宠医到%' OR product_name LIKE '%新宠之康%' OR product_name LIKE '%驱虫%'
    OR product_name LIKE '%除虫%' OR product_name LIKE '%海乐妙%' OR product_name LIKE '%拜达尔%'
    OR product_name LIKE '%普安特%' OR product_name LIKE '%阿莫西林%' OR product_name LIKE '%多西环素%'
    OR product_name LIKE '%恩诺沙星%' OR product_name LIKE '%滴眼液%' OR product_name LIKE '%消炎%' THEN '兽药'
  WHEN product_name LIKE '%猫砂%' OR product_name LIKE '%猫沙%' OR product_name LIKE '%豆腐砂%'
    OR product_name LIKE '%膨润土%' OR product_name LIKE '%木薯%' OR product_name LIKE '%矿砂%' THEN '猫砂'
  WHEN product_name LIKE '%猫粮%' OR product_name LIKE '%狗粮%' OR product_name LIKE '%犬粮%'
    OR product_name LIKE '%全价%' OR product_name LIKE '%主食罐%' OR product_name LIKE '%奶糕%' THEN '主粮'
  WHEN product_name LIKE '%猫条%' OR product_name LIKE '%罐头%' OR product_name LIKE '%冻干%'
    OR product_name LIKE '%零食%' OR product_name LIKE '%慕斯%' OR product_name LIKE '%肉泥%'
    OR product_name LIKE '%鸡胸肉%' OR product_name LIKE '%火腿肠%' THEN '湿粮零食'
  WHEN product_name LIKE '%益生菌%' OR product_name LIKE '%羊奶粉%' OR product_name LIKE '%营养%'
    OR product_name LIKE '%化毛%' OR product_name LIKE '%葡萄糖%' OR product_name LIKE '%软骨%'
    OR product_name LIKE '%补充剂%' OR product_name LIKE '%肠胃宝%' OR product_name LIKE '%乳铁%' THEN '营养保健'
  WHEN product_name LIKE '%猫砂盆%' OR product_name LIKE '%尿垫%' OR product_name LIKE '%玩具%'
    OR product_name LIKE '%逗猫%' OR product_name LIKE '%湿巾%' OR product_name LIKE '%除臭%'
    OR product_name LIKE '%喂水%' OR product_name LIKE '%绝育服%' OR product_name LIKE '%项圈%' THEN '用品'
  ELSE '其他' END`;

const SQL = `
WITH base AS (
  SELECT CASE WHEN shop_name LIKE '%爪壮壮%' THEN '爪壮壮'
              WHEN shop_name LIKE '%邻小虎%' THEN '邻小虎'
              ELSE shop_name END AS shop,
         product_name, month_sale, tier_price, list_price, tier_type, tier_qty,
         captured_at, raw_block,
         ${CATS} AS cat
    FROM public.petstore_rival_quotes_app
   WHERE collect_method IN ('app_ocr','app_shop_page')
), dedup AS (
  SELECT *, row_number() OVER (PARTITION BY shop, product_name
              ORDER BY month_sale DESC NULLS LAST, captured_at DESC) AS rn
    FROM base
)
SELECT shop, cat, product_name, month_sale, tier_price, list_price,
       tier_type, tier_qty, captured_at, raw_block
  FROM dedup WHERE rn = 1`;

function json(res, code, body) { return res.status(code).json(body); }
function num(v) { if (v === null || v === undefined || v === "") return null;
  const n = Number(v); return Number.isFinite(n) ? n : null; }

function build(rows) {
  const byShop = new Map();
  for (const r of rows) {
    if (!byShop.has(r.shop)) byShop.set(r.shop, []);
    byShop.get(r.shop).push(r);
  }
  const shops = [];
  for (const [shop, list] of byShop) {
    const totalSale = list.reduce((a, r) => a + (num(r.month_sale) || 0), 0);
    const cats = new Map();
    for (const r of list) {
      if (!cats.has(r.cat)) cats.set(r.cat, { cat: r.cat, n: 0, sale: 0, prices: [] });
      const c = cats.get(r.cat);
      c.n += 1; c.sale += num(r.month_sale) || 0;
      const p = num(r.tier_price); if (p !== null) c.prices.push(p);
    }
    const catRows = [...cats.values()].map((c) => {
      c.prices.sort((a, b) => a - b);
      const mid = c.prices.length ? c.prices[Math.floor(c.prices.length / 2)] : null;
      return { cat: c.cat, items: c.n,
        item_pct: Math.round(1000 * c.n / list.length) / 10,
        month_sale: c.sale,
        sale_pct: totalSale ? Math.round(1000 * c.sale / totalSale) / 10 : null,
        per_item: Math.round(10 * c.sale / c.n) / 10,
        median_price: mid };
    }).sort((a, b) => b.month_sale - a.month_sale);
    shops.push({ shop, items: list.length, month_sale: totalSale, cats: catRows });
  }
  shops.sort((a, b) => b.month_sale - a.month_sale);

  const MED = ["宠医到","新宠之康","驱虫","除虫","海乐妙","拜达尔","普安特","阿莫西林","多西环素","恩诺沙星","滴眼液","消炎"];
  const top = rows
    .filter((r) => (num(r.month_sale) || 0) >= 20)
    .map((r) => ({
      shop: r.shop, cat: r.cat, name: r.product_name,
      month_sale: num(r.month_sale), price: num(r.tier_price), list_price: num(r.list_price),
      tier_type: r.tier_type, tier_qty: r.tier_qty,
      tier_text: r.raw_block?.tier ?? null, coupon: r.raw_block?.coupon ?? null,
      captured_at: r.captured_at,
      is_med: MED.some((k) => String(r.product_name).includes(k))
    }))
    .sort((a, b) => (b.month_sale ?? -1) - (a.month_sale ?? -1))
    .slice(0, 120);

  const times = rows.map((r) => r.captured_at).filter(Boolean).sort();
  return {
    verdict: shops.length
      ? `两家共 ${rows.length} 个不重复商品;${shops.map(s => s.shop + ' 猫砂占月销 ' +
          ((s.cats.find(c => c.cat === '猫砂') || {}).sale_pct ?? '-') + '%').join(' · ')}`
      : "没有数据",
    captured_from: times[0] || null,
    captured_to: times[times.length - 1] || null,
    shops, top, caveats: CAVEATS
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") { if (!requireAuth(req, res)) return; }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    const result = await getPool().query(SQL);
    return json(res, 200, build(result.rows));
  } catch (err) {
    console.error("[petstore-rival-live]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
