// official-rates.js — 官方运价管理
// GET  ?pol=&pod=&carrier=   → 拉取官方价（is_official=true）
// POST action=upsert         → 手动更新官方价
// POST action=fetch_maersk   → 调 Maersk 免费 API 拉最新价
// POST action=ensure_cols    → 确保数据库字段存在

import { getPool, setCors } from "../db.js";

const FIXED_ROUTES = [
  { pol: "Qingdao",  pod: "Port Klang" },
  { pol: "Tianjin",  pod: "Port Klang" },
  { pol: "Shanghai", pod: "Port Klang" },
];

const ENSURE_COLS = `
  ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS is_official BOOLEAN DEFAULT FALSE;
  ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS source VARCHAR(60);
  ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS official_gp20 NUMERIC;
  ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS official_hq40 NUMERIC;
  ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS fetched_at TIMESTAMPTZ;
`;

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ── 确保字段 ──
  try { await pool.query(ENSURE_COLS); } catch(e) {}

  // ══ GET: 返回官方价列表 ══
  if (req.method === "GET") {
    try {
      const { pol, pod, carrier } = req.query;
      let q = `SELECT id, pol, pod, carrier, source,
        gp20, hq40, official_gp20, official_hq40,
        customer_gp20, customer_hq40,
        transit_days, valid_to, fetched_at, is_official,
        created_at, updated_at
        FROM freight_rates WHERE is_official = TRUE`;
      const params = [];
      if (pol)     { params.push(`%${pol}%`);     q += ` AND pol ILIKE $${params.length}`; }
      if (pod)     { params.push(`%${pod}%`);     q += ` AND pod ILIKE $${params.length}`; }
      if (carrier) { params.push(`%${carrier}%`); q += ` AND carrier ILIKE $${params.length}`; }
      q += " ORDER BY carrier, pol";
      const result = await pool.query(q, params);
      return res.status(200).json({ success: true, data: result.rows, count: result.rows.length });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  // ══ POST ══
  if (req.method === "POST") {
    const body = req.body || {};
    const { action } = body;

    // ── 手动更新/新增官方价 ──
    if (action === "upsert") {
      try {
        const { pol, pod, carrier, gp20, hq40, transitDays, validTo, source } = body;
        if (!pol || !pod || !carrier) return res.status(400).json({ success: false, error: "pol/pod/carrier 必填" });

        // 先查是否存在
        const exist = await pool.query(
          "SELECT id FROM freight_rates WHERE pol ILIKE $1 AND pod ILIKE $2 AND carrier ILIKE $3 AND is_official = TRUE LIMIT 1",
          [pol, pod, carrier]
        );
        if (exist.rows.length) {
          await pool.query(
            `UPDATE freight_rates SET
              gp20=$1, hq40=$2, official_gp20=$1, official_hq40=$2,
              transit_days=$3, valid_to=$4, source=$5,
              fetched_at=NOW(), updated_at=NOW()
             WHERE id=$6`,
            [gp20||null, hq40||null, transitDays||null, validTo||null, source||"manual", exist.rows[0].id]
          );
          return res.status(200).json({ success: true, action: "updated" });
        } else {
          await pool.query(
            `INSERT INTO freight_rates (pol, pod, carrier, gp20, hq40, official_gp20, official_hq40,
              transit_days, valid_to, source, is_official, fetched_at, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$4,$5,$6,$7,$8,TRUE,NOW(),NOW(),NOW())`,
            [pol, pod, carrier, gp20||null, hq40||null, transitDays||null, validTo||null, source||"manual"]
          );
          return res.status(200).json({ success: true, action: "inserted" });
        }
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    // ── 拉取 Maersk 免费 API ──
    if (action === "fetch_maersk") {
      const { clientId, clientSecret } = body;
      if (!clientId || !clientSecret) {
        return res.status(400).json({ success: false, error: "需要 Maersk clientId + clientSecret" });
      }
      try {
        // 1. 获取 token
        const tokenRes = await fetch("https://api.maersk.com/customer-identity/oauth/v2/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "client_credentials",
            client_id: clientId,
            client_secret: clientSecret,
          }),
        });
        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) {
          return res.status(401).json({ success: false, error: "Maersk token 获取失败", detail: tokenData });
        }
        const token = tokenData.access_token;

        // 2. 查各固定航线
        const headers = {
          "Authorization": "Bearer " + token,
          "Consumer-Key": clientId,
          "Accept": "application/json",
        };
        const results = [];
        for (const route of FIXED_ROUTES) {
          try {
            const url = `https://api.maersk.com/products/ocean-products?` + new URLSearchParams({
              collectionOriginCountryCode: "CN",
              collectionOriginCityName: route.pol,
              deliveryDestinationCountryCode: "MY",
              deliveryDestinationCityName: route.pod,
            });
            const r = await fetch(url, { headers });
            const d = await r.json();
            const products = d?.products || d?.oceanProducts || [];
            for (const p of products.slice(0, 5)) {
              // 提取价格（结构按 Maersk API 实际返回调整）
              const prices = p?.prices || p?.freightRates || [];
              const gp20 = prices.find(x => (x.containerType||x.containerCode||"").includes("20"))?.amount || null;
              const hq40 = prices.find(x => (x.containerType||x.containerCode||"").includes("40"))?.amount || null;
              const transit = p?.transitTime || p?.transitDays || null;
              results.push({ pol: route.pol, pod: route.pod, carrier: "Maersk", gp20, hq40, transit, raw: p });
              // 存进数据库
              const exist = await pool.query(
                "SELECT id FROM freight_rates WHERE pol ILIKE $1 AND pod ILIKE $2 AND carrier='Maersk' AND is_official=TRUE LIMIT 1",
                [route.pol, route.pod]
              );
              if (exist.rows.length) {
                await pool.query(
                  `UPDATE freight_rates SET gp20=$1,hq40=$2,official_gp20=$1,official_hq40=$2,
                    transit_days=$3,source='maersk_api',fetched_at=NOW(),updated_at=NOW() WHERE id=$4`,
                  [gp20, hq40, transit, exist.rows[0].id]
                );
              } else {
                await pool.query(
                  `INSERT INTO freight_rates (pol,pod,carrier,gp20,hq40,official_gp20,official_hq40,
                    transit_days,source,is_official,fetched_at,created_at,updated_at)
                   VALUES ($1,$2,'Maersk',$3,$4,$3,$4,$5,'maersk_api',TRUE,NOW(),NOW(),NOW())`,
                  [route.pol, route.pod, gp20, hq40, transit]
                );
              }
              break; // 每条航线取第一个结果
            }
          } catch (e) { results.push({ route, error: e.message }); }
        }
        return res.status(200).json({ success: true, fetched: results.length, results });
      } catch (err) {
        return res.status(500).json({ success: false, error: err.message });
      }
    }

    return res.status(400).json({ success: false, error: "unknown action" });
  }

  return res.status(405).end();
}
