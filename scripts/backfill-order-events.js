// backfill-order-events.js — one-time: extract events from orders.raw + shipping_plans → order_events
//
// Mapping (v3.2 §6.1, source='backfill'):
//   orders.raw.blNo (non-null)   → vessel_loaded       (ocean)
//   shipping_plans.etd           → vessel_etd_carrier   (ocean)
//   shipping_plans.atd           → vessel_atd           (ocean)
//   shipping_plans.eta           → vessel_eta_carrier   (ocean)
//   shipping_plans.ata           → vessel_ata           (ocean)
//   orders.actDelivery           → delivery_actual      (milestone)
//
// Usage:
//   node scripts/backfill-order-events.js [--dry-run]
//
import pg from "pg";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");
const LOG_PATH = "/tmp/backfill-events.log";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const logLines = [];

function log(msg) {
  console.log(msg);
  logLines.push(msg);
}

function toTs(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function eventExists(client, order_id, stage_key) {
  const r = await client.query(
    `SELECT 1 FROM order_events WHERE order_id=$1 AND stage_key=$2 AND status='active' LIMIT 1`,
    [order_id, stage_key]
  );
  return r.rowCount > 0;
}

async function insertEvent(client, { order_id, stage_key, event_group, occurred_at }) {
  await client.query(
    `INSERT INTO order_events
       (order_id, stage_key, event_group, sequence_no, is_current,
        occurred_at, source, status)
     VALUES ($1,$2,$3,1,TRUE,$4,'backfill','active')`,
    [order_id, stage_key, event_group, occurred_at]
  );
}

async function main() {
  log(`[backfill-order-events] DRY_RUN=${DRY_RUN} started at ${new Date().toISOString()}`);

  // Fetch orders joined with shipping_plans on bl_no
  const { rows: orders } = await pool.query(`
    SELECT
      o.id            AS order_id,
      o.order_no,
      o.raw->>'blNo'       AS bl_no,
      o.raw->>'actDelivery' AS act_delivery,
      sp.etd, sp.atd, sp.eta, sp.ata
    FROM orders o
    LEFT JOIN shipping_plans sp ON sp.bl_no = o.raw->>'blNo'
    ORDER BY o.id
  `);

  log(`Found ${orders.length} orders to process`);

  let inserted = 0;
  let skipped  = 0;

  const client = await pool.connect();
  try {
    for (const row of orders) {
      const oid = row.order_id;

      // Map: (source_value, stage_key, event_group)
      const candidates = [
        { val: row.bl_no       ? new Date() : null, stage: "vessel_loaded",      group: "ocean",     ts: row.bl_no ? new Date().toISOString() : null, useNow: true },
        { val: row.etd,  stage: "vessel_etd_carrier", group: "ocean" },
        { val: row.atd,  stage: "vessel_atd",         group: "ocean" },
        { val: row.eta,  stage: "vessel_eta_carrier",  group: "ocean" },
        { val: row.ata,  stage: "vessel_ata",          group: "ocean" },
        { val: row.act_delivery, stage: "delivery_actual", group: "milestone" },
      ];

      for (const c of candidates) {
        const ts = c.useNow
          ? (row.bl_no ? toTs(row.atd || row.etd || new Date()) : null)  // best-effort timestamp for vessel_loaded
          : toTs(c.val);

        if (!ts) continue;

        if (await eventExists(client, oid, c.stage)) {
          log(`  SKIP order=${oid} (${row.order_no}) stage=${c.stage} — already exists`);
          skipped++;
          continue;
        }

        log(`  ${DRY_RUN ? "[DRY]" : "INSERT"} order=${oid} (${row.order_no}) stage=${c.stage} group=${c.group} ts=${ts}`);

        if (!DRY_RUN) {
          await insertEvent(client, { order_id: oid, stage_key: c.stage, event_group: c.group, occurred_at: ts });
          inserted++;
        }
      }
    }
  } finally {
    client.release();
  }

  const summary = DRY_RUN
    ? `[DRY RUN] would insert events (skipped=${skipped})`
    : `Done. inserted=${inserted} skipped=${skipped}`;
  log(summary);
  log(`Finished at ${new Date().toISOString()}`);

  fs.writeFileSync(LOG_PATH, logLines.join("\n") + "\n");
  console.log(`Log written to ${LOG_PATH}`);

  await pool.end();
}

main().catch(err => {
  console.error(err);
  fs.appendFileSync(LOG_PATH, `\nFATAL: ${err.message}\n`);
  process.exit(1);
});
