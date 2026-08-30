import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// Sensitive fields returned for audit-gated callers: cost_price, supplier.
const ALL_COLUMNS = [
  "product_code", "barcode", "product_name", "category", "spec_text", "pic_url",
  "supplier", "own_brand", "is_locked_price", "lock_reason", "store_price",
  "mt_price", "ele_price", "cost_price", "price_status", "src_log_id",
  "market_price", "market_store", "market_sold", "market_spec",
  "market_captured_at", "market_quote_cnt", "market_valid_cnt",
  "market_excluded_cnt", "sales_1d", "sales_7d", "sales_30d", "sales_90d",
  "daily_avg_90", "cur_stock", "days_of_supply", "days_left", "last_sale_at",
  "problem_types", "pending_card_cnt", "restock_verdict", "restock_qty",
  "shelf_code", "shelf_missing", "expiry_flag", "sales_src", "stock_src",
  "product_status", "market_src_id", "as_of", "market_price_prev",
  "market_price_delta", "market_price_delta_pct", "market_days_unchanged",
];

function cleanText(value, max = 120) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function json(res, status, data) {
  return res.status(status).json(data);
}

async function getRow(req, res) {
  const productCode = cleanText(req.query?.product_code, 80);
  if (!productCode) return json(res, 400, { error: "product_code required" });

  const sql = `
    SELECT product_code, barcode, product_name, category, spec_text, pic_url,
           supplier, own_brand, is_locked_price, lock_reason, store_price,
           mt_price, ele_price, cost_price, price_status, src_log_id,
           market_price, market_store, market_sold, market_spec,
           market_captured_at, market_quote_cnt, market_valid_cnt,
           market_excluded_cnt, sales_1d, sales_7d, sales_30d, sales_90d,
           daily_avg_90, cur_stock, days_of_supply, days_left, last_sale_at,
           problem_types, pending_card_cnt, restock_verdict, restock_qty,
           shelf_code, shelf_missing, expiry_flag, sales_src, stock_src,
           product_status, market_src_id, as_of, market_price_prev,
           market_price_delta, market_price_delta_pct, market_days_unchanged
      FROM public.petstore_ops_row
     WHERE product_code = $1
     LIMIT 1`;
  const result = await getPool().query(sql, [productCode]);
  if (!result.rows[0]) return json(res, 404, { error: "not found" });
  return json(res, 200, { rows: result.rows, total: 1, page: 1, pageSize: 1 });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    return await getRow(req, res);
  } catch (err) {
    return json(res, 500, { ok: false, error: err.message || "server_error" });
  }
}

export const returnedColumns = ALL_COLUMNS;
