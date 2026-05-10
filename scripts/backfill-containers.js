// backfill-containers.js — one-time: build shipment_group + containers + order_containers from shipping_plans
//
// Strategy: group shipping_plans by bl_no. Each unique BL → one shipment_group.
// Container info (container_no, seal_no) may be in shipping_plans columns or orders.raw.
// Each order sharing a BL → order_containers entry.
//
// Usage:
//   node scripts/backfill-containers.js [--dry-run]
//
import pg from "pg";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const DRY_RUN = process.argv.includes("--dry-run");
const LOG_PATH = "/tmp/backfill-containers.log";
const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const logLines = [];

function log(msg) {
  console.log(msg);
  logLines.push(msg);
}

async function main() {
  log(`[backfill-containers] DRY_RUN=${DRY_RUN} started at ${new Date().toISOString()}`);

  // Fetch all shipping_plans that have a bl_no
  const { rows: plans } = await pool.query(`
    SELECT
      sp.id              AS plan_id,
      sp.bl_no,
      sp.vessel,
      sp.voyage,
      sp.pol,
      sp.pod,
      sp.container_no,
      sp.seal_no,
      sp.container_type,
      sp.order_contract_nos
    FROM shipping_plans sp
    WHERE sp.bl_no IS NOT NULL AND sp.bl_no <> ''
    ORDER BY sp.bl_no, sp.id
  `);

  log(`Found ${plans.length} shipping_plans with a bl_no`);

  // Group plans by bl_no
  const byBl = {};
  for (const p of plans) {
    if (!byBl[p.bl_no]) byBl[p.bl_no] = [];
    byBl[p.bl_no].push(p);
  }

  log(`Unique BL numbers: ${Object.keys(byBl).length}`);

  // Also fetch orders so we can look up order_id by order_no / contract_no
  const { rows: orderRows } = await pool.query(`
    SELECT id, order_no, raw->>'blNo' AS raw_bl_no FROM orders
  `);
  const orderByNo = {};
  const orderByBl = {};
  for (const o of orderRows) {
    if (o.order_no) orderByNo[o.order_no.trim()] = o.id;
    if (o.raw_bl_no) {
      if (!orderByBl[o.raw_bl_no]) orderByBl[o.raw_bl_no] = [];
      orderByBl[o.raw_bl_no].push(o.id);
    }
  }

  let sg_count = 0;
  let ct_count = 0;
  let oc_count = 0;

  const client = await pool.connect();
  try {
    for (const [bl_no, group] of Object.entries(byBl)) {
      const first = group[0];

      // Check if shipment_group already exists for this BL
      const existing_sg = await client.query(
        `SELECT id FROM shipment_group WHERE bl_master = $1 LIMIT 1`,
        [bl_no]
      );
      if (existing_sg.rows.length > 0) {
        log(`  SKIP BL=${bl_no} — shipment_group already exists (id=${existing_sg.rows[0].id})`);
        continue;
      }

      const group_code = `SHIP-${bl_no.replace(/[^A-Z0-9]/gi, "").slice(-12).toUpperCase()}`;

      log(`  ${DRY_RUN ? "[DRY]" : "INSERT"} shipment_group BL=${bl_no} group_code=${group_code} vessel=${first.vessel || "-"}`);

      let sg_id;
      if (!DRY_RUN) {
        const sg = await client.query(
          `INSERT INTO shipment_group (group_code, bl_master, vessel, voyage, pol, pod)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [group_code, bl_no, first.vessel || null, first.voyage || null, first.pol || null, first.pod || null]
        );
        sg_id = sg.rows[0].id;
        sg_count++;
      }

      // Each unique container_no in this BL group → one containers row
      // container_no may be comma/slash/space separated (dirty data) — split into individual rows
      const seenContainers = {};
      for (const plan of group) {
        // Normalize: split by comma, slash, space+slash, " / "
        const rawCno = plan.container_no?.trim() || "";
        const cnoList = rawCno
          ? rawCno.split(/[,/]/).map(s => s.trim()).filter(s => s.length > 0 && s.length <= 16)
          : [null];

        for (const cno of cnoList.length ? cnoList : [null]) {
          const ckey = cno || `__plan_${plan.plan_id}`;
          if (seenContainers[ckey]) continue;

          log(`    ${DRY_RUN ? "[DRY]" : "INSERT"} container container_no=${cno || "(null)"} seal=${plan.seal_no || "-"}`);

          let ct_id;
          if (!DRY_RUN) {
            const ct = await client.query(
              `INSERT INTO containers (shipment_group_id, container_no, seal_no, container_type)
               VALUES ($1,$2,$3,$4) RETURNING id`,
              [sg_id, cno, plan.seal_no || null, plan.container_type || null]
            );
            ct_id = ct.rows[0].id;
            ct_count++;
          }
          seenContainers[ckey] = ct_id || true;

        // Find orders belonging to this BL
        const order_ids = orderByBl[bl_no] || [];

        // Also parse order_contract_nos from the plan (JSONB array or CSV string)
        if (plan.order_contract_nos) {
          let nos = [];
          try {
            if (typeof plan.order_contract_nos === "string") {
              // Try JSON first, fall back to CSV splitting
              try { nos = JSON.parse(plan.order_contract_nos); }
              catch { nos = plan.order_contract_nos.split(",").map(s => s.trim()).filter(Boolean); }
            } else {
              nos = plan.order_contract_nos;
            }
          } catch { nos = []; }
          for (const no of nos) {
            const oid = orderByNo[String(no).trim()];
            if (oid && !order_ids.includes(oid)) order_ids.push(oid);
          }
        }

          for (const oid of order_ids) {
            log(`      ${DRY_RUN ? "[DRY]" : "LINK"} order_id=${oid} → container`);
            if (!DRY_RUN) {
              await client.query(
                `INSERT INTO order_containers (order_id, container_id)
                 VALUES ($1,$2)
                 ON CONFLICT (order_id, container_id) DO NOTHING`,
                [oid, ct_id]
              );
              oc_count++;
            }
          }
        }
      }
    }
  } finally {
    client.release();
  }

  const summary = DRY_RUN
    ? `[DRY RUN] would create shipment_groups, containers, order_containers`
    : `Done. shipment_groups=${sg_count} containers=${ct_count} order_containers=${oc_count}`;
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
