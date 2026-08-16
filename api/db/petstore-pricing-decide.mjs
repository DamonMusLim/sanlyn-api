// api/db/petstore-pricing-decide.mjs
import { getPool, setCors } from "./db.js";
import { verifyToken } from "./auth.js";
import { resolvePerson, capSources } from "./authz.js";
import { applyProfileUpdate, validateProfileActions } from "./petstore-pricing-profile.mjs";
import { RIVALS_CTES, RIVALS_JOINS, RIVALS_SELECT } from "./petstore-pricing-rivals.mjs";

const MAX_LIMIT = 80;
const DECISION_ACTIONS = new Set(["approve", "reject"]);
const DECIDE_CAP = "price.decide";

function send(res, code, data) {
  res.status(code).json(data);
  return null;
}

function addCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Staff-Token");
}

function text(value, max = 500) {
  const s = String(value ?? "").trim();
  return s ? s.slice(0, max) : null;
}

function moneyOrNull(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
}

function tokenFrom(req, body = {}) {
  const auth = String(req.headers?.authorization || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const h = String(req.headers?.["x-staff-token"] || "").trim();
  if (h) return h;
  return String(body.token || req.query?.t || req.query?.token || "").trim();
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

async function requireDecider(req, res, pool, body = {}) {
  const claims = verifyToken(tokenFrom(req, body));
  if (!claims || claims.role !== "staff" || !claims.employee_id) {
    res.status(401).json({ success: false, error: "请从员工端进入" });
    return null;
  }

  const empId = claims.employee_id;
  const person = await resolvePerson({ user: { employee_id: empId } }, { pool, audit: false });
  if (!person) {
    res.status(403).json({ success: false, error: "员工身份未映射，不能审批改价" });
    return null;
  }
  if (capSources(person, DECIDE_CAP).length === 0) {
    res.status(403).json({ success: false, error: "缺少 price.decide 能力" });
    return null;
  }
  return person;
}

function unsupportedFields(body) {
  const changes = body.other_changes && typeof body.other_changes === "object" ? body.other_changes : {};
  const bad = [];
  const offline = body.offline_price ?? changes.offline_price;
  const online = body.online_price ?? changes.online_price;
  const shelfCode = body.shelf_code ?? changes.shelf_code;
  const expiryDate = body.expiry_date ?? changes.expiry_date;

  if (offline !== undefined && offline !== null && offline !== "") bad.push("线下价暂不可改：当前后端没有写入路径");
  if (online !== undefined && online !== null && online !== "") bad.push("线上价暂不可改：当前后端没有写入路径");
  if (shelfCode !== undefined && shelfCode !== null && shelfCode !== "") bad.push("货位请使用 shelf_location 写入");
  if (expiryDate !== undefined && expiryDate !== null && expiryDate !== "") bad.push("到期日请使用 expire_date_batch 写入");
  return bad;
}

function snapshot(row, body, effectivePrice, profileResult) {
  return {
    intent: {
      id: row.id,
      product_code: row.product_code,
      product_name: row.product_name,
      channel: row.channel,
      old_price: row.old_price,
      target_price: row.target_price,
      status: row.status,
      reason: row.reason,
      author: row.author,
      created_at: row.created_at,
    },
    decision: {
      action: body.action,
      effective_price: effectivePrice,
      note: text(body.note, 500),
      batch_ids: body._batch_ids || null,
    },
    profile_update: profileResult?.snapshot || null,
    guard: {
      cost_price: row.cost_price,
      cost_state: row.cost_state,
    },
  };
}

function rowEffectivePrice(row, body) {
  if (body.action !== "approve") return null;
  const map = body.effective_prices && typeof body.effective_prices === "object" ? body.effective_prices : {};
  const raw = Object.prototype.hasOwnProperty.call(map, row.id)
    ? map[row.id]
    : (row.id === body._primary_id ? body.effective_price : null);
  return moneyOrNull(raw ?? row.target_price);
}

function selectedIds(body) {
  const id = Number.parseInt(String(body.id || ""), 10);
  const ids = [id];
  const siblings = body.include_siblings ? (body.sibling_intent_ids || []) : [];
  for (const raw of siblings) {
    const n = Number.parseInt(String(raw || ""), 10);
    if (Number.isFinite(n) && n > 0 && !ids.includes(n)) ids.push(n);
  }
  return ids;
}

async function listIntents(req, res, pool) {
  const limitRaw = Number.parseInt(String(req.query?.limit || "30"), 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, MAX_LIMIT) : 30;
  const total = await pool.query(`
    SELECT COUNT(*)::int AS total_pending
    FROM petstore_price_intents
    WHERE status = 'proposed'`);
  const { rows } = await pool.query(`WITH picked AS MATERIALIZED (
  SELECT
    p.id, p.product_code, p.product_name, p.channel, p.old_price, p.target_price,
    p.reason, p.author, p.status, p.created_at,
    COALESCE(o.cost_price, s.cost_price) AS cost_price,
    CASE
      WHEN COALESCE(o.cost_price, s.cost_price) IS NULL THEN 'unknown_cost'
      WHEN p.target_price < COALESCE(o.cost_price, s.cost_price) THEN 'blocked'
      ELSE 'ok'
    END AS cost_state,
    o.category, o.spec_text, o.pic_url, o.supplier, o.is_locked_price, o.lock_reason,
    o.store_price, o.mt_price, o.ele_price, o.market_price, o.market_store,
    o.market_quote_cnt, o.market_captured_at,
    o.sales_1d, o.sales_7d, o.sales_30d, o.sales_90d, o.daily_avg_90,
    o.cur_stock, o.days_of_supply, o.days_left, o.last_sale_at,
    o.problem_types, o.restock_verdict, o.expiry_flag,
    ps.shelf_location, ps.expire_date_batch, ps.brand,
    CASE
      WHEN NULLIF(trim(ps.brand), '') IS NOT NULL THEN trim(ps.brand)
      WHEN length(split_part(trim(p.product_name), ' ', 1)) BETWEEN 1 AND 12
        THEN split_part(trim(p.product_name), ' ', 1)
      ELSE NULL
    END AS band_brand_name,
    CASE
      WHEN NULLIF(trim(ps.brand), '') IS NULL
       AND length(split_part(trim(p.product_name), ' ', 1)) BETWEEN 1 AND 12
      THEN true ELSE false
    END AS band_brand_inferred
  FROM petstore_price_intents p
  LEFT JOIN petstore_ops_row o ON o.product_code = p.product_code
  LEFT JOIN petstore_skus s ON s.product_code = p.product_code
  LEFT JOIN petstore_sku_supp ps ON ps.product_code = p.product_code
  WHERE p.status = 'proposed'
  ORDER BY p.created_at ASC, p.id ASC
  LIMIT $1
),
${RIVALS_CTES},
category_stats AS MATERIALIZED (
  SELECT
    category AS name,
    COUNT(*)::int AS sku_cnt,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY store_price)::numeric AS median,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY store_price)::numeric AS p25,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY store_price)::numeric AS p75
  FROM petstore_ops_row
  WHERE NULLIF(trim(category), '') IS NOT NULL
    AND store_price > 0
  GROUP BY category
),
brand_pool AS MATERIALIZED (
  SELECT
    CASE
      WHEN NULLIF(trim(ps.brand), '') IS NOT NULL THEN trim(ps.brand)
      WHEN length(split_part(trim(o.product_name), ' ', 1)) BETWEEN 1 AND 12
        THEN split_part(trim(o.product_name), ' ', 1)
      ELSE NULL
    END AS name,
    o.store_price
  FROM petstore_ops_row o
  LEFT JOIN petstore_sku_supp ps ON ps.product_code = o.product_code
  WHERE o.store_price > 0
),
brand_stats AS MATERIALIZED (
  SELECT
    name,
    COUNT(*)::int AS sku_cnt,
    percentile_cont(0.5) WITHIN GROUP (ORDER BY store_price)::numeric AS median,
    percentile_cont(0.25) WITHIN GROUP (ORDER BY store_price)::numeric AS p25,
    percentile_cont(0.75) WITHIN GROUP (ORDER BY store_price)::numeric AS p75
  FROM brand_pool
  WHERE name IS NOT NULL
  GROUP BY name
)
SELECT
  p.*,
  ${RIVALS_SELECT}
  jsonb_build_object(
    'category', CASE
      WHEN cs.sku_cnt >= 3 THEN jsonb_build_object(
        'name', cs.name,
        'sku_cnt', cs.sku_cnt,
        'median', round(cs.median, 2),
        'p25', round(cs.p25, 2),
        'p75', round(cs.p75, 2),
        'deviation_pct', CASE
          WHEN p.old_price IS NOT NULL AND cs.median > 0
          THEN round(((p.old_price / cs.median) - 1) * 100, 1)
          ELSE NULL
        END
      )
      ELSE NULL
    END,
    'brand', CASE
      WHEN bs.sku_cnt >= 3 THEN jsonb_build_object(
        'name', bs.name,
        'sku_cnt', bs.sku_cnt,
        'median', round(bs.median, 2),
        'p25', round(bs.p25, 2),
        'p75', round(bs.p75, 2),
        'deviation_pct', CASE
          WHEN p.old_price IS NOT NULL AND bs.median > 0
          THEN round(((p.old_price / bs.median) - 1) * 100, 1)
          ELSE NULL
        END,
        'inferred', p.band_brand_inferred
      )
      ELSE NULL
    END
  ) AS price_band,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'channel', sib.channel,
      'old_price', sib.old_price,
      'target_price', sib.target_price,
      'intent_id', sib.id
    ) ORDER BY sib.created_at ASC, sib.id ASC)
    FROM petstore_price_intents sib
    WHERE sib.product_code = p.product_code
      AND sib.status = 'proposed'
      AND sib.id <> p.id
  ), '[]'::jsonb) AS sibling_channels
FROM picked p
LEFT JOIN category_stats cs ON cs.name = p.category
LEFT JOIN brand_stats bs ON bs.name = p.band_brand_name
${RIVALS_JOINS}
ORDER BY p.created_at ASC, p.id ASC;`, [limit]);
  send(res, 200, { success: true, total_pending: total.rows[0]?.total_pending || 0, rows });
}

async function decideIntent(req, res, pool, body) {
  if (!DECISION_ACTIONS.has(String(body.action || ""))) {
    return send(res, 400, { success: false, error: "action 只能是 approve / reject" });
  }

  const ids = selectedIds(body);
  if (!ids.length || !Number.isFinite(ids[0]) || ids[0] <= 0) {
    return send(res, 400, { success: false, error: "id 必填" });
  }

  const unsupported = unsupportedFields(body);
  if (unsupported.length) {
    return send(res, 400, { success: false, error: unsupported.join("；") });
  }

  const actionError = validateProfileActions(body);
  if (actionError) {
    return send(res, 400, { success: false, error: actionError });
  }

  const person = await requireDecider(req, res, pool, body);
  if (!person) return null;

  let profileResult = { updated: [], snapshot: null, intents: {} };
  try {
    profileResult = await applyProfileUpdate(pool, body, ids[0], person);
  } catch (err) {
    console.error("[petstore-pricing-decide-profile]", err);
    return send(res, 500, { success: false, error: "资料订正失败，改价未提交", profile_updated: [] });
  }
  if (profileResult.notFound) {
    return send(res, 409, { success: false, error: "该改价单已被处理或不存在", profile_updated: [] });
  }
  if (profileResult.conflict) {
    return send(res, profileResult.status || 409, {
      success: false,
      error: profileResult.error,
      profile_updated: profileResult.updated,
      ...profileResult.intents,
    });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    body._primary_id = ids[0];
    body._batch_ids = ids.length > 1 ? ids : null;

    const locked = await client.query(`
      SELECT
        p.id, p.product_code, p.product_name, p.channel, p.old_price, p.target_price,
        p.reason, p.author, p.status, p.created_at,
        COALESCE(o.cost_price, s.cost_price) AS cost_price,
        CASE
          WHEN COALESCE(o.cost_price, s.cost_price) IS NULL THEN 'unknown_cost'
          WHEN p.target_price < COALESCE(o.cost_price, s.cost_price) THEN 'blocked'
          ELSE 'ok'
        END AS cost_state
      FROM petstore_price_intents p
      LEFT JOIN petstore_ops_row o ON o.product_code = p.product_code
      LEFT JOIN petstore_skus s ON s.product_code = p.product_code
      WHERE p.id = ANY($1::int[])
      FOR UPDATE OF p`, [ids]);

    if (locked.rowCount !== ids.length || locked.rows.some((r) => r.status !== "proposed")) {
      await client.query("ROLLBACK");
      return send(res, 409, { success: false, error: "该改价单已被处理或不存在", profile_updated: profileResult.updated, ...profileResult.intents });
    }

    const rowsById = new Map(locked.rows.map((r) => [Number(r.id), r]));
    const orderedRows = ids.map((id) => rowsById.get(id));
    const primaryCode = orderedRows[0].product_code;
    const wrongSku = orderedRows.find((r) => String(r.product_code) !== String(primaryCode));
    if (wrongSku) {
      await client.query("ROLLBACK");
      return send(res, 400, { success: false, error: "同批提交只能处理同一个商品的其他渠道", profile_updated: profileResult.updated, ...profileResult.intents });
    }

    for (const row of orderedRows) {
      const effectivePrice = rowEffectivePrice(row, body);
      if (body.action === "approve" && (effectivePrice == null || Number.isNaN(effectivePrice) || effectivePrice <= 0)) {
        await client.query("ROLLBACK");
        return send(res, 400, { success: false, error: `${row.channel || row.id} 批准价必须是正数`, profile_updated: profileResult.updated, ...profileResult.intents });
      }
      const cost = moneyOrNull(row.cost_price);
      if (body.action === "approve" && cost != null && !Number.isNaN(cost) && effectivePrice < cost) {
        await client.query("ROLLBACK");
        return send(res, 409, {
          success: false,
          error: `${row.channel || row.id} 批准价低于成本，改价未提交`,
          intent_id: row.id,
          cost_price: cost,
          effective_price: effectivePrice,
          profile_updated: profileResult.updated,
          ...profileResult.intents,
        });
      }
    }

    const updatedRows = [];
    for (const row of orderedRows) {
      const effectivePrice = rowEffectivePrice(row, body);
      const note = text(body.note, 500);
      const snap = JSON.stringify(snapshot(row, body, effectivePrice, profileResult));
      const params = [row.id, person.person_id, note, snap];
      let updated;

      if (body.action === "approve") {
        params.push(effectivePrice);
        updated = await client.query(`
          UPDATE petstore_price_intents
             SET status = 'approved',
                 target_price = $5,
                 decided_by_person_id = $2,
                 decided_at = now(),
                 decided_note = $3,
                 decided_snapshot = $4::jsonb
           WHERE id = $1 AND status = 'proposed'
           RETURNING id, product_code, product_name, channel, old_price, target_price,
                     status, decided_by_person_id, decided_at, decided_note, decided_snapshot`, params);
      } else {
        updated = await client.query(`
          UPDATE petstore_price_intents
             SET status = 'rejected',
                 decided_by_person_id = $2,
                 decided_at = now(),
                 decided_note = $3,
                 decided_snapshot = $4::jsonb
           WHERE id = $1 AND status = 'proposed'
           RETURNING id, product_code, product_name, channel, old_price, target_price,
                     status, decided_by_person_id, decided_at, decided_note, decided_snapshot`, params);
      }

      if (updated.rowCount === 0) {
        await client.query("ROLLBACK");
        return send(res, 409, { success: false, error: "该改价单已被处理", profile_updated: profileResult.updated, ...profileResult.intents });
      }
      updatedRows.push(updated.rows[0]);
    }

    await client.query("COMMIT");
    return send(res, 200, {
      success: true,
      row: updatedRows[0],
      rows: updatedRows,
      profile_updated: profileResult.updated,
      decision: body.action,
      ...profileResult.intents,
    });
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("[petstore-pricing-decide]", err);
    return send(res, 500, { success: false, error: "服务异常", profile_updated: profileResult.updated, ...profileResult.intents });
  } finally {
    client.release();
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  addCorsHeaders(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return null;
  }

  const pool = getPool();
  try {
    if (req.method === "GET") {
      const person = await requireDecider(req, res, pool);
      if (!person) return null;
      return listIntents(req, res, pool);
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      return decideIntent(req, res, pool, body);
    }
    return send(res, 405, { success: false, error: "仅支持 GET / POST" });
  } catch (err) {
    console.error("[petstore-pricing-decide]", err);
    return send(res, 500, { success: false, error: "服务异常" });
  }
}
