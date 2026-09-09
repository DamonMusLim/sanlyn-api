// 数据加工中心 · 竞店商品档 · 0909
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const LIMIT = 300;

function json(res, code, body) { return res.status(code).json(body); }

const CAVEATS = [
  "数据来源=美团商家后台导出的竞店完整商品档(老板提供的 Excel),⛔不是爬虫抓的列表页 —— 所以有条码和实际购买价。",
  "🔴 导出日 2026-06-17,距今约三个月。价格和月销都可能变了,⛔当参考不当今天行情。",
  "「月销」=近30天,以它为准;「已售」是累计且平台分档展示(200/600/700),⛔只做参考不做判断。",
  "「实付」=Excel 的「折扣」列=实际购买价格;「标价」=「价格」列。⛔ 实付列里仍混着活动价 —— ¥0.01 就是证据。",
  "🔴 同一个品挂多条链接做三档价(邻小虎固有打法):①首件神价当钩子 ②常规价赚钱 ③囤货装。⛔ 拿最低那档去比价会得出反的结论,必须看区间。",
  "同一条码会因挂多个店内分类而重复出现(实测多恩一个条码21行),已按条码去重;⛔月销绝不相加。",
  "「重量」列全是 0.1kg,是默认值不是真重量,⛔别用它判多件装。",
  "有些条码是 19 位平台自编码(19120784…),不是国际条码,跟我方对齐时对不上是正常的。",
  "「我们有没有」按【条码】判,⛔不是品名匹配(品名匹配准确率只有 10.6%)。"
];

const BUCKETS = [
  { key: "hot", label: "月销20+", test: (p) => Number(p.month_sale) >= 20 },
  { key: "selling", label: "有月销", test: (p) => Number(p.month_sale) > 0 },
  { key: "linked", label: "多链接", test: (p) => Number(p.links) > 1 },
  { key: "hook", label: "疑钩子", test: (p) => Number(p.price_lo) <= 0.5 }
];

const BASE = `
  SELECT DISTINCT ON (shop_name, barcode, spec_name)
         shop_name,
         export_date::date::text AS export_date,
         barcode,
         product_name,
         spec_name,
         round(list_price::numeric, 2) AS list_price,
         round(real_price::numeric, 2) AS real_price,
         month_sale,
         sold_total,
         stock_num,
         brand,
         category_l3,
         min_buy,
         sell_status,
         shop_cat1,
         shop_cat2,
         sale_time,
         src_file,
         loaded_at,
         EXISTS (
           SELECT 1
             FROM public.petstore_ops_row o
            WHERE o.barcode = petstore_rival_catalog.barcode
         ) AS mine_has
    FROM public.petstore_rival_catalog
   ORDER BY shop_name, barcode, spec_name, month_sale DESC NULLS LAST
`;

function cleanName(s) {
  return String(s || "").replace(/^【[^】]*】\s*/, "").trim() || null;
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function minNum(list) {
  const xs = list.map(num).filter((v) => v !== null);
  return xs.length ? Math.min(...xs) : null;
}

function maxNum(list) {
  const xs = list.map(num).filter((v) => v !== null);
  return xs.length ? Math.max(...xs) : null;
}

function uniqJoin(list) {
  const xs = [...new Set(list.filter((v) => v !== null && v !== undefined && String(v).trim() !== "").map(String))];
  return xs.length ? xs.join(" / ") : null;
}

function dateDaysAgo(s) {
  if (!s) return null;
  return Math.floor((Date.now() - new Date(`${s}T00:00:00+08:00`).getTime()) / 86400000);
}

function productKey(r) {
  return `${r.shop_name}\u0001${cleanName(r.product_name) || ""}\u0001${r.month_sale ?? ""}`;
}

function packProduct(rows) {
  const first = rows[0];
  const priceLo = minNum(rows.map((r) => r.real_price));
  const priceHi = maxNum(rows.map((r) => r.real_price));
  const links = rows.length;
  let flag = null;
  if (links > 1 && priceHi !== null && priceLo !== null && priceHi > priceLo * 1.5) flag = "三档价";
  else if (priceLo !== null && priceLo <= 0.5) flag = "疑钩子价";

  return {
    key: productKey(first),
    shop_name: first.shop_name,
    品名: cleanName(first.product_name),
    月销: num(first.month_sale),
    已售: num(first.sold_total),
    链接数: links,
    实付最低: priceLo,
    实付最高: priceHi,
    标价最低: minNum(rows.map((r) => r.list_price)),
    标价最高: maxNum(rows.map((r) => r.list_price)),
    规格: uniqJoin(rows.map((r) => r.spec_name)),
    条码: uniqJoin(rows.map((r) => r.barcode)),
    店内分类: uniqJoin(rows.map((r) => [r.shop_cat1, r.shop_cat2].filter(Boolean).join(" / "))),
    我方有没有: rows.some((r) => r.mine_has),
    flag
  };
}

function groupProducts(rows) {
  const m = new Map();
  for (const r of rows) {
    const k = productKey(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.values()].map(packProduct);
}

function byShopProducts(rows) {
  const shops = new Map();
  for (const p of groupProducts(rows)) {
    if (!shops.has(p.shop_name)) shops.set(p.shop_name, []);
    shops.get(p.shop_name).push(p);
  }
  return shops;
}

function countBucket(products, key) {
  const b = BUCKETS.find((x) => x.key === key);
  return products.filter(b.test).length;
}

function buildSummary(rows) {
  const shopsProducts = byShopProducts(rows);
  const dates = rows.map((r) => r.export_date).filter(Boolean).sort();
  const shopRows = [];

  for (const [shopName, products] of shopsProducts.entries()) {
    const shopDates = rows.filter((r) => r.shop_name === shopName).map((r) => r.export_date).filter(Boolean).sort();
    const mine = products.filter((p) => p.我方有没有).length;
    shopRows.push({
      key: shopName,
      shop_name: shopName,
      品: products.length,
      月销20plus: countBucket(products, "hot"),
      有月销: countBucket(products, "selling"),
      我们有: mine,
      我们没有: products.length - mine,
      多链接: countBucket(products, "linked"),
      疑钩子: countBucket(products, "hook"),
      export_date: shopDates[shopDates.length - 1] || null
    });
  }

  shopRows.sort((a, b) => b.品 - a.品);
  const totalProducts = shopRows.reduce((a, s) => a + s.品, 0);
  const hot = shopRows.reduce((a, s) => a + s.月销20plus, 0);
  const mine = shopRows.reduce((a, s) => a + s.我们有, 0);
  const maxDate = dates[dates.length - 1] || null;

  return {
    verdict: `${shopRows.length} 家竞店 · ${totalProducts.toLocaleString("zh-CN")} 个品 · 其中 ${hot} 个月销20+ · 我们有 ${mine} 个`,
    shops: shopRows,
    overview: {
      总品数: totalProducts,
      总店数: shopRows.length,
      export_date_min: dates[0] || null,
      export_date_max: maxDate,
      stale_days: dateDaysAgo(maxDate)
    },
    caveats: CAVEATS
  };
}

function buildShop(rows, shop, ms) {
  const threshold = ms === null ? 1 : ms;
  const products = groupProducts(rows.filter((r) => r.shop_name === shop))
    .filter((p) => Number(p.月销) >= threshold)
    .sort((a, b) => (Number(b.月销) || 0) - (Number(a.月销) || 0) || String(a.品名 || "").localeCompare(String(b.品名 || ""), "zh-CN"));

  return {
    shop,
    ms: threshold,
    total: products.length,
    shown: Math.min(products.length, LIMIT),
    truncated: products.length > LIMIT,
    rows: products.slice(0, LIMIT),
    caveats: CAVEATS
  };
}

async function build(pool, req) {
  const shop = typeof req.query.shop === "string" && req.query.shop.trim() ? req.query.shop.trim() : null;
  const msRaw = typeof req.query.ms === "string" && req.query.ms.trim() ? Number(req.query.ms) : null;
  const ms = Number.isFinite(msRaw) ? msRaw : null;
  const { rows } = await pool.query(BASE);
  if (shop) return buildShop(rows, shop, ms);
  return buildSummary(rows);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") { if (!requireAuth(req, res)) return; }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await build(getPool(), req));
  } catch (err) {
    console.error("[petstore-rival-catalog]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
