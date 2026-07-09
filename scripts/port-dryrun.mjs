import "dotenv/config";
import { getPool } from "../api/db/db.js";
import { resolvePort } from "../api/db/port-resolver.js";

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find(arg => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function addBucket(buckets, result) {
  if (!buckets[result.status]) buckets[result.status] = [];
  buckets[result.status].push(result);
}

function label(result) {
  return result.input || "(empty)";
}

function printResolved(rows) {
  console.log(`\nRESOLVED (${rows.length})`);
  for (const row of rows) console.log(`- ${label(row)} -> ${row.code} (${row.confidence})`);
}

function printAmbiguous(rows) {
  console.log(`\nAMBIGUOUS (${rows.length})`);
  for (const row of rows) {
    const candidates = row.candidates.map(x => `${x.code}:${x.name}`).join(", ");
    console.log(`- ${label(row)} -> ${row.code || "match"} candidates=[${candidates}]`);
  }
}

function printUnknown(rows) {
  console.log(`\nUNKNOWN (${rows.length})`);
  for (const row of rows) console.log(`- ${label(row)} normalized=${row.normalized_input || "(empty)"}`);
}

async function distinctPorts(pool, forwarderCompanyId) {
  const params = [];
  const where = [];
  if (forwarderCompanyId) {
    params.push(forwarderCompanyId);
    where.push(`forwarder_company_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT DISTINCT pol, pod
       FROM shipping_plans
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY pol NULLS LAST, pod NULLS LAST`,
    params
  );
  return rows;
}

async function ambiguousShipments(pool, pods, forwarderCompanyId) {
  if (!pods.length) return [];
  const params = [pods];
  const where = [`pod = ANY($1::text[])`];
  if (forwarderCompanyId) {
    params.push(forwarderCompanyId);
    where.push(`forwarder_company_id = $${params.length}`);
  }
  const { rows } = await pool.query(
    `SELECT pod, bl_no, carrier_code, vessel
       FROM shipping_plans
      WHERE ${where.join(" AND ")}
      ORDER BY pod, bl_no NULLS LAST`,
    params
  );
  return rows;
}

const pool = getPool();
const forwarderCompanyId = argValue("forwarder-company-id");

try {
  const pairs = await distinctPorts(pool, forwarderCompanyId);
  const texts = new Set();
  for (const row of pairs) {
    if (row.pol) texts.add(row.pol);
    if (row.pod) texts.add(row.pod);
  }

  const buckets = { resolved: [], ambiguous: [], unknown: [] };
  const resultsByText = new Map();
  for (const text of [...texts].sort()) {
    const result = await resolvePort(pool, text);
    resultsByText.set(text, result);
    addBucket(buckets, result);
  }

  console.log("PORT RESOLUTION DRY RUN");
  console.log(`scope=${forwarderCompanyId ? `forwarder_company_id:${forwarderCompanyId}` : "all"}`);
  console.log(`distinct_pairs=${pairs.length} distinct_texts=${texts.size}`);
  printResolved(buckets.resolved);
  printAmbiguous(buckets.ambiguous);
  printUnknown(buckets.unknown);

  const ambiguousPods = [...new Set(
    pairs
      .map(row => row.pod)
      .filter(pod => resultsByText.get(pod)?.status === "ambiguous")
  )];
  const shipments = await ambiguousShipments(pool, ambiguousPods, forwarderCompanyId);
  console.log(`\nAMBIGUOUS POD SHIPMENTS (${shipments.length})`);
  for (const row of shipments) {
    console.log(`- pod=${row.pod} bl_no=${row.bl_no || ""} carrier=${row.carrier_code || ""} vessel=${row.vessel || ""}`);
  }
} finally {
  await pool.end();
}
