// ──────────────────────────────────────────────────────────────
// ⚠ paymentTerms SOURCE OF TRUTH: accounts.raw.paymentTerms
//   The legacy customers.payment_term column is NOT used for the
//   proxy-purchase credit flow. Do not read from it when checking
//   credit / approval. Migration path (future): drop the column
//   once legacy reports migrate.
// ──────────────────────────────────────────────────────────────
// seed-payment-defaults.js — one-shot backfill
// Sets default paymentTerms / creditLimit / proxyFee on every
// accounts row where role='customer' that doesn't already have
// them. Existing manual values are preserved (idempotent).
//
// Call:  curl -X POST https://api.sanlyn.cn/api/db/seed-payment-defaults \
//          -H "Authorization: Bearer <ADMIN_JWT>"
//
// Defaults:
//   paymentTerms    : "cod_on_arrival"   (pay on arrival)
//   creditLimit     : 20000  USD
//   creditCurrency  : "USD"
//   gracePeriodDays : 7
//   requireApproval : true   (over-limit orders need admin OK)
//   proxyFeeRate    : 0.02   (2%)
//   proxyFeeMin     : 30     (USD floor)
// ──────────────────────────────────────────────────────────────

import { getPool, setCors } from "../db.js";

const DEFAULTS = {
  paymentTerms:    "cod_on_arrival",
  creditLimit:     20000,
  creditCurrency:  "USD",
  gracePeriodDays: 7,
  requireApproval: true,
  proxyFeeRate:    0.02,
  proxyFeeMin:     30,
  // Reseller flag + commission — default off; opt-in per account
  isReseller:      false,
  commissionRate:  0,
};

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Only admins may run this
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "admin only" });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "POST required" });
  }

  // Allow overriding via body if admin wants different defaults
  const overrides = (req.body && typeof req.body === "object") ? req.body : {};
  const cfg = Object.assign({}, DEFAULTS, overrides);

  try {
    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT username, raw FROM accounts WHERE role = 'customer'"
    );

    let updated = 0, skipped = 0;
    const details = [];

    for (const r of rows) {
      const raw = r.raw || {};
      const patch = {};

      // NOTE: falsy check (not just null) — empty strings from legacy data
      // would otherwise be skipped and leave customers without valid terms.
      if (!raw.paymentTerms)                         patch.paymentTerms    = cfg.paymentTerms;
      if (raw.creditLimit     == null)               patch.creditLimit     = cfg.creditLimit;
      if (!raw.creditCurrency)                       patch.creditCurrency  = cfg.creditCurrency;
      if (raw.gracePeriodDays == null)               patch.gracePeriodDays = cfg.gracePeriodDays;
      if (raw.requireApproval == null)               patch.requireApproval = cfg.requireApproval;
      if (raw.proxyFeeRate    == null)               patch.proxyFeeRate    = cfg.proxyFeeRate;
      if (raw.proxyFeeMin     == null)               patch.proxyFeeMin     = cfg.proxyFeeMin;
      if (raw.isReseller      == null)               patch.isReseller      = cfg.isReseller;
      if (raw.commissionRate  == null)               patch.commissionRate  = cfg.commissionRate;
      // creditUsed is cron-computed; initialize to 0 if missing
      if (raw.creditUsed      == null)               patch.creditUsed      = 0;

      if (Object.keys(patch).length === 0) {
        skipped++;
        continue;
      }

      const merged = Object.assign({}, raw, patch);
      await pool.query(
        "UPDATE accounts SET raw = $1 WHERE username = $2",
        [JSON.stringify(merged), r.username]
      );
      updated++;
      details.push({ username: r.username, applied: Object.keys(patch) });
    }

    return res.status(200).json({
      ok: true,
      total:    rows.length,
      updated,
      skipped,
      defaultsUsed: cfg,
      details,
    });
  } catch (e) {
    console.error("[seed-payment-defaults]", e);
    return res.status(500).json({ error: e.message });
  }
}
