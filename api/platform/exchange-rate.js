// exchange-rate.js
// GET  /api/platform/exchange-rate      → 返回当前 USD/CNY 汇率（公开）
// POST /api/platform/exchange-rate      → 从 frankfurter 拉汇率 + 刷 price_usd（admin/trader/internal）
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

// 从 DB 读最新汇率
async function getLatestRate(pool) {
  try {
    const r = await pool.query(
      `SELECT rate, fetched_at FROM exchange_rates
       WHERE currency_pair='USD_CNY'
       ORDER BY fetched_at DESC LIMIT 1`
    );
    return r.rows[0] || null;
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  const pool = getPool();

  // ── GET: 返回当前汇率（公开，不需要 auth）──
  if (req.method === "GET") {
    const row = await getLatestRate(pool);
    if (!row) return res.status(404).json({ error: "No exchange rate found. Run POST /api/platform/exchange-rate to sync." });
    return res.status(200).json({
      success: true,
      currency_pair: "USD_CNY",
      rate: parseFloat(row.rate),
      formula: "price_usd = price_cny / rate + 0.1",
      fetched_at: row.fetched_at,
    });
  }

  // ── POST: 拉外部汇率 + 刷 price_usd ──
  if (req.method === "POST") {
    // 允许 admin、trader、internal 触发；factory 和 customer 不允许
    if (!requireAuth(req, res)) return;
    const role = req.user?.role || "";
    if (role === "customer" || role === "factory") {
      return res.status(403).json({ error: "Not authorized" });
    }

    let rate = null;
    let source = "frankfurter";

    // 拉 frankfurter.app
    try {
      const resp = await fetch("https://api.frankfurter.app/latest?from=USD&to=CNY", {
        signal: AbortSignal.timeout(8000),
      });
      const data = await resp.json();
      rate = parseFloat(data?.rates?.CNY);
      if (!rate || isNaN(rate)) throw new Error("Invalid rate from API: " + JSON.stringify(data));
    } catch (fetchErr) {
      // fallback: use latest DB value
      console.warn("[exchange-rate] fetch failed, using DB fallback:", fetchErr.message);
      const fallback = await getLatestRate(pool);
      if (!fallback) {
        return res.status(502).json({
          error: "External API failed and no fallback rate available.",
          detail: fetchErr.message,
        });
      }
      rate = parseFloat(fallback.rate);
      source = "fallback_db";
    }

    // 存新汇率
    await pool.query(
      `INSERT INTO exchange_rates (currency_pair, rate, source) VALUES ('USD_CNY', $1, $2)`,
      [rate, source]
    );

    // 刷新 company_products.price_usd = ROUND(price_cny / rate + 0.1, 2)
    // 只更新 price_cny IS NOT NULL AND price_cny > 0 的记录
    const updateRes = await pool.query(
      `UPDATE company_products
       SET price_usd = ROUND((price_cny / $1::NUMERIC + 0.1)::NUMERIC, 2)
       WHERE price_cny IS NOT NULL AND price_cny > 0`,
      [rate]
    );

    return res.status(200).json({
      success: true,
      rate,
      source,
      updated_rows: updateRes.rowCount,
      formula: `price_usd = ROUND(price_cny / ${rate} + 0.1, 2)`,
    });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
