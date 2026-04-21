// ──────────────────────────────────────────────────────────────
// recompute-credit-used.js
// Walks every customer account and recomputes accounts.raw.creditUsed
// = sum of (total_amount - received) for orders tied to the account's
// companyCode / groupId whose payment is not yet settled.
//
// Idempotent. Safe to call on a schedule or on-demand.
//
// Auth:   admin only
// Call:   POST /api/db/recompute-credit-used
//         (optional body: { dryRun: true } — returns diff without writing)
// ──────────────────────────────────────────────────────────────

import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST required" });
  }

  const dryRun = !!(req.body && req.body.dryRun);

  try {
    const pool = getPool();

    // 1) Pull all customer accounts
    const { rows: accounts } = await pool.query(
      "SELECT username, raw FROM accounts WHERE role = 'customer'"
    );

    // 2) Pull open-exposure aggregates by companyCode in a single query.
    //    "Open" = not marked paid AND outstanding > 0.
    //    Outstanding = total_amount - COALESCE(sum of received payments, 0)
    //
    //    We use company_code col first, fallback to raw->>'companyCode'.
    //    Currency-aware: aggregated per code per currency.
    const { rows: exposures } = await pool.query(`
      SELECT
        COALESCE(NULLIF(o.company_code, ''), o.raw->>'companyCode') AS code,
        COALESCE(o.currency, 'USD') AS currency,
        SUM(
          COALESCE(CAST(NULLIF(o.total_amount::text,'') AS NUMERIC), 0)
          - COALESCE((
              SELECT SUM(CAST(COALESCE(p.raw->>'receivedAmount', p.amount::text, '0') AS NUMERIC))
              FROM finance_payments p
              WHERE p.order_no = o.order_no
            ), 0)
        ) AS outstanding
      FROM orders o
      WHERE COALESCE(o.raw->>'paymentStatus','') <> 'paid'
      GROUP BY code, currency
    `);

    // Build lookup: code -> { currency -> outstanding }
    const byCode = {};
    for (const e of exposures) {
      if (!e.code) continue;
      const out = Number(e.outstanding) || 0;
      if (out <= 0) continue;
      if (!byCode[e.code]) byCode[e.code] = {};
      byCode[e.code][e.currency] = out;
    }

    // 3) For each account, compute creditUsed in the account's credit currency
    const updates = [];
    for (const a of accounts) {
      const raw = a.raw || {};
      const code = raw.companyCode || a.companyCode || null;
      const ccy  = raw.creditCurrency || "USD";
      if (!code) continue;

      const perCcy = byCode[code] || {};
      // MVP: only sum same-currency exposure. Mixed-currency shows a warning flag.
      const same = Number(perCcy[ccy] || 0);
      const otherCcy = Object.keys(perCcy).filter(c => c !== ccy);
      const mixed = otherCcy.length > 0;

      const newUsed = Math.round(same * 100) / 100;
      const oldUsed = Number(raw.creditUsed) || 0;

      if (newUsed !== oldUsed || raw.creditMixedCurrency !== mixed) {
        updates.push({
          username: a.username,
          code,
          currency: ccy,
          oldUsed,
          newUsed,
          mixed,
          mixedCurrencies: otherCcy,
        });
        if (!dryRun) {
          const merged = Object.assign({}, raw, {
            creditUsed: newUsed,
            creditUsedAt: new Date().toISOString(),
            creditMixedCurrency: mixed,
            creditMixedDetail:   mixed ? perCcy : null,
          });
          await pool.query(
            "UPDATE accounts SET raw = $1 WHERE username = $2",
            [JSON.stringify(merged), a.username]
          );
        }
      }
    }

    return res.status(200).json({
      ok: true,
      dryRun,
      scannedAccounts: accounts.length,
      changed:         updates.length,
      updates,
    });
  } catch (e) {
    console.error("[recompute-credit-used]", e);
    return res.status(500).json({ error: e.message });
  }
}
