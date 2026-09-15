import { getPool, setCors } from "../db.js";

const STORE = "63350001";
const CACHE_TTL_MS = 60000;
let cache = { at: 0, data: null };

function json(res, code, body) { return res.status(code).json(body); }
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function money(v) { const x = n(v); return x == null ? null : Math.round(x * 100) / 100; }
function pct(a, b) { return b > 0 ? Math.round(a * 1000 / b) / 10 : null; }
function wrap(data, cached, at) { return { ...data, cached, generated_at: new Date(at).toISOString() }; }

export function invalidateProductAnalysisCache() {
  cache = { at: 0, data: null };
}

async function loadOwnRows(pool) {
  const r = await pool.query(
    `WITH latest AS (
       SELECT max(as_of) AS as_of FROM public.petstore_sku_sales_dna WHERE store_code=$1
     )
     SELECT d.product_code, d.product_name, d.category_name, d.spec,
            d.qty_30, d.qty_90, d.qty_180, d.cur_stock, d.cost_price,
            d.velocity_tier, d.restock_verdict, d.last_sale_at,
            public.pet_category_of(d.product_name) AS category,
            co.cost AS override_cost
       FROM public.petstore_sku_sales_dna d
       JOIN latest l ON l.as_of=d.as_of
       LEFT JOIN public.petstore_cost_override co ON co.product_code=d.product_code
      WHERE d.store_code=$1`,
    [STORE]
  );
  return r.rows;
}

async function loadMix(pool) {
  const r = await pool.query(`SELECT * FROM public.v_own_category_mix ORDER BY category`);
  return r.rows;
}

async function loadRival(pool) {
  const r = await pool.query(
    `SELECT shop, product_name, month_sale, hand_price, tier_text, category, is_med
       FROM public.v_rival_sku_today
      WHERE shop IN ('爪壮壮','邻小虎')`
  );
  return r.rows;
}

async function loadMedRows(pool) {
  const r = await pool.query(
    `WITH latest AS (
       SELECT max(as_of) AS as_of FROM public.petstore_sku_sales_dna WHERE store_code=$1
     ), exp_latest AS (
       SELECT max(capture_date) AS capture_date FROM public.petstore_offline_expiry_snapshot
     ), exp AS (
       SELECT e.product_code, e.expiration_date, e.days_to_expire, e.warn_status_str
         FROM public.petstore_offline_expiry_snapshot e
         JOIN exp_latest l ON l.capture_date=e.capture_date
     )
     SELECT d.product_code, d.product_name, d.spec, d.category_name,
            d.cur_stock, d.qty_180, d.qty_90,
            c.rx_type, c.confidence, c.reason, c.forbid_marketing, c.evidence,
            e.expiration_date, e.days_to_expire
       FROM public.petstore_sku_sales_dna d
       JOIN latest l ON l.as_of=d.as_of
       LEFT JOIN public.petstore_med_classify c ON c.product_code=d.product_code
       LEFT JOIN exp e ON e.product_code=d.product_code
      WHERE d.store_code=$1
        AND (d.category_name LIKE '%驱虫%' OR d.category_name LIKE '%医疗%' OR d.category_name LIKE '%保健%')
      ORDER BY d.category_name NULLS LAST, d.product_name NULLS LAST, d.product_code`,
    [STORE]
  );
  return r.rows;
}

async function loadOpenTasks(pool) {
  const r = await pool.query(
    `SELECT id, title, status, next_holder, created_at, due_at, dedupe_key
       FROM public.tasks
      WHERE dedupe_key LIKE 'pa:%'
        AND status NOT IN ('done','cancelled')
      ORDER BY created_at DESC NULLS LAST, id`
  );
  return r.rows;
}

function stockInfo(r) {
  const stockRaw = n(r.cur_stock);
  const stock = stockRaw != null && stockRaw >= 0 ? stockRaw : null;
  const cost = n(r.override_cost != null ? r.override_cost : r.cost_price);
  const hasStock = stock != null && stock > 0;
  const hasCost = cost != null && cost > 0.2;
  const value = hasStock && hasCost ? stock * cost : null;
  return { stock, cost, hasStock, hasCost, value };
}

function playOf(category, gapPt) {
  if (gapPt != null && gapPt <= -8) return "对手主力·我方偏弱";
  if (gapPt != null && gapPt >= 8) return "我方偏重·对手少";
  if (category === "营养保健") return "两边都小·收缩";
  if (category === "兽药") return "只记录·合规";
  return "持平";
}

function topRival(rivals, category) {
  return rivals
    .filter((x) => x.category === category)
    .sort((a, b) => (n(b.month_sale) || 0) - (n(a.month_sale) || 0))
    .slice(0, 5)
    .map((x) => ({
      shop: x.shop,
      product_name: x.product_name,
      month_sale: n(x.month_sale) || 0,
      hand_price: money(x.hand_price),
      tier_text: x.tier_text
    }));
}

function complianceOf(r) {
  const stock = n(r.cur_stock);
  const hasStock = stock != null && stock > 0;
  const days = n(r.days_to_expire);
  const conf = n(r.confidence);
  if (!r.rx_type) return { compliance: "待AI分类", action: "人工复核" };
  if (conf == null || conf < 0.8 || r.rx_type === "不确定") return { compliance: "待人工复核", action: "人工复核" };
  if (days != null && days <= 0 && hasStock) return { compliance: "过期·下架核查", action: "下架核查" };
  if (r.rx_type === "处方药") return { compliance: "仅记录·需资质", action: "补资质" };
  return { compliance: "仅记录", action: "记录" };
}

export async function buildProductAnalysis(pool) {
  const [ownRows, mixRows, rivals, medRaw, openTasks] = await Promise.all([
    loadOwnRows(pool), loadMix(pool), loadRival(pool), loadMedRows(pool), loadOpenTasks(pool)
  ]);

  const taskByCode = new Map();
  for (const t of openTasks) {
    const parts = String(t.dedupe_key || "").split(":");
    const code = parts[parts.length - 1];
    if (code && !taskByCode.has(code)) taskByCode.set(code, t);
  }

  let stuckValue = 0, deadValue = 0, movingN = 0, inStockN = 0, costMissingN = 0;
  const ownByCat = new Map();
  for (const r of ownRows) {
    const s = stockInfo(r);
    const qty90 = n(r.qty_90) || 0;
    const qty180 = n(r.qty_180) || 0;
    if (s.hasStock) {
      inStockN += 1;
      if (!s.hasCost) costMissingN += 1;
      if (qty90 > 0) movingN += 1;
      if (["slow", "stale", "dead"].includes(String(r.velocity_tier || "")) && s.value != null) stuckValue += s.value;
      if (r.velocity_tier === "dead" && s.value != null) deadValue += s.value;
    }
    const cat = r.category || "其他";
    if (!ownByCat.has(cat)) ownByCat.set(cat, []);
    const { cost_price, override_cost, ...pub } = r;
    ownByCat.get(cat).push({ ...pub, qty_180: qty180, qty_90: qty90, cur_stock: s.stock, stock_value: s.value == null ? null : money(s.value) });
  }

  const categories = mixRows.map((m) => {
    const cat = m.category || "其他";
    const rows = ownByCat.get(cat) || [];
    let stockValue = 0, deadCatValue = 0;
    for (const r of rows) {
      const v = n(r.stock_value);
      if (v != null) stockValue += v;
      if (r.velocity_tier === "dead" && v != null) deadCatValue += v;
    }
    const qtyShare = n(m.qty_share) || 0;
    const zzz = n(m.zzz_sales_share) || 0;
    const lxh = n(m.lxh_sales_share) || 0;
    const gapPt = Math.round((qtyShare - ((zzz + lxh) / 2)) * 10) / 10;
    return {
      category: cat,
      names: n(m.names) || 0,
      codes: n(m.codes) || 0,
      in_stock: n(m.in_stock) || 0,
      moving: n(m.moving) || 0,
      qty_180: n(m.qty_180) || 0,
      qty_share: qtyShare,
      zzz_sales_share: zzz,
      lxh_sales_share: lxh,
      nearby_sales_share: n(m.nearby_sales_share) || 0,
      stock_value: money(stockValue),
      dead_value: money(deadCatValue),
      gap_pt: gapPt,
      play: playOf(cat, gapPt),
      top_own: rows.sort((a, b) => (n(b.qty_180) || 0) - (n(a.qty_180) || 0)).slice(0, 10),
      top_dead: rows.filter((x) => x.velocity_tier === "dead" && (n(x.stock_value) || 0) > 0)
        .sort((a, b) => (n(b.stock_value) || 0) - (n(a.stock_value) || 0)).slice(0, 10),
      top_rival: topRival(rivals, cat)
    };
  }).sort((a, b) => (n(b.stock_value) || 0) - (n(a.stock_value) || 0));

  const gapTop = categories.slice().sort((a, b) => Math.abs(n(b.gap_pt) || 0) - Math.abs(n(a.gap_pt) || 0))[0] || null;
  const medRows = medRaw.map((r) => {
    const cx = complianceOf(r);
    const t = taskByCode.get(r.product_code);
    return {
      product_code: r.product_code,
      product_name: r.product_name,
      spec: r.spec,
      category_name: r.category_name,
      cur_stock: n(r.cur_stock) != null && n(r.cur_stock) >= 0 ? n(r.cur_stock) : null,
      qty_180: n(r.qty_180) || 0,
      rx_type: r.rx_type || null,
      confidence: n(r.confidence),
      reason: r.reason,
      forbid_marketing: Boolean(r.forbid_marketing),
      evidence: r.evidence || null,
      expiration_date: r.expiration_date,
      days_to_expire: n(r.days_to_expire),
      compliance: cx.compliance,
      action: t ? cx.action : cx.action,
      open_task: t ? { id: t.id, title: t.title, status: t.status, next_holder: t.next_holder, due_at: t.due_at } : null
    };
  });

  const medCards = {
    own_n: medRows.length,
    in_stock_n: medRows.filter((x) => (n(x.cur_stock) || 0) > 0).length,
    qty_180: medRows.reduce((a, x) => a + (n(x.qty_180) || 0), 0),
    rx_n: medRows.filter((x) => x.rx_type === "处方药").length,
    unsure_n: medRows.filter((x) => !x.rx_type || x.rx_type === "不确定" || (n(x.confidence) || 0) < 0.8).length,
    expired_n: medRows.filter((x) => (n(x.cur_stock) || 0) > 0 && n(x.days_to_expire) != null && n(x.days_to_expire) <= 0).length,
    rival_zzz_sales: rivals.filter((x) => x.is_med && x.shop === "爪壮壮").reduce((a, x) => a + (n(x.month_sale) || 0), 0),
    rival_lxh_sales: rivals.filter((x) => x.is_med && x.shop === "邻小虎").reduce((a, x) => a + (n(x.month_sale) || 0), 0)
  };

  return {
    ok: true,
    verdict: `压货 ¥${Math.round(stuckValue).toLocaleString("zh-CN")} · 兽药待复核 ${medCards.unsure_n} 个`,
    verdict_level: medCards.unsure_n || medCards.expired_n ? "red" : "ok",
    own: {
      cards: {
        stuck_value: money(stuckValue),
        dead_value: money(deadValue),
        moving_n: movingN,
        in_stock_n: inStockN,
        moving_pct: pct(movingN, inStockN),
        cat_gap_top: gapTop ? { category: gapTop.category, gap_pt: gapTop.gap_pt } : null,
        cost_missing_n: costMissingN
      },
      categories
    },
    med: {
      cards: medCards,
      rows: medRows,
      rival_top: rivals.filter((x) => x.is_med)
        .sort((a, b) => (n(b.month_sale) || 0) - (n(a.month_sale) || 0))
        .slice(0, 20)
        .map((x) => ({ shop: x.shop, product_name: x.product_name, month_sale: n(x.month_sale) || 0, hand_price: money(x.hand_price), tier_text: x.tier_text }))
    }
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") return json(res, 403, { ok: false, error: "gateway_auth_required" });
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

  try {
    const now = Date.now();
    if (cache.data && now - cache.at < CACHE_TTL_MS) return json(res, 200, wrap(cache.data, true, cache.at));
    const data = await buildProductAnalysis(getPool());
    cache = { at: Date.now(), data };
    return json(res, 200, wrap(data, false, cache.at));
  } catch (err) {
    console.error("[petstore-product-analysis]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
