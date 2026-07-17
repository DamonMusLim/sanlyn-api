// /api/db/bb-overview.js - M5 巴匕总览: 全工厂库存 + 供应商报价 + 同款比价 + 异常看板. 仅内部.
import { getPool, setCors } from "./db.js";
import { extractUser } from "../auth.js";

function json(res, s, p) { return res.status(s).json(p); }
function clean(v, n = 80) { return String(v == null ? "" : v).trim().slice(0, n); }
function isInternal(req) { const r = clean(req.user?.role, 40).toLowerCase(); return r === "admin" || r === "sanlyn"; }
const nn = v => v == null ? null : Number(v);

async function factories(pool) {
  const q = await pool.query(`
    SELECT p.factory_code,
           COUNT(*)::int AS sku_count,
           COALESCE(SUM(fg.stock),0) AS stock_sum,
           COALESCE(SUM(GREATEST(fg.safety - fg.stock, 0)),0) AS gap_sum,
           COUNT(*) FILTER (WHERE fg.stock > 0)::int AS filled_skus
      FROM products p
 LEFT JOIN LATERAL (SELECT COALESCE(SUM(f.current_stock),0) AS stock, COALESCE(SUM(f.safety_stock),0) AS safety
                      FROM finished_goods_inventory f WHERE f.sku = p.sku) fg ON true
     WHERE p.factory_code IS NOT NULL AND p.sku IS NOT NULL AND COALESCE(p.active, true)
  GROUP BY p.factory_code ORDER BY sku_count DESC LIMIT 20`);
  const names = await pool.query(`SELECT company_code, company FROM accounts WHERE role='factory' AND COALESCE(is_active,true)`);
  const nm = Object.fromEntries(names.rows.map(r => [r.company_code, r.company]));
  return q.rows.map(r => ({ ...r, stock_sum: Number(r.stock_sum), gap_sum: Number(r.gap_sum), factory_name: nm[r.factory_code] || r.factory_code }));
}

async function suppliers(pool) {
  const q = await pool.query(`
    SELECT pm.supplier_code, COUNT(*)::int AS styles,
           COUNT(pm.price_ex_tax)::int AS priced,
           COUNT(NULLIF(pm.image_url,''))::int AS with_image
      FROM packaging_materials pm WHERE pm.supplier_code IS NOT NULL
  GROUP BY pm.supplier_code ORDER BY styles DESC`);
  const names = await pool.query(`SELECT code, name FROM suppliers`);
  const nm = Object.fromEntries(names.rows.map(r => [r.code, r.name]));
  return q.rows.map(r => ({ ...r, supplier_name: nm[r.supplier_code] || r.supplier_code }));
}

async function compare(pool) {
  const q = await pool.query(`
    SELECT LOWER(REGEXP_REPLACE(name, '\\s', '', 'g')) AS k, name, supplier_code, sku_code,
           price_ex_tax, tax_point, moq, lead_time_days, quote_valid_until::text AS valid_until
      FROM packaging_materials WHERE supplier_code IS NOT NULL`);
  const map = new Map();
  for (const r of q.rows) {
    if (!map.has(r.k)) map.set(r.k, { name: r.name, offers: [] });
    const ex = nn(r.price_ex_tax), pt = nn(r.tax_point);
    map.get(r.k).offers.push({
      supplier_code: r.supplier_code, sku_code: r.sku_code,
      price_ex_tax: ex, price_inc_tax: ex == null ? null : Math.round(ex * (1 + (pt || 0) / 100) * 10000) / 10000,
      moq: nn(r.moq), lead_time_days: nn(r.lead_time_days), valid_until: r.valid_until || "",
    });
  }
  return [...map.values()].filter(g => new Set(g.offers.map(o => o.supplier_code)).size >= 2)
    .map(g => {
      const priced = g.offers.filter(o => o.price_inc_tax != null);
      const best = priced.length ? Math.min(...priced.map(o => o.price_inc_tax)) : null;
      return { ...g, best_inc: best };
    }).sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

async function alerts(pool) {
  const links = await pool.query(`
    SELECT sl.code, sl.page, sl.hits, a.company, a.role FROM share_links sl JOIN accounts a ON a.id = sl.account_id
     WHERE NOT sl.revoked AND (sl.expires_at IS NULL OR sl.expires_at > NOW()) AND sl.hits = 0 ORDER BY sl.created_at DESC LIMIT 20`);
  const gaps = await pool.query(`
    SELECT f.sku, f.current_stock, f.safety_stock FROM finished_goods_inventory f
     WHERE f.safety_stock > 0 AND f.current_stock < f.safety_stock ORDER BY (f.safety_stock - f.current_stock) DESC LIMIT 20`);
  const expired = await pool.query(`
    SELECT sku_code, name, supplier_code, quote_valid_until::text AS d FROM packaging_materials
     WHERE quote_valid_until IS NOT NULL AND quote_valid_until < NOW()::date ORDER BY quote_valid_until LIMIT 20`);
  const diffs = await pool.query(`
    SELECT d.material_sku, d.order_qty, d.real_qty FROM inbound_deliveries d
     WHERE d.real_qty IS NOT NULL AND ABS(d.real_qty - d.order_qty) > 0.001 ORDER BY d.updated_at DESC LIMIT 20`);
  const unpriced = await pool.query(`
    SELECT supplier_code, COUNT(*)::int c FROM packaging_materials
     WHERE supplier_code IS NOT NULL AND price_ex_tax IS NULL GROUP BY supplier_code`);
  return {
    links_unopened: links.rows, stock_gaps: gaps.rows, quotes_expired: expired.rows,
    receipt_diffs: diffs.rows, unpriced: unpriced.rows,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user) extractUser(req);
  if (!req.user) return json(res, 401, { success: false, error: "Unauthorized" });
  if (!isInternal(req)) return json(res, 403, { success: false, error: "internal only" });
  if (req.method !== "GET") return json(res, 405, { success: false, error: "GET only" });
  const pool = getPool();
  try {
    const [f, s, c, a] = await Promise.all([factories(pool), suppliers(pool), compare(pool), alerts(pool)]);
    return json(res, 200, { success: true, factories: f, suppliers: s, compare: c, alerts: a });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message });
  }
}
