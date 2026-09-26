import { getPool, setCors } from "../db.js";

const ROWS_SQL = `
SELECT product_code, our_name, spec_text, total_sales, shop_count, max_sales, max_shop,
       eff_min_price, eff_min_shop, raw_min_price, our_store_price, our_mt_price,
       qty_180, cur_stock, monthly_demand, our_ele_price
  FROM public.v_selection_rows
 ORDER BY total_sales DESC NULLS LAST, product_code`;

const SHOPS_SQL = `
SELECT product_code, shop, source, monthly_sales, price, orig_price, is_first_price,
       delivery_min, distance, shop_month_sales, captured_at, eta_min
  FROM public.v_selection_shop
 WHERE product_code = ANY($1::text[])
 ORDER BY product_code, monthly_sales DESC NULLS LAST, captured_at DESC NULLS LAST`;

const COST_SQL = `
WITH ops AS (
  SELECT DISTINCT ON (product_code) product_code, cost_price::numeric AS cost_price, NULLIF(pic_url, '') AS pic_url
    FROM public.petstore_ops_row
   WHERE product_code = ANY($1::text[])
   ORDER BY product_code, (NULLIF(pic_url, '') IS NULL), pic_url
)
SELECT c.product_code,
       COALESCE(o.cost, ops.cost_price) AS cost,
       ops.pic_url
  FROM unnest($1::text[]) AS c(product_code)
  LEFT JOIN ops ON ops.product_code = c.product_code
  LEFT JOIN public.petstore_cost_override o ON o.product_code = c.product_code`;

function json(res, code, body) {
  return res.status(code).json(body);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function div(a, b) {
  a = num(a);
  b = num(b);
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

function moneyDiff(a, b) {
  a = num(a);
  b = num(b);
  if (a === null || b === null) return null;
  return a - b;
}

function ceilNeed(monthlyDemand, curStock) {
  monthlyDemand = num(monthlyDemand);
  curStock = num(curStock);
  if (monthlyDemand === null || curStock === null) return null;
  return Math.ceil(monthlyDemand * 1.5) - curStock;
}

function gradeOf(r, cost, unitProfit, unitProfitMt, margin) {
  const eff = num(r.eff_min_price);
  if (cost === null || cost <= 0.2 || eff === null || cost > eff * 3) return "待核";
  if (unitProfitMt !== null && unitProfitMt < 0) return "3";
  if (margin !== null && margin < 0.05) return "3";
  if (num(r.total_sales) >= 50 && unitProfit !== null && unitProfit >= 2 && margin !== null && margin >= 0.15) return "1";
  if (num(r.qty_180) >= 50) return "1";
  return "2";
}

function kindOf(r, unitProfit, margin) {
  if (num(r.max_sales) >= 50 && (unitProfit === null || unitProfit < 2 || margin === null || margin < 0.15)) return "流量款";
  if (margin !== null && margin >= 0.20 && unitProfit !== null && unitProfit >= 2) return "利润款";
  return "普通";
}

function adviceOf(r, grade) {
  const stock = num(r.cur_stock);
  const qty = num(r.qty_180);
  if (grade === "待核") return "先核数据";
  if (grade === "3") return "不跟价,核进价";
  if (stock === null) return "库存待盘";
  if (qty === 0 && stock <= 0 && grade === "1") return "试销2";
  const need = ceilNeed(r.monthly_demand, stock);
  if (need !== null && need > 0 && (grade === "1" || grade === "2")) return "进" + need;
  return "不补";
}

function gapsOf(r, cost, shops) {
  const gaps = [];
  const eff = num(r.eff_min_price);
  if (cost === null || cost <= 0.2 || (eff !== null && cost > eff * 3)) gaps.push("成本缺失或异常");
  if (eff === null) gaps.push("无有效最低价");
  if (num(r.cur_stock) === null) gaps.push("库存为负/未知");
  if (!shops.some((s) => num(s.delivery_min) !== null)) gaps.push("起送价缺失");
  if (num(r.our_mt_price) === null) gaps.push("我方美团价缺失");
  if (num(r.our_ele_price) === null) gaps.push("我方饿了么价缺失");
  return gaps;
}

function shopKind(s, estMargin) {
  if (s.is_first_price || (estMargin !== null && estMargin < 0.05)) return "流量款";
  if (estMargin !== null && estMargin >= 0.20) return "利润款";
  return "普通";
}

function build(rows, shops, costs) {
  const byShop = new Map();
  for (const s of shops) {
    const arr = byShop.get(s.product_code) || [];
    arr.push(s);
    byShop.set(s.product_code, arr);
  }

  const costMap = new Map(costs.map((r) => [r.product_code, num(r.cost)]));
  const picMap = new Map(costs.map((r) => [r.product_code, r.pic_url || null]));
  const counts = { grade1: 0, grade2: 0, grade3: 0, pending: 0 };

  const out = rows.map((r) => {
    const cost = costMap.has(r.product_code) ? costMap.get(r.product_code) : null;
    const eff = num(r.eff_min_price);
    const unitProfit = moneyDiff(eff, cost);
    const unitProfitMt = eff === null || cost === null ? null : eff * 0.95 - cost;
    const margin = div(unitProfit, eff);
    const grade = gradeOf(r, cost, unitProfit, unitProfitMt, margin);
    const kind = kindOf(r, unitProfit, margin);
    const rowShops = (byShop.get(r.product_code) || []).map((s) => {
      const price = num(s.price);
      const estMargin = price === null || price === 0 || cost === null ? null : (price * 0.95 - cost) / price;
      return {
        shop: s.shop,
        source: s.source,
        monthly_sales: num(s.monthly_sales),
        price,
        orig_price: num(s.orig_price),
        is_first_price: !!s.is_first_price,
        delivery_min: num(s.delivery_min),
        eta_min: num(s.eta_min),
        distance: s.distance || null,
        shop_month_sales: s.shop_month_sales || null,
        captured_at: s.captured_at,
        est_margin: estMargin,
        // 0915 Damon:爪壮壮蓝氏波波1.99是单条价——远低于有效最低价的,标疑似单件/小规格
        small_unit: eff !== null && price !== null && price < eff * 0.4,
        shop_kind: shopKind(s, estMargin)
      };
    });

    if (grade === "1") counts.grade1 += 1;
    else if (grade === "2") counts.grade2 += 1;
    else if (grade === "3") counts.grade3 += 1;
    else counts.pending += 1;

    return {
      product_code: r.product_code,
      our_name: r.our_name || null,
      spec_text: r.spec_text || null,
      total_sales: num(r.total_sales),
      shop_count: num(r.shop_count),
      max_sales: num(r.max_sales),
      max_shop: r.max_shop || null,
      eff_min_price: eff,
      eff_min_shop: r.eff_min_shop || null,
      raw_min_price: num(r.raw_min_price),
      our_store_price: num(r.our_store_price),
      our_mt_price: num(r.our_mt_price),
      qty_180: num(r.qty_180),
      cur_stock: num(r.cur_stock),
      monthly_demand: num(r.monthly_demand),
      pic_url: picMap.get(r.product_code) || null,
      cost,
      unit_profit: unitProfit,
      unit_profit_mt: unitProfitMt,
      margin,
      grade,
      kind,
      advice: adviceOf(r, grade),
      shops: rowShops,
      ours: {
        our_store_price: num(r.our_store_price),
        our_mt_price: num(r.our_mt_price),
        our_ele_price: num(r.our_ele_price),
        cost,
        qty_180: num(r.qty_180),
        cur_stock: num(r.cur_stock),
        store_margin: div(moneyDiff(r.our_store_price, cost), r.our_store_price),
        mt_margin: num(r.our_mt_price) === null || cost === null ? null : (num(r.our_mt_price) * 0.95 - cost) / num(r.our_mt_price),
        ele_margin: num(r.our_ele_price) === null || cost === null ? null : (num(r.our_ele_price) * 0.95 - cost) / num(r.our_ele_price)
      },
      gaps: gapsOf(r, cost, rowShops)
    };
  });

  return { ok: true, generated_at: new Date().toISOString(), rows: out, counts };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") {
    return json(res, 403, { ok: false, error: "forbidden" });
  }
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

  try {
    const pool = getPool();
    const rows = await pool.query(ROWS_SQL);
    const codes = rows.rows.map((r) => r.product_code).filter(Boolean);
    const [shops, costs] = await Promise.all([
      pool.query(SHOPS_SQL, [codes]),
      pool.query(COST_SQL, [codes])
    ]);
    return json(res, 200, build(rows.rows, shops.rows, costs.rows));
  } catch (err) {
    console.error("[petstore-selection-table]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
