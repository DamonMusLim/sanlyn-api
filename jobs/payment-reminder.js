// jobs/payment-reminder.js
// Scheduled payment overdue reminder — runs daily at 09:00
//
// Logic:
//  1. Query shipped orders + payment sums grouped by order_no
//  2. Calculate balance due = total_amount - paid
//  3. If delivery_date + 7d overdue + balance > 0  → Level 1 (first reminder)
//  4. If delivery_date + 30d overdue + balance > 0 → Level 2 (escalation)
//  5. Dedup: skip if same (order_no, level) sent within 7 days
//  6. Send WeCom markdown, write to payment_reminder_logs

import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

const { Pool } = pg;

// ── DB pool ──────────────────────────────────────────────────────────────────
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
  }
  return _pool;
}

// ── Ensure migration table exists ────────────────────────────────────────────
export async function ensureLogTable() {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payment_reminder_logs (
      id             SERIAL PRIMARY KEY,
      order_no       TEXT    NOT NULL,
      reminder_level INTEGER NOT NULL,  -- 1 = 7-day, 2 = 30-day
      sent_at        TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS ix_pay_reminder_order_level
      ON payment_reminder_logs (order_no, reminder_level, sent_at DESC)
  `);
}

// ── WeCom notification ────────────────────────────────────────────────────────
async function sendWecom(markdown) {
  const url = process.env.WECOM_WEBHOOK_URL;
  if (!url) {
    console.warn("[payment-reminder] WECOM_WEBHOOK_URL not set — skipping notify");
    return { skipped: true };
  }
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msgtype: "markdown", markdown: { content: markdown } }),
    });
    const body = await r.json();
    return body;
  } catch (e) {
    console.error("[payment-reminder] wecom error:", e.message);
    return { error: e.message };
  }
}

// ── Core reminder logic ───────────────────────────────────────────────────────
export async function runPaymentReminder({ dryRun = false } = {}) {
  const pool = getPool();
  await ensureLogTable();

  const now = new Date();

  // 1. Query shipped orders with payment sums
  const { rows: orders } = await pool.query(`
    SELECT
      o.order_no,
      o.customer,
      o.total_amount,
      o.currency,
      o.delivery_date,
      o.status,
      COALESCE(SUM(fp.amount), 0)   AS paid_amount,
      MAX(fp.payment_date)           AS last_payment_date
    FROM orders o
    LEFT JOIN finance_payments fp ON fp.order_no = o.order_no
    WHERE o.status IN ('shipped', 'delivered')
      AND o.delivery_date IS NOT NULL
      AND o.total_amount  IS NOT NULL
      AND o.total_amount  > 0
    GROUP BY o.order_no, o.customer, o.total_amount, o.currency,
             o.delivery_date, o.status
    HAVING COALESCE(SUM(fp.amount), 0) < o.total_amount * 0.95
    ORDER BY o.delivery_date ASC
  `);

  const results = { checked: orders.length, sent: 0, skipped: 0, errors: 0 };

  for (const order of orders) {
    const deliveryDate  = new Date(order.delivery_date);
    const daysSince     = Math.floor((now - deliveryDate) / 86_400_000);
    const balance       = Number(order.total_amount) - Number(order.paid_amount);
    const cur           = order.currency || "CNY";

    // Determine which levels apply
    const levels = [];
    if (daysSince >= 7)  levels.push(1);
    if (daysSince >= 30) levels.push(2);
    if (!levels.length) { results.skipped++; continue; }

    for (const level of levels) {
      // Dedup: check if same (order_no, level) sent in last 7 days
      const { rows: recent } = await pool.query(`
        SELECT id FROM payment_reminder_logs
        WHERE order_no = $1
          AND reminder_level = $2
          AND sent_at > NOW() - INTERVAL '7 days'
        LIMIT 1
      `, [order.order_no, level]);

      if (recent.length) { results.skipped++; continue; }

      const labelMap = { 1: "⚠️ 付款逾期提醒", 2: "🚨 付款严重逾期 (30天+)" };
      const paidStr  = cur + " " + Number(order.paid_amount).toLocaleString("zh", { minimumFractionDigits: 2 });
      const totalStr = cur + " " + Number(order.total_amount).toLocaleString("zh", { minimumFractionDigits: 2 });
      const dueStr   = cur + " " + Number(balance).toLocaleString("zh", { minimumFractionDigits: 2 });

      const markdown = [
        `**${labelMap[level]}**`,
        `客户：${order.customer || "—"}`,
        `订单：\`${order.order_no || "—"}\``,
        `应收：${totalStr}`,
        `已收：${paidStr}`,
        `欠款：**${dueStr}**`,
        `交货日期：${order.delivery_date} （已逾期 ${daysSince} 天）`,
      ].join("\n");

      if (!dryRun) {
        await sendWecom(markdown);
        await pool.query(
          "INSERT INTO payment_reminder_logs (order_no, reminder_level) VALUES ($1, $2)",
          [order.order_no, level]
        );
      }

      console.log(`[payment-reminder] ${dryRun ? "[DRY]" : ""} sent level-${level} for ${order.order_no} (${daysSince}d overdue, due ${dueStr})`);
      results.sent++;
    }
  }

  console.log("[payment-reminder] done:", results);
  return results;
}

// ── Scheduling (setTimeout-based, like wecom-cron.mjs) ───────────────────────
function msUntilNext9am() {
  const now  = new Date();
  const next = new Date(now);
  next.setHours(9, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function schedulePaymentReminder() {
  function tick() {
    console.log("[payment-reminder] running daily check…");
    runPaymentReminder()
      .catch(e => console.error("[payment-reminder] error:", e.message));
    setTimeout(tick, msUntilNext9am());
  }
  const delay = msUntilNext9am();
  const h = Math.floor(delay / 3_600_000);
  const m = Math.floor((delay % 3_600_000) / 60_000);
  console.log(`[payment-reminder] scheduled — next run in ${h}h ${m}m`);
  setTimeout(tick, delay);
}
