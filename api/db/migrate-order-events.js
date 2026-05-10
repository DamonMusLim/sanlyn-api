// migrate-order-events.js — creates order_events table per v3.2 §6.1
import { getPool, setCors } from "../db.js";
import { extractUser } from "../auth.js";

export default async function handler(req, res) {
  setCors(req, res, "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "POST only" });

  if (!req.user) extractUser(req);
  const okJwt  = req.user && ["admin", "system"].includes(req.user.role);
  const okCron = process.env.CRON_SECRET && req.headers["x-cron-secret"] === process.env.CRON_SECRET;
  if (!okJwt && !okCron) return res.status(403).json({ success: false, error: "Forbidden" });

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS order_events (
        id               BIGSERIAL PRIMARY KEY,
        order_id         INT NOT NULL,
        stage_key        VARCHAR(48) NOT NULL,
        event_group      VARCHAR(32) CHECK (event_group IN ('negotiation','milestone','logistics','customs','ocean','finance')),
        sequence_no      INT DEFAULT 1,
        is_current       BOOLEAN DEFAULT TRUE,
        occurred_at      TIMESTAMPTZ NOT NULL,
        actor_role       VARCHAR(32),
        actor_company_id VARCHAR(64),
        actor_user_id    VARCHAR(64),
        source           VARCHAR(24) CHECK (source IN ('manual','portun','minimax','cron','ocr','backfill')),
        visibility_scope JSONB,
        confidence       NUMERIC(4,3),
        status           VARCHAR(16) DEFAULT 'active' CHECK (status IN ('active','corrected','revoked','superseded')),
        meta             JSONB,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Partial unique index: one active current milestone per (order, stage_key).
    // IS DISTINCT FROM handles NULL event_group correctly (NULL <> 'negotiation' is NULL in SQL).
    await pool.query(`DROP INDEX IF EXISTS uq_current_milestone_event`);
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_current_milestone_event
        ON order_events(order_id, stage_key)
        WHERE status = 'active'
          AND is_current = TRUE
          AND event_group IS DISTINCT FROM 'negotiation'
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_events_order_id ON order_events(order_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_events_stage_key ON order_events(stage_key)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_events_status ON order_events(status)`);

    return res.status(200).json({ success: true, message: "order_events table + indexes created" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
