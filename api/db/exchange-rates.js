// /api/db/exchange-rates.js — latest rate per currency_pair (for 总成本折算)
import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  try {
    const pool = getPool();
    const r = await pool.query(
      `SELECT DISTINCT ON (currency_pair) currency_pair, rate, fetched_at
         FROM exchange_rates ORDER BY currency_pair, fetched_at DESC NULLS LAST`);
    return res.status(200).json(r.rows);
  } catch (e) { return res.status(500).json({ error: e.message }); }
}
