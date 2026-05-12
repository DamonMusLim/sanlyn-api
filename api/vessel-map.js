// /api/vessel-map.js — v4 (2026-04-21 成本守卫)
//  变更：
//   1. 进入时先查 DB：
//      a) shipping_plans.ata 有值 → 已到港，拒绝订阅（省 Portune 费）
//      b) raw.portun_subscription_id 且 subscribed_at < 30 天 → 返回缓存，不重复订阅
//   2. 订阅成功后把 subscriptionId 回写 shipping_plans.raw
//   3. 仍然只按 BL（一个提单一份钱），不按柜
import { getPool } from "./db.js";
import { requireAuth } from "./auth.js";

const BASE = "https://prod-api.4portun.com/openapi";

const CARRIER_MAP = {
  "KMTC":"KMTC","COSCO":"COSCO","COSU":"COSCO","MSCU":"MSC","MEDU":"MSC","MSCL":"MSC",
  "MAEU":"MAE","HLCU":"HLC","EITU":"ONE","ONEY":"ONE","CXDU":"COSCO",
  "NBXG":"CMA","CMDU":"CMA","YMLU":"YML","EVGU":"EVG","HDMU":"HMM",
  "ZIMU":"ZIM","OOLU":"OOCL","APLU":"APL","SITU":"SIT","FCIU":"FCL",
  "EGLV":"EVG","TRIU":"TSL","WHLC":"WHL","SNKO":"SNL","NSAU":"ANL",
};

const BL_PATTERNS = [
  { re: /^\d{3}[A-Z]{4,}/,  carrier: null },
  { re: /^HJSC/,             carrier: "HJS" },
  { re: /^SHPH/,             carrier: "COSCO" },
];

function guessCarrier(blNo) {
  if (!blNo) return null;
  const u = blNo.toUpperCase();
  for (const [p, c] of Object.entries(CARRIER_MAP)) if (u.startsWith(p)) return c;
  for (const { re, carrier } of BL_PATTERNS) if (re.test(u) && carrier) return carrier;
  return null;
}

const CACHE_TTL_DAYS = 30;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!requireAuth(req, res)) return;

  const APP_ID = process.env.PORTUN_APP_ID || "SHYBB";
  const SECRET = process.env.PORTUN_SECRET;
  if (!SECRET) return res.status(500).json({ error: "Missing PORTUN_SECRET" });

  const body = req.method === "POST" ? req.body : req.query;
  const blNo        = (body?.blNo || body?.blno || "").trim().toUpperCase();
  const carrierCode = (body?.carrierCode || guessCarrier(blNo) || "").toUpperCase();
  const forceRefresh = body?.forceRefresh === true || body?.forceRefresh === "true";

  if (!blNo)        return res.status(400).json({ error: "Missing blNo" });
  if (!carrierCode) return res.status(400).json({ error: "Cannot determine carrierCode for " + blNo });

  // ── Guard: 查 DB，看是否已到港/已缓存 ─────────────────────────────────
  let cached = null;
  try {
    const pool = getPool();
    const q = await pool.query(
      `SELECT _id, bl_no, eta, ata, current_status_cn, raw FROM shipping_plans
       WHERE bl_no=$1 OR _id=$1 LIMIT 1`,
      [blNo]
    );
    if (q.rows.length > 0) {
      const p = q.rows[0];
      // (a) 已到港 → 拒绝订阅（除非显式 forceRefresh）
      if (!forceRefresh && (p.ata || p.current_status_cn === "已到港")) {
        return res.status(200).json({
          cached: true,
          arrived: true,
          reason: "shipment_arrived_no_new_subscription",
          token: null,
          subscriptionId: p.raw?.portun_subscription_id || null,
          appId: APP_ID, carrierCode, blNo,
        });
      }
      // (a1) ETA+3 守卫：预计到港已过 3 天，很可能已到港（客户只是没回填 ata）
      //      → 拒绝新订阅，避免每天刷订阅烧钱；已缓存的可以继续复用
      if (!forceRefresh && p.eta) {
        const etaPlus3Ms = new Date(p.eta).getTime() + 3 * 86400000;
        if (Date.now() > etaPlus3Ms) {
          return res.status(200).json({
            cached: !!p.raw?.portun_subscription_id,
            arrived: true,
            reason: "eta_plus_3_days_passed_assumed_arrived",
            token: null,
            subscriptionId: p.raw?.portun_subscription_id || null,
            appId: APP_ID, carrierCode, blNo,
            hint: "回填 shipping_plans.ata 后即不再触发此规则；如要继续追踪请 forceRefresh=true",
          });
        }
      }
      // (a2) 严格白名单：raw.portun_allowed != true 且无缓存 → 拒绝订阅
      //      (已有缓存 subscriptionId 可以继续复用，不触发收费)
      const isAllowed = p.raw?.portun_allowed === true || p.raw?.portun_allowed === "true";
      const hasCache  = !!p.raw?.portun_subscription_id;
      if (!forceRefresh && !isAllowed && !hasCache) {
        return res.status(200).json({
          cached: false,
          denied: true,
          reason: "bl_not_in_portun_allowlist",
          token: null,
          subscriptionId: null,
          appId: APP_ID, carrierCode, blNo,
          hint: "Set shipping_plans.raw.portun_allowed=true to enable tracking for this BL",
        });
      }
      // (b) 有缓存且未过 30 天 → 返回缓存
      const cachedId = p.raw?.portun_subscription_id;
      const cachedAt = p.raw?.portun_subscribed_at;
      if (!forceRefresh && cachedId && cachedAt) {
        const ageDays = (Date.now() - new Date(cachedAt).getTime()) / 86400000;
        if (ageDays < CACHE_TTL_DAYS) {
          cached = { subscriptionId: cachedId, subscribedAt: cachedAt, ageDays: Math.round(ageDays) };
        }
      }
    } else if (!forceRefresh) {
      // DB 里完全找不到此 BL → 默认拒绝（防止野 BL 刷单）
      return res.status(200).json({
        cached: false,
        denied: true,
        reason: "bl_not_found_in_shipping_plans",
        token: null,
        subscriptionId: null,
        appId: APP_ID, carrierCode, blNo,
        hint: "BL must exist in shipping_plans with raw.portun_allowed=true",
      });
    }
  } catch (dbErr) {
    // DB 查询失败：拒绝订阅，而不是降级（成本守卫优先）
    console.warn("[vessel-map] DB guard failed:", dbErr.message);
    if (!forceRefresh) {
      return res.status(503).json({
        error: "db_guard_unavailable_subscription_blocked",
        detail: dbErr.message,
      });
    }
  }

  try {
    // Step 1: token（仍然需要，用于前端 createTracking）
    const tokenRes  = await fetch(`${BASE}/auth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId: APP_ID, secret: SECRET }),
    });
    const tokenJson = await tokenRes.json();
    if (tokenJson.code !== 200 || !tokenJson.data)
      return res.status(502).json({ error: "Token fetch failed", detail: tokenJson });
    const token = tokenJson.data;

    // 如果有 30 天内的缓存 subscriptionId，直接复用，不再调订阅接口
    if (cached) {
      return res.status(200).json({
        token,
        subscriptionId: cached.subscriptionId,
        cached: true,
        cachedAgeDays: cached.ageDays,
        appId: APP_ID, carrierCode, blNo,
      });
    }

    // Step 2: 新订阅（✱ 收费点 ✱）
    const subRes  = await fetch(`${BASE}/gateway/api/v2/subscribeOceanTracking`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "appId": APP_ID,
        "Authorization": token,
      },
      body: JSON.stringify({
        billNo: blNo,
        carrierCode,
        isExport: "E",
        dataType: ["CARRIER"],
      }),
    });
    const subJson        = await subRes.json();
    const subscriptionId = subJson?.data?.subscriptionId || null;

    // Step 3: 订阅成功 → 回写缓存
    if (subscriptionId) {
      try {
        const pool = getPool();
        await pool.query(
          `UPDATE shipping_plans
           SET raw = COALESCE(raw,'{}'::jsonb) || jsonb_build_object(
             'portun_subscription_id', $1::text,
             'portun_subscribed_at',    NOW()::text,
             'portun_carrier_code',     $2::text
           ),
           updated_at = NOW()
           WHERE bl_no=$3 OR _id=$3`,
          [subscriptionId, carrierCode, blNo]
        );
      } catch (dbErr) {
        console.warn("[vessel-map] cache write failed:", dbErr.message);
      }
    }

    return res.status(200).json({
      token,
      subscriptionId,
      appId: APP_ID,
      carrierCode,
      blNo,
      subCode: subJson?.code,
      subMsg:  subJson?.message,
    });

  } catch (err) {
    return res.status(500).json({ error: "Internal error", detail: err.message });
  }
}
