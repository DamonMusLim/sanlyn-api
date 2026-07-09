import { getPool, setCors } from "../db.js";

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS finance_invoice_drafts (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     contract_no text NOT NULL,
     order_nos text,
     customs_nos text[],
     buyer_name text, buyer_tax_id text, buyer_email text,
     seller_name text, seller_company_code text,
     currency text,
     amount_declared numeric,
     amount_order numeric,
     amount_invoice numeric,
     line_items jsonb DEFAULT '[]'::jsonb,
     remark text,
     status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','blocked','confirmed','issued','cancelled')),
     missing jsonb DEFAULT '[]'::jsonb,
     source text DEFAULT 'p2-scan',
     created_by text, created_at timestamptz DEFAULT now(),
     confirmed_by text, confirmed_at timestamptz,
     issued_invoice_no text, issued_at timestamptz,
     cancelled_by text, cancelled_at timestamptz, cancel_reason text,
     updated_at timestamptz DEFAULT now(),
     UNIQUE (contract_no)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_finance_invoice_drafts_status
     ON finance_invoice_drafts(status)`,
  `CREATE INDEX IF NOT EXISTS idx_finance_invoice_drafts_customs_nos
     ON finance_invoice_drafts USING GIN(customs_nos)`,
];

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  const pool = getPool();
  const log = [];
  try {
    for (const sql of STATEMENTS) {
      await pool.query(sql);
      log.push("OK: " + sql.replace(/\s+/g, " ").trim().slice(0, 120));
    }
    return res.json({
      success: true,
      table: "finance_invoice_drafts",
      indexes_added: ["idx_finance_invoice_drafts_status", "idx_finance_invoice_drafts_customs_nos"],
      log,
    });
  } catch (err) {
    console.error("[migrate-invoice-drafts]", err);
    return res.status(500).json({ success: false, error: String(err.message || err), log });
  }
}
