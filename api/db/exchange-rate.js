// exchange-rate.js — daily FX rate, cached in exchange_rates table
// GET ?pair=USD_CNY  → latest rate (auto-refreshes if today's entry is missing)
// POST action=refresh → force refresh from frankfurter
//
// Table: exchange_rates(id, currency_pair, rate, source, fetched_at, created_at)

import { getPool, setCors } from "../db.js";

const DEFAULT_PAIR = "USD_CNY";
const FALLBACK_RATE = 7.2; // used only if frankfurter is unreachable AND no cached row exists

async function fetchFromFrankfurter(pair) {
  // pair e.g. "USD_CNY"
  const [base, quote] = pair.split("_");
  if (!base || !quote) throw new Error("Invalid pair: " + pair);
  const url = "https://api.frankfurter.app/latest?from=" + base + "&to=" + quote;
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!resp.ok) throw new Error("frankfurter HTTP " + resp.status);
  const data = await resp.json();
  if (!data || !data.rates || !data.rates[quote]) throw new Error("frankfurter missing rate");
  return Number(data.rates[quote]);
}

export default async function handler(req, res) {
  setCors(req, res, "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  const pool = getPool();
  const pair = String(req.query.pair || DEFAULT_PAIR).toUpperCase();

  if (req.method === "GET") {
    try {
      // Latest cached row
      const cached = await pool.query(
        "SELECT rate, source, fetched_at FROM exchange_rates WHERE currency_pair = $1 ORDER BY fetched_at DESC LIMIT 1",
        [pair]
      );
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const stale = !cached.rows.length || new Date(cached.rows[0].fetched_at).toISOString() < todayStart;

      if (!stale) {
        return res.status(200).json({
          success: true,
          pair,
          rate: Number(cached.rows[0].rate),
          source: cached.rows[0].source,
          fetched_at: cached.rows[0].fetched_at,
          fresh: false,
        });
      }

      // Stale or missing — try to refresh
      try {
        const rate = await fetchFromFrankfurter(pair);
        await pool.query(
          "INSERT INTO exchange_rates (currency_pair, rate, source, fetched_at, created_at) VALUES ($1, $2, 'frankfurter', NOW(), NOW())",
          [pair, rate]
        );
        return res.status(200).json({ success: true, pair, rate, source: "frankfurter", fetched_at: new Date().toISOString(), fresh: true });
      } catch (e) {
        // Fall back to cached row if any, else FALLBACK_RATE
        if (cached.rows.length) {
          return res.status(200).json({
            success: true,
            pair,
            rate: Number(cached.rows[0].rate),
            source: cached.rows[0].source + " (stale)",
            fetched_at: cached.rows[0].fetched_at,
            fresh: false,
            refreshError: e.message,
          });
        }
        return res.status(200).json({
          success: true,
          pair,
          rate: FALLBACK_RATE,
          source: "fallback",
          fetched_at: null,
          fresh: false,
          refreshError: e.message,
        });
      }
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }

  if (req.method === "POST") {
    const action = (req.body && req.body.action) || req.query.action;
    if (action === "refresh") {
      try {
        const rate = await fetchFromFrankfurter(pair);
        await pool.query(
          "INSERT INTO exchange_rates (currency_pair, rate, source, fetched_at, created_at) VALUES ($1, $2, 'frankfurter', NOW(), NOW())",
          [pair, rate]
        );
        return res.status(200).json({ success: true, pair, rate, source: "frankfurter", fresh: true });
      } catch (e) {
        return res.status(502).json({ success: false, error: e.message });
      }
    }
    return res.status(400).json({ error: "Unknown action. Try POST {action:'refresh'}." });
  }

  return res.status(405).json({ error: "Method not allowed" });
}
