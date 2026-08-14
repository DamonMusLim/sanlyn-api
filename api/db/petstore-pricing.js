import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";
import { getDailySales, postStockNote } from "./petstore-pricing-sales.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

const TAB_SQL = {
  price: "problem_type IN ('below_cost','above_market')",
  expiry: "problem_type = 'expiry'",
  stale: "problem_type = 'stale_90d'",
  shelfless: "problem_type = 'no_shelf'",
  badname: "problem_type = 'badname'",
};

const ALLOWED_VERDICTS = ["合理", "跟市场", "我定价", "清仓", "驳回", "安排货位"];
const REJECT_REASONS = ["证据不足", "数据不准", "特殊品", "暂不处理"];

function json(res, code, data) {
  return res.status(code).json(data);
}

function addPricingCorsHeaders(res) {
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
  if (payload.username && bossUsers().includes(String(payload.username))) return true;

  const expected = process.env.PRICING_BOSS_TOKEN;
  const got = req.headers["x-pricing-boss"];
  if (got && expected && timingTokenMatches(got, expected)) return true;

  json(res, 403, { success: false, error: "boss_forbidden" });
  return false;
}

function normalizeTab(tab) {
  return TAB_SQL[tab] ? tab : "price";
}

function tabWhere(tab) {
  return TAB_SQL[normalizeTab(tab)];
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

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function audit(api, id, verdict, price) {
  console.info(JSON.stringify({
    ts: new Date().toISOString(),
    api,
    id,
    verdict: verdict || null,
    price: price ?? null,
  }));
}

async function getQueue(req, res) {
  const pool = getPool();
  const tab = normalizeTab(req.query?.tab);
  const chip = req.query?.chip || "pending";
  const limit = clampLimit(req.query?.limit);
  const offset = parseCursor(req.query?.cursor);

  const filters = [tabWhere(tab)];
  let statusSql = "exec_status = 'pending'";
  if (chip === "anomaly") statusSql = "exec_status = 'failed'";
  filters.push(statusSql);
  if (chip === "fresh") filters.push("mkt_captured_at >= now() - interval '2 days'");

  const highstockJoin = chip === "highstock" ? `, cutoff AS (
    SELECT percentile_cont(0.8) WITHIN GROUP (
      ORDER BY COALESCE(stock_qty,0) * COALESCE(cost_price,0)
    ) AS min_value
    FROM latest
  )` : "";
  const highstockFrom = chip === "highstock" ? ", cutoff c" : "";
  const highstockFilter = chip === "highstock"
    ? "AND COALESCE(l.stock_qty,0) * COALESCE(l.cost_price,0) >= COALESCE(c.min_value,0)"
    : "";

  const orderSql = tab === "expiry"
    ? "COALESCE(l.days_left, 999999) ASC, COALESCE(l.stock_qty,0) * COALESCE(l.cost_price,0) DESC"
    : tab === "stale"
      ? "COALESCE(l.stock_qty,0) * COALESCE(l.cost_price,0) DESC, l.ts DESC"
      : "ABS(COALESCE(l.new_price,0) - COALESCE(l.old_price,0)) * COALESCE(l.stock_qty,0) DESC, l.ts DESC";

  const sql = `
    WITH ranked AS (
      SELECT *,
        row_number() OVER (
          PARTITION BY product_code
          ORDER BY ts DESC, id DESC
        ) AS rn
      FROM petstore_pricing_log
      WHERE ${filters.join(" AND ")}
    ),
    latest AS (
      SELECT * FROM ranked WHERE rn = 1
    )
    ${highstockJoin}
    SELECT
      l.id, l.ts, l.log_date, l.store_code, l.channel, l.product_code,
      l.product_name, l.pic_url, l.old_price, l.new_price, l.rate, l.reason, l.result,
      l.days_left, l.tier, l.source_hash, l.synced_at,
      l.mkt_price, l.mt_price, l.ele_price, l.mkt_store, l.mkt_sold, l.mkt_total_sold,
      l.mkt_n_stores, l.mkt_matched_title, l.mkt_conf, l.mkt_captured_at,
      l.cost_price, l.stock_qty, l.qty_90, l.expiry_flag, l.problem_type,
      l.damon_verdict, l.damon_price, l.damon_reason, l.confirmed_at,
      l.exec_status, l.executed_at, l.readback_ok, l.idem_key,
      l.sales_7d_after, l.sales_30d_after, l.barcode
    FROM latest l ${highstockFrom}
    WHERE true ${highstockFilter}
    ORDER BY ${orderSql}
    LIMIT $1 OFFSET $2
  `;

  const { rows } = await pool.query(sql, [limit, offset]);
  const codes = rows.map((r) => r.product_code).filter(Boolean);

  let quotesByCode = {};
  if (codes.length) {
    const quotes = await pool.query(`
      SELECT
        product_code, store_name, source, source_tier, matched_title, spec_text,
        price, orig_price, monthly_sales, match_conf, captured_at
      FROM (
        SELECT
          q.product_code, q.store_name, q.source, q.source_tier, q.matched_title,
          q.spec_text, q.price, q.orig_price, q.monthly_sales, q.match_conf,
          q.captured_at,
          row_number() OVER (
            PARTITION BY q.product_code
            ORDER BY COALESCE(q.monthly_sales,0) DESC, q.captured_at DESC
          ) AS rn
        FROM petstore_market_quotes q
        WHERE q.product_code = ANY($1)
          AND q.captured_at >= now() - interval '14 days'
      ) t
      WHERE rn <= 8
      ORDER BY product_code, COALESCE(monthly_sales,0) DESC, captured_at DESC
    `, [codes]);

    quotesByCode = quotes.rows.reduce((acc, q) => {
      const { product_code: code, ...quote } = q;
      if (!acc[code]) acc[code] = [];
      acc[code].push(quote);
      return acc;
    }, {});
  }

  return json(res, 200, {
    success: true,
    tab,
    chip,
    limit,
    cursor: offset,
    next_cursor: rows.length === limit ? String(offset + limit) : null,
    rows: rows.map((row) => ({ ...row, quotes: quotesByCode[row.product_code] || [] })),
  });
}

async function getStats(req, res) {
  const { rows } = await getPool().query(`
    SELECT
      CASE
        WHEN problem_type IN ('below_cost','above_market') THEN 'price'
        WHEN problem_type = 'expiry' THEN 'expiry'
        WHEN problem_type = 'stale_90d' THEN 'stale'
        WHEN problem_type = 'no_shelf' THEN 'shelfless'
        WHEN problem_type = 'badname' THEN 'badname'
        ELSE 'other'
      END AS tab,
      count(*) FILTER (WHERE exec_status = 'pending')::int AS pending,
      count(*) FILTER (
        WHERE exec_status IN ('approved','rejected')
          AND confirmed_at::date = current_date
      )::int AS done_today,
      count(*) FILTER (WHERE exec_status = 'failed')::int AS failed
    FROM petstore_pricing_log
    GROUP BY 1
  `);
  return json(res, 200, { success: true, rows });
}

async function postVerdict(req, res, bodyArg) {
  const body = bodyArg || await readBody(req);
  const id = Number.parseInt(body.id, 10);
  const verdict = String(body.verdict || "").trim();
  const reason = body.reason ? String(body.reason).trim() : null;
  const price = body.price === "" || body.price == null ? null : Number(body.price);

  if (!id || !ALLOWED_VERDICTS.includes(verdict)) {
    return json(res, 400, { success: false, error: "bad_request" });
  }
  if (verdict === "我定价" && (!Number.isFinite(price) || price < 0)) {
    return json(res, 400, { success: false, error: "price_required" });
  }
  if (verdict === "驳回" && !REJECT_REASONS.includes(reason)) {
    return json(res, 400, { success: false, error: "reject_reason_required" });
  }

  const pool = getPool();
  const current = await pool.query(
    "SELECT id, confirmed_at, exec_status FROM petstore_pricing_log WHERE id=$1",
    [id],
  );
  if (!current.rowCount) return json(res, 404, { success: false, error: "not_found" });
  if (current.rows[0].confirmed_at) {
    return json(res, 409, { success: false, error: "already_confirmed", row: current.rows[0] });
  }

  const status = verdict === "驳回" ? "rejected" : "approved";
  const result = await pool.query(`
    UPDATE petstore_pricing_log
    SET damon_verdict=$2,
        damon_price=$3,
        damon_reason=$4,
        confirmed_at=now(),
        exec_status=$5
    WHERE id=$1 AND confirmed_at IS NULL
    RETURNING *
  `, [id, verdict, price, reason, status]);

  audit("/api/db/petstore-pricing", id, verdict, price);
  return json(res, 200, { success: true, row: result.rows[0] });
}

async function postUndo(req, res, bodyArg) {
  const body = bodyArg || await readBody(req);
  const id = Number.parseInt(body.id, 10);
  if (!id) return json(res, 400, { success: false, error: "bad_request" });

  const result = await getPool().query(`
    UPDATE petstore_pricing_log
    SET exec_status='pending',
        confirmed_at=NULL,
        damon_reason=concat_ws(' ', damon_reason, '[撤回 ' || to_char(now(), 'YYYY-MM-DD HH24:MI:SS') || ']')
    WHERE id=$1
      AND exec_status='approved'
      AND executed_at IS NULL
    RETURNING *
  `, [id]);

  if (!result.rows.length) return json(res, 409, { success: false, error: "cannot_undo" });

  audit("/api/db/petstore-pricing", id, "undo", null);
  return json(res, 200, { success: true, row: result.rows[0] });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  addPricingCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!requireAuth(req, res)) return;
  if (!requireBoss(req, res)) return;

  try {
    const body = req.method === "POST" ? await readBody(req) : null;
    const action = req.method === "GET" ? req.query?.action : body?.action;
    if (req.method === "GET" && action === "queue") return getQueue(req, res);
    if (req.method === "GET" && action === "stats") return getStats(req, res);
    if (req.method === "GET" && action === "daily_sales") return getDailySales(req, res);
    if (req.method === "POST" && action === "verdict") return postVerdict(req, res, body);
    if (req.method === "POST" && action === "undo") return postUndo(req, res, body);
    if (req.method === "POST" && action === "stock_note") return postStockNote(req, res, body);
    return json(res, 400, { success: false, error: "bad_action" });
  } catch (e) {
    return json(res, 500, { success: false, error: e.message || "server_error" });
  }
}
