// migrate-025-shipping-schema.js
// ALTER TABLE: orders + freight_rates + shipping_plans (v3.2 shipping schema audit 2026-05-22)
// Safe: all ADD COLUMN IF NOT EXISTS + UPDATE with ILIKE match filters
// POST /api/db/migrate-025-shipping-schema  (admin/system or CRON_SECRET)
import { getPool, setCors } from "../db.js";
import { extractUser } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  if (!req.user) extractUser(req);
  const okJwt  = req.user && ["admin", "system"].includes(req.user.role);
  const okCron = process.env.CRON_SECRET && req.headers["x-cron-secret"] === process.env.CRON_SECRET;
  if (!okJwt && !okCron) return res.status(403).json({ success: false, error: "Forbidden" });

  const pool = getPool();
  const results = [];

  async function run(label, sql) {
    try {
      const r = await pool.query(sql);
      results.push({ label, ok: true, rowsAffected: r.rowCount ?? 0 });
    } catch (e) {
      results.push({ label, ok: false, error: e.message });
    }
  }

  // ── orders: bind shipping plan + rate ─────────────────────────────────────
  await run("orders.shipping_plan_id",
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipping_plan_id INTEGER`);
  await run("orders.freight_rate_id",
    `ALTER TABLE orders ADD COLUMN IF NOT EXISTS freight_rate_id INTEGER`);

  // ── freight_rates: missing logistic fields ─────────────────────────────────
  await run("freight_rates.currency",
    `ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS currency VARCHAR(10) DEFAULT 'USD'`);
  await run("freight_rates.sail_date",
    `ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS sail_date DATE`);
  await run("freight_rates.doc_cutoff",
    `ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS doc_cutoff DATE`);
  await run("freight_rates.cargo_cutoff",
    `ALTER TABLE freight_rates ADD COLUMN IF NOT EXISTS cargo_cutoff DATE`);

  // ── shipping_plans: profit + LC code ─────────────────────────────────────
  await run("shipping_plans.ocean_freight_profit_usd",
    `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS ocean_freight_profit_usd NUMERIC`);
  await run("shipping_plans.local_charges_code",
    `ALTER TABLE shipping_plans ADD COLUMN IF NOT EXISTS local_charges_code TEXT`);

  // ── freight_rates: auto-link local charges (unique matches only) ──────────
  await run("link GZ00011 Tianjin→KK MSK",
    `UPDATE freight_rates SET local_charge_code = 'GZ00011'
      WHERE pol ILIKE '%tianjin%' AND pod ILIKE '%kinabalu%'
        AND carrier ILIKE '%MSK%' AND local_charge_code IS NULL`);
  await run("link GZ00013 Qingdao→PKW OOCL",
    `UPDATE freight_rates SET local_charge_code = 'GZ00013'
      WHERE pol ILIKE '%qingdao%' AND pod ILIKE '%klang%'
        AND carrier ILIKE '%OOCL%' AND local_charge_code IS NULL`);

  const allOk = results.every(r => r.ok);
  return res.status(allOk ? 200 : 207).json({ success: allOk, results });
}
