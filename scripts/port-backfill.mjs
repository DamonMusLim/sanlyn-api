import "dotenv/config";
import { getPool } from "../api/db/db.js";
import { resolvePort } from "../api/db/port-resolver.js";

const BATCH_SIZE = 500;

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function emptyStats() {
  return {
    rows: 0,
    pol_resolved: 0,
    pod_resolved: 0,
    pod_ambiguous: 0,
    pod_unknown: 0,
    updated: 0,
  };
}

function addPodStats(stats, result) {
  if (result.status === "resolved") stats.pod_resolved += 1;
  else if (result.status === "ambiguous") stats.pod_ambiguous += 1;
  else stats.pod_unknown += 1;
}

async function parentPortId(client, result) {
  if (result.port_id) return result.port_id;
  const candidateIds = (result.candidates || [])
    .map(candidate => candidate.port_id)
    .filter(Boolean);
  if (!candidateIds.length) return null;

  const { rows } = await client.query(
    `SELECT DISTINCT parent_port_id
       FROM ports
      WHERE id = ANY($1::int[])
        AND parent_port_id IS NOT NULL`,
    [candidateIds]
  );
  const parents = new Set(rows.map(row => row.parent_port_id).filter(Boolean));
  return parents.size === 1 ? [...parents][0] : null;
}

async function loadBatch(pool, lastId, forwarderCompanyId) {
  const params = [lastId, BATCH_SIZE];
  const where = ["id > $1"];
  if (forwarderCompanyId) {
    params.push(forwarderCompanyId);
    where.push(`forwarder_company_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT id, pol, pod
       FROM shipping_plans
      WHERE ${where.join(" AND ")}
      ORDER BY id
      LIMIT $2`,
    params
  );
  return rows;
}

async function updateRow(client, row, polResult, podResult) {
  const polPortId = polResult.status === "resolved" ? polResult.port_id : null;
  let podPortId = null;
  let podTerminalUnconfirmed = false;

  if (podResult.status === "resolved") {
    podPortId = podResult.port_id;
  } else if (podResult.status === "ambiguous") {
    podPortId = await parentPortId(client, podResult);
    podTerminalUnconfirmed = true;
  }

  await client.query(
    `UPDATE shipping_plans
        SET pol_port_id = $1,
            pod_port_id = $2,
            pod_terminal_unconfirmed = $3,
            port_resolution_status = $4
      WHERE id = $5`,
    [polPortId, podPortId, podTerminalUnconfirmed, podResult.status, row.id]
  );
}

async function processBatch(pool, rows, dry, stats) {
  const client = await pool.connect();
  try {
    if (!dry) await client.query("BEGIN");
    for (const row of rows) {
      const [polResult, podResult] = await Promise.all([
        resolvePort(client, row.pol),
        resolvePort(client, row.pod),
      ]);

      stats.rows += 1;
      if (polResult.status === "resolved") stats.pol_resolved += 1;
      addPodStats(stats, podResult);

      if (!dry) {
        await updateRow(client, row, polResult, podResult);
        stats.updated += 1;
      }
    }
    if (!dry) await client.query("COMMIT");
  } catch (err) {
    if (!dry) await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function printProgress(stats, dry) {
  console.log(
    [
      `processed=${stats.rows}`,
      `updated=${dry ? 0 : stats.updated}`,
      `pod_resolved=${stats.pod_resolved}`,
      `pod_ambiguous=${stats.pod_ambiguous}`,
      `pod_unknown=${stats.pod_unknown}`,
    ].join(" ")
  );
}

const dry = hasFlag("dry");
const forwarderCompanyId = argValue("forwarder-company-id");
const pool = getPool();
const stats = emptyStats();

try {
  console.log("PORT BACKFILL");
  console.log(`mode=${dry ? "dry" : "write"}`);
  console.log(`scope=${forwarderCompanyId ? `forwarder_company_id:${forwarderCompanyId}` : "all"}`);

  let lastId = 0;
  while (true) {
    const rows = await loadBatch(pool, lastId, forwarderCompanyId);
    if (!rows.length) break;

    await processBatch(pool, rows, dry, stats);
    lastId = rows[rows.length - 1].id;
    printProgress(stats, dry);
  }

  console.log("FINAL");
  console.log(`rows=${stats.rows}`);
  console.log(`pol_resolved=${stats.pol_resolved}`);
  console.log(`pod_resolved=${stats.pod_resolved}`);
  console.log(`pod_ambiguous=${stats.pod_ambiguous}`);
  console.log(`pod_unknown=${stats.pod_unknown}`);
  console.log(`updated=${dry ? 0 : stats.updated}`);
} finally {
  await pool.end();
}
