// migrate-exchange-rate.js — exchange_rates table
// POST /api/db/migrate-exchange-rate
import { getPool, setCors } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!requireAuth(req, res)) return;
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin only" });

  const pool = getPool();
  const results = [];
  const run = async (label, sql) => {
    try { await pool.query(sql); results.push("✅ " + label); }
    catch (e) { results.push("⚠️ " + label + ": " + e.message); }
  };

  await run("create exchange_rates", `
    CREATE TABLE IF NOT EXISTS exchange_rates (
      id            SERIAL PRIMARY KEY,
      currency_pair VARCHAR(16) NOT NULL,
      rate          NUMERIC(18,6) NOT NULL,
      source        TEXT,
      fetched_at    TIMESTAMPTZ DEFAULT NOW(),
      created_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await run("idx_exchange_rates_pair", `
    CREATE INDEX IF NOT EXISTS idx_exchange_rates_pair
    ON exchange_rates(currency_pair, fetched_at DESC)
  `);
  // seed row if empty
  await run("seed USD_CNY if empty", `
    INSERT INTO exchange_rates (currency_pair, rate, source)
    SELECT 'USD_CNY', 7.26, 'seed'
    WHERE NOT EXISTS (SELECT 1 FROM exchange_rates WHERE currency_pair='USD_CNY')
  `);

  return res.status(200).json({ success: true, results });
}
