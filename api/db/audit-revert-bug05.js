// One-shot revert: delete the wrong CN-00040 bank_accounts row I inserted by mistake.
// ENRICH is a buyer (customer), not a seller — bank_accounts stores SELLER (Sanlyn) bank info shown TO customers.
import { getPool, setCors } from "../db.js";
export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "admin only" });
  const pool = getPool();
  const r = await pool.query(`DELETE FROM bank_accounts WHERE company_code = 'CN-00040' RETURNING id, account_holder`);
  return res.status(200).json({ ok: true, deleted: r.rowCount, rows: r.rows });
}
