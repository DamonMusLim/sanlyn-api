import { getPool, setCors } from "../db.js";
import { buildCatalogOverview } from "./petstore-catalog-overview.js";
import { buildExpiryRisk } from "./petstore-expiry-risk.js";
import { buildProblemGoods } from "./petstore-problem-goods.js";

const STORE = "63350001";
const CACHE_TTL_MS = 60000;
const PREWARM_MS = 5 * 60000;
// 0927 Damon「加载太慢了」:重计算 12 秒 → 先给上一份(不管多旧),过期后台重算;工单每次现查。
const boardCache = new Map(); // storeCode -> { at, data, inflight }

function json(res, code, body) { return res.status(code).json(body); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function money(v) { return v == null ? null : Math.round(Number(v) * 100) / 100; }
function pct(a, b) { return b > 0 ? Math.round(a * 1000 / b) / 10 : null; }
function groupOf(data, key) { return (data.groups || []).find((g) => g.key === key) || { count: 0, amount_by_price: null, up_count: 0 }; }
function cacheWrap(data, cached, at) { return { ...data, cached, generated_at: new Date(at).toISOString() }; }

export function invalidateStoreBoardCache() {
  for (const c of boardCache.values()) c.at = 0; // 只标过期,旧数据照给,后台重算
}

async function loadDna(pool, storeCode) {
  const r = await pool.query(
    `WITH latest AS (
       SELECT max(as_of) AS as_of FROM public.petstore_sku_sales_dna WHERE store_code=$1
     ), ops AS (
       SELECT DISTINCT ON(product_code)
              product_code, store_price, mt_price, ele_price, cost_price
         FROM public.petstore_ops_row
        ORDER BY product_code
     )
     SELECT d.product_code, d.product_name, d.category_name, d.spec,
            d.qty_30, d.qty_90, d.qty_180, d.cur_stock, d.cost_price AS dna_cost_price,
            d.velocity_tier, d.restock_verdict, d.last_sale_at,
            o.store_price, o.mt_price, o.ele_price, o.cost_price AS ops_cost_price,
            co.cost AS override_cost
       FROM public.petstore_sku_sales_dna d
       JOIN latest l ON d.as_of=l.as_of
       LEFT JOIN ops o ON o.product_code=d.product_code
       LEFT JOIN public.petstore_cost_override co ON co.product_code=d.product_code
      WHERE d.store_code=$1
      ORDER BY d.category_name NULLS LAST, d.product_code`,
    [storeCode]);
  return r.rows;
}

async function loadOpenTasks(pool) {
  const r = await pool.query(
    `SELECT id, title, status, next_holder, created_at, due_at, dedupe_key
       FROM public.tasks
      WHERE dedupe_key LIKE 'storehealth:%'  -- 0916: health: 前缀被个人健康模块占用,⛔别用
        AND status NOT IN ('done','cancelled')
      ORDER BY created_at DESC NULLS LAST, id`);
  return r.rows;
}

export async function buildStoreBoard(pool, storeCode = STORE) {
  const [base, openTasks] = await Promise.all([buildStoreBoardBase(pool, storeCode), loadOpenTasks(pool)]);
  return { ...base, open_tasks: openTasks };
}

async function buildStoreBoardBase(pool, storeCode) {
  const [catalog, expiry, goods, rows] = await Promise.all([
    buildCatalogOverview(pool, storeCode),
    buildExpiryRisk(pool),
    buildProblemGoods(pool),
    loadDna(pool, storeCode)
  ]);

  const exp = groupOf(expiry, "tier_5_expired");
  const onsale = groupOf(goods, "onsale_no_stock");
  let stuckValue = 0, stuckN = 0, deadValue = 0, deadN = 0, movingN = 0, inStockN = 0;
  let costMissingN = 0, negativeStockN = 0;
  const cats = new Map();

  for (const r of rows) {
    const rawStock = n(r.cur_stock);
    if (rawStock != null && rawStock < 0) negativeStockN++;
    const stock = rawStock != null && rawStock >= 0 ? rawStock : null;
    const qty90 = n(r.qty_90) || 0;
    const qty180 = n(r.qty_180) || 0;
    const costRaw = r.override_cost != null ? r.override_cost : (r.dna_cost_price != null ? r.dna_cost_price : r.ops_cost_price);
    const cost = n(costRaw);
    const hasCost = cost != null && cost > 0.2;
    const hasStock = stock != null && stock > 0;
    const moving = hasStock && qty90 > 0;
    const tier = String(r.velocity_tier || "");
    const value = hasStock && hasCost ? stock * cost : null;

    if (hasStock) {
      inStockN++;
      if (!hasCost) costMissingN++;
      if (moving) movingN++;
      if (["slow", "stale", "dead"].includes(tier)) { stuckN++; if (value != null) stuckValue += value; }
      if (tier === "dead") { deadN++; if (value != null) deadValue += value; }
    }

    const key = r.category_name || "(无品类)";
    if (!cats.has(key)) cats.set(key, {
      category: key, skus: 0, in_stock: 0, moving: 0, moving_pct: null,
      stock_value: 0, dead_value: 0, dead_n: 0, qty_180: 0, products: []
    });
    const c = cats.get(key);
    c.skus++;
    c.qty_180 += qty180;
    if (hasStock) c.in_stock++;
    if (moving) c.moving++;
    if (value != null) c.stock_value += value;
    if (tier === "dead") {
      c.dead_n++;
      if (value != null) c.dead_value += value;
    }
    c.products.push({
      product_code: r.product_code,
      product_name: r.product_name,
      spec: r.spec,
      cur_stock: stock,
      qty_90: qty90,
      qty_180: qty180,
      velocity_tier: r.velocity_tier,
      restock_verdict: r.restock_verdict,
      last_sale_at: r.last_sale_at,
      store_price: r.store_price,
      mt_price: r.mt_price,
      stock_value: value == null ? null : money(value)
    });
  }

  const categories = Array.from(cats.values()).map((c) => {
    c.moving_pct = pct(c.moving, c.in_stock);
    c.stock_value = money(c.stock_value);
    c.dead_value = money(c.dead_value);
    c.products = c.products.sort((a, b) => (n(b.stock_value) || 0) - (n(a.stock_value) || 0)).slice(0, 20);
    return c;
  }).sort((a, b) => (n(b.stock_value) || 0) - (n(a.stock_value) || 0));

  const comp = catalog.completeness || {};
  const staleN = (catalog.daily_update || []).filter((x) => x.level !== "green").length;
  const gaps = [
    { key: "barcode_missing", label: "条码缺失", count: Math.max(0, (n(comp.total) || 0) - (n(comp.has_barcode) || 0)), level: "yellow", assignee: "OPS-01" },
    { key: "pic_missing", label: "图片缺失", count: Math.max(0, (n(comp.total) || 0) - (n(comp.has_pic) || 0)), level: "yellow", assignee: "PET-12" },
    { key: "cost_missing", label: "成本缺失", count: costMissingN, level: "red", assignee: "PET-22" },
    { key: "negative_stock", label: "负库存", count: negativeStockN, level: "red", assignee: "PET-22" },
    { key: "source_stale", label: "数据源未更新", count: staleN, level: staleN ? "red" : "green", assignee: "OPS-01" }
  ];

  const movingPct = pct(movingN, inStockN);
  const red = (n(exp.up_count) || 0) > 0 || (movingPct != null && movingPct < 10);
  return {
    ok: true,
    store_code: storeCode,
    verdict: "压货 ¥" + Math.round(stuckValue).toLocaleString("zh-CN") + " · 卖得动 " + movingN + " 个(" + (movingPct == null ? "—" : movingPct) + "%)",
    verdict_level: red ? "red" : "ok",
    cards: {
      stuck_value: money(stuckValue), stuck_n: stuckN,
      dead_value: money(deadValue), dead_n: deadN,
      moving_n: movingN, in_stock_n: inStockN, moving_pct: movingPct,
      onsale_no_stock_n: n(onsale.count) || 0,
      expired_amount: exp.amount_by_price == null ? null : money(exp.amount_by_price),
      expired_onsale_n: n(exp.up_count) || 0,
      sources_fresh: (catalog.daily_update || []).filter((x) => x.level === "green").length,
      sources_total: (catalog.daily_update || []).length,
      cost_missing_n: costMissingN
    },
    categories,
    health: {
      daily_update: catalog.daily_update,
      completeness: catalog.completeness,
      last_snapshot_at: catalog.last_snapshot_at,
      gaps
    }
  };
}

function refreshBase(storeCode) {
  let c = boardCache.get(storeCode);
  if (!c) { c = { at: 0, data: null, inflight: null }; boardCache.set(storeCode, c); }
  if (c.inflight) return c.inflight;
  c.inflight = buildStoreBoardBase(getPool(), storeCode)
    .then((data) => { c.data = data; c.at = Date.now(); return c; })
    .catch((err) => { console.error("[petstore-store-board] refresh", err); if (!c.data) throw err; return c; })
    .finally(() => { c.inflight = null; });
  return c.inflight;
}

async function getBase(storeCode) {
  const c = boardCache.get(storeCode);
  if (c && c.data) {
    if (Date.now() - c.at >= CACHE_TTL_MS) refreshBase(storeCode).catch(() => {});
    return { data: c.data, at: c.at, cached: true };
  }
  const fresh = await refreshBase(storeCode);
  return { data: fresh.data, at: fresh.at, cached: false };
}

refreshBase(STORE).catch(() => {});
setInterval(() => { refreshBase(STORE).catch(() => {}); }, PREWARM_MS).unref();

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") return json(res, 403, { ok: false, error: "gateway_auth_required" });
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

  try {
    const q = String(req.query?.storeCode || "");
    const storeCode = /^\d{8}$/.test(q) ? q : STORE; // 缓存按店分,只收 8 位店号,防乱传参撑爆 Map
    const [base, openTasks] = await Promise.all([getBase(storeCode), loadOpenTasks(getPool())]);
    return json(res, 200, cacheWrap({ ...base.data, open_tasks: openTasks }, base.cached, base.at));
  } catch (err) {
    console.error("[petstore-store-board]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
