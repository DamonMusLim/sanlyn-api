import { getPool, setCors } from "../db.js";

const CACHE_TTL_MS = 60000;
let nearexpCache = { at: 0, data: null };

function json(res, code, body) { return res.status(code).json(body); }

function cacheWrap(data, cached, at) {
  return { ...data, cached, generated_at: new Date(at).toISOString() };
}

export function invalidateNearexpCache() {
  nearexpCache = { at: 0, data: null };
}

function todayWhere(alias = "") {
  const p = alias ? alias + "." : "";
  return `(
    ${p}status IN ('proposed','approved')
    OR (
      ${p}status IN ('executed','rejected')
      AND COALESCE(${p}executed_at, ${p}updated_at, ${p}created_at)::date = CURRENT_DATE
    )
  )`;
}

export async function buildNearexp(pool) {
  const [plan, proposals, summary] = await Promise.all([
    pool.query(
      `SELECT id,min_days,max_days,rate,rule_text,sort,updated_at,updated_by
         FROM public.petstore_nearexp_plan
        ORDER BY sort,id`
    ),
    pool.query(
      `SELECT id,product_code,product_name,spec,orig_shelf,nearexp_shelf,days_left,
              expiry_date,produce_date,date_verified,base_price,suggest_price,
              current_price,stock,tier_label,status,approved_by,approved_at,
              executed_at,readback_price,note,created_at,updated_at,last_seen_date
         FROM public.petstore_nearexp_proposals
        WHERE ${todayWhere()}
        ORDER BY days_left ASC NULLS LAST, product_name ASC NULLS LAST, id ASC`
    ),
    pool.query(
      `SELECT tier_label,
              count(*)::int AS product_count,
              COALESCE(sum(stock),0)::numeric AS stock_count,
              COALESCE(sum(stock * suggest_price),0)::numeric AS amount
         FROM public.petstore_nearexp_proposals
        WHERE ${todayWhere()}
        GROUP BY tier_label
        ORDER BY min(days_left) ASC NULLS LAST`
    )
  ]);

  return {
    ok: true,
    version: "v2026.09.18-2",
    plan: plan.rows,
    proposals: proposals.rows,
    summary: summary.rows,
  };
}

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.headers["x-gateway-auth"] !== "gw-dataops-0903") {
    return json(res, 403, { ok: false, error: "gateway_auth_required" });
  }
  if (req.method !== "GET") return json(res, 405, { ok: false, error: "method_not_allowed" });

  try {
    const now = Date.now();
    if (nearexpCache.data && now - nearexpCache.at < CACHE_TTL_MS) {
      return json(res, 200, cacheWrap(nearexpCache.data, true, nearexpCache.at));
    }
    const data = await buildNearexp(getPool());
    nearexpCache = { at: Date.now(), data };
    return json(res, 200, cacheWrap(data, false, nearexpCache.at));
  } catch (err) {
    console.error("[petstore-nearexp]", err);
    return json(res, 500, { ok: false, error: "server_error" });
  }
}
