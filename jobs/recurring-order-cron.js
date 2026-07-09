// jobs/recurring-order-cron.js
// Daily cron: check recurring_orders where next_due_date <= today and status='active'
// Creates a draft order for each due recurring plan.
// Runs at 08:00 server time (before business opens).
//
// Exported: scheduleRecurringOrders()
// Called from server.js similar to payment-reminder.

import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

const { Pool } = pg;

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      host:     process.env.PG_HOST     || "127.0.0.1",
      port:     Number(process.env.PG_PORT || 5432),
      database: process.env.PG_DATABASE || "sanlyn_db",
      user:     process.env.PG_USER     || "sanlyn_admin",
      password: process.env.PG_PASSWORD,
      max: 3,
    });
    _pool.on("error", (err) => { console.error("[recurring-cron] pool error:", err.message); });
  }
  return _pool;
}

// ── Run due recurring orders ──────────────────────────────────────────────────
export async function runDueRecurringOrders() {
  const pool = getPool();

  // Ensure table exists (safe no-op if already there)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS recurring_orders (
      id              SERIAL PRIMARY KEY,
      company_code    TEXT        NOT NULL,
      company_name    TEXT,
      label           TEXT        NOT NULL DEFAULT '',
      frequency       TEXT        NOT NULL DEFAULT 'monthly'
                        CHECK(frequency IN ('weekly','biweekly','monthly','bimonthly','quarterly')),
      day_of_month    INT         NOT NULL DEFAULT 1,
      items           JSONB       NOT NULL DEFAULT '[]',
      factory_code    TEXT,
      load_port       TEXT,
      delivery_addr   TEXT,
      req_arrival_days INT        DEFAULT NULL,
      remarks         TEXT,
      status          TEXT        NOT NULL DEFAULT 'active'
                        CHECK(status IN ('active','paused','cancelled')),
      next_due_date   DATE,
      last_run_at     TIMESTAMPTZ,
      last_order_no   TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const today = new Date().toISOString().slice(0, 10);
  const due = await pool.query(`
    SELECT * FROM recurring_orders
    WHERE status = 'active'
      AND next_due_date IS NOT NULL
      AND next_due_date <= $1
    ORDER BY id
  `, [today]);

  if (due.rows.length === 0) {
    console.log("[recurring-cron] No recurring orders due today (" + today + ")");
    return;
  }

  console.log("[recurring-cron] " + due.rows.length + " recurring plan(s) due on " + today);

  const { fireRecurring } = await import("../api/db/recurring-orders.js");

  for (const rec of due.rows) {
    try {
      const orderNo = await fireRecurring(pool, rec);
      console.log("[recurring-cron] Created draft order " + orderNo + " for plan #" + rec.id + " (" + rec.label + ")");
    } catch (e) {
      console.error("[recurring-cron] Failed plan #" + rec.id + ":", e.message);
    }
  }
}

// ── Schedule at 08:00 daily ───────────────────────────────────────────────────
export function scheduleRecurringOrders() {
  // Run once immediately on startup to catch any missed (server was down)
  runDueRecurringOrders().catch(e => console.error("[recurring-cron] startup run failed:", e.message));

  // Then schedule daily at 08:00
  function msUntil8am() {
    const now  = new Date();
    const next = new Date(now);
    next.setHours(8, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    return next.getTime() - now.getTime();
  }

  function scheduleNext() {
    const delay = msUntil8am();
    console.log("[recurring-cron] Next run in " + Math.round(delay / 60000) + " min");
    setTimeout(function() {
      runDueRecurringOrders()
        .catch(e => console.error("[recurring-cron] daily run failed:", e.message))
        .finally(scheduleNext);
    }, delay);
  }

  scheduleNext();
}
