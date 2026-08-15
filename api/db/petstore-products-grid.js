import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function json(res, code, data) {
  return res.status(code).json(data);
}

function addBossCorsHeaders(res) {
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
  } catch {
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

function clampLimit(value) {
  const n = Number.parseInt(value || "", 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

function parseCursor(value) {
  const n = Number.parseInt(value || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function textParam(value, max = 120) {
  const s = String(value || "").trim();
  return s ? s.slice(0, max) : null;
}

function safeIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function getColumns(pool, table) {
  const { rows } = await pool.query(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = ANY (current_schemas(false))
      AND table_name = $1
  `, [table]);
  return new Set(rows.map((r) => r.column_name));
}

async function selectJsonByProduct(pool, table, productCode, opts = {}) {
  const cols = await getColumns(pool, table);
  if (!cols.has("product_code")) return [];
  const dateCol = ["ts", "created_at", "captured_at", "effective_at", "log_date", "note_date", "as_of"]
    .find((c) => cols.has(c));
  const orderCol = dateCol || "product_code";
  const where = [`product_code=$1`];
  const params = [productCode];

  if (opts.days && dateCol) {
    params.push(opts.days);
    where.push(`${safeIdent(dateCol)} >= now() - ($${params.length}::int || ' days')::interval`);
  }

  const limit = Number.isFinite(opts.limit) ? opts.limit : 200;
  params.push(limit);

  const { rows } = await pool.query(`
    SELECT to_jsonb(t) AS row
    FROM ${safeIdent(table)} t
    WHERE ${where.join(" AND ")}
    ORDER BY ${safeIdent(orderCol)} DESC NULLS LAST
    LIMIT $${params.length}
  `, params);
  return rows.map((r) => r.row);
}

function chineseExcludeReason(reason) {
  const s = String(reason || "").trim();
  const dict = {
    no_barcode: "条码不一致",
    bad_match: "匹配不可靠",
    far_price: "价格偏离太大",
    stale: "报价太旧",
    spec_mismatch: "规格不一致",
    duplicate: "重复报价",
  };
  return dict[s] || s || "未写排除原因";
}

async function getDetail(req, res) {
  const productCode = textParam(req.query?.product_code, 80);
  if (!productCode) return json(res, 400, { ok: false, error: "product_code_required" });

  const pool = getPool();
  const [
    validQuotes,
    marketQuotes,
    ourPriceHistory,
    marketHistory,
    problems,
    stockLedger,
    stockNotes,
  ] = await Promise.all([
    selectJsonByProduct(pool, "petstore_valid_quotes", productCode, { limit: 200 }),
    selectJsonByProduct(pool, "petstore_market_quotes", productCode, { limit: 300 }),
    selectJsonByProduct(pool, "petstore_price_history", productCode, { days: 90, limit: 300 }),
    selectJsonByProduct(pool, "petstore_market_quote_history", productCode, { days: 90, limit: 300 }),
    selectJsonByProduct(pool, "petstore_pricing_log", productCode, { limit: 300 }),
    selectJsonByProduct(pool, "petstore_stock_ledger", productCode, { limit: 300 }),
    selectJsonByProduct(pool, "petstore_stock_notes", productCode, { limit: 300 }),
  ]);

  return json(res, 200, {
    ok: true,
    product_code: productCode,
    quotes: {
      valid: validQuotes.map((r) => ({ ...r, quote_group: "有效报价" })),
      excluded: marketQuotes
        .filter((r) => r.exclude_reason)
        .map((r) => ({ ...r, quote_group: "被排除报价", exclude_reason_cn: chineseExcludeReason(r.exclude_reason) })),
    },
    price_history: [
      ...ourPriceHistory.map((r) => ({ ...r, history_group: "我方生效价" })),
      ...marketHistory.map((r) => ({ ...r, history_group: "竞店日聚合" })),
    ],
    problems: problems.map((r) => ({
      ...r,
      problem_group: "问题卡",
      boss_verdict: r.damon_verdict || "",
      exec_result: r.result || r.exec_status || "",
    })),
    stock_notes: [
      ...stockLedger.map((r) => ({ ...r, note_group: "库存变动", reason_missing: false })),
      ...stockNotes.map((r) => ({
        ...r,
        note_group: "库存原因",
        reason_missing: !(r.reason || r.note || r.memo || r.remark),
      })),
    ],
  });
}

function buildFilters(query) {
  const filters = [];
  const params = [];

  const push = (sql, value) => {
    params.push(value);
    filters.push(sql.replace("?", `$${params.length}`));
  };

  const q = textParam(query.q);
  if (q) push("(product_name ILIKE ? OR product_code ILIKE ? OR barcode ILIKE ?)", `%${q}%`);
  if (q) {
    params.push(`%${q}%`, `%${q}%`);
    filters[filters.length - 1] = `(product_name ILIKE $${params.length - 2} OR product_code ILIKE $${params.length - 1} OR barcode ILIKE $${params.length})`;
  }

  const brand = textParam(query.brand);
  if (brand) push("brand_final = ?", brand);

  const series = textParam(query.series);
  if (series) push("series ILIKE ?", `%${series}%`);

  const expiry = textParam(query.expiry, 20);
  if (expiry === "any") filters.push("expiry_flag IS NOT NULL");
  else if (["过期", "临期", "清仓"].includes(expiry)) push("expiry_flag = ?", expiry);

  const nearby = textParam(query.nearby, 20);
  if (nearby === "has") filters.push("market_price IS NOT NULL");
  if (nearby === "none") filters.push("market_price IS NULL");

  const problem = textParam(query.problem, 80);
  if (problem === "any") filters.push("cardinality(COALESCE(problem_types, ARRAY[]::text[])) > 0");
  else if (problem === "none") filters.push("cardinality(COALESCE(problem_types, ARRAY[]::text[])) = 0");
  else if (problem) push("? = ANY(COALESCE(problem_types, ARRAY[]::text[]))", problem);

  return { where: filters.length ? `WHERE ${filters.join(" AND ")}` : "", params };
}

function orderSql(sort) {
  return {
    stock_value: "COALESCE(cur_stock,0) * COALESCE(cost_price,0) DESC NULLS LAST, product_code",
    sales: "sales_90d DESC NULLS LAST, sales_30d DESC NULLS LAST, product_code",
    price_gap: "ABS(COALESCE(store_price,0) - COALESCE(market_price,0)) DESC NULLS LAST, product_code",
    days_left: "days_left ASC NULLS LAST, product_code",
  }[sort] || "product_code";
}

async function getList(req, res) {
  const limit = clampLimit(req.query?.limit);
  const offset = parseCursor(req.query?.cursor);
  const { where, params } = buildFilters(req.query || {});
  const sort = orderSql(textParam(req.query?.sort, 40));
  params.push(limit, offset);

  const { rows } = await getPool().query(`
    WITH base AS (
      SELECT
        o.*,
        s.pet_type, s.shelf_life_days, s.expire_date_batch,
        s.compliance_status, s.shelf_location,
        NULLIF(s.brand, '') AS supp_brand,
        CASE
          WHEN NULLIF(s.brand, '') IS NOT NULL THEN NULL
          WHEN o.product_name ~ '^[[:alnum:]][[:alnum:]&+._-]+' THEN substring(o.product_name FROM '^([[:alnum:]][[:alnum:]&+._-]+)')
          WHEN o.product_name ~ '^[一-龥]{2,8}(牌|宠物|猫砂|猫粮|狗粮|冻干|罐头)' THEN substring(o.product_name FROM '^([一-龥]{2,8}(?:牌|宠物|猫砂|猫粮|狗粮|冻干|罐头))')
          ELSE NULLIF(split_part(o.product_name, ' ', 1), o.product_name)
        END AS raw_brand_guess
      FROM petstore_ops_row o
      LEFT JOIN petstore_sku_supp s ON s.product_code = o.product_code
    ),
    branded AS (
      SELECT
        *,
        COALESCE(supp_brand, raw_brand_guess) AS brand_final,
        raw_brand_guess AS brand_guess,
        CASE WHEN supp_brand IS NOT NULL THEN 'supp' WHEN raw_brand_guess IS NOT NULL THEN 'guess' ELSE NULL END AS brand_src
      FROM base
    ),
    tailed AS (
      SELECT *,
        btrim(CASE
          WHEN brand_final IS NOT NULL AND product_name LIKE brand_final || '%' THEN substr(product_name, char_length(brand_final) + 1)
          ELSE product_name
        END) AS name_tail
      FROM branded
    ),
    final_rows AS (
      SELECT *,
        NULLIF(btrim(CASE
          WHEN spec_text IS NOT NULL AND name_tail LIKE '%' || spec_text THEN substr(name_tail, 1, greatest(char_length(name_tail) - char_length(spec_text), 0))
          ELSE name_tail
        END), '') AS series,
        CASE
          WHEN product_name IS NULL THEN NULL
          WHEN brand_final IS NOT NULL OR spec_text IS NOT NULL THEN 'guess'
          ELSE NULL
        END AS series_src
      FROM tailed
    )
    SELECT
      product_code, barcode, product_name, category, spec_text, pic_url, supplier,
      own_brand, is_locked_price, lock_reason,
      round(store_price::numeric, 2) AS store_price,
      round(mt_price::numeric, 2) AS mt_price,
      round(ele_price::numeric, 2) AS ele_price,
      round(cost_price::numeric, 2) AS cost_price,
      price_status, src_log_id,
      round(market_price::numeric, 2) AS market_price,
      market_store, market_sold, market_spec, market_captured_at,
      market_quote_cnt, market_valid_cnt, market_excluded_cnt,
      sales_1d, sales_7d, sales_30d, sales_90d, daily_avg_90,
      cur_stock, days_of_supply, days_left, last_sale_at,
      problem_types, pending_card_cnt, restock_verdict, restock_qty,
      shelf_code, shelf_missing, expiry_flag, sales_src, stock_src,
      market_src_id, as_of,
      pet_type, shelf_life_days, expire_date_batch, compliance_status, shelf_location,
      brand_final, brand_guess, brand_src, series, series_src,
      ARRAY[]::jsonb[] AS items
    FROM final_rows
    ${where}
    ORDER BY ${sort}
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  return json(res, 200, {
    ok: true,
    rows,
    data: rows,
    limit,
    cursor: offset,
    next_cursor: rows.length === limit ? String(offset + limit) : null,
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  addBossCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (!requireBoss(req, res)) return;
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    if (req.query?.action === "detail") return getDetail(req, res);
    return getList(req, res);
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || "server_error" });
  }
}
