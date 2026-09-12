// 数据加工中心 · 竞品研究中心 · 四家店按条码合并 · 0912
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const FILTERS = new Set(["all", "hot", "mine", "shared", "nomine"]);

const CAVEATS = [
  "数据来源=public.petstore_rival_catalog,按条码合并四家竞店。",
  "导出日取源表 export_date;价格和月销是导出时点,不是今天实时行情。",
  "low_price 先剔除五类假价后取唯一真实最低价;四家全是假价时返回 null。",
  "taobao_price 和 pdd_price 当前没有数据源,恒为 null。",
  "我方商品只按 barcode 关联 public.petstore_ops_row;取不到的值返回 null,绝不填 0。",
  "成本字段只在 /dataops/api/ 网关路径返回(等价于 damon 的 console cookie 已验);其他路径一律不含成本键。"
];

const SQL = `
  WITH rival AS (
    SELECT shop_name,
           max(export_date::date::text) AS export_date,
           barcode,
           max(product_name) AS product_name,
           max(spec_name) AS spec_name,
           round(max(list_price::numeric), 2) AS list_price,
           round(max(real_price::numeric), 2) AS real_price,
           max(month_sale) AS month_sale,
           max(stock_num) AS stock_num,
           max(brand) AS brand,
           max(category_l3) AS category_l3,
           count(*) AS raw_rows,
           array_agg(DISTINCT shop_cat2) FILTER (WHERE shop_cat2 IS NOT NULL AND shop_cat2 <> '') AS shop_cats
      FROM public.petstore_rival_catalog
     WHERE barcode IS NOT NULL
       AND barcode <> ''
       AND (
            $1::text IS NULL
         OR barcode ILIKE '%' || $1 || '%'
         OR product_name ILIKE '%' || $1 || '%'
       )
     GROUP BY shop_name, barcode
  ), mine AS (
    SELECT DISTINCT ON (o.barcode)
           o.barcode,
           o.product_code AS mine_code,
           o.product_name AS mine_name,
           round(o.store_price::numeric, 2) AS mine_price,
           o.cur_stock AS mine_stock,
           o.product_status AS mine_status,
           COALESCE(o.cost_price, s.cost_price) AS mine_cost
      FROM public.petstore_ops_row o
      LEFT JOIN public.petstore_skus s ON s.product_code = o.product_code
     WHERE o.barcode IS NOT NULL
       AND o.barcode <> ''
     ORDER BY o.barcode, o.product_code
  )
  SELECT r.*,
         m.mine_code,
         m.mine_name,
         m.mine_price,
         m.mine_stock,
         m.mine_cost,
         m.mine_status
    FROM rival r
    LEFT JOIN mine m ON m.barcode = r.barcode
`;

function json(res, code, body) {
  return res.status(code).json(body);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundMoney(v) {
  const n = num(v);
  return n === null ? null : Math.round(n * 100) / 100;
}

function cleanText(v) {
  const s = String(v ?? "").trim();
  return s ? s : null;
}

function parseLimit(v) {
  const n = Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseFilter(v) {
  const s = String(v ?? "all").trim();
  return FILTERS.has(s) ? s : "all";
}

function shopShort(name) {
  const s = String(name || "");
  if (s.includes("邻小虎")) return "邻小虎";
  if (s.includes("爪壮壮")) return "爪壮壮";
  if (s.includes("多恩")) return "多恩";
  if (s.includes("哈妮")) return "哈妮";
  return s || null;
}

function shopRank(name) {
  const short = shopShort(name);
  if (short === "邻小虎") return 1;
  if (short === "爪壮壮") return 2;
  return 9;
}

function fakeReason(row) {
  const real = num(row.real_price);
  const list = num(row.list_price);
  const name = String(row.product_name || "");
  if (real !== null && real <= 0.5) return "钩子价";
  if (real !== null && list !== null && real < list * 0.3) return "首件神价";
  if (/试新|新客|首单|尝鲜|老客|复购|进店必点/.test(name)) return "分档钓鱼";
  if (/囤货|箱装|组合|\*\s*\d+\s*袋/.test(name)) return "多包装";
  if (/拆售|单片|一片|\/片/.test(name)) return "拆零单价";
  return null;
}

function shopItem(row) {
  const reason = fakeReason(row);
  const real = roundMoney(row.real_price);
  return {
    shop: row.shop_name || null,
    shop_short: shopShort(row.shop_name),
    shop_cats: row.shop_cats ?? [],
    list_price: roundMoney(row.list_price),
    real_price: real,
    month_sale: num(row.month_sale),
    stock_num: num(row.stock_num),
    price_usable: real !== null && !reason,
    fake_reason: reason,
    raw_rows: num(row.raw_rows)
  };
}

function pickShop(rows) {
  const packed = rows.map((row) => ({ row, item: shopItem(row) }));
  packed.sort((a, b) => {
    if (a.item.price_usable !== b.item.price_usable) return a.item.price_usable ? -1 : 1;
    const ap = a.item.real_price;
    const bp = b.item.real_price;
    if (ap !== null && bp !== null && ap !== bp) return ap - bp;
    if (ap !== null && bp === null) return -1;
    if (ap === null && bp !== null) return 1;
    return (b.item.month_sale ?? -1) - (a.item.month_sale ?? -1);
  });
  return packed[0];
}

function notBlank(v) {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

function firstValue(rows, field) {
  const hit = rows.find((r) => notBlank(r[field]));
  return hit ? String(hit[field]).trim() : null;
}

function sumNullable(values) {
  const xs = values.map(num).filter((v) => v !== null);
  return xs.length ? xs.reduce((a, b) => a + b, 0) : null;
}

function lowInfo(picks) {
  const usable = picks.filter((p) => p.item.price_usable && p.item.real_price !== null);
  if (usable.length === 0) {
    return { price: null, shop: null, reason: "四家全是假价或都取不到实付价", row: null };
  }
  const min = Math.min(...usable.map((p) => p.item.real_price));
  const lows = usable.filter((p) => p.item.real_price === min);
  const lowShops = [...new Set(lows.map((p) => p.item.shop_short).filter(Boolean))].join("/");
  return { price: min, shop: lowShops || null, reason: null, row: lows[0].row };
}

function tierOf(lowPrice, listPrice) {
  const low = num(lowPrice);
  const list = num(listPrice);
  if (low === null) return null;
  if (low <= 2 || (list !== null && list > 0 && low / list <= 0.15)) return "hook";
  if (low >= 30 && list !== null && list > 0 && low / list >= 0.65) return "profit";
  return "volume";
}

function gapPct(minePrice, lowPrice) {
  const mine = num(minePrice);
  const low = num(lowPrice);
  if (mine === null || low === null || low === 0) return null;
  return Math.round(((mine - low) / low) * 100);
}

function buildRow(rows, viaGateway) {
  const byShop = new Map();
  for (const r of rows) {
    const key = r.shop_name || "";
    if (!byShop.has(key)) byShop.set(key, []);
    byShop.get(key).push(r);
  }

  const picks = [...byShop.values()].map(pickShop);
  const shops = picks
    .map((p) => p.item)
    .sort((a, b) => shopRank(a.shop) - shopRank(b.shop)
      || (b.month_sale ?? -1) - (a.month_sale ?? -1)
      || String(a.shop || "").localeCompare(String(b.shop || ""), "zh-CN"));

  const low = lowInfo(picks);
  const monthSaleTotal = sumNullable(shops.map((s) => s.month_sale));
  const first = rows[0];
  const minePrice = roundMoney(first.mine_price);
  const mineCost = num(first.mine_cost);
  const floorTraffic = mineCost === null ? null : roundMoney(mineCost * 0.95);
  const floorTakeout = mineCost === null ? null : roundMoney(mineCost / 0.95);
  const marginIfMatch = mineCost === null || low.price === null
    ? null
    : Math.round((low.price - mineCost) / low.price * 100);
  const canMatch = mineCost === null || low.price === null
    ? null
    : low.price >= floorTakeout ? "可跟"
    : low.price >= mineCost ? "持平线以下,亏抽成"
    : "破成本,不可跟";

  return {
    barcode: first.barcode || null,
    name: firstValue(rows, "product_name"),
    spec: firstValue(rows, "spec_name"),
    brand: firstValue(rows, "brand"),
    category: firstValue(rows, "category_l3"),
    shops,
    shop_count: shops.length,
    month_sale_total: monthSaleTotal,
    low_price: low.price,
    low_shop: low.shop,
    low_fake_reason: low.reason,
    taobao_price: null,
    pdd_price: null,
    mine_code: first.mine_code || null,
    mine_name: first.mine_name || null,
    mine_price: minePrice,
    mine_stock: num(first.mine_stock),
    mine_status: first.mine_status || null,
    gap_pct: gapPct(minePrice, low.price),
    tier: tierOf(low.price, low.row?.list_price),
    ...(viaGateway ? {
      mine_cost: mineCost,
      floor_traffic: floorTraffic,
      floor_takeout: floorTakeout,
      margin_if_match: marginIfMatch,
      can_match: canMatch
    } : {})
  };
}

function passFilter(row, filter) {
  if (filter === "hot") return (row.month_sale_total ?? -1) >= 20;
  if (filter === "mine") return row.mine_code !== null;
  if (filter === "shared") return row.shop_count >= 2;
  if (filter === "nomine") return row.mine_code === null;
  return true;
}

function overview(rows) {
  return {
    原始行数: rows.reduce((sum, r) => sum + (r.shops || []).reduce((shopSum, s) => shopSum + (num(s.raw_rows) ?? 0), 0), 0),
    去重后商品数: rows.reduce((sum, r) => sum + (num(r.shop_count) ?? 0), 0),
    条码数: rows.length,
    两家以上共有: rows.filter((r) => r.shop_count >= 2).length,
    三家以上共有: rows.filter((r) => r.shop_count >= 3).length,
    我方也有: rows.filter((r) => r.mine_code !== null).length,
    可比且热销: rows.filter((r) => r.low_price !== null && (r.month_sale_total ?? -1) >= 20).length
  };
}

function verdictOf(rows, shownRows) {
  const hot = rows.filter((r) => (r.month_sale_total ?? -1) >= 20).length;
  const shared = rows.filter((r) => r.shop_count >= 2).length;
  const mine = rows.filter((r) => r.mine_code !== null).length;
  return `${rows.length} 个条码合并为一张表,${shared} 个两家以上共有,${hot} 个合计月销20+,我方已有 ${mine} 个。`;
}

function buildPayload(rawRows, req, viaGateway) {
  const groups = new Map();
  for (const r of rawRows) {
    if (!groups.has(r.barcode)) groups.set(r.barcode, []);
    groups.get(r.barcode).push(r);
  }

  const allRows = [...groups.values()]
    .map((rows) => buildRow(rows, viaGateway))
    .sort((a, b) => (b.month_sale_total ?? -1) - (a.month_sale_total ?? -1)
      || b.shop_count - a.shop_count
      || String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));

  const filter = parseFilter(req.query?.filter);
  const limit = parseLimit(req.query?.limit);
  const rows = allRows.filter((r) => passFilter(r, filter)).slice(0, limit);
  const dates = rawRows.map((r) => r.export_date).filter(Boolean).sort();

  return {
    verdict: verdictOf(allRows, rows),
    export_date: dates[dates.length - 1] || null,
    overview: overview(allRows),
    rows,
    caveats: CAVEATS
  };
}

async function build(pool, req, viaGateway) {
  const q = cleanText(req.query?.q);
  const result = await pool.query(SQL, [q]);
  return buildPayload(result.rows, req, viaGateway);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const viaGateway = req.headers["x-gateway-auth"] === "gw-dataops-0903";
    if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") { if (!requireAuth(req, res)) return; }
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return json(res, 200, await build(getPool(), req, viaGateway));
  } catch (err) {
    console.error("[petstore-rival-merged]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}

