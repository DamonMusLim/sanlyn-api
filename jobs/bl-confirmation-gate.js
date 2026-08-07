// jobs/bl-confirmation-gate.js
// Scheduled BL draft confirmation gate.
//
// Flow:
//  1. SI cutoff comes from shipping_plans.si_cutoff_date only.
//  2. Customer confirmation deadline = SI cutoff - 5h.
//  3. Generate pending internal reminders at T-48h, T-12h, T-2h, T.
//  4. At T, if customer has not confirmed and no revision is pending,
//     mark the draft as auto_submitted in shipping_plans.raw.bl_confirmation.
//  5. Never sends customer-facing messages unless BL_CONFIRMATION_SEND_CUSTOMER=true.

import pg from "pg";
import dotenv from "dotenv";
dotenv.config({ path: new URL("../.env", import.meta.url).pathname });

const { Pool } = pg;
const SOURCE = "bl_confirmation_gate";
const REMINDER_LEVELS = [
  { key: "48h", hoursBeforeDeadline: 48 },
  { key: "12h", hoursBeforeDeadline: 12 },
  { key: "2h", hoursBeforeDeadline: 2 },
  { key: "due", hoursBeforeDeadline: 0 },
];
const FINAL_STATUSES = new Set(["customer_confirmed", "submitted", "submitted_to_carrier", "auto_submitted"]);
const PAUSED_STATUSES = new Set(["revision_requested", "needs_revision", "awaiting_internal_revision"]);

let _pool = null;
function getPool() {
  if (!_pool) {
    _pool = new Pool({
      host: process.env.PG_HOST || "127.0.0.1",
      port: Number(process.env.PG_PORT || 5432),
      database: process.env.PG_DATABASE || "sanlyn_db",
      user: process.env.PG_USER || "sanlyn_admin",
      password: process.env.PG_PASSWORD,
      max: 3,
    });
    _pool.on("error", (err) => console.error("[bl-confirmation-gate] pool error:", err.message));
  }
  return _pool;
}

function fmtBJ(value) {
  if (!value) return "";
  return new Date(value).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function iso(value) {
  return value ? new Date(value).toISOString() : null;
}

function addHours(value, hours) {
  return new Date(new Date(value).getTime() + hours * 3_600_000);
}

function rawObj(row) {
  if (!row || !row.raw) return {};
  if (typeof row.raw === "string") {
    try { return JSON.parse(row.raw); } catch (_) { return {}; }
  }
  return row.raw;
}

function gateOf(row) {
  return rawObj(row).bl_confirmation || {};
}

function draftVersion(gate) {
  return String(gate.version || gate.draft_version || "1");
}

function draftSnapshot(row, gate, customerDeadline) {
  return {
    shipping_plan_id: row.id,
    shipment_no: row.shipment_no || null,
    so_no: row.so_no || null,
    bl_no: row.bl_no || null,
    order_nos: row.order_nos || [],
    contract_nos: row.contract_nos || [],
    customer: row.customer_cn || row.customer_en || row.customer || null,
    vessel: row.vessel || null,
    voyage: row.voyage || null,
    shipping_line: row.shipping_line || row.carrier_code || null,
    pol: row.pol || null,
    pod: row.pod || null,
    etd: iso(row.etd),
    si_cutoff_date: iso(row.si_cutoff_date),
    customer_deadline_at: iso(customerDeadline),
    version: draftVersion(gate),
    draft_ref: gate.draft_ref || gate.draft_url || null,
  };
}

function publicMessage(row, gate, deadline, level) {
  const shipment = row.shipment_no || row.bl_no || "shipment";
  return [
    `BL draft confirmation pending: ${shipment}`,
    `Customer confirmation deadline: ${fmtBJ(deadline)} Beijing time`,
    `Reminder stage: ${level}`,
    "No customer message was sent; this record is pending internal review.",
    "Customer sending is disabled unless BL_CONFIRMATION_SEND_CUSTOMER=true.",
  ].join("\n");
}

function eventKey(row, type, trigger, version) {
  return [row.id, type, trigger, version].join(":");
}

async function ensureTables(pool) {
  await pool.query(`
    ALTER TABLE tasks
      ADD COLUMN IF NOT EXISTS source VARCHAR,
      ADD COLUMN IF NOT EXISTS dedupe_key VARCHAR,
      ADD COLUMN IF NOT EXISTS priority VARCHAR(4),
      ADD COLUMN IF NOT EXISTS notify_stage INT DEFAULT 0
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bl_confirmation_events (
      id BIGSERIAL PRIMARY KEY,
      shipping_plan_id INTEGER NOT NULL,
      shipment_no TEXT,
      bl_no TEXT,
      order_nos TEXT[],
      version TEXT NOT NULL,
      action_type TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      event_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      customer_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
      message TEXT,
      customer_send_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      customer_send_result JSONB,
      task_id VARCHAR(32),
      event_key TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bl_confirmation_events_plan_time
      ON bl_confirmation_events (shipping_plan_id, event_at DESC)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS backup_bl_confirmation_shipping_plans_20260807
    AS SELECT NOW()::timestamptz AS backup_at, 'init'::text AS backup_reason, sp.*
         FROM shipping_plans sp WHERE false
  `);
}

async function sendCustomerMessageIfEnabled(message) {
  if (process.env.BL_CONFIRMATION_SEND_CUSTOMER !== "true") {
    return { skipped: true, reason: "BL_CONFIRMATION_SEND_CUSTOMER is not true" };
  }
  const url = process.env.BL_CONFIRMATION_CUSTOMER_WEBHOOK_URL;
  if (!url) return { skipped: true, reason: "BL_CONFIRMATION_CUSTOMER_WEBHOOK_URL not set" };
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: message }),
  });
  const body = await r.text().catch(() => "");
  return { ok: r.ok, status: r.status, body: body.slice(0, 500) };
}

function taskPayload(row, gate, deadline, level, actionType) {
  const shipment = row.shipment_no || row.bl_no || `SP-${row.id}`;
  const orderNo = Array.isArray(row.order_nos) && row.order_nos.length ? row.order_nos[0] : null;
  const isSubmit = actionType === "auto_submit";
  return {
    id: ("blg-" + row.id + "-" + actionType + "-" + level).slice(0, 32),
    title: (isSubmit ? "BL draft auto submitted: " : "BL draft confirmation reminder: ") + shipment,
    task_type: "BL_CONFIRMATION_GATE",
    level: "logi",
    risk_level: isSubmit ? "high" : "mid",
    priority: isSubmit ? "P1" : "P2",
    related_order_no: orderNo,
    owner_object_type: "logistics",
    owner_object_id: String(row.id),
    due_at: iso(deadline),
    reason: isSubmit
      ? `Customer deadline ${fmtBJ(deadline)} reached; system submitted draft version ${draftVersion(gate)}.`
      : `Customer deadline ${fmtBJ(deadline)}, reminder stage ${level}; pending notice generated only.`,
    raw: {
      source: SOURCE,
      action_type: actionType,
      reminder_level: level,
      shipment_no: row.shipment_no || null,
      bl_no: row.bl_no || null,
      version: draftVersion(gate),
      customer_send_enabled: process.env.BL_CONFIRMATION_SEND_CUSTOMER === "true",
    },
    dedupe_key: `${row.id}:${actionType}:${level}:${draftVersion(gate)}`,
  };
}

async function upsertInternalTask(client, payload) {
  try {
    const existing = await client.query(
      `SELECT id FROM tasks
        WHERE source = $1
          AND dedupe_key = $2
          AND status NOT IN ('done','cancelled')
        ORDER BY created_at DESC
        LIMIT 1`,
      [SOURCE, payload.dedupe_key]
    );
    if (existing.rows[0]) {
      const r = await client.query(
        `UPDATE tasks
            SET title=$2,
                risk_level=$3,
                priority=$4,
                due_at=$5::timestamptz,
                reason=$6,
                raw=COALESCE(raw,'{}'::jsonb) || $7::jsonb,
                updated_at=NOW()
          WHERE id=$1
          RETURNING id`,
        [
          existing.rows[0].id, payload.title, payload.risk_level, payload.priority,
          payload.due_at, payload.reason, JSON.stringify(payload.raw),
        ]
      );
      return r.rows[0]?.id || null;
    }
    const r = await client.query(
      `INSERT INTO tasks (
         id, title, task_type, level, status, risk_level, priority,
         owner_object_type, owner_object_id, related_order_no,
         mode, due_at, reason, raw, source, dedupe_key, notify_stage,
         created_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,'open',$5,$6,
         $7,$8,$9,
         'owned',$10::timestamptz,$11,$12::jsonb,$13,$14,0,
         NOW(),NOW()
       )
       RETURNING id`,
      [
        payload.id, payload.title, payload.task_type, payload.level,
        payload.risk_level, payload.priority, payload.owner_object_type,
        payload.owner_object_id, payload.related_order_no, payload.due_at,
        payload.reason, JSON.stringify(payload.raw), SOURCE, payload.dedupe_key,
      ]
    );
    return r.rows[0]?.id || null;
  } catch (e) {
    console.error("[bl-confirmation-gate] task upsert failed:", e.message);
    return null;
  }
}

async function insertEvent(client, row, gate, actionType, triggerType, snapshot, message, sendResult, taskId) {
  const version = draftVersion(gate);
  const key = eventKey(row, actionType, triggerType, version);
  const r = await client.query(
    `INSERT INTO bl_confirmation_events (
       shipping_plan_id, shipment_no, bl_no, order_nos, version, action_type,
       trigger_type, customer_snapshot, message, customer_send_enabled,
       customer_send_result, task_id, event_key
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,$13)
     ON CONFLICT (event_key) DO NOTHING
     RETURNING id`,
    [
      row.id, row.shipment_no || null, row.bl_no || null, row.order_nos || [],
      version, actionType, triggerType, JSON.stringify(snapshot), message,
      process.env.BL_CONFIRMATION_SEND_CUSTOMER === "true",
      JSON.stringify(sendResult || {}), taskId, key,
    ]
  );
  return r.rowCount > 0;
}

async function backupPlanBeforeUpdate(client, row, reason) {
  const before = await client.query(
    "SELECT COUNT(*)::int AS cnt FROM backup_bl_confirmation_shipping_plans_20260807 WHERE id = $1 AND backup_reason = $2",
    [row.id, reason]
  );
  if (before.rows[0].cnt > 0) return before.rows[0].cnt;
  await client.query(
    `INSERT INTO backup_bl_confirmation_shipping_plans_20260807
     SELECT NOW()::timestamptz AS backup_at, $2::text AS backup_reason, sp.*
       FROM shipping_plans sp WHERE sp.id = $1`,
    [row.id, reason]
  );
  const after = await client.query(
    "SELECT COUNT(*)::int AS cnt FROM backup_bl_confirmation_shipping_plans_20260807 WHERE id = $1 AND backup_reason = $2",
    [row.id, reason]
  );
  if (after.rows[0].cnt <= before.rows[0].cnt) {
    throw new Error(`backup failed for shipping_plan ${row.id}`);
  }
  return after.rows[0].cnt;
}

async function updateAutoSubmitted(client, row, gate, deadline, snapshot) {
  const nowIso = new Date().toISOString();
  const nextGate = {
    ...gate,
    status: "auto_submitted",
    submitted_by: "system",
    submitted_trigger: "timeout_auto",
    submitted_at: nowIso,
    customer_deadline_at: iso(deadline),
    customer_deadline_bj: fmtBJ(deadline),
    customer_snapshot: snapshot,
  };
  await backupPlanBeforeUpdate(client, row, `bl_confirmation_auto_submit_v${draftVersion(gate)}`);
  await client.query(
    `UPDATE shipping_plans
        SET raw = jsonb_set(COALESCE(raw,'{}'::jsonb), '{bl_confirmation}', $2::jsonb, true),
            updated_at = NOW()
      WHERE id = $1`,
    [row.id, JSON.stringify(nextGate)]
  );
}

async function processPlan(client, row, now, dryRun) {
  const gate = gateOf(row);
  const status = String(gate.status || "awaiting_customer_confirmation");
  if (!row.si_cutoff_date) return { wait_so: 1 };
  if (FINAL_STATUSES.has(status)) return { skipped_final: 1 };
  if (PAUSED_STATUSES.has(status)) return { paused_revision: 1 };

  const deadline = addHours(row.si_cutoff_date, -5);
  const snapshot = draftSnapshot(row, gate, deadline);
  const result = { reminders: 0, auto_submitted: 0, skipped: 0 };

  for (const level of REMINDER_LEVELS) {
    const dueAt = addHours(deadline, -level.hoursBeforeDeadline);
    if (now < dueAt) continue;
    const message = publicMessage(row, gate, deadline, level.key);
    const task = taskPayload(row, gate, deadline, level.key, "reminder");
    const taskId = dryRun ? null : await upsertInternalTask(client, task);
    const sendResult = dryRun ? { dryRun: true } : await sendCustomerMessageIfEnabled(message);
    const inserted = dryRun
      ? true
      : await insertEvent(client, row, gate, "reminder", level.key, snapshot, message, sendResult, taskId);
    if (inserted) result.reminders++;
  }

  if (now >= deadline) {
    const task = taskPayload(row, gate, deadline, "timeout", "auto_submit");
    const taskId = dryRun ? null : await upsertInternalTask(client, task);
    const message = `BL draft auto-submitted at ${fmtBJ(now)} Beijing time for version ${draftVersion(gate)}.`;
    const inserted = dryRun
      ? true
      : await insertEvent(client, row, gate, "auto_submit", "timeout_auto", snapshot, message, { internal: true }, taskId);
    if (inserted && !dryRun) await updateAutoSubmitted(client, row, gate, deadline, snapshot);
    if (inserted) result.auto_submitted++;
  }

  if (!result.reminders && !result.auto_submitted) result.skipped++;
  return result;
}

export async function runBlConfirmationGate({ dryRun = false } = {}) {
  const pool = getPool();
  await ensureTables(pool);
  const now = new Date();
  const stats = { checked: 0, reminders: 0, auto_submitted: 0, wait_so: 0, paused_revision: 0, skipped_final: 0, skipped: 0, errors: 0 };
  const { rows } = await pool.query(`
    SELECT id, shipment_no, so_no, bl_no, order_nos, contract_nos,
           customer, customer_en, customer_cn, vessel, voyage, shipping_line,
           carrier_code, pol, pod, etd, si_cutoff_date, raw, status, deleted_at
      FROM shipping_plans
     WHERE deleted_at IS NULL
       AND COALESCE(status,'') NOT IN ('cancelled','archived')
       AND (
         si_cutoff_date IS NOT NULL
         OR COALESCE(raw->'bl_confirmation'->>'status','') IN ('wait_so','waiting_so')
       )
     ORDER BY si_cutoff_date NULLS LAST, id
     LIMIT 500
  `);
  stats.checked = rows.length;
  for (const row of rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const r = await processPlan(client, row, now, dryRun);
      for (const [k, v] of Object.entries(r)) stats[k] = (stats[k] || 0) + Number(v || 0);
      if (dryRun) await client.query("ROLLBACK");
      else await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      stats.errors++;
      console.error("[bl-confirmation-gate] plan failed:", row.id, e.message);
    } finally {
      client.release();
    }
  }
  console.log("[bl-confirmation-gate] done:", stats);
  return stats;
}

function msUntilNextRun() {
  const now = new Date();
  const next = new Date(now);
  next.setMinutes(Math.ceil((now.getMinutes() + 1) / 15) * 15, 0, 0);
  if (next <= now) next.setMinutes(next.getMinutes() + 15);
  return next.getTime() - now.getTime();
}

export function scheduleBlConfirmationGate() {
  function tick() {
    runBlConfirmationGate()
      .catch(e => console.error("[bl-confirmation-gate] error:", e.message))
      .finally(() => setTimeout(tick, msUntilNextRun()));
  }
  const delay = msUntilNextRun();
  console.log(`[bl-confirmation-gate] scheduled - next run in ${Math.round(delay / 60000)} min`);
  setTimeout(tick, delay);
}
