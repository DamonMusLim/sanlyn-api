// One-off SOA cleanup — 2026-05-16
// Deletes 12 test orders (PETSOME GROUP + low-amount JJ PET GROUP) + backfills
// created_at and missing company_name_en for legitimate manual_import orders.
//
// Auth: ?key=<CRON_SECRET>
// Usage: curl -X POST "https://api.sanlyn.cn/api/admin/cleanup-soa-2026-05-16?key=$CRON_SECRET"
//
// After running once, this file SHOULD be deleted in the next commit (dead code red line).
// Tracked in /Users/mac/.claude/projects/-Users-mac-Desktop/memory/MEMORY.md
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST")    return res.status(405).json({ error: "POST only" });
  if (req.query.key !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const pool = getPool();
  const result = { steps: [] };

  try {
    // Step 1: preview test orders before delete
    const before = await pool.query(`
      SELECT contract_no, order_no, company_name_en, total_amount, currency
      FROM orders WHERE created_at IS NULL AND (
        company_name_en = 'PETSOME GROUP'
        OR (company_name_en = 'JJ PET GROUP SDN BHD' AND total_amount::numeric <= 500)
      )
      ORDER BY contract_no
    `);
    result.steps.push({ step: "preview", count: before.rowCount, rows: before.rows });

    // Step 2: delete test orders
    const del = await pool.query(`
      DELETE FROM orders WHERE created_at IS NULL AND (
        company_name_en = 'PETSOME GROUP'
        OR (company_name_en = 'JJ PET GROUP SDN BHD' AND total_amount::numeric <= 500)
      )
      RETURNING order_no
    `);
    result.steps.push({ step: "delete", count: del.rowCount, order_nos: del.rows.map(r => r.order_no) });

    // Step 3: backfill created_at for real manual_import orders
    const ts = await pool.query(`
      UPDATE orders SET created_at = NOW(), updated_at = NOW()
      WHERE created_at IS NULL AND raw->>'source' = 'manual_import'
      RETURNING order_no
    `);
    result.steps.push({ step: "backfill_created_at", count: ts.rowCount, order_nos: ts.rows.map(r => r.order_no) });

    // Step 4: backfill missing company_name_en from raw.consignee / raw.companyNameEN
    const buyer = await pool.query(`
      UPDATE orders SET company_name_en = COALESCE(
        NULLIF(raw->>'companyNameEN', ''),
        NULLIF(raw->>'consignee', '')
      )
      WHERE (company_name_en IS NULL OR company_name_en = '')
        AND COALESCE(NULLIF(raw->>'companyNameEN',''), NULLIF(raw->>'consignee','')) IS NOT NULL
      RETURNING order_no, company_name_en
    `);
    result.steps.push({ step: "backfill_buyer", count: buyer.rowCount, rows: buyer.rows });

    // Step 5: final audit
    const after = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_at IS NULL)::int AS no_created_at,
        COUNT(*) FILTER (WHERE company_name_en IS NULL OR company_name_en = '')::int AS no_buyer
      FROM orders
    `);
    result.steps.push({ step: "final_audit", ...after.rows[0] });

    return res.status(200).json({ ok: true, result });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack, partial: result });
  }
}
