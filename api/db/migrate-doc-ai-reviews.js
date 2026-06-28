// /api/db/migrate-doc-ai-reviews.js
// One-time migration: doc_ai_reviews table for DAS AI Smart Review results.
// POST → run migration. Idempotent.
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS doc_ai_reviews (
        id           SERIAL PRIMARY KEY,
        doc_id       TEXT NOT NULL,            -- "{key}:{contractNo}" or doc.id
        doc_type     TEXT,                     -- 'sc' / 'pi' / 'iv' / 'pl' / 'bl' / 'msds' ...
        contract_no  TEXT,
        status       TEXT NOT NULL,            -- 'ok' | 'warn' | 'error'
        findings     JSONB DEFAULT '[]'::jsonb,-- [{level:'high'|'mid'|'low'|'ok', text:'...'}]
        passed       INT,                      -- # of checks that passed
        total        INT,                      -- # of checks attempted
        reviewed_at  TIMESTAMPTZ DEFAULT NOW(),
        reviewed_by  TEXT,                     -- username or 'system'
        engine       TEXT DEFAULT 'sanlyn-v1', -- model/version tag
        meta         JSONB
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS doc_ai_reviews_docid_idx ON doc_ai_reviews(doc_id, reviewed_at DESC);`);
    await pool.query(`CREATE INDEX IF NOT EXISTS doc_ai_reviews_contract_idx ON doc_ai_reviews(contract_no);`);

    return res.status(200).json({ success: true, message: "doc_ai_reviews table ready" });
  } catch (err) {
    console.error("[migrate-doc-ai-reviews]", err);
    return res.status(500).json({ error: err.message });
  }
}
