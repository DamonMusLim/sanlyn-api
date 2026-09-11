// 数据加工中心 · 附近美团 H5 实时 SKU · 0911
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

function json(res, code, body) { return res.status(code).json(body); }

const CAVEATS = [
  "数据来源=petstore_market_quotes_raw,source=meituan_h5,只取最新 captured_at 那天。",
  "H5 不返回条码,我方匹配只能按品名:先品牌头候选,再规格数字+单位确认。",
  "exact=品牌头相同且规格相同;brand=只有品牌头相同;none=品牌头也没有。",
  "价格已标记五类假数字:钩子价、首件神价、分档钓鱼、多包装、拆零;前端应划掉 price_usable=false 的价格。",
  "不返回成本、进价、毛利。取不到的值返回 null。"
];

const GROUPS = [
  { key: "within1km", label: "1km 内 · 贴脸", tier: "red", test: (m) => m !== null && m <= 1000 },
  { key: "within3km", label: "1-3km · 主战场", tier: "orange", test: (m) => m !== null && m > 1000 && m <= 3000 },
  { key: "beyond3km", label: "3km 外 · 参考", tier: "gray", test: (m) => m === null || m > 3000 }
];

const FLAVOR_WORDS = [
  "鸡胸", "鸡肉", "牛肉", "羊肉", "鸭肉", "猪肉", "兔肉", "鹿肉", "火鸡", "鹌鹑", "乳鸽", "鳄鱼",
  "三文鱼", "金枪鱼", "鳕鱼", "鳀鱼", "沙丁鱼", "鲣鱼", "深海鱼", "海鱼", "鱼肉", "虾仁", "虾", "蟹肉", "蟹",
  "蛋黄", "鸡蛋", "奶酪", "芝士", "羊奶", "牛奶",
  "南瓜", "胡萝卜", "蔬菜", "猫草", "果蔬", "蓝莓", "苹果", "车前子",
  "山茶花", "樱花", "茉莉", "薰衣草",
  "原味", "无谷", "混合", "高汤", "慕斯", "冻干", "生骨肉"
];

const QUOTES_SQL = `
  WITH latest AS (
    SELECT max(captured_at::date) AS day
      FROM public.petstore_market_quotes_raw
     WHERE source = 'meituan_h5'
  )
  SELECT competitor_name,
         raw_key,
         title,
         round(price::numeric, 2) AS price,
         round(orig_price::numeric, 2) AS orig_price,
         monthly_sales,
         raw_payload->>'distance' AS distance,
         raw_payload->>'keyword' AS keyword,
         raw_payload->>'price_tip' AS price_tip,
         raw_payload->>'picture' AS picture,
         captured_at::date::text AS captured_day
    FROM public.petstore_market_quotes_raw q, latest
   WHERE q.source = 'meituan_h5'
     AND q.captured_at::date = latest.day
   ORDER BY monthly_sales DESC NULLS LAST, competitor_name, raw_key
`;

const MINE_SQL = `
  SELECT r.product_code,
         r.product_name,
         r.barcode,
         round(r.store_price::numeric, 2) AS store_price,
         r.product_status,
         GREATEST(coalesce(k.stock_num, 0), coalesce(r.cur_stock, 0)) AS stock_num,
         k.month_sale
    FROM public.petstore_ops_row r
    LEFT JOIN public.petstore_skus k ON k.product_code = r.product_code
   WHERE coalesce(r.product_name, '') <> ''
`;

const REVIEW_SQL = `
  SELECT h5_sku_id,
         our_product_code,
         verdict,
         correct_spec,
         note,
         reviewed_by,
         reviewed_at,
         near_price_at_review,
         mine_price_at_review
    FROM public.petstore_match_review
`;

function cleanName(s) {
  return String(s || "").replace(/^【[^】]*】\s*/, "").trim() || null;
}

function isHan(ch) {
  const cp = ch ? ch.codePointAt(0) : 0;
  return (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff);
}

function brandHead(name) {
  const s = cleanName(name);
  if (!s) return null;
  const en = s.match(/^[A-Za-z][A-Za-z0-9&.+-]*/);
  if (en && en[0].length >= 2) return en[0].toLowerCase();
  const chars = Array.from(s);
  const head = [];
  for (const ch of chars) {
    if (isHan(ch)) head.push(ch);
    else if (head.length) break;
    else if (!/\s|[([{（【]/.test(ch)) break;
    if (head.length >= 4) break;
  }
  return head.length >= 2 ? head.join("") : null;
}

function specs(name) {
  const s = String(name || "")
    .replace(/Ｋ/g, "K").replace(/ｋ/g, "k")
    .replace(/Ｇ/g, "G").replace(/ｇ/g, "g")
    .replace(/Ｍ/g, "M").replace(/ｍ/g, "m")
    .replace(/Ｌ/g, "L").replace(/ｌ/g, "l");
  const out = new Set();
  const re = /(\d+(?:\.\d+)?)\s*(kg|KG|Kg|g|G|克|千克|斤|ml|ML|Ml|毫升|l|L|升)/g;
  let m;
  while ((m = re.exec(s))) {
    let unit = m[2].toLowerCase();
    if (unit === "克") unit = "g";
    if (unit === "千克") unit = "kg";
    if (unit === "毫升") unit = "ml";
    if (unit === "升") unit = "l";
    out.add(`${Number(m[1])}${unit}`);
  }
  return out;
}

function doubtSpecs(name) {
  const s = String(name || "")
    .replace(/Ｋ/g, "K").replace(/ｋ/g, "k")
    .replace(/Ｇ/g, "G").replace(/ｇ/g, "g")
    .replace(/Ｍ/g, "M").replace(/ｍ/g, "m")
    .replace(/Ｌ/g, "L").replace(/ｌ/g, "l");
  const out = new Set();
  const re = /(\d+(?:\.\d+)?)\s*(kg|KG|Kg|g|G|ml|ML|Ml|l|L|斤|片|袋|罐|支|条|粒|包)/g;
  let m;
  while ((m = re.exec(s))) {
    out.add(`${Number(m[1])}${m[2].toLowerCase()}`);
  }
  return out;
}

function extractFlavors(title) {
  const s = String(title || "");
  const hits = FLAVOR_WORDS
    .map((word, order) => ({ word, order, idx: s.indexOf(word) }))
    .filter((x) => x.idx >= 0);
  return hits
    .filter((x) => !hits.some((y) => y.word !== x.word && y.word.includes(x.word)))
    .sort((a, b) => a.idx - b.idx || a.order - b.order)
    .slice(0, 3)
    .map((x) => x.word);
}

function parseDistance(s) {
  const v = String(s || "").trim();
  const m = v.match(/^(\d+(?:\.\d+)?)\s*(m|米|km|公里)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return /km|公里/i.test(m[2]) ? Math.round(n * 1000) : Math.round(n);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function fakePrice(row) {
  const price = num(row.price);
  const orig = num(row.orig_price);
  const title = String(row.title || "");
  if (price !== null && price <= 0.5) return "钩子价";
  if (price !== null && orig !== null && orig > 0 && price < orig * 0.3) return "首件神价";
  if (/试新|新客|首单|首件|尝鲜|老客|复购|进店必点|必抢|秒杀/.test(title)) return "分档钓鱼";
  if (/\*\s*\d+\s*袋|\d+\s*袋装|囤货|箱装|组合|特惠装|\d+\s*件/.test(title)) return "多包装";
  if (/拆售|拆零|散卖|单片|一片|\/片|每片|试用装|小样/.test(title)) return "拆零";
  return null;
}

function reviewKey(h5SkuId, productCode) {
  return `${h5SkuId || ""}\u0001${productCode || ""}`;
}

function samePrice(a, b) {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Number(a).toFixed(2) === Number(b).toFixed(2);
}

function buildReviewMap(rows) {
  const map = new Map();
  for (const r of rows) {
    map.set(reviewKey(r.h5_sku_id, r.our_product_code), r);
  }
  return map;
}

function buildMineIndex(rows) {
  const map = new Map();
  for (const r of rows) {
    const brand = brandHead(r.product_name);
    if (!brand) continue;
    const item = {
      product_code: r.product_code || null,
      name: r.product_name || null,
      price: num(r.store_price),
      stock: num(r.stock_num),
      month_sale: num(r.month_sale),
      status: r.product_status || null,
      specs: specs(r.product_name)
    };
    if (!map.has(brand)) map.set(brand, []);
    map.get(brand).push(item);
  }
  return map;
}

function pickMine(q, index) {
  const brand = brandHead(q.title);
  if (!brand || !index.has(brand)) return { level: "none" };
  const candidates = index.get(brand);
  const qSpecs = specs(q.title);
  if (qSpecs.size) {
    for (const c of candidates) {
      for (const sp of qSpecs) {
        if (c.specs.has(sp)) return { level: "exact", mine: c };
      }
    }
  }
  const mine = candidates
    .slice()
    .sort((a, b) => (b.month_sale ?? -1) - (a.month_sale ?? -1) || (b.stock ?? -1) - (a.stock ?? -1))[0];
  return { level: "brand", mine };
}

function attachReview(row, reviewMap) {
  const rv = reviewMap.get(reviewKey(row.sku_id, row.mine_product_code));
  if (!rv) {
    row.review = null;
    return row;
  }
  const priceChanged = !samePrice(num(rv.near_price_at_review), row.price) || !samePrice(num(rv.mine_price_at_review), row.mine_price);
  row.review = {
    verdict: rv.verdict || null,
    correct_spec: rv.correct_spec || null,
    note: rv.note || null,
    reviewed_by: rv.reviewed_by || null,
    reviewed_at: rv.reviewed_at || null,
    near_price_at_review: num(rv.near_price_at_review),
    mine_price_at_review: num(rv.mine_price_at_review),
    price_changed: priceChanged
  };
  if (priceChanged) {
    row.doubts = row.doubts || [];
    if (!row.doubts.includes("价已变·结论可能过期")) row.doubts.push("价已变·结论可能过期");
    row.doubt_level = row.doubt_level === "high" ? "high" : "warn";
  }
  return row;
}

function rowOut(q, index) {
  const fake = fakePrice(q);
  const price = num(q.price);
  const hit = pickMine(q, index);
  const exactUsable = hit.level === "exact" && !fake && price !== null;
  return {
    shop: q.competitor_name || null,
    distance_m: parseDistance(q.distance),
    sku_id: q.raw_key || null,
    title: q.title || null,
    flavors: extractFlavors(q.title),
    keyword: q.keyword || null,
    price,
    orig_price: num(q.orig_price),
    price_usable: !fake,
    fake_reason: fake,
    month_sales: num(q.monthly_sales),
    picture: q.picture || null,
    mine_level: hit.level,
    mine_product_code: hit.mine?.product_code || null,
    mine_name: hit.mine?.name || null,
    mine_price: hit.mine?.price ?? null,
    mine_stock: hit.mine?.stock ?? null,
    mine_month_sale: hit.mine?.month_sale ?? null,
    mine_status: hit.mine?.status || null,
    price_gap: exactUsable && hit.mine?.price !== null ? Number((hit.mine.price - price).toFixed(2)) : null
  };
}

function addDoubts(rows) {
  const mineToSkus = new Map();
  for (const r of rows) {
    if (r.mine_level !== "exact") continue;
    const mineKey = r.mine_name || null;
    if (!mineKey) continue;
    if (!mineToSkus.has(mineKey)) mineToSkus.set(mineKey, new Set());
    if (r.sku_id) mineToSkus.get(mineKey).add(r.sku_id);
  }

  for (const r of rows) {
    const doubts = [];
    if (r.mine_level === "exact") {
      const price = num(r.price);
      const gap = num(r.price_gap);
      if (price !== null && price > 0 && gap !== null && Math.abs(gap) / price >= 1.0) doubts.push("差价过大");
      if (r.mine_name && mineToSkus.has(r.mine_name) && mineToSkus.get(r.mine_name).size > 3) doubts.push("一对多");
      if (doubtSpecs(r.title).size >= 2 || doubtSpecs(r.mine_name).size >= 2) doubts.push("多规格标题");
      const nearFlavors = r.flavors || [];
      const mineFlavors = extractFlavors(r.mine_name);
      if (nearFlavors.length && mineFlavors.length && !nearFlavors.some((x) => mineFlavors.includes(x))) doubts.push("口味不一致");
    }
    r.doubts = doubts;
    r.doubt_level = doubts.length === 0 ? "ok" : (doubts.length >= 2 || doubts.includes("差价过大") ? "high" : "warn");
  }
  return rows;
}

function makeVerdict(day, staleDays, overview) {
  const stale = staleDays > 3 ? `数据已滞后${staleDays}天,先当趋势看;` : "";
  return `${stale}附近最新有${overview.商品数}个SKU,${overview.有月销的商品数}个有月销;我方exact命中${overview.我方exact命中数}个,brand命中${overview.我方brand命中数}个。`;
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });

  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") {
    if (!requireAuth(req, res)) return;
  }

  try {
    const pool = getPool();
    const [quotesRet, mineRet, reviewRet] = await Promise.all([pool.query(QUOTES_SQL), pool.query(MINE_SQL), pool.query(REVIEW_SQL)]);
    const quotes = quotesRet.rows || [];
    const mineIndex = buildMineIndex(mineRet.rows || []);
    const reviewMap = buildReviewMap(reviewRet.rows || []);
    const rows = addDoubts(quotes.map((q) => rowOut(q, mineIndex))).map((r) => attachReview(r, reviewMap));
    const capturedAt = quotes[0]?.captured_day || null;
    const staleDays = capturedAt ? Math.floor((Date.now() - new Date(`${capturedAt}T00:00:00Z`).getTime()) / 86400000) : null;

    const shops = new Set(rows.map((r) => r.shop).filter(Boolean));
    const nearShops = new Set(rows.filter((r) => r.distance_m !== null && r.distance_m <= 3000).map((r) => r.shop).filter(Boolean));
    const overview = {
      店数: shops.size,
      商品数: rows.length,
      三公里内店数: nearShops.size,
      有月销的商品数: rows.filter((r) => (r.month_sales ?? 0) > 0).length,
      我方exact命中数: rows.filter((r) => r.mine_level === "exact").length,
      我方brand命中数: rows.filter((r) => r.mine_level === "brand").length,
      待核查数: rows.filter((r) => (!r.review && r.doubt_level !== "ok") || (r.review && r.review.price_changed)).length,
      其中high: rows.filter((r) => ((!r.review && r.doubt_level === "high") || (r.review && r.review.price_changed && r.doubt_level === "high"))).length,
      已核查数: rows.filter((r) => r.review).length,
      确认真差价数: rows.filter((r) => r.review && r.review.verdict === "real_gap" && !r.review.price_changed).length,
      我方档案要修数: rows.filter((r) => r.review && r.review.verdict === "our_sku_dirty" && !r.review.price_changed).length
    };

    const confirmedGapRows = rows
      .filter((r) => r.review && r.review.verdict === "real_gap" && !r.review.price_changed)
      .sort((a, b) => Math.abs(num(b.price_gap) ?? 0) - Math.abs(num(a.price_gap) ?? 0));
    const needVerifyRows = rows
      .filter((r) => (!r.review && r.doubt_level !== "ok") || (r.review && r.review.price_changed))
      .sort((a, b) => (a.doubt_level === "high" ? 0 : 1) - (b.doubt_level === "high" ? 0 : 1) || (b.month_sales ?? -1) - (a.month_sales ?? -1));
    const skuDirtyRows = rows
      .filter((r) => r.review && r.review.verdict === "our_sku_dirty" && !r.review.price_changed)
      .sort((a, b) => (b.month_sales ?? -1) - (a.month_sales ?? -1));

    const groups = [{
      key: "confirmed_gap",
      label: "✅ 确认差价 · 可调价",
      tier: "green",
      count: confirmedGapRows.length,
      rows: confirmedGapRows
    }, {
      key: "need_verify",
      label: "⚠️ 待核查 · 匹配存疑,别直接调价",
      tier: "red",
      count: needVerifyRows.length,
      rows: needVerifyRows
    }, {
      key: "sku_dirty",
      label: "🔧 我方商品档要修 · 一码多规格",
      tier: "orange",
      count: skuDirtyRows.length,
      rows: skuDirtyRows
    }].concat(GROUPS.map((g) => {
      const all = rows
        .filter((r) => g.test(r.distance_m))
        .sort((a, b) => (b.month_sales ?? -1) - (a.month_sales ?? -1) || (a.distance_m ?? 999999) - (b.distance_m ?? 999999));
      return {
        key: g.key,
        label: g.label,
        tier: g.tier,
        count: all.length,
        truncated: all.length > 120,
        rows: all.slice(0, 120)
      };
    }));

    return json(res, 200, {
      verdict: makeVerdict(capturedAt, staleDays ?? 999, overview),
      captured_at: capturedAt,
      stale_days: staleDays,
      overview,
      groups,
      caveats: CAVEATS
    });
  } catch (e) {
    console.error("[petstore-nearby-live]", e);
    return json(res, 500, { error: "nearby_live_failed", detail: e.message || String(e) });
  }
}
