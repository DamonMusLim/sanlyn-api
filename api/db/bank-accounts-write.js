// POST /api/db/bank-accounts-write — admin-only INSERT into bank_accounts table
// (Distinct from the read-only resolver at order-payee-account.js.)
// Used by Damon's admin tooling to provision new payee accounts per company_code.
import { getPool, setCors } from "./db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }

  const b = req.body || {};
  const required = ["company_code", "currency", "account_holder", "bank_name", "account_no"];
  for (const k of required) {
    if (!b[k]) return res.status(400).json({ error: `${k} is required` });
  }

  try {
    const pool = getPool();
    const r = await pool.query(`
      INSERT INTO bank_accounts
        (company_code, currency, account_holder, bank_name, bank_name_en,
         account_no, swift, bank_address, is_default, active)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      RETURNING id, company_code, currency, account_holder, account_no
    `, [
      b.company_code, b.currency, b.account_holder, b.bank_name,
      b.bank_name_en || null, b.account_no, b.swift || null,
      b.bank_address || null,
      b.is_default !== false, b.active !== false,
    ]);
    return res.status(200).json({ ok: true, row: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message, code: err.code });
  }
}
