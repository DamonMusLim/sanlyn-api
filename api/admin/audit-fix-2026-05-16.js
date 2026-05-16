// One-off audit fixes for the 2026-05-16 customer flow audit
// (~/Desktop/Sanlyn/audits/customer-flow-audit-2026-05-16.md)
//
// Auth: POST ?nonce=<NONCE>  (single-use — file deleted in follow-up commit)
// Path added to PUBLIC_PATHS so the global JWT middleware doesn't intercept.
//
// Actions:
//   1. BUG-19 — backfill orders.company_name_en from customers.name_en for the
//      5 orders (CP-4, WP-62, ZC-20, 40-XZ-1, 37-ZC-16) plus any others where
//      it's NULL and a matching customers row exists.
//   2. BUG-05 — ensure ENRICH (CN-00040) has a Sanlyn USD payee account row in
//      bank_accounts. If none exists, copy the BABI USD account as a template
//      and re-key it under CN-00040 (admin can later edit the actual
//      account_no/swift). This unblocks the "Payee account pending setup"
//      empty state in the customer Finance panel.
import { getPool, setCors } from "../db.js";

const NONCE = "d2f5aa61b5d7c4a30f8c5e09bf7a14d6e3f0b8a921c7d6f4";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });
  if (req.query.nonce !== NONCE) return res.status(403).json({ error: "Forbidden" });

  const pool = getPool();
  const log = [];

  try {
    // ── BUG-19: backfill company_name_en ──
    const buyer = await pool.query(`
      UPDATE orders o
      SET    company_name_en = c.name_en,
             updated_at = NOW()
      FROM   customers c
      WHERE  o.company_code = c.company_code
        AND  (o.company_name_en IS NULL OR o.company_name_en = '')
        AND  c.name_en IS NOT NULL AND c.name_en <> ''
      RETURNING o.order_no, o.contract_no, o.company_name_en
    `);
    log.push({ step: "BUG-19 backfill company_name_en", rows: buyer.rowCount, samples: buyer.rows.slice(0, 10) });

    // Anything still NULL? Report so admin can investigate
    const stillNull = await pool.query(`
      SELECT order_no, contract_no, company_code
      FROM orders
      WHERE company_name_en IS NULL OR company_name_en = ''
      LIMIT 20
    `);
    log.push({ step: "BUG-19 still-null after backfill", rows: stillNull.rowCount, list: stillNull.rows });

    // ── BUG-05: ensure ENRICH CN-00040 has a USD bank account ──
    const enrich = await pool.query(`
      SELECT id FROM bank_accounts WHERE company_code = 'CN-00040' AND currency = 'USD' LIMIT 1
    `);
    if (enrich.rowCount === 0) {
      // Copy BABI USD account as template — admin must edit account_no / swift later
      const babi = await pool.query(`
        SELECT account_holder, bank_name, bank_name_en, account_no, swift, bank_address
        FROM bank_accounts WHERE company_code = 'BABI' AND currency = 'USD' AND active != false
        LIMIT 1
      `);
      if (babi.rowCount > 0) {
        const b = babi.rows[0];
        const ins = await pool.query(`
          INSERT INTO bank_accounts
            (company_code, currency, account_holder, bank_name, bank_name_en,
             account_no, swift, bank_address, is_default, active)
          VALUES
            ('CN-00040', 'USD', $1, $2, $3, $4, $5, $6, true, true)
          RETURNING id
        `, [
          b.account_holder + " (CN-00040 PLACEHOLDER — please edit)",
          b.bank_name, b.bank_name_en,
          b.account_no, b.swift, b.bank_address,
        ]);
        log.push({ step: "BUG-05 ENRICH USD account created (placeholder)", id: ins.rows[0].id });
      } else {
        log.push({ step: "BUG-05 no template BABI account found — skip" });
      }
    } else {
      log.push({ step: "BUG-05 ENRICH USD account already exists", existing_id: enrich.rows[0].id });
    }

    return res.status(200).json({ ok: true, log });
  } catch (err) {
    return res.status(500).json({ error: err.message, partial_log: log });
  }
}
