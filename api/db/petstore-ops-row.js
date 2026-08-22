import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

const BASE_COLS = [
  "product_code", "barcode", "product_name", "category", "spec_text",
  "pic_url", "supplier", "own_brand", "is_locked_price", "lock_reason",
];

const REF_COLS = ["sales_src", "stock_src", "market_src_id", "as_of"];

const VIEW_COLS = {
  pricing: [
    ...BASE_COLS,
    "store_price", "mt_price", "ele_price", "cost_price", "price_status", "src_log_id",
    "market_price", "market_store", "market_sold", "market_spec", "market_captured_at",
    "market_quote_cnt", "market_valid_cnt", "market_excluded_cnt",
    "sales_1d", "sales_7d", "sales_30d", "sales_90d", "daily_avg_90",
    "cur_stock", "problem_types",
  ],
  restock: [
    ...BASE_COLS,
    "cur_stock", "sales_1d", "sales_7d", "sales_30d", "sales_90d",
    "daily_avg_90", "days_of_supply", "restock_verdict", "restock_qty",
    "supplier", "market_price",
  ],
  expiry: [
    ...BASE_COLS,
    "days_left", "expiry_flag", "cur_stock", "sales_1d", "sales_7d",
    "sales_30d", "sales_90d", "daily_avg_90", "store_price",
  ],
  shelfless: [
    ...BASE_COLS,
    "shelf_code", "cur_stock", "sales_1d", "sales_7d", "sales_30d",
    "sales_90d", "daily_avg_90",
  ],
  badname: [
    ...BASE_COLS,
    "product_name", "spec_text", "barcode",
  ],
  daily: [
    ...BASE_COLS,
    "sales_1d", "cur_stock", "sales_7d", "sales_30d", "sales_90d", "daily_avg_90",
  ],
};

const ORDER_SQL = {
  pricing: "ABS(COALESCE(store_price,0) - COALESCE(market_price,0)) * COALESCE(cur_stock,0) DESC NULLS LAST, product_code",
  restock: "GREATEST(0, 7 - COALESCE(days_of_supply, 999999)) * COALESCE(daily_avg_90,0) * COALESCE(store_price,0) DESC NULLS LAST, product_code",
  expiry: "days_left ASC NULLS LAST, product_code",
  shelfless: "COALESCE(cur_stock,0) * COALESCE(cost_price,0) DESC NULLS LAST, product_code",
  badname: "COALESCE(cur_stock,0) * COALESCE(cost_price,0) DESC NULLS LAST, product_code",
  daily: "COALESCE(cur_stock,0) * COALESCE(cost_price,0) DESC NULLS LAST, product_code",
};

function json(res, code, data) {
  return res.status(code).json(data);
}

function addOpsCorsHeaders(res) {
  const old = String(res.getHeader("Access-Control-Allow-Headers") || "Content-Type, Authorization");
  const needed = ["Content-Type", "Authorization", "X-Pricing-Boss", "X-Clerk-Session"];
  const merged = Array.from(new Set([...old.split(",").map((s) => s.trim()).filter(Boolean), ...needed]));
  res.setHeader("Access-Control-Allow-Headers", merged.join(", "));
}

function timingTokenMatches(input, expected) {
  if (typeof input !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function decodeJwtPayload(req) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : auth;
  const payloadPart = token.split(".")[1];
  if (!payloadPart) return {};
  try {
    const padded = payloadPart.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(payloadPart.length / 4) * 4, "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch (e) {
    return {};
  }
}

function bossUsers() {
  return String(process.env.PRICING_BOSS_USERS || "damon_sl")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function requireBoss(req, res) {
  if (req.headers["x-clerk-session"]) {
    json(res, 403, { success: false, error: "clerk_forbidden" });
    return false;
  }

  const payload = decodeJwtPayload(req);
  // 0822:员工端 token 载荷是 {role,employee_id,name},没有 username;
  //      老板从员工端进来只有 name(Damon id=35 manager)。两字段都认,大小写不敏感。
  const who = String(payload.username || payload.name || "").trim().toLowerCase();
  if (who && bossUsers().includes(who)) return true;

  const expected = process.env.PRICING_BOSS_TOKEN;
  const got = req.headers["x-pricing-boss"];
  if (got && expected && timingTokenMatches(got, expected)) return true;

  json(res, 403, { success: false, error: "boss_forbidden" });
  return false;
}

function normalizeView(value) {
  return VIEW_COLS[value] ? value : "pricing";
}

function clampLimit(value) {
  const n = Number.parseInt(value || "", 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseCursor(value) {
  const n = Number.parseInt(value || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function uniqueCols(cols) {
  return Array.from(new Set(cols));
}

function expiryRank(flag) {
  if (flag === "过期") return 0;
  if (flag === "临期") return 1;
  if (flag === "清仓") return 2;
  return 3;
}

function shapeRow(row) {
  const refs = {
    sales_src: row.sales_src,
    stock_src: row.stock_src,
    market_src_id: row.market_src_id,
    as_of: row.as_of,
  };
  const clean = { ...row, refs };
  for (const col of REF_COLS) delete clean[col];
  if (Object.prototype.hasOwnProperty.call(clean, "expiry_flag")) {
    clean.expiry_rank = expiryRank(clean.expiry_flag);
  }
  return clean;
}

async function getOpsRows(req, res) {
  const view = normalizeView(req.query?.view);
  const limit = clampLimit(req.query?.limit);
  const offset = parseCursor(req.query?.cursor);
  const q = String(req.query?.q || "").trim();

  const cols = uniqueCols([...VIEW_COLS[view], ...REF_COLS]);
  const selectSql = cols.map((c) => `"${c}"`).join(", ");

  const params = [];
  const filters = [];

  if (q) {
    params.push(`%${q}%`);
    filters.push(`(
      product_code ILIKE $${params.length}
      OR barcode ILIKE $${params.length}
      OR product_name ILIKE $${params.length}
    )`);
  }

  if (view === "restock") {
    filters.push("(restock_verdict IS NOT NULL OR COALESCE(restock_qty,0) > 0)");
  } else if (view === "expiry") {
    filters.push("(expiry_flag IS NOT NULL OR days_left IS NOT NULL)");
  } else if (view === "shelfless") {
    filters.push("(shelf_missing = true AND COALESCE(cur_stock,0) > 0)");
  } else if (view === "badname") {
    filters.push("'badname' = ANY(problem_types)");
  }

  params.push(limit);
  const limitPos = params.length;
  params.push(offset);
  const offsetPos = params.length;

  const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const sql = `
    SELECT ${selectSql}
    FROM petstore_ops_row
    ${whereSql}
    ORDER BY ${ORDER_SQL[view]}
    LIMIT $${limitPos} OFFSET $${offsetPos}
  `;

  const { rows } = await getPool().query(sql, params);

  return json(res, 200, {
    success: true,
    view,
    limit,
    cursor: offset,
    next_cursor: rows.length === limit ? String(offset + limit) : null,
    rows: rows.map(shapeRow),
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  addOpsCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (!requireBoss(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { success: false, error: "method_not_allowed" });
    return getOpsRows(req, res);
  } catch (e) {
    return json(res, 500, { success: false, error: e.message || "server_error" });
  }
}
