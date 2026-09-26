// 数据加工中心 · 竞品机会池 · 0915
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const TYPES = ["restock", "new_item", "review", "watch"];

const ROW_SQL = `
SELECT shop, product_name, month_sale, hand_price, tier_type, tier_text,
       category, is_med, captured_at, match_status, product_code, confidence,
       our_status, our_qty_90, our_qty_180, our_cur_stock, is_hook,
       is_first_price, opp_type, rank_in_type
  FROM public.v_rival_opportunity
 WHERE rank_in_type <= 50
 ORDER BY opp_type, rank_in_type`;

const SELECTION_SQL = `
SELECT product_code, shop, source, monthly_sales, price, orig_price, is_first_price,
       price_suspect, captured_at
  FROM public.v_selection_shop
 WHERE product_code = ANY($1::text[])`;

const DNA_SQL = `
WITH latest AS (
  SELECT max(as_of) AS as_of
    FROM public.petstore_sku_sales_dna
   WHERE store_code = '63350001'
)
SELECT d.product_code, d.restock_qty, d.restock_verdict, d.verdict_reason,
       d.qty_180, d.cur_stock
  FROM public.petstore_sku_sales_dna d
  JOIN latest l ON d.as_of = l.as_of
 WHERE d.store_code = '63350001'
   AND d.product_code = ANY($1::text[])`;

const SUPPLIER_SQL = `
SELECT DISTINCT ON (product_code) product_code, NULLIF(btrim(supplier), '') AS supplier
  FROM public.petstore_ops_row
 WHERE product_code = ANY($1::text[])
 ORDER BY product_code, (NULLIF(btrim(supplier), '') IS NULL)`;

function json(res, code, body) {
  return res.status(code).json(body);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function uniq(arr) {
  return [...new Set(arr.filter(Boolean))];
}

function median(values) {
  const xs = values.filter((v) => v !== null).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

function firstText(rows, field) {
  const r = rows.find((x) => x[field] !== null && x[field] !== undefined && x[field] !== "");
  return r ? r[field] : null;
}

function bestConfidence(rows) {
  const score = { high: 3, low: 2, none: 1 };
  let best = null;
  for (const r of rows) {
    if (!best || (score[r.confidence] || 0) > (score[best] || 0)) best = r.confidence;
  }
  return best || null;
}

function typeOf(rows) {
  const score = { restock: 1, new_item: 2, review: 3, watch: 4 };
  let best = "watch";
  for (const r of rows) {
    if ((score[r.opp_type] || 99) < (score[best] || 99)) best = r.opp_type;
  }
  return best;
}

function normalizedRow(r) {
  return {
    shop: r.shop,
    product_name: r.product_name,
    month_sale: num(r.month_sale),
    hand_price: num(r.hand_price),
    tier_type: r.tier_type,
    tier_text: r.tier_text,
    category: r.category,
    is_med: r.is_med,
    captured_at: r.captured_at,
    match_status: r.match_status,
    product_code: r.product_code,
    confidence: r.confidence,
    our_status: r.our_status,
    our_qty_90: num(r.our_qty_90),
    our_qty_180: num(r.our_qty_180),
    our_cur_stock: num(r.our_cur_stock),
    is_hook: r.is_hook,
    is_first_price: r.is_first_price,
    opp_type: r.opp_type,
    rank_in_type: num(r.rank_in_type)
  };
}

function rawMin(rows, priceField) {
  let best = null;
  for (const r of rows) {
    const price = num(r[priceField]);
    if (price === null || price <= 0) continue;
    if (!best || price < best.price) {
      best = {
        price,
        shop: r.shop || null,
        is_first_price: !!r.is_first_price
      };
    }
  }
  return best;
}

function selectionMetrics(rows) {
  const totalSales = rows.reduce((sum, r) => sum + (num(r.monthly_sales) || 0), 0);
  const max = rows.reduce((best, r) => {
    const sales = num(r.monthly_sales);
    if (sales === null) return best;
    return !best || sales > best.sales ? { sales, shop: r.shop || null } : best;
  }, null);
  const valid = rows.filter((r) => {
    const price = num(r.price);
    return (num(r.monthly_sales) || 0) >= 3 && !r.is_first_price && !r.price_suspect && price !== null && price > 1;
  });
  const med = median(valid.map((r) => num(r.price)));
  const eff = valid.filter((r) => med === null || num(r.price) >= med * 0.6);
  const effMin = eff.reduce((best, r) => {
    const price = num(r.price);
    if (price === null) return best;
    return !best || price < best.price ? { price, shop: r.shop || null } : best;
  }, null);
  const raw = rawMin(rows, "price");
  return {
    nearby_total_sales: totalSales,
    nearby_max_sales: max ? max.sales : null,
    nearby_max_shop: max ? max.shop : null,
    nearby_shop_count: uniq(rows.map((r) => r.shop)).length,
    nearby_price: effMin ? effMin.price : raw ? raw.price : null,
    nearby_price_shop: effMin ? effMin.shop : raw ? raw.shop : null,
    nearby_price_kind: effMin ? "effective" : raw && raw.is_first_price ? "first_price" : raw ? "reference" : null
  };
}

function rivalMetrics(rows) {
  const totalSales = rows.reduce((sum, r) => sum + (num(r.month_sale) || 0), 0);
  const max = rows.reduce((best, r) => {
    const sales = num(r.month_sale);
    if (sales === null) return best;
    return !best || sales > best.sales ? { sales, shop: r.shop || null } : best;
  }, null);
  const valid = rows.filter((r) => {
    const price = num(r.hand_price);
    return (num(r.month_sale) || 0) >= 3 && !r.is_first_price && price !== null && price > 1;
  });
  const med = median(valid.map((r) => num(r.hand_price)));
  const eff = valid.filter((r) => med === null || num(r.hand_price) >= med * 0.6);
  const effMin = eff.reduce((best, r) => {
    const price = num(r.hand_price);
    if (price === null) return best;
    return !best || price < best.price ? { price, shop: r.shop || null } : best;
  }, null);
  const raw = rawMin(rows, "hand_price");
  return {
    nearby_total_sales: totalSales,
    nearby_max_sales: max ? max.sales : null,
    nearby_max_shop: max ? max.shop : null,
    nearby_shop_count: uniq(rows.map((r) => r.shop)).length,
    nearby_price: effMin ? effMin.price : raw ? raw.price : null,
    nearby_price_shop: effMin ? effMin.shop : raw ? raw.shop : null,
    nearby_price_kind: effMin ? "effective" : raw && raw.is_first_price ? "first_price" : raw ? "reference" : null
  };
}

function mergedRow(rows, selectionMap, dnaMap, supplierMap = new Map()) {
  const sorted = [...rows].sort((a, b) => {
    const ta = { restock: 1, new_item: 2, review: 3, watch: 4 }[a.opp_type] || 99;
    const tb = { restock: 1, new_item: 2, review: 3, watch: 4 }[b.opp_type] || 99;
    if (ta !== tb) return ta - tb;
    return (num(a.rank_in_type) || 9999) - (num(b.rank_in_type) || 9999);
  });
  const first = sorted[0];
  const code = firstText(sorted, "product_code");
  const metrics = code && selectionMap.has(code) ? selectionMetrics(selectionMap.get(code)) : rivalMetrics(sorted);
  const dna = code ? dnaMap.get(code) || null : null;
  return {
    product_key: code ? "code:" + code : "name:" + (first.product_name || ""),
    product_code: code,
    product_name: firstText(sorted, "product_name"),
    category: firstText(sorted, "category"),
    tier_type: firstText(sorted, "tier_type"),
    tier_text: firstText(sorted, "tier_text"),
    is_med: sorted.some((r) => !!r.is_med),
    match_status: firstText(sorted, "match_status"),
    confidence: bestConfidence(sorted),
    our_status: firstText(sorted, "our_status"),
    is_hook: sorted.some((r) => !!r.is_hook),
    opp_type: typeOf(sorted),
    nearby_total_sales: metrics.nearby_total_sales,
    nearby_max_sales: metrics.nearby_max_sales,
    nearby_max_shop: metrics.nearby_max_shop,
    nearby_shop_count: metrics.nearby_shop_count,
    nearby_price: metrics.nearby_price,
    nearby_price_shop: metrics.nearby_price_shop,
    nearby_price_kind: metrics.nearby_price_kind,
    our_cur_stock: dna ? num(dna.cur_stock) : num(first.our_cur_stock),
    our_qty_180: dna ? num(dna.qty_180) : num(first.our_qty_180),
    restock_qty: dna ? num(dna.restock_qty) : null,
    restock_verdict: dna ? dna.restock_verdict || null : null,
    verdict_reason: dna ? dna.verdict_reason || null : null,
    source_rows: sorted.length,
    supplier: code ? supplierMap.get(code) || null : null,
    // 0926:操作按钮(补货/转新品/转复核)仍按原始「店+商品名」调 petstore-rival-opportunity-act
    act_shop: first.shop || null,
    act_name: first.product_name || null,
    act_rank: num(first.rank_in_type)
  };
}

export function build(rows, selectionRows = [], dnaRows = [], supplierRows = []) {
  const counts = {};
  const groups = {};
  for (const t of TYPES) {
    counts[t] = 0;
    groups[t] = [];
  }

  const selectionMap = new Map();
  for (const s of selectionRows) {
    if (!s.product_code) continue;
    const arr = selectionMap.get(s.product_code) || [];
    arr.push(s);
    selectionMap.set(s.product_code, arr);
  }

  const dnaMap = new Map(dnaRows.filter((r) => r.product_code).map((r) => [r.product_code, r]));
  const supplierMap = new Map(supplierRows.filter((r) => r.product_code && r.supplier).map((r) => [r.product_code, r.supplier]));
  const buckets = new Map();
  for (const raw of rows) {
    const r = normalizedRow(raw);
    const key = r.product_code ? "code:" + r.product_code : "name:" + (r.product_name || "");
    const arr = buckets.get(key) || [];
    arr.push(r);
    buckets.set(key, arr);
  }

  for (const rowsInBucket of buckets.values()) {
    const r = mergedRow(rowsInBucket, selectionMap, dnaMap, supplierMap);
    if (!groups[r.opp_type]) groups[r.opp_type] = [];
    groups[r.opp_type].push(r);
  }

  for (const t of TYPES) {
    groups[t].sort((a, b) => {
      if (!!a.is_hook !== !!b.is_hook) return a.is_hook ? 1 : -1;
      return (num(b.nearby_total_sales) || 0) - (num(a.nearby_total_sales) || 0);
    });
    counts[t] = groups[t].length;
  }
  return { ok: true, counts, groups };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") {
      if (!requireAuth(req, res)) return;
    }
    if (req.method !== "GET") {
      return json(res, 405, { ok: false, error: "method_not_allowed" });
    }

    const pool = getPool();
    const rows = await pool.query(ROW_SQL);
    const codes = uniq(rows.rows.map((r) => r.product_code));
    const [selection, dna, supplier] = codes.length ? await Promise.all([
      pool.query(SELECTION_SQL, [codes]),
      pool.query(DNA_SQL, [codes]),
      pool.query(SUPPLIER_SQL, [codes])
    ]) : [{ rows: [] }, { rows: [] }, { rows: [] }];
    return json(res, 200, build(rows.rows, selection.rows, dna.rows, supplier.rows));
  } catch (err) {
    console.error("[petstore-rival-opportunity]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
