// migrate-order-tasks.js — creates order_tasks table per v3.2 §6.2
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
      CREATE TABLE IF NOT EXISTS order_tasks (
        id                  BIGSERIAL PRIMARY KEY,
        order_id            INT NOT NULL,
        task_key            VARCHAR(48) NOT NULL,
        assigned_role       VARCHAR(32) NOT NULL,
        assigned_company_id VARCHAR(64),
        assigned_user_id    VARCHAR(64),
        due_at              TIMESTAMPTZ,
        status              VARCHAR(16) DEFAULT 'open' CHECK (status IN ('open','in_progress','done','cancelled','blocked')),
        source_event_id     BIGINT REFERENCES order_events(id),
        action_route        VARCHAR(120),
        meta                JSONB,
        created_at          TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_tasks_order_id ON order_tasks(order_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_tasks_assigned_role ON order_tasks(assigned_role)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_tasks_assigned_user ON order_tasks(assigned_user_id)`);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_order_tasks_status ON order_tasks(status)`);

    return res.status(200).json({ success: true, message: "order_tasks table + indexes created" });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
