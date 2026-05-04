// api/db/migrate-credit-notes.js
// POST /api/db/migrate-credit-notes
// Creates credit_notes table

import { getPool, setCors } from '../db.js';

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS credit_notes (
        id            SERIAL PRIMARY KEY,
        cn_no         TEXT NOT NULL UNIQUE,          -- CN-20260504-001
        company_code  TEXT NOT NULL,                 -- buyer's company_code (CN-00040)
        company_name  TEXT,                          -- ENRICH CHAMPION SDN BHD
        order_no      TEXT,                          -- 40-CP-2
        contract_no   TEXT,                          -- FS20260320009
        invoice_no    TEXT,                          -- ref invoice
        issued_date   DATE NOT NULL DEFAULT CURRENT_DATE,
        currency      TEXT NOT NULL DEFAULT 'CNY',
        net_amount    NUMERIC(14,2) NOT NULL,        -- negative=credit to buyer, positive=debit
        status        TEXT NOT NULL DEFAULT 'draft', -- draft|issued|acknowledged
        lang          TEXT NOT NULL DEFAULT 'en',   -- en|zh|bilingual
        note          TEXT,
        items         JSONB NOT NULL DEFAULT '[]',   -- [{no,desc,qty,qty_unit,price_diff,amount,type}]
        pdf_url       TEXT,                          -- DAS stored PDF
        created_by    TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_cn_company   ON credit_notes(company_code);
      CREATE INDEX IF NOT EXISTS idx_cn_order     ON credit_notes(order_no);
      CREATE INDEX IF NOT EXISTS idx_cn_status    ON credit_notes(status);
      CREATE INDEX IF NOT EXISTS idx_cn_date      ON credit_notes(issued_date DESC);
    `);

    res.json({ success: true, message: 'credit_notes table ready' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
