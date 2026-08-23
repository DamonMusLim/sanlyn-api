import crypto from "crypto";
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

function json(res, code, data) { return res.status(code).json(data); }

function addBossCorsHeaders(res) {
  const old = String(res.getHeader("Access-Control-Allow-Headers") || "Content-Type, Authorization");
  const needed = ["Content-Type", "Authorization", "X-Pricing-Boss", "X-Clerk-Session"];
  res.setHeader("Access-Control-Allow-Headers", Array.from(new Set([...old.split(",").map((s) => s.trim()).filter(Boolean), ...needed])).join(", "));
}

function timingTokenMatches(input, expected) {
  if (typeof input !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

function bossUsers() { return String(process.env.PRICING_BOSS_USERS || "damon_sl").split(",").map((s) => s.trim()).filter(Boolean); }

function requireBoss(req, res) {
  if (req.headers["x-clerk-session"]) {
    json(res, 403, { success: false, error: "clerk_forbidden" });
    return false;
  }

  const payload = decodeJwtPayload(req);
  const who = String(payload.username || payload.name || "").trim().toLowerCase();
  if (who && bossUsers().includes(who)) return true;

  const expected = process.env.PRICING_BOSS_TOKEN;
  const got = req.headers["x-pricing-boss"];
  if (got && expected && timingTokenMatches(got, expected)) return true;

  json(res, 403, { success: false, error: "boss_forbidden" });
  return false;
}

function clampLimit(value) { const n = Number.parseInt(value || "", 10); return !Number.isFinite(n) || n <= 0 ? DEFAULT_LIMIT : Math.min(n, MAX_LIMIT); }

function parseCursor(value) { const n = Number.parseInt(value || "0", 10); return Number.isFinite(n) && n > 0 ? n : 0; }

function textParam(value, max = 120) { const s = String(value || "").trim(); return s ? s.slice(0, max) : null; }

function personId(req) {
  const payload = decodeJwtPayload(req);
  const raw = req.body?.updated_by_person_id || req.body?.person_id || req.body?.personId || payload.employee_id || payload.person_id || null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function safeIdent(name) { return `"${String(name).replace(/"/g, '""')}"`; }

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

function quoteExcluded(row) {
  return Boolean(row?.exclude_reason || row?.is_soft_excluded === true || row?.is_comparable === false);
}

function splitQuotesByReviewState(rows) {
  const byId = new Map();
  for (const row of rows) {
    const key = row?.id == null ? JSON.stringify(row) : String(row.id);
    const prev = byId.get(key);
    if (!prev || (!quoteExcluded(prev) && quoteExcluded(row))) byId.set(key, row);
  }
  const valid = [];
  const excluded = [];
  for (const row of byId.values()) {
    if (quoteExcluded(row)) {
      excluded.push({ ...row, quote_group: "被排除报价", exclude_reason_cn: chineseExcludeReason(row.exclude_reason) });
    } else {
      valid.push({ ...row, quote_group: "有效报价" });
    }
  }
  return { valid, excluded };
}

function presenceStateCn(state) {
  return {
    seen_active: "在售",
    missing_once: "缺失1次",
    missing_since: "连续缺失",
    confirmed_offline: "已下架",
  }[state] || null;
}

function labelListText(value) {
  if (value == null) return "标签未同步";
  if (!Array.isArray(value)) return null;
  if (value.length === 0) return "无标签";
  return value.map((v) => String(v?.labelName || v?.name || v).trim()).filter(Boolean).join(", ") || "无标签";
}

function decorateRows(rows) {
  return rows.map((row) => ({
    ...row,
    presence_state_cn: presenceStateCn(row.presence_state),
    label_list_text: labelListText(row.label_list),
  }));
}

async function reviewProduct(req, res) {
  const productCode = textParam(req.body?.product_code || req.query?.product_code, 80);
  if (!productCode) return json(res, 400, { ok: false, error: "product_code_required" });

  const action = textParam(req.body?.review || req.body?.marker || req.body?.status || req.body?.value, 40);
  const marker = action === "verified" ? "正常" : action === "written_off" ? "死货" : null;
  if (!["verified", "written_off", "clear"].includes(action)) {
    return json(res, 400, { ok: false, error: "invalid_review_action" });
  }

  const note = textParam(req.body?.note, 500);
  const updatedBy = personId(req);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO petstore_product_status (product_code, marker, note, updated_by_person_id, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (product_code) DO UPDATE SET
        marker = EXCLUDED.marker,
        note = EXCLUDED.note,
        updated_by_person_id = EXCLUDED.updated_by_person_id,
        updated_at = now()
    `, [productCode, marker, note, updatedBy]);
    if (note) {
      await client.query(`
        INSERT INTO petstore_product_notes (product_code, note, author)
        VALUES ($1, $2, $3)
      `, [productCode, note, updatedBy == null ? null : String(updatedBy)]);
    }
    await client.query("COMMIT");
    return json(res, 200, { ok: true, product_code: productCode, marker });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
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

  const quotes = splitQuotesByReviewState([...validQuotes, ...marketQuotes]);
  return json(res, 200, {
    ok: true,
    product_code: productCode,
    quotes,
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
  if (nearby === "has") filters.push("market_price IS NOT NULL AND COALESCE(market_valid_cnt,0) > 0");
  if (nearby === "none") filters.push("(market_price IS NULL OR COALESCE(market_valid_cnt,0) = 0)");

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
        pm.take_out, pm.month_sale, pm.warn_status_str, pm.label_list,
        gp.presence_state, gp.missing_count, gp.supplier_sync_status,
        online_price.online_source_sku_id,
        online_price.online_original_price, online_price.online_activity_price,
        online_price.online_price_captured_at,
        gpr.gdc_profile,
        NULLIF(s.brand, '') AS supp_brand,
        CASE
          WHEN NULLIF(s.brand, '') IS NOT NULL THEN NULL
          WHEN o.product_name ~ '^[[:alnum:]][[:alnum:]&+._-]+' THEN substring(o.product_name FROM '^([[:alnum:]][[:alnum:]&+._-]+)')
          WHEN o.product_name ~ '^[一-龥]{2,8}(牌|宠物|猫砂|猫粮|狗粮|冻干|罐头)' THEN substring(o.product_name FROM '^([一-龥]{2,8}(?:牌|宠物|猫砂|猫粮|狗粮|冻干|罐头))')
          ELSE NULLIF(split_part(o.product_name, ' ', 1), o.product_name)
        END AS raw_brand_guess
      FROM petstore_ops_row o
      LEFT JOIN petstore_sku_supp s ON s.product_code = o.product_code
      LEFT JOIN product_external_ids pei
        ON pei.source_system = 'jelly_orange'
       AND pei.is_current
       AND pei.external_product_code = o.product_code
      LEFT JOIN product_master pm ON pm.product_id = pei.product_id
      LEFT JOIN gdc_product_presence gp
        ON gp.store_code = '63350001'
       AND gp.product_code = o.product_code
      LEFT JOIN LATERAL (
        SELECT
          max(source_sku_id) AS online_source_sku_id,
          max(price) FILTER (WHERE channel = '线上原价') AS online_original_price,
          max(price) FILTER (WHERE channel = '线上活动价') AS online_activity_price,
          max(captured_at) AS online_price_captured_at
        FROM (
          SELECT DISTINCT ON (h.channel)
            h.source_sku_id, h.channel, h.price, h.captured_at
          FROM petstore_price_history h
          WHERE h.source_sku_id = o.product_code
            AND h.source_table = 'gdc_online_price'
            AND h.channel IN ('线上原价', '线上活动价')
            AND h.price_type = '生效'
          ORDER BY h.channel, h.effective_at DESC, h.captured_at DESC, h.id DESC
        ) h
      ) online_price ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_strip_nulls(jsonb_build_object(
          'sku_id', r.sku_id, 'spu_product_code', r.spu_product_code, 'collected_at', r.collected_at,
          'product_status', r.product_status, 'first_category_name', r.raw_payload->'firstCategoryName',
          'second_category_name', r.raw_payload->'secondCategoryName', 'take_out', r.raw_payload->'takeOut',
          'month_sale', r.raw_payload->'monthSale', 'warn_status_str', r.raw_payload->'warnStatusStr',
          'label_list', r.raw_payload->'labelList', 'supplier_list', r.raw_payload->'supplierList',
          'channel_codes', r.raw_payload->'channelCodes', 'channel_activities', act.channel_activities
        )) AS gdc_profile
        FROM gdc_emall_product_raw r
        LEFT JOIN LATERAL (
          SELECT jsonb_object_agg(channel_key, activity ORDER BY channel_key) AS channel_activities
          FROM (
            SELECT DISTINCT ON (channel_key) channel_key,
              jsonb_strip_nulls(jsonb_build_object(
                'channel', channel_key, 'channelCode', channel_code, 'activityPrice', activity_price,
                'activityStartTime', start_text, 'activityEndTime', end_text,
                'daysLeft', CASE WHEN end_at IS NULL THEN NULL ELSE ceil(extract(epoch FROM end_at - now()) / 86400)::int END,
                'lifecycleRatio', ratio,
                'expiryStatus', CASE WHEN ratio IS NULL THEN NULL WHEN ratio <= 0 THEN 'expired' WHEN ratio <= 0.15 THEN 'soon' ELSE 'normal' END,
                'activityType', item->>'activityType', 'activityName', item->>'activityName', 'orderLimitNum', item->>'orderLimitNum'
              )) AS activity, end_at
            FROM (
              SELECT item,
                CASE item->>'channelCode' WHEN 'MEI_TUAN' THEN 'meituan' WHEN 'E_BAI' THEN 'eleme' WHEN 'JD' THEN 'jd_daojia' ELSE NULL END AS channel_key,
                item->>'channelCode' AS channel_code,
                NULLIF(item->>'activityStartTime', '') AS start_text,
                NULLIF(item->>'activityEndTime', '') AS end_text,
                NULLIF(item->>'activityPrice', '')::numeric AS activity_price
              FROM jsonb_array_elements(COALESCE(r.raw_payload->'listActivityProduct', '[]'::jsonb)) item
            ) src
            CROSS JOIN LATERAL (
              SELECT to_timestamp(start_text, 'YYYY-MM-DD HH24:MI:SS') AS start_at, to_timestamp(end_text, 'YYYY-MM-DD HH24:MI:SS') AS end_at
            ) tm
            CROSS JOIN LATERAL (
              SELECT CASE WHEN start_text IS NULL OR end_at <= start_at THEN NULL ELSE (extract(epoch FROM end_at - now()) / extract(epoch FROM end_at - start_at))::numeric END AS ratio
            ) calc
            WHERE channel_key IN ('meituan', 'eleme')
            ORDER BY channel_key, (end_at < now()), end_at ASC NULLS LAST
          ) picked
        ) act ON true
        WHERE r.store_code = '63350001'
          AND r.sku_id = o.product_code
        ORDER BY r.collected_at DESC
        LIMIT 1
      ) gpr ON true
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
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN round(market_price::numeric, 2) END AS market_price,
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN market_store END AS market_store,
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN market_sold END AS market_sold,
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN market_spec END AS market_spec,
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN market_captured_at END AS market_captured_at,
      market_quote_cnt, market_valid_cnt, market_excluded_cnt,
      sales_1d, sales_7d, sales_30d, sales_90d, daily_avg_90,
      cur_stock, days_of_supply, days_left, last_sale_at,
      problem_types, pending_card_cnt, restock_verdict, restock_qty,
      shelf_code, shelf_missing, expiry_flag, sales_src, stock_src,
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN market_src_id END AS market_src_id, as_of,
      pet_type, shelf_life_days, expire_date_batch, compliance_status, shelf_location,
      take_out, month_sale, warn_status_str, label_list,
      presence_state, missing_count, supplier_sync_status, gdc_profile,
      online_source_sku_id,
      round(online_original_price::numeric, 2) AS online_original_price,
      round(online_activity_price::numeric, 2) AS online_activity_price,
      online_price_captured_at,
      brand_final, brand_guess, brand_src, series, series_src,
      CASE WHEN store_price IS NULL OR store_price = 0 OR cost_price IS NULL THEN NULL
           ELSE round(((store_price - cost_price) / store_price * 100)::numeric, 2)
      END AS margin_pct,
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN round(market_price_prev::numeric, 2) END AS market_price_prev,
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN round(market_price_delta::numeric, 2) END AS market_price_delta,
      CASE WHEN COALESCE(market_valid_cnt,0) > 0 THEN round(market_price_delta_pct::numeric, 2) END AS market_price_delta_pct,
      market_days_unchanged,
      ARRAY[]::jsonb[] AS items
    FROM final_rows
    ${where}
    ORDER BY ${sort}
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);

  const decorated = decorateRows(rows);
  return json(res, 200, {
    ok: true,
    rows: decorated,
    data: decorated,
    limit,
    cursor: offset,
    next_cursor: rows.length === limit ? String(offset + limit) : null,
  });
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  addBossCorsHeaders(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (!requireAuth(req, res)) return;
    if (!requireBoss(req, res)) return;
    if (req.method === "POST" && req.query?.action === "review") return reviewProduct(req, res);
    if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });
    if (req.query?.action === "detail") return getDetail(req, res);
    return getList(req, res);
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message || "server_error" });
  }
}
