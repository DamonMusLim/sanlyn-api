// migrate-doc-sends.js — GET /api/db/migrate-doc-sends
// Creates doc_sends table for the document send/receive/confirm loop.
import { getPool, setCors } from "../db.js";

export default async function handler(req, res) {
  setCors(req, res, "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "GET") return res.status(405).json({ error: "GET only" });

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS doc_sends (
        id            SERIAL PRIMARY KEY,
        order_id      INTEGER NOT NULL,
        doc_type      TEXT NOT NULL,
        recipient     TEXT NOT NULL,
        token_hash    TEXT UNIQUE NOT NULL,
        meta          JSONB NOT NULL DEFAULT '{}',
        access_log    JSONB NOT NULL DEFAULT '[]',
        reply_data    JSONB,
        status        TEXT NOT NULL DEFAULT 'sent',
        sent_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at    TIMESTAMPTZ NOT NULL,
        created_by    TEXT
      )
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS doc_sends_order_idx ON doc_sends(order_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS doc_sends_token_idx ON doc_sends(token_hash)`);
    return res.json({ ok: true, message: "doc_sends table ready" });
  } catch (e) {
    console.error("[migrate-doc-sends]", e);
    return res.status(500).json({ error: e.message });
  }
}
