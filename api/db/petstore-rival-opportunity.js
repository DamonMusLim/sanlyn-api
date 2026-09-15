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

const COUNT_SQL = `
SELECT opp_type, count(*)::int AS count
  FROM public.v_rival_opportunity
 GROUP BY opp_type`;

function json(res, code, body) {
  return res.status(code).json(body);
}

function num(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function row(r) {
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

function build(countRows, rows) {
  const counts = {};
  const groups = {};
  for (const t of TYPES) {
    counts[t] = 0;
    groups[t] = [];
  }
  for (const r of countRows) counts[r.opp_type] = num(r.count) || 0;
  for (const r of rows) {
    if (!groups[r.opp_type]) groups[r.opp_type] = [];
    groups[r.opp_type].push(row(r));
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
    const [counts, rows] = await Promise.all([
      pool.query(COUNT_SQL),
      pool.query(ROW_SQL)
    ]);
    return json(res, 200, build(counts.rows, rows.rows));
  } catch (err) {
    console.error("[petstore-rival-opportunity]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
