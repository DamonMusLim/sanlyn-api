// W0-6: Central FX resolver — replaces literal 7.2 / 7.30 defaults.
//
// Memory rule (HARD): feedback_never_invent_fields.md +
// feedback_docs_tables_no_calc_only_fields.md — never default to a guessed rate.
// When no rate is available AND the caller requires FX conversion, the caller
// MUST receive a 400 with error='exchange_rate_required' rather than a silent
// 7.2 fallback (which is wrong by ~1.5% on most days and skews margin math).
//
// Resolution order (first non-null wins):
//   1. Explicit `requestedRate` (e.g. POST body `exchange_rate`)
//   2. exchange_rates table, latest USD_CNY row (refreshed daily elsewhere)
//   3. null  → caller decides: return 400 with exchange_rate_required
//
// USAGE:
//   import { getExchangeRate } from "../lib/finance/exchange-rate.js";
//   const rate = await getExchangeRate(pool, { currency: "USD", requestedRate: body.exchange_rate });
//   if (!rate) return res.status(400).json({ error: "exchange_rate_required",
//     hint: "Pass exchange_rate in body or wait for exchange_rates table refresh." });

const SUPPORTED_PAIRS = { USD: "USD_CNY", EUR: "EUR_CNY" };

export async function getExchangeRate(pool, opts) {
  opts = opts || {};
  const currency = String(opts.currency || "USD").toUpperCase();
  // 1. Explicit override
  if (opts.requestedRate != null && Number(opts.requestedRate) > 0) {
    return Number(opts.requestedRate);
  }
  // CNY → 1.0 trivial
  if (currency === "CNY") return 1;
  const pair = SUPPORTED_PAIRS[currency];
  if (!pair) return null;
  // 2. exchange_rates table
  try {
    const r = await pool.query(
      "SELECT rate FROM exchange_rates WHERE currency_pair = $1 ORDER BY fetched_at DESC LIMIT 1",
      [pair]
    );
    if (r.rows.length && Number(r.rows[0].rate) > 0) {
      return Number(r.rows[0].rate);
    }
  } catch (_) { /* table may not exist yet — fall through */ }
  // 3. No rate available → caller's responsibility to 400
  return null;
}

// Convenience: throw-style for callers that want a guaranteed rate or HTTP 400.
// Returns { ok: true, rate } or { ok: false, error, hint }.
export async function requireExchangeRate(pool, opts) {
  const rate = await getExchangeRate(pool, opts);
  if (rate == null) {
    return {
      ok: false,
      error: "exchange_rate_required",
      hint: "Pass exchange_rate in request body, or refresh exchange_rates table (POST /api/db/exchange-rate {action:'refresh'}).",
    };
  }
  return { ok: true, rate };
}
