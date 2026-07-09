// migrate-account-identities.js
// POST /api/db/migrate-account-identities
//
// 离职即刻失效操作 SQL:
// UPDATE accounts SET is_active=false, token_version=token_version+1 WHERE id=X;
// UPDATE employees SET status='INACTIVE' WHERE user_id::text=X::text;

import { getPool, setCors } from "../db.js";

const DAMON_OPENID = "oVFzv2B0-lnKmIWEZbs8MxpgtB5U";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, error: "POST only" });
  }

  const pool = getPool();
  const log = [];

  try {
    await pool.query("BEGIN");

    await pool.query(`
      ALTER TABLE accounts
        ADD COLUMN IF NOT EXISTS token_version INT NOT NULL DEFAULT 1
    `);
    log.push("accounts.token_version ready");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS account_identities (
        id BIGSERIAL PRIMARY KEY,
        account_id VARCHAR NOT NULL,
        provider VARCHAR NOT NULL CHECK (provider IN ('wechat_mp','wechat_mini','email','phone')),
        subject VARCHAR NOT NULL,
        verified_at TIMESTAMPTZ,
        raw JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE (provider, subject)
      )
    `);
    log.push("account_identities table ready");

    await pool.query(
      `INSERT INTO account_identities (account_id, provider, subject, verified_at, raw)
       VALUES ($1, $2, $3, NOW(), $4::jsonb)
       ON CONFLICT (provider, subject) DO NOTHING`,
      ["1", "wechat_mp", DAMON_OPENID, JSON.stringify({ source: "bindings.json", username: "damon_sl" })]
    );
    log.push("damon wechat_mp identity seeded");

    await pool.query("COMMIT");
    return res.status(200).json({ success: true, log });
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    console.error("[migrate-account-identities]", err);
    return res.status(500).json({ success: false, error: err.message, log });
  }
}
