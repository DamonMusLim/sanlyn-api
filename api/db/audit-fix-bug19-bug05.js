// Admin-only one-shot fix for the 2026-05-16 customer audit.
// POST /api/db/audit-fix-bug19-bug05  (JWT required, role=admin)
//
// Why this file exists: my earlier attempts to modify orders.js PATCH_ALLOWED_COLS
// and to add bank-accounts-write.js did push to git but Vercel didn't propagate
// the changes within reasonable time. NEW files DO deploy (marketplace / ddp-quote
// landed fine the same way), so this is a self-contained handler that bypasses
// the propagation snag.
//
// Body: {} — no parameters. Hardcoded for the 5 orders + 1 bank account row
// identified in ~/Desktop/Sanlyn/audits/customer-flow-audit-2026-05-16.md.
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: admin only" });
  }

  const pool = getPool();
  const log = [];

  try {
    // ── BUG-19: backfill orders.company_name_en for the 5 NULL rows ──
    const buyer = await pool.query(`
      UPDATE orders o
      SET    company_name_en = c.name_en,
             updated_at      = NOW()
      FROM   customers c
      WHERE  o.company_code = c.company_code
        AND  (o.company_name_en IS NULL OR o.company_name_en = '')
        AND  c.name_en IS NOT NULL
        AND  c.name_en <> ''
      RETURNING o.order_no, o.contract_no, o.company_name_en
    `);
    log.push({ step: "BUG-19 backfill", count: buyer.rowCount, rows: buyer.rows });

    const stillNull = await pool.query(`
      SELECT order_no, contract_no, company_code
      FROM orders WHERE company_name_en IS NULL OR company_name_en = ''
      LIMIT 20
    `);
    log.push({ step: "BUG-19 leftover", count: stillNull.rowCount, rows: stillNull.rows });

    // ── BUG-05: ensure ENRICH CN-00040 has a USD bank_accounts row ──
    const enrich = await pool.query(`
      SELECT id FROM bank_accounts WHERE company_code = 'CN-00040' AND currency = 'USD' LIMIT 1
    `);
    if (enrich.rowCount === 0) {
      const babi = await pool.query(`
        SELECT account_holder, bank_name, bank_name_en, account_no, swift, bank_address
        FROM bank_accounts
        WHERE company_code = 'BABI' AND currency = 'USD' AND COALESCE(active, true) = true
        LIMIT 1
      `);
      if (babi.rowCount > 0) {
        const b = babi.rows[0];
        const ins = await pool.query(`
          INSERT INTO bank_accounts
            (company_code, currency, account_holder, bank_name, bank_name_en,
             account_no, swift, bank_address, is_default, active)
          VALUES ('CN-00040','USD',$1,$2,$3,$4,$5,$6,true,true)
          RETURNING id, company_code, currency, account_no
        `, [
          (b.account_holder || "") + " (CN-00040 PLACEHOLDER — please edit)",
          b.bank_name, b.bank_name_en, b.account_no, b.swift, b.bank_address,
        ]);
        log.push({ step: "BUG-05 inserted placeholder", row: ins.rows[0] });
      } else {
        log.push({ step: "BUG-05 NO BABI template — skipped" });
      }
    } else {
      log.push({ step: "BUG-05 CN-00040 USD already exists", existing_id: enrich.rows[0].id });
    }

    return res.status(200).json({ ok: true, log });
  } catch (err) {
    return res.status(500).json({ error: err.message, code: err.code, partial: log });
  }
}
